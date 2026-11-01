import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { MspError, Session, readSessionDurability, type ApprovalFailure, type ExitClassification } from "@muse-code/sdk";
import { appendAudit, type AuditActor, type AuditEvent } from "./audit.ts";
import { buildUserInputAnswers, type QuestionView } from "./answers.ts";
import { BrokerError, PendingBroker, type PendingItem, type PendingKind } from "./broker.ts";
import { approvalWire, type ApprovalModeName, type MuseMcpConfig, type ReasoningEffortName } from "./config.ts";
import { MuseHost, postureKey, type HostFrame, type HostPosture } from "./host.ts";
import type { ApprovalSubjectView } from "./policy.ts";
import { credentialMethod } from "./raw.ts";
import { SessionStore, type SessionRecord } from "./state.ts";
import { Coalescer, translateFrame, type StreamSink } from "./stream.ts";

export interface SpawnInput {
  workspace: string;
  prompt?: string;
  prompt_file?: string;
  model?: string;
  reasoning_effort?: ReasoningEffortName;
  preset?: string;
  worktree?: "off" | "create" | "existing";
  worktree_base?: string;
  worktree_path?: string;
  approval_mode?: ApprovalModeName;
  contributor_mode?: boolean;
  wait?: boolean;
}

export interface TurnInput {
  session_id: string;
  prompt?: string;
  prompt_file?: string;
  reasoning_effort?: ReasoningEffortName;
  wait?: boolean;
}

export interface CallResult {
  session_id: string;
  turn_id?: string;
  status: string;
}

export interface StatusResult {
  session_id: string;
  status: string;
  turn_id?: string;
  model?: string;
  workspace: string;
  worktree?: string;
  worktree_path?: string;
  approval_mode: ApprovalModeName;
  contributor_mode: boolean;
  preset?: string;
  token_usage?: unknown;
  pending_approvals: number;
  pending_user_inputs: number;
  fingerprint_warning?: string;
  /** Stream delta events whose send failed, cumulative for this live session. */
  stream_dropped_deltas?: number;
}

export interface ResultView {
  session_id: string;
  status: string;
  turn_id?: string;
  terminal?: string;
  answer: string;
  events: { method: string; at: string }[];
}

interface Live {
  record: SessionRecord;
  host: MuseHost;
  sdk: Session;
  events: { method: string; at: string }[];
  settled: Set<string>;
  answer: string;
  lastTerminal?: string;
  /** In-flight `approval/decide` sends, keyed by approval id. */
  decideSends: Map<string, Promise<unknown>>;
  /** Stream delta sends that failed in the current turn. */
  streamDroppedTurn: number;
  /** Stream delta sends that failed across this live session. */
  streamDroppedTotal: number;
  /** Whether a stream failure was already audited for the current turn. */
  streamErrorAudited: boolean;
  /** Pending hints already emitted this turn, as `requestId:kind:phase`. */
  pendingHints: Set<string>;
  /** In-flight delta sends, tracked so turn-completed can stamp after they settle. */
  pendingDeltaSends: Set<Promise<void>>;
}

type ApprovalWire = ApprovalSubjectView & { sessionId: string; currentRequirementId?: unknown };

export class MuseService {
  private readonly store: SessionStore;
  private readonly broker: PendingBroker;
  private readonly hosts = new Map<string, MuseHost>();
  private readonly starting = new Map<string, Promise<MuseHost>>();
  private readonly live = new Map<string, Live>();
  private readonly held = new Map<string, HostFrame[]>();
  private readonly seenApprovals = new Set<string>();
  private opening = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly coalescer: Coalescer;
  private readonly streamTimer: ReturnType<typeof setInterval>;
  private streamSink?: StreamSink;
  private readonly options: {
    home: string;
    config: MuseMcpConfig;
    bin: string;
    env?: NodeJS.ProcessEnv;
    shutdownTimeoutMs?: number;
  };
  private elicitor?: (item: PendingItem) => void;

  constructor(options: {
    home: string;
    config: MuseMcpConfig;
    bin: string;
    env?: NodeJS.ProcessEnv;
    shutdownTimeoutMs?: number;
  }) {
    this.options = options;
    this.store = new SessionStore(options.home);
    this.store.load();
    this.broker = new PendingBroker({
      rules: options.config.autoApprove,
      timeoutSec: options.config.pendingTimeoutSec,
      audit: (event) => this.audit(event),
    });
    this.timer = setInterval(() => this.expire(), 1000);
    this.timer.unref?.();
    this.coalescer = new Coalescer({ sink: (event) => this.sendStream(event) });
    this.streamTimer = setInterval(() => this.coalescer.tick(), 10);
    this.streamTimer.unref?.();
  }

  setElicitor(elicitor: (item: PendingItem) => void): void {
    this.elicitor = elicitor;
  }

  /** Receive stream events (plans/streaming/plan.md). One sink; the server edge owns it. */
  setStreamSink(sink: StreamSink): void {
    this.streamSink = sink;
  }

  async pending(): Promise<Array<PendingItem & { ageSec: number }>> {
    await this.resumeDormant();
    return this.broker.list();
  }

  async spawn(input: SpawnInput): Promise<CallResult> {
    const workspace = requireWorkspace(input.workspace);
    const approvalMode = input.approval_mode ?? this.options.config.approvalMode;
    const model = input.model ?? this.options.config.model;
    const effort = input.reasoning_effort ?? this.options.config.reasoningEffort;
    const posture: HostPosture = {
      workspace,
      contributorMode: input.contributor_mode ?? false,
      preset: input.preset,
      trustWorkspace: true,
    };
    const wire = approvalWire(approvalMode);
    const host = await this.hostFor(posture);
    this.opening += 1;
    try {
      const params: Record<string, unknown> = {
        workspaceRoot: workspace,
        approvalMode: wire.approvalMode,
        permissionProfile: wire.permissionProfile,
      };
      if (model) params.modelId = model;
      const worktree = worktreeParam(input);
      if (worktree) params.worktree = worktree;
      const raw = await host.connection.command("session/start", params);
      const now = new Date().toISOString();
      const record: SessionRecord = {
        sessionId: sessionIdOf(raw),
        workspace,
        model,
        reasoningEffort: effort,
        approvalMode,
        hostKey: host.key,
        status: "idle",
        contributorMode: posture.contributorMode,
        preset: input.preset,
        worktree: input.worktree ?? "off",
        worktreePath: input.worktree_path,
        fingerprintWarning: host.fingerprintWarning,
        createdAt: now,
        updatedAt: now,
      };
      this.store.upsert(record);
      const live = this.bind(record, host);
      this.flush(record.sessionId);
      if (effort) {
        await host.connection.command("session/setReasoningEffort", {
          sessionId: record.sessionId,
          reasoningEffort: effort,
        });
      }
      const prompt = readPrompt(input.prompt, input.prompt_file);
      if (!prompt) return { session_id: record.sessionId, status: "idle" };
      return this.submit(live, prompt, effort, input.wait === true);
    } finally {
      this.releaseOpening();
    }
  }

  async turn(input: TurnInput): Promise<CallResult> {
    const live = await this.ensure(input.session_id);
    const prompt = readPrompt(input.prompt, input.prompt_file);
    if (!prompt) throw new Error("turn requires prompt or prompt_file");
    const effort = input.reasoning_effort ?? live.record.reasoningEffort;
    return this.submit(live, prompt, effort, input.wait === true);
  }

  async steer(sessionId: string, prompt: string, turnId: string): Promise<Record<string, unknown>> {
    const live = await this.ensure(sessionId);
    const active = live.sdk.fold.activeTurnId;
    if (!active) throw new Error(`session ${sessionId} is idle; turn/steer needs the running turn`);
    if (turnId !== active) throw new Error(`session ${sessionId} is running turn ${active}, not ${turnId}`);
    return live.host.connection.command("turn/steer", {
      sessionId,
      expectedTurnId: active,
      input: [{ type: "text", text: prompt }],
    });
  }

  async decide(requestId: string, decision: "approve" | "deny", actor: AuditActor, reason?: string) {
    await this.ensureRequest(requestId, "approval");
    const preview = this.broker.get(requestId);
    if (!preview || preview.kind !== "approval") throw new BrokerError(`no pending approval ${requestId}`);
    const live = await this.ensure(preview.sessionId);
    const result = this.broker.decide(requestId, decision, actor, reason);
    const send = live.decideSends.get(requestId);
    if (!send) throw new Error(`approval ${requestId} was not submitted to the host`);
    try {
      await send;
    } catch (error) {
      this.broker.restoreDecision(requestId);
      throw error;
    }
    this.broker.commitDecision(requestId);
    return result;
  }

  async answer(requestId: string, actor: AuditActor, answer: unknown): Promise<unknown> {
    await this.ensureRequest(requestId, "userInput");
    const item = this.broker.get(requestId);
    if (!item || item.kind !== "userInput") throw new BrokerError(`no pending user-input ${requestId}`);
    const live = await this.ensure(item.sessionId);
    const answers = buildUserInputAnswers(questionsOf(item.payload), answer);
    const result = await live.sdk.answerUserInput(requestId, answers);
    this.broker.commitAnswer(requestId, actor, answer);
    return result;
  }

  status(sessionId?: string): StatusResult[] {
    const records = sessionId === undefined ? this.store.list() : [this.requireRecord(sessionId)];
    return records.map((record) => this.statusOf(record));
  }

  result(sessionId: string): ResultView {
    const record = this.requireRecord(sessionId);
    const live = this.live.get(sessionId);
    return {
      session_id: sessionId,
      status: record.status,
      turn_id: record.turnId,
      terminal: live?.lastTerminal ?? record.lastTerminal,
      answer: live?.answer || record.lastAnswer || "",
      events: live?.events ?? [],
    };
  }

  async cancel(sessionId: string, turnId?: string): Promise<Record<string, unknown>> {
    const live = await this.ensure(sessionId);
    return live.host.connection.command("turn/cancel", {
      sessionId,
      ...(turnId ? { turnId } : {}),
    });
  }

  async close(sessionId: string): Promise<Record<string, unknown>> {
    const live = await this.ensure(sessionId);
    const result = await live.host.connection.command("session/leave", { sessionId, stop: true });
    live.record.status = "closed";
    live.record.updatedAt = new Date().toISOString();
    this.store.upsert(live.record);
    this.live.delete(sessionId);
    this.broker.dropSession(sessionId);
    return result;
  }

  async raw(sessionId: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (credentialMethod(method)) {
      this.audit({ kind: "refuse", sessionId, detail: { method } });
      throw new Error(`refused credential method ${method}`);
    }
    const live = await this.ensure(sessionId);
    return live.host.connection.request(method, params);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    clearInterval(this.streamTimer);
    this.coalescer.flushAll();
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    await Promise.all(hosts.map((host) => host.close().catch(() => undefined)));
  }

  private async submit(live: Live, prompt: string, effort: ReasoningEffortName | undefined, wait: boolean): Promise<CallResult> {
    const turn = await live.sdk.sendUserTurn({
      input: [{ type: "text", text: prompt }],
      ...(effort ? { reasoningEffort: effort } : {}),
    });
    live.record.turnId = turn.turnId;
    live.record.status = live.settled.has(turn.turnId) ? "idle" : "running";
    live.record.updatedAt = new Date().toISOString();
    this.store.upsert(live.record);
    if (!wait) return { session_id: live.record.sessionId, turn_id: turn.turnId, status: live.record.status };
    const outcome = await turn.completed;
    const status = outcome.kind === "completed" ? outcome.params.terminal : outcome.kind;
    return { session_id: live.record.sessionId, turn_id: turn.turnId, status };
  }

  private async ensure(sessionId: string): Promise<Live> {
    const record = this.requireRecord(sessionId);
    if (record.status === "closed") throw new Error(`session ${sessionId} is closed`);
    const existing = this.live.get(sessionId);
    if (existing && !existing.host.isDead) return existing;
    const host = await this.hostFor({
      workspace: record.workspace,
      contributorMode: record.contributorMode,
      preset: record.preset,
      trustWorkspace: true,
    });
    this.opening += 1;
    try {
      const raw = await host.connection.command("session/resume", {
        sessionId,
        permissionProfile: approvalWire(record.approvalMode).permissionProfile,
        ...(record.model ? { modelId: record.model } : {}),
      });
      const resumed = sessionIdOf(raw);
      if (resumed !== sessionId) throw new Error(`session/resume returned ${resumed} for ${sessionId}`);
      const live = this.bind(record, host);
      this.flush(sessionId);
      record.status = live.sdk.fold.activeTurnId ? "running" : "idle";
      record.fingerprintWarning = host.fingerprintWarning ?? record.fingerprintWarning;
      record.updatedAt = new Date().toISOString();
      this.store.upsert(record);
      await this.rebind(live);
      if (record.reasoningEffort) {
        await host.connection.command("session/setReasoningEffort", {
          sessionId,
          reasoningEffort: record.reasoningEffort,
        });
      }
      return live;
    } catch (error) {
      if (error instanceof MspError && error.kind === "sessionInUse") {
        throw new Error(
          `session ${sessionId} is in use by another client (sessionInUse: ${error.message}). Muse MCP will not attach to it.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      this.releaseOpening();
    }
  }

  private bind(record: SessionRecord, host: MuseHost): Live {
    const sdk = new Session({
      sessionId: record.sessionId,
      durability: readSessionDurability(host.initializeResult),
      connection: host.connection,
    });
    const live: Live = {
      record,
      host,
      sdk,
      events: [],
      settled: new Set(),
      answer: record.lastAnswer ?? "",
      decideSends: new Map(),
      streamDroppedTurn: 0,
      streamDroppedTotal: record.streamDroppedDeltas ?? 0,
      streamErrorAudited: false,
      pendingHints: new Set(),
      pendingDeltaSends: new Set(),
    };
    sdk.onApproval((request) => {
      const stage = stageKey(request.sessionId, request.approvalId, request.currentRequirementId.sourceIndex);
      if (this.seenApprovals.has(stage)) return new Promise(() => {});
      this.seenApprovals.add(stage);
      const queued = this.broker.registerApproval(request, (decision) => {
        this.trackSend(live, request, decision);
      });
      if (queued) this.maybeElicit(queued);
      // The SDK sends `approval/decide` only after this promise settles.
      // Settling it would send a second decide. This server sends the one frame itself.
      return new Promise(() => {});
    });
    sdk.onApprovalError((failure) => {
      this.audit(approvalFailureEvent(record.sessionId, failure));
    });
    this.live.set(record.sessionId, live);
    return live;
  }

  private async rebind(live: Live): Promise<void> {
    const raw = await live.host.connection.command("approval/listPending", { sessionId: live.record.sessionId });
    const approvals = Array.isArray(raw.approvals) ? raw.approvals : [];
    for (const entry of approvals) {
      if (!isRecord(entry) || typeof entry.approvalId !== "string") continue;
      const sourceIndex = requirementIndex(entry.currentRequirementId);
      const stage = stageKey(String(entry.sessionId ?? live.record.sessionId), entry.approvalId, sourceIndex);
      if (this.seenApprovals.has(stage) || this.broker.get(entry.approvalId)) continue;
      this.seenApprovals.add(stage);
      const queued = this.broker.registerApproval(entry as unknown as ApprovalWire, (decision) => {
        this.trackSend(live, entry as unknown as ApprovalWire, decision);
      });
      if (queued) this.maybeElicit(queued);
    }
    const inputs = Array.isArray(raw.userInputs) ? raw.userInputs : [];
    for (const entry of inputs) {
      if (!isRecord(entry) || typeof entry.userInputId !== "string") continue;
      if (this.broker.get(entry.userInputId)) continue;
      const item = this.broker.registerUserInput(entry.userInputId, String(entry.sessionId ?? live.record.sessionId), entry);
      this.maybeElicit(item);
    }
  }

  private hostFor(posture: HostPosture): Promise<MuseHost> {
    const key = postureKey(posture);
    const existing = this.hosts.get(key);
    if (existing && !existing.isDead) return Promise.resolve(existing);
    const pending = this.starting.get(key);
    if (pending) return pending;
    const created = MuseHost.start({
      bin: this.options.bin,
      posture,
      env: { ...process.env, ...this.options.env },
      ...(this.options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: this.options.shutdownTimeoutMs }),
      onFrame: (frame) => {
        try {
          this.route(frame);
        } catch {
          // A bad frame must not kill the host pump.
        }
      },
      onExit: (host, exit) => this.hostDied(host, exit),
    }).then((host) => {
      this.hosts.set(key, host);
      return host;
    });
    this.starting.set(key, created);
    void created.finally(() => {
      if (this.starting.get(key) === created) this.starting.delete(key);
    });
    return created;
  }

  private hostDied(host: MuseHost, exit: ExitClassification): void {
    if (this.hosts.get(host.key) === host) this.hosts.delete(host.key);
    for (const [sessionId, live] of this.live) {
      if (live.host !== host) continue;
      live.sdk.hostExited(exit);
      // Flush buffered deltas while the session is still in the live map,
      // so a failed send here is counted and audited like any other.
      this.coalescer.flushSession(sessionId);
      this.broker.dropSession(sessionId);
      for (const stage of this.seenApprovals) {
        if (stage.startsWith(`${sessionId}:`)) this.seenApprovals.delete(stage);
      }
      if (live.record.status !== "closed") {
        live.record.status = "orphaned";
        live.record.updatedAt = new Date().toISOString();
        this.store.upsert(live.record);
      }
      this.live.delete(sessionId);
    }
  }

  private route(frame: HostFrame): void {
    const params = isRecord(frame.params) ? frame.params : undefined;
    const sessionId = params && typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!sessionId) return;
    const live = this.live.get(sessionId);
    if (live && !live.host.isDead) {
      this.deliver(live, frame);
      return;
    }
    if (this.opening > 0) {
      const list = this.held.get(sessionId) ?? [];
      list.push(frame);
      this.held.set(sessionId, list);
    }
  }

  private deliver(live: Live, frame: HostFrame): void {
    live.sdk.apply({ method: frame.method, params: frame.params });
    this.pushEvent(live, frame.method);
    const params = isRecord(frame.params) ? frame.params : {};
    if (frame.method === "userInput/requested" && typeof params.userInputId === "string" && !this.broker.get(params.userInputId)) {
      const item = this.broker.registerUserInput(
        params.userInputId,
        String(params.sessionId ?? live.record.sessionId),
        params,
      );
      this.maybeElicit(item);
    }
    if (frame.method === "turn/started" && typeof params.turnId === "string") {
      live.record.turnId = params.turnId;
      live.record.status = "running";
      live.record.updatedAt = new Date().toISOString();
      this.store.upsert(live.record);
    }
    if (frame.method === "turn/completed" && typeof params.turnId === "string") {
      live.settled.add(params.turnId);
      live.lastTerminal = typeof params.terminal === "string" ? params.terminal : "completed";
      live.answer = agentText(live.sdk);
      live.record.turnId = params.turnId;
      live.record.status = "idle";
      live.record.lastAnswer = live.answer;
      live.record.lastTerminal = live.lastTerminal;
      live.record.updatedAt = new Date().toISOString();
      this.store.upsert(live.record);
    }
    this.emitStream(live, frame);
  }

  /** Tap the ordered frame flow for stream clients. Runs after all bookkeeping. */
  private emitStream(live: Live, frame: HostFrame): void {
    if (!this.streamSink) return;
    const event = translateFrame(frame);
    if (!event) return;
    if (event.type === "turn-started") {
      live.streamDroppedTurn = 0;
      live.streamErrorAudited = false;
      live.pendingHints.clear();
    }
    if (event.type === "turn-completed") {
      event.answer = live.answer;
      // droppedDeltas is stamped later, in sendStream: the coalescer
      // flushes this session's buffered deltas on the way to this event,
      // and failures in that flush must land in the count first.
    }
    if (event.type === "pending") {
      // The host can surface one request twice (the view frame and the
      // synthesized request frame). One hint per request per turn.
      const key = `${event.requestId ?? ""}:${event.kind ?? ""}:${event.phase ?? ""}`;
      if (live.pendingHints.has(key)) return;
      live.pendingHints.add(key);
    }
    this.coalescer.push(event);
  }

  /** Send one stream event. A failing client never blocks or breaks the host pump. */
  private sendStream(event: Parameters<StreamSink>[0]): void {
    const sink = this.streamSink;
    if (!sink) return;
    if (event.type !== "turn-completed") {
      this.sendNow(sink, event);
      return;
    }
    // Stamp droppedDeltas at send time, after the coalescer's final flush
    // for the session, and after that flush's sends settle: several frames
    // can arrive in one synchronous chunk, so a rejected delta send may not
    // have run its failure handler yet when this event is reached. The wait
    // is capped; sends that outlive it settle into the cumulative count in
    // muse_status instead. If this send itself fails, the count goes with it.
    const live = this.live.get(event.sessionId);
    const pending = live ? [...live.pendingDeltaSends] : [];
    if (!live || pending.length === 0) {
      if (live) event.droppedDeltas = live.streamDroppedTurn;
      this.sendNow(sink, event);
      return;
    }
    void Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]).then(() => {
      event.droppedDeltas = live.streamDroppedTurn;
      this.sendNow(sink, event);
    });
  }

  private sendNow(sink: StreamSink, event: Parameters<StreamSink>[0]): void {
    try {
      const result: unknown = sink(event);
      if (!isThenable(result)) return;
      // Promise.resolve also tames non-native thenables, which an
      // instanceof check would leave without a rejection handler.
      const tracked = Promise.resolve(result).then(
        () => undefined,
        (error: unknown) => this.streamFailed(event, error),
      );
      if (event.type === "item-delta") {
        const live = this.live.get(event.sessionId);
        if (live) {
          live.pendingDeltaSends.add(tracked);
          void tracked.then(() => live.pendingDeltaSends.delete(tracked));
        }
      }
    } catch (error) {
      this.streamFailed(event, error);
    }
  }

  private streamFailed(event: Parameters<StreamSink>[0], error: unknown): void {
    const live = this.live.get(event.sessionId);
    if (!live) return;
    if (event.type === "item-delta") {
      live.streamDroppedTurn += 1;
      live.streamDroppedTotal += 1;
      // Persist the cumulative count so muse_status keeps it after the
      // session leaves the live map (host death, restart).
      live.record.streamDroppedDeltas = live.streamDroppedTotal;
      this.store.upsert(live.record);
    }
    if (live.streamErrorAudited) return;
    live.streamErrorAudited = true;
    this.audit({
      kind: "error",
      sessionId: event.sessionId,
      detail: { source: "stream", error: error instanceof Error ? error.message : String(error) },
    });
  }

  private flush(sessionId: string): void {
    const frames = this.held.get(sessionId);
    this.held.delete(sessionId);
    const live = this.live.get(sessionId);
    if (!frames || !live) return;
    for (const frame of frames) this.deliver(live, frame);
  }

  private releaseOpening(): void {
    this.opening -= 1;
    if (this.opening > 0) return;
    for (const id of [...this.held.keys()]) {
      if (!this.live.has(id)) this.held.delete(id);
    }
  }

  private trackSend(live: Live, request: ApprovalWire, decision: { choiceId: string; feedback?: string }): void {
    const promise = live.host.connection.command("approval/decide", {
      sessionId: live.record.sessionId,
      approvalId: request.approvalId,
      requirementId: request.currentRequirementId,
      choiceId: decision.choiceId,
      ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }),
    });
    live.decideSends.set(request.approvalId, promise);
  }

  /** Resume sessions whose host is gone so `approval/listPending` can refill the broker. */
  private async resumeDormant(): Promise<void> {
    for (const record of this.store.list()) {
      if (record.status === "closed") continue;
      const existing = this.live.get(record.sessionId);
      if (existing && !existing.host.isDead) continue;
      try {
        await this.ensure(record.sessionId);
      } catch (error) {
        if (error instanceof Error && error.message.includes("sessionInUse")) continue;
        throw error;
      }
    }
  }

  private async ensureRequest(requestId: string, kind: PendingKind): Promise<void> {
    const current = this.broker.get(requestId);
    if (current?.kind === kind) return;
    for (const record of this.store.list()) {
      if (record.status === "closed") continue;
      const existing = this.live.get(record.sessionId);
      if (existing && !existing.host.isDead) continue;
      await this.ensure(record.sessionId);
      const found = this.broker.get(requestId);
      if (found?.kind === kind) return;
    }
  }

  private expire(): void {
    let actions;
    try {
      actions = this.broker.sweep();
    } catch {
      return;
    }
    for (const action of actions) {
      if (action.approval) {
        const live = this.live.get(action.item.sessionId);
        const send = live?.decideSends.get(action.item.requestId);
        if (send) void send.catch(() => undefined);
      }
      if (!action.question) continue;
      const live = this.live.get(action.item.sessionId);
      if (!live || live.host.isDead) continue;
      void live.host.connection
        .command("userInput/cancel", {
          sessionId: action.item.sessionId,
          userInputId: action.item.requestId,
          reason: "pending timeout",
        })
        .catch(() => undefined);
    }
  }

  private statusOf(record: SessionRecord): StatusResult {
    const live = this.live.get(record.sessionId);
    const pending = this.broker.list().filter((item) => item.sessionId === record.sessionId);
    const usage = live ? live.sdk.fold.sessionState.get("session/tokenUsage") : undefined;
    return {
      session_id: record.sessionId,
      status: record.status,
      turn_id: live?.sdk.fold.activeTurnId ?? record.turnId,
      model: record.model,
      workspace: record.workspace,
      worktree: record.worktree,
      worktree_path: record.worktreePath,
      approval_mode: record.approvalMode,
      contributor_mode: record.contributorMode,
      preset: record.preset,
      token_usage: usage,
      pending_approvals: pending.filter((item) => item.kind === "approval").length,
      pending_user_inputs: pending.filter((item) => item.kind === "userInput").length,
      fingerprint_warning: live?.host.fingerprintWarning ?? record.fingerprintWarning,
      stream_dropped_deltas: live?.streamDroppedTotal ?? record.streamDroppedDeltas ?? 0,
    };
  }

  private requireRecord(sessionId: string): SessionRecord {
    const record = this.store.get(sessionId);
    if (!record) throw new Error(`unknown session ${sessionId}`);
    return record;
  }

  private pushEvent(live: Live, method: string): void {
    live.events.push({ method, at: new Date().toISOString() });
    if (live.events.length > 20) live.events.shift();
  }

  private maybeElicit(item: PendingItem): void {
    this.elicitor?.(item);
  }

  private audit(event: AuditEvent): void {
    appendAudit(this.options.home, event);
  }
}

/** An SDK approval round trip that did not complete, as an audit event. */
export function approvalFailureEvent(sessionId: string, failure: ApprovalFailure): AuditEvent {
  return {
    kind: "error",
    sessionId,
    requestId: failure.approvalId,
    detail: {
      source: "approval",
      failure: failure.kind,
      ...("error" in failure
        ? { error: failure.error instanceof Error ? failure.error.message : String(failure.error) }
        : {}),
    },
  };
}

export function asActor(actor: string | undefined): AuditActor {
  if (actor === undefined || actor === "orchestrator") return "orchestrator";
  if (actor === "user") return "user";
  throw new Error("actor must be user or orchestrator");
}

function requireWorkspace(workspace: string): string {
  if (!path.isAbsolute(workspace)) throw new Error("workspace must be an absolute path");
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`workspace does not exist: ${workspace}`);
  }
  return workspace;
}

function readPrompt(prompt?: string, promptFile?: string): string | undefined {
  if (prompt !== undefined && promptFile !== undefined) throw new Error("pass prompt or prompt_file, not both");
  if (promptFile !== undefined) {
    if (!path.isAbsolute(promptFile)) throw new Error("prompt_file must be an absolute path");
    return readFileSync(promptFile, "utf8");
  }
  return prompt;
}

function worktreeParam(input: SpawnInput): Record<string, unknown> | undefined {
  const mode = input.worktree ?? "off";
  if (mode === "off") return undefined;
  if (mode === "create") return input.worktree_base ? { mode: "create", baseRef: input.worktree_base } : { mode: "create" };
  if (!input.worktree_path) throw new Error("worktree existing requires worktree_path");
  return { mode: "existing", path: input.worktree_path };
}

function sessionIdOf(raw: Record<string, unknown>): string {
  const session = raw.session;
  if (!isRecord(session) || typeof session.sessionId !== "string") throw new Error("MSP result has no session.sessionId");
  return session.sessionId;
}

function stageKey(sessionId: string, approvalId: string, sourceIndex: number): string {
  return `${sessionId}:${approvalId}:${sourceIndex}`;
}

function requirementIndex(value: unknown): number {
  if (!isRecord(value) || typeof value.sourceIndex !== "number") return 0;
  return value.sourceIndex;
}

function questionsOf(payload: unknown): QuestionView[] {
  if (!isRecord(payload) || !Array.isArray(payload.questions)) return [];
  return payload.questions.flatMap((question) => {
    if (!isRecord(question) || typeof question.id !== "string") return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => (isRecord(option) && typeof option.label === "string" ? [{ label: option.label }] : []))
      : [];
    const selection = isRecord(question.selection) && typeof question.selection.mode === "string" ? { mode: question.selection.mode } : undefined;
    return [{ id: question.id, options, selection }];
  });
}

function agentText(sdk: Session): string {
  let text = "";
  for (const item of sdk.fold.items.list()) {
    if (item.kind !== "agentMessage" || typeof item.text !== "string") continue;
    if (item.messagePhase === "finalAnswer" || item.messagePhase === undefined) text = item.text;
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
