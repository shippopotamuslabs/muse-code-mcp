import type { AutoApproveRule } from "./config.ts";
import type { AuditActor, AuditEvent } from "./audit.ts";
import { canonicalSubject, matchPolicy, selectChoice, type ApprovalChoice, type ApprovalSubjectView } from "./policy.ts";

export type PendingKind = "approval" | "userInput";

export interface PendingItem {
  requestId: string;
  sessionId: string;
  kind: PendingKind;
  payload: unknown;
  receivedAt: number;
}

export interface DecideResult {
  choiceId: string;
  feedback?: string;
}

interface HeldApproval extends PendingItem {
  kind: "approval";
  payload: ApprovalSubjectView;
  resolve: (decision: DecideResult) => void;
}

interface HeldQuestion extends PendingItem {
  kind: "userInput";
}

type Held = HeldApproval | HeldQuestion;

export interface ExpireAction {
  item: PendingItem;
  approval?: DecideResult;
  question?: true;
}

export class PendingBroker {
  private readonly held = new Map<string, Held>();
  /** Decisions whose wire send has not been acked. Restored if that send fails. */
  private readonly taken = new Map<string, HeldApproval>();
  private readonly options: {
    rules: readonly AutoApproveRule[];
    timeoutSec: number;
    now?: () => number;
    audit: (event: AuditEvent) => void;
  };

  constructor(options: {
    rules: readonly AutoApproveRule[];
    timeoutSec: number;
    now?: () => number;
    audit: (event: AuditEvent) => void;
  }) {
    this.options = options;
  }

  list(now = this.now()): Array<PendingItem & { ageSec: number }> {
    return [...this.held.values()].map((item) => ({
      requestId: item.requestId,
      sessionId: item.sessionId,
      kind: item.kind,
      payload: item.payload,
      receivedAt: item.receivedAt,
      ageSec: Math.max(0, Math.floor((now - item.receivedAt) / 1000)),
    }));
  }

  get(requestId: string): PendingItem | undefined {
    const item = this.held.get(requestId);
    if (!item) return undefined;
    return {
      requestId: item.requestId,
      sessionId: item.sessionId,
      kind: item.kind,
      payload: item.payload,
      receivedAt: item.receivedAt,
    };
  }

  /**
   * Register an approval. A policy hit resolves the SDK promise immediately
   * and does not queue. Returns the queued item, or undefined when policy settled it.
   */
  registerApproval(payload: ApprovalSubjectView & { sessionId: string }, resolve: (decision: DecideResult) => void): PendingItem | undefined {
    const line = canonicalSubject(payload);
    const rule = matchPolicy(this.options.rules, line);
    this.options.audit({
      kind: "request",
      sessionId: payload.sessionId,
      requestId: payload.approvalId,
      detail: { kind: "approval", line },
    });
    if (rule) {
      const selected = selectChoice(payload.availableChoices, "approve");
      if (selected.ok) {
        this.options.audit({
          kind: "decision",
          actor: "policy",
          sessionId: payload.sessionId,
          requestId: payload.approvalId,
          detail: { decision: "approve", choiceId: selected.choiceId, match: rule.match },
        });
        resolve({ choiceId: selected.choiceId });
        return undefined;
      }
    }
    const item: HeldApproval = {
      requestId: payload.approvalId,
      sessionId: payload.sessionId,
      kind: "approval",
      payload,
      receivedAt: this.now(),
      resolve,
    };
    this.held.set(item.requestId, item);
    return this.publicItem(item);
  }

  registerUserInput(requestId: string, sessionId: string, payload: unknown): PendingItem {
    const existing = this.held.get(requestId);
    if (existing) return this.publicItem(existing);
    this.options.audit({
      kind: "request",
      sessionId,
      requestId,
      detail: { kind: "userInput" },
    });
    const item: HeldQuestion = {
      requestId,
      sessionId,
      kind: "userInput",
      payload,
      receivedAt: this.now(),
    };
    this.held.set(requestId, item);
    return this.publicItem(item);
  }

  decide(requestId: string, decision: "approve" | "deny", actor: AuditActor, reason?: string): DecideResult {
    const item = this.takeApproval(requestId);
    const selected = selectChoice(item.payload.availableChoices, decision, reason);
    if (!selected.ok) {
      this.held.set(requestId, item);
      throw new BrokerError(selected.error, selected.choices);
    }
    this.options.audit({
      kind: "decision",
      actor,
      sessionId: item.sessionId,
      requestId,
      detail: { decision, choiceId: selected.choiceId, feedback: selected.feedback },
    });
    const result = { choiceId: selected.choiceId, feedback: selected.feedback };
    this.taken.set(requestId, item);
    item.resolve(result);
    return result;
  }

  /** Drop the stashed approval after the host acks `approval/decide`. */
  commitDecision(requestId: string): void {
    this.taken.delete(requestId);
  }

  /** Put a stashed approval back when `approval/decide` fails. */
  restoreDecision(requestId: string): void {
    const item = this.taken.get(requestId);
    if (!item) return;
    this.taken.delete(requestId);
    this.held.set(requestId, item);
  }

  /**
   * Record an answer only after `userInput/answer` is acked.
   * A rejected answer leaves the row in place and writes no audit line.
   */
  commitAnswer(requestId: string, actor: AuditActor, answer: unknown): PendingItem {
    const item = this.held.get(requestId);
    if (!item || item.kind !== "userInput") throw new BrokerError(`no pending user-input ${requestId}`);
    this.held.delete(requestId);
    this.options.audit({
      kind: "answer",
      actor,
      sessionId: item.sessionId,
      requestId,
      detail: { answer },
    });
    return this.publicItem(item);
  }

  sweep(now = this.now()): ExpireAction[] {
    const timeoutMs = this.options.timeoutSec * 1000;
    const actions: ExpireAction[] = [];
    for (const item of [...this.held.values()]) {
      if (now - item.receivedAt < timeoutMs) continue;
      if (item.kind === "approval") {
        const selected = selectChoice(item.payload.availableChoices, "deny", "pending timeout");
        if (!selected.ok) {
          // No deny or abort choice exists to send. Holding the item would
          // strand it past every later sweep with no record; drop it and
          // audit the drop as the expiry outcome.
          this.held.delete(item.requestId);
          this.options.audit({
            kind: "expiry",
            actor: "policy",
            sessionId: item.sessionId,
            requestId: item.requestId,
            detail: { kind: "approval", resolution: "dropped", reason: "no deny choice offered" },
          });
          actions.push({ item: this.publicItem(item) });
          continue;
        }
        this.held.delete(item.requestId);
        this.options.audit({
          kind: "expiry",
          actor: "policy",
          sessionId: item.sessionId,
          requestId: item.requestId,
          detail: { kind: "approval", choiceId: selected.choiceId },
        });
        const approval = { choiceId: selected.choiceId, feedback: selected.feedback };
        item.resolve(approval);
        actions.push({ item: this.publicItem(item), approval });
      } else {
        this.held.delete(item.requestId);
        this.options.audit({
          kind: "expiry",
          actor: "policy",
          sessionId: item.sessionId,
          requestId: item.requestId,
          detail: { kind: "userInput" },
        });
        actions.push({ item: this.publicItem(item), question: true });
      }
    }
    return actions;
  }

  /** Drop a dead host's queue entries without deciding them. */
  dropSession(sessionId: string): void {
    for (const [id, item] of this.held) {
      if (item.sessionId === sessionId) this.held.delete(id);
    }
    for (const [id, item] of this.taken) {
      if (item.sessionId === sessionId) this.taken.delete(id);
    }
  }

  private takeApproval(requestId: string): HeldApproval {
    const item = this.held.get(requestId);
    if (!item || item.kind !== "approval") throw new BrokerError(`no pending approval ${requestId}`);
    this.held.delete(requestId);
    return item;
  }

  private publicItem(item: Held): PendingItem {
    return {
      requestId: item.requestId,
      sessionId: item.sessionId,
      kind: item.kind,
      payload: item.payload,
      receivedAt: item.receivedAt,
    };
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

export class BrokerError extends Error {
  readonly choices?: ApprovalChoice[];
  constructor(message: string, choices?: ApprovalChoice[]) {
    super(message);
    this.name = "BrokerError";
    this.choices = choices;
  }
}
