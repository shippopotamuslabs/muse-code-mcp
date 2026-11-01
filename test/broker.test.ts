import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "../src/audit.ts";
import { PendingBroker } from "../src/broker.ts";
import { selectChoice, type ApprovalSubjectView } from "../src/policy.ts";

const NETWORK_CHOICES = [
  { choiceId: "allow_once", decision: "approved", scope: "once", label: "Allow once", acceptsFeedback: false },
  { choiceId: "allow_session", decision: "approvedForSession", scope: "session", label: "Allow for this session" },
  { choiceId: "allow_local_network", decision: "approvedPolicyAmendment", scope: "localPersistent", label: "Always allow" },
  { choiceId: "abort", decision: "abort", scope: "once", label: "Reject", acceptsFeedback: true },
];

function networkPayload(host = "example.com"): ApprovalSubjectView & { sessionId: string } {
  return {
    approvalId: "ap-1",
    sessionId: "sess-1",
    toolName: "network",
    subject: { kind: "network", host },
    availableChoices: NETWORK_CHOICES,
  };
}

function broker(options: { rules?: { match: string; decision: "approve" }[]; timeoutSec?: number; now?: () => number } = {}) {
  const events: AuditEvent[] = [];
  let clock = 1_000;
  const pending = new PendingBroker({
    rules: options.rules ?? [],
    timeoutSec: options.timeoutSec ?? 1800,
    now: options.now ?? (() => clock),
    audit: (event) => events.push(event),
  });
  return {
    pending,
    events,
    advance(ms: number) {
      clock += ms;
    },
  };
}

test("a matching rule approves immediately and audits policy", () => {
  const { pending, events } = broker({ rules: [{ match: "network example.com", decision: "approve" }] });
  let decided: { choiceId: string } | undefined;
  const queued = pending.registerApproval(networkPayload(), (decision) => {
    decided = decision;
  });
  assert.equal(queued, undefined);
  assert.equal(decided?.choiceId, "allow_once");
  assert.equal(events.some((event) => event.kind === "decision" && event.actor === "policy"), true);
  assert.equal(pending.list().length, 0);
});

test("an unmatched approval stays pending with its payload", () => {
  const { pending } = broker();
  pending.registerApproval(networkPayload(), () => {});
  const [item] = pending.list();
  assert.equal(item?.requestId, "ap-1");
  assert.equal(item?.kind, "approval");
  const payload = item?.payload as ApprovalSubjectView;
  assert.equal(payload.toolName, "network");
  assert.equal(payload.subject?.host, "example.com");
  assert.equal(typeof item?.ageSec, "number");
});

test("approve selects the once choice, not a persistent allow", () => {
  const selected = selectChoice(NETWORK_CHOICES, "approve");
  assert.equal(selected.ok && selected.choiceId, "allow_once");
});

test("deny uses abort and passes feedback when the choice accepts it", () => {
  const { pending, events } = broker();
  let decided: { choiceId: string; feedback?: string } | undefined;
  pending.registerApproval(networkPayload(), (decision) => {
    decided = decision;
  });
  pending.decide("ap-1", "deny", "user", "no");
  assert.deepEqual(decided, { choiceId: "abort", feedback: "no" });
  assert.equal(events.at(-1)?.actor, "user");
});

test("an expiring approval with no deny choice is dropped and the drop is audited", () => {
  const { pending, events, advance } = broker({ timeoutSec: 10 });
  let decided: { choiceId: string } | undefined;
  pending.registerApproval(
    {
      approvalId: "ap-2",
      sessionId: "sess-1",
      toolName: "network",
      subject: { kind: "network", host: "example.com" },
      availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once", label: "Allow once" }],
    },
    (decision) => {
      decided = decision;
    },
  );
  advance(10_000);
  const actions = pending.sweep();
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.approval, undefined);
  assert.equal(actions[0]?.question, undefined);
  assert.equal(decided, undefined);
  assert.equal(pending.list().length, 0);
  const expiry = events.find((event) => event.kind === "expiry");
  assert.equal((expiry?.detail as { resolution?: string })?.resolution, "dropped");
});

test("an old approval expires to deny and an old question expires to cancel", () => {
  const { pending, events, advance } = broker({ timeoutSec: 10 });
  let denied: { choiceId: string; feedback?: string } | undefined;
  pending.registerApproval(networkPayload(), (decision) => {
    denied = decision;
  });
  pending.registerUserInput("ui-1", "sess-1", { questions: [] });
  advance(10_000);
  const actions = pending.sweep();
  assert.equal(actions.length, 2);
  assert.equal(denied?.choiceId, "abort");
  assert.equal(denied?.feedback, "pending timeout");
  assert.equal(actions.some((action) => action.question === true), true);
  assert.equal(events.filter((event) => event.kind === "expiry").length, 2);
  assert.equal(pending.list().length, 0);
});
