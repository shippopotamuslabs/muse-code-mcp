import assert from "node:assert/strict";
import test from "node:test";
import { Coalescer, translateFrame, type StreamEvent } from "../src/stream.ts";

test("turn and item frames translate to stream events", () => {
  const started = translateFrame({ method: "turn/started", params: { sessionId: "s1", turnId: "t1", viewCursor: "c1" } });
  assert.deepEqual(started, { type: "turn-started", sessionId: "s1", viewCursor: "c1", turnId: "t1" });

  const item = { itemId: "i1", kind: "agentMessage", text: "hi" };
  const itemStarted = translateFrame({ method: "item/started", params: { sessionId: "s1", viewCursor: "c2", item } });
  assert.equal(itemStarted?.type, "item-started");
  assert.deepEqual(itemStarted?.item, item);

  const delta = translateFrame({ method: "item/delta", params: { sessionId: "s1", viewCursor: "c3", itemId: "i1", delta: "he" } });
  assert.deepEqual(delta, { type: "item-delta", sessionId: "s1", viewCursor: "c3", itemId: "i1", field: "text", delta: "he" });

  const fieldDelta = translateFrame({
    method: "item/delta",
    params: { sessionId: "s1", itemId: "i1", field: "summary.0", delta: "x" },
  });
  assert.equal(fieldDelta?.field, "summary.0");

  const completed = translateFrame({
    method: "turn/completed",
    params: { sessionId: "s1", turnId: "t1", terminal: "completed", viewCursor: "c9" },
  });
  assert.deepEqual(completed, { type: "turn-completed", sessionId: "s1", viewCursor: "c9", turnId: "t1", terminal: "completed" });
});

test("usage frames carry the raw params and say which frame they were", () => {
  const params = { sessionId: "s1", viewCursor: "c4", cumulative: { total: 42 }, modelId: "muse-spark" };
  const event = translateFrame({ method: "session/tokenUsage", params });
  assert.equal(event?.type, "usage");
  assert.equal(event?.usageKind, "tokenUsage");
  assert.deepEqual(event?.usage, params);
  const changed = translateFrame({ method: "usage/changed", params });
  assert.equal(changed?.type, "usage");
  assert.equal(changed?.usageKind, "changed");
});

test("approval and user-input frames become pending hints", () => {
  assert.deepEqual(
    translateFrame({ method: "approval/requested", params: { sessionId: "s1", approvalId: "a1" } }),
    { type: "pending", sessionId: "s1", requestId: "a1", kind: "approval", phase: "requested" },
  );
  // The synthesized request frame maps to the same hint; the service dedupes.
  assert.deepEqual(
    translateFrame({ method: "approval/request", params: { sessionId: "s1", approvalId: "a1" } }),
    { type: "pending", sessionId: "s1", requestId: "a1", kind: "approval", phase: "requested" },
  );
  assert.deepEqual(
    translateFrame({ method: "approval/resolved", params: { sessionId: "s1", approvalId: "a1" } }),
    { type: "pending", sessionId: "s1", requestId: "a1", kind: "approval", phase: "settled" },
  );
  assert.deepEqual(
    translateFrame({ method: "userInput/requested", params: { sessionId: "s1", userInputId: "u1" } }),
    { type: "pending", sessionId: "s1", requestId: "u1", kind: "userInput", phase: "requested" },
  );
  assert.deepEqual(
    translateFrame({ method: "userInput/settled", params: { sessionId: "s1", userInputId: "u1" } }),
    { type: "pending", sessionId: "s1", requestId: "u1", kind: "userInput", phase: "settled" },
  );
});

test("skill and plugin changed frames become catalog-changed events", () => {
  assert.deepEqual(translateFrame({ method: "skill/changed", params: { sessionId: "s1" } }), {
    type: "catalog-changed",
    sessionId: "s1",
    catalog: "skill",
  });
  assert.deepEqual(
    translateFrame({
      method: "plugin/changed",
      params: { sessionId: "s1", id: "acme", version: "1.2.0", source: "marketplace", enabled: true },
    }),
    { type: "catalog-changed", sessionId: "s1", catalog: "plugin" },
  );
});

test("session goalChanged frames become goal-changed events with the block verbatim", () => {
  const goal = {
    objective: "Ship the slice",
    percentComplete: 150,
    status: "in-progress",
    currentWork: "wiring the fold",
    nextWork: "docs",
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  assert.deepEqual(
    translateFrame({ method: "session/goalChanged", params: { sessionId: "s1", viewCursor: "c1", goal } }),
    { type: "goal-changed", sessionId: "s1", viewCursor: "c1", goal },
  );
  assert.deepEqual(translateFrame({ method: "session/goalChanged", params: { sessionId: "s1", goal: null } }), {
    type: "goal-changed",
    sessionId: "s1",
    goal: null,
  });
});

test("session todoListChanged frames become todos events carrying the whole snapshot", () => {
  const items = [
    { text: "wire the fold", status: "inProgress", activeForm: "wiring the fold" },
    { text: "write the docs", status: "pending" },
  ];
  assert.deepEqual(
    translateFrame({
      method: "session/todoListChanged",
      params: { sessionId: "s1", viewCursor: "c1", items, revision: 3, sourceTool: "write_todos" },
    }),
    { type: "todos", sessionId: "s1", viewCursor: "c1", items, revision: 3, sourceTool: "write_todos" },
  );
  // A replacement snapshot forwards wholesale, never merged with the last one.
  const replacement = [{ text: "write the docs", status: "completed" }];
  assert.deepEqual(
    translateFrame({
      method: "session/todoListChanged",
      params: { sessionId: "s1", viewCursor: "c2", items: replacement, revision: 4, sourceTool: "write_todos" },
    }),
    { type: "todos", sessionId: "s1", viewCursor: "c2", items: replacement, revision: 4, sourceTool: "write_todos" },
  );
  // An empty list is a cleared list: a real event, not a no-op.
  assert.deepEqual(
    translateFrame({
      method: "session/todoListChanged",
      params: { sessionId: "s1", viewCursor: "c3", items: [], revision: 5, sourceTool: "write_todos" },
    }),
    { type: "todos", sessionId: "s1", viewCursor: "c3", items: [], revision: 5, sourceTool: "write_todos" },
  );
  // A frame without an items array carries no snapshot and translates to nothing.
  assert.equal(translateFrame({ method: "session/todoListChanged", params: { sessionId: "s1", revision: 6 } }), undefined);
});

test("unmapped frames and frames without a session translate to nothing", () => {
  assert.equal(translateFrame({ method: "session/updated", params: { sessionId: "s1" } }), undefined);
  assert.equal(translateFrame({ method: "item/delta", params: { itemId: "i1", delta: "x" } }), undefined);
  assert.equal(translateFrame({ method: "item/delta", params: "nope" }), undefined);
  assert.equal(translateFrame({ method: "item/delta", params: { sessionId: "s1", delta: "x" } }), undefined);
});

function harness(flushMs = 30) {
  const sent: StreamEvent[] = [];
  let clock = 1_000;
  const coalescer = new Coalescer({ sink: (event) => sent.push(event), flushMs, now: () => clock });
  return {
    sent,
    coalescer,
    advance(ms: number) {
      clock += ms;
    },
  };
}

function delta(sessionId: string, itemId: string, text: string, viewCursor: string, field?: string): StreamEvent {
  return { type: "item-delta", sessionId, itemId, field: field ?? "text", delta: text, viewCursor };
}

test("deltas for one field merge and flush on the timer", () => {
  const { sent, coalescer, advance } = harness();
  coalescer.push(delta("s1", "i1", "he", "c1"));
  coalescer.push(delta("s1", "i1", "llo", "c2"));
  coalescer.tick();
  assert.equal(sent.length, 0);
  advance(30);
  coalescer.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.delta, "hello");
  assert.equal(sent[0]?.viewCursor, "c2");
});

test("different fields and different sessions buffer separately", () => {
  const { sent, coalescer, advance } = harness();
  coalescer.push(delta("s1", "i1", "a", "c1"));
  coalescer.push(delta("s1", "i1", "b", "c2", "summary.0"));
  coalescer.push(delta("s2", "i1", "c", "c3"));
  advance(30);
  coalescer.tick();
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((event) => event.delta), ["a", "b", "c"]);
});

test("a non-delta event flushes its session's deltas first", () => {
  const { sent, coalescer } = harness();
  coalescer.push(delta("s1", "i1", "partial", "c1"));
  coalescer.push(delta("s2", "i1", "other", "c2"));
  coalescer.push({ type: "turn-completed", sessionId: "s1", turnId: "t1", terminal: "completed", viewCursor: "c3" });
  assert.deepEqual(
    sent.map((event) => event.type),
    ["item-delta", "turn-completed"],
  );
  assert.equal(sent[0]?.delta, "partial");
  coalescer.flushAll();
  assert.equal(sent.length, 3);
  assert.equal(sent[2]?.delta, "other");
});
