import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureHome } from "../src/config.ts";
import { readAudit } from "../src/audit.ts";
import { approvalFailureEvent, MuseService } from "../src/sessions.ts";
import type { StreamEvent } from "../src/stream.ts";

const FAKE = join(import.meta.dirname, "fake-muse.mjs");

function harness(scenario: string, fingerprint?: string) {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-svc-"));
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-ws-"));
  const argvLog = join(home, "argv.log");
  const methodLog = join(home, "methods.log");
  const config = ensureHome(home, {});
  const env: NodeJS.ProcessEnv = {
    MUSE_FAKE_SCENARIO: scenario,
    MUSE_FAKE_ARGV_LOG: argvLog,
    MUSE_FAKE_METHOD_LOG: methodLog,
  };
  if (fingerprint) env.MUSE_FAKE_FINGERPRINT = fingerprint;
  const service = new MuseService({ home, config, bin: FAKE, env, shutdownTimeoutMs: 0 });
  return {
    home,
    workspace,
    service,
    env,
    argv() {
      return readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean);
    },
    methods() {
      return readFileSync(methodLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    },
  };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 3000) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("two sessions share one host, and contributor on starts a second", async () => {
  const { service, workspace, argv } = harness("ok");
  try {
    const first = await service.spawn({ workspace, prompt: "one", wait: true });
    const second = await service.spawn({ workspace, prompt: "two", wait: true });
    assert.equal(argv().length, 1);
    assert.notEqual(first.session_id, second.session_id);
    assert.equal(service.result(first.session_id).answer, "MSP OK");
    await service.spawn({ workspace, prompt: "three", contributor_mode: true, wait: true });
    const lines = argv();
    assert.equal(lines.length, 2);
    assert.equal(lines.some((line) => line.includes('"on"')), true);
    assert.equal(lines.some((line) => line.includes('"off"')), true);
  } finally {
    await service.shutdown();
  }
});

test("a crashed host orphans the session and the next use resumes once", async () => {
  const box = harness("crash-after-start");
  try {
    const spawned = await box.service.spawn({ workspace: box.workspace });
    await until(() => box.service.status(spawned.session_id)[0]?.status === "orphaned");
    box.env.MUSE_FAKE_SCENARIO = "ok";
    const follow = await box.service.turn({ session_id: spawned.session_id, prompt: "again", wait: true });
    assert.equal(follow.status, "completed");
    const resumes = box.methods().filter((entry) => entry.method === "session/resume");
    assert.equal(resumes.length, 1);
  } finally {
    await box.service.shutdown();
  }
});

test("sessionInUse is surfaced and not retried", async () => {
  const box = harness("crash-after-start");
  try {
    const spawned = await box.service.spawn({ workspace: box.workspace });
    await until(() => box.service.status(spawned.session_id)[0]?.status === "orphaned");
    box.env.MUSE_FAKE_SCENARIO = "in-use";
    const error = await box.service.turn({ session_id: spawned.session_id, prompt: "nope" }).catch((caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.match(error.message, /sessionInUse/);
    assert.equal((error.cause as { kind?: string } | undefined)?.kind, "sessionInUse");
    assert.equal(box.service.status(spawned.session_id)[0]?.status, "orphaned");
    const resumes = box.methods().filter((entry) => entry.method === "session/resume");
    assert.equal(resumes.length, 1);
  } finally {
    await box.service.shutdown();
  }
});

test("an approval failure becomes an error audit event", () => {
  const failed = approvalFailureEvent("sess-1", { kind: "submitFailed", approvalId: "ap-9", error: new Error("host gone") });
  assert.equal(failed.kind, "error");
  assert.equal(failed.sessionId, "sess-1");
  assert.equal(failed.requestId, "ap-9");
  assert.deepEqual(failed.detail, { source: "approval", failure: "submitFailed", error: "host gone" });
  const unoffered = approvalFailureEvent("sess-1", {
    kind: "unofferedChoice",
    approvalId: "ap-10",
    choiceId: "allow_always",
    availableChoiceIds: ["allow_once"],
  });
  assert.deepEqual(unoffered.detail, { source: "approval", failure: "unofferedChoice" });
});

test("a stream sink receives the turn in order and the deltas build the answer", async () => {
  const box = harness("stream");
  const events: StreamEvent[] = [];
  box.service.setStreamSink((event) => {
    events.push(event);
  });
  try {
    const spawned = await box.service.spawn({ workspace: box.workspace, prompt: "go", wait: true });
    assert.equal(spawned.status, "completed");
    assert.deepEqual(
      events.map((event) => event.type),
      ["turn-started", "item-started", "item-delta", "item-completed", "turn-completed"],
    );
    const delta = events.find((event) => event.type === "item-delta");
    assert.equal(delta?.delta, "MSP STREAM OK");
    assert.equal(delta?.delta, box.service.result(spawned.session_id).answer);
    const completed = events.find((event) => event.type === "turn-completed");
    assert.equal(completed?.answer, "MSP STREAM OK");
    assert.equal(completed?.droppedDeltas, 0);
    assert.equal(events[0]?.turnId, spawned.turn_id);
    assert.equal(completed?.turnId, spawned.turn_id);
    // turn-started carries no viewCursor on the real protocol; the rest strictly increase.
    const cursors = events.flatMap((event) => (event.viewCursor ? [Number(event.viewCursor.slice(1))] : []));
    assert.equal(cursors.length, 4);
    assert.equal(cursors.every((cursor, index) => index === 0 || cursor > (cursors[index - 1] ?? 0)), true);
  } finally {
    await box.service.shutdown();
  }
});

test("a failing stream sink never breaks the turn and the drops are counted", async () => {
  const box = harness("stream");
  box.service.setStreamSink(() => {
    throw new Error("client gone");
  });
  try {
    const spawned = await box.service.spawn({ workspace: box.workspace, prompt: "go", wait: true });
    assert.equal(spawned.status, "completed");
    assert.equal(box.service.result(spawned.session_id).answer, "MSP STREAM OK");
    assert.equal(box.service.status(spawned.session_id)[0]?.stream_dropped_deltas, 1);
    const errors = readAudit(box.home).filter(
      (event) => event.kind === "error" && (event.detail as { source?: string })?.source === "stream",
    );
    assert.equal(errors.length, 1);
    const stored = JSON.parse(readFileSync(join(box.home, "state.json"), "utf8")) as {
      sessions: Record<string, { streamDroppedDeltas?: number }>;
    };
    assert.equal(stored.sessions[spawned.session_id]?.streamDroppedDeltas, 1);
  } finally {
    await box.service.shutdown();
  }
});

test("delta-only send failures land in the turn-completed count, sync and async", async () => {
  for (const mode of ["throw", "reject"] as const) {
    const box = harness("stream");
    const received: StreamEvent[] = [];
    box.service.setStreamSink((event) => {
      if (event.type === "item-delta") {
        if (mode === "throw") throw new Error("delta sink down");
        return Promise.reject(new Error("delta sink down"));
      }
      received.push(event);
      return undefined;
    });
    try {
      const spawned = await box.service.spawn({ workspace: box.workspace, prompt: "go", wait: true });
      assert.equal(spawned.status, "completed");
      // The turn-completed stream event can land just after the turn itself.
      await until(() => received.some((event) => event.type === "turn-completed"));
      const completed = received.find((event) => event.type === "turn-completed");
      assert.equal(completed?.droppedDeltas, 1, `mode ${mode}`);
      assert.equal(box.service.result(spawned.session_id).answer, "MSP STREAM OK");
    } finally {
      await box.service.shutdown();
    }
  }
});

test("streaming on or off leaves result and status payloads identical", async () => {
  const off = harness("stream");
  const on = harness("stream");
  on.service.setStreamSink(() => {});
  try {
    const offSpawn = await off.service.spawn({ workspace: off.workspace, prompt: "go", wait: true });
    const onSpawn = await on.service.spawn({ workspace: on.workspace, prompt: "go", wait: true });
    const offResult = off.service.result(offSpawn.session_id);
    const onResult = on.service.result(onSpawn.session_id);
    assert.equal(onResult.answer, offResult.answer);
    assert.equal(onResult.status, offResult.status);
    assert.equal(onResult.terminal, offResult.terminal);
    const offStatus = off.service.status(offSpawn.session_id)[0];
    const onStatus = on.service.status(onSpawn.session_id)[0];
    assert.equal(onStatus?.status, offStatus?.status);
    assert.equal(onStatus?.stream_dropped_deltas, 0);
    assert.equal(offStatus?.stream_dropped_deltas, 0);
  } finally {
    await off.service.shutdown();
    await on.service.shutdown();
  }
});

test("one approval and one question each produce exactly one pending hint", async () => {
  const approvalBox = harness("approve");
  const approvalEvents: StreamEvent[] = [];
  approvalBox.service.setStreamSink((event) => {
    approvalEvents.push(event);
  });
  try {
    const spawned = await approvalBox.service.spawn({ workspace: approvalBox.workspace, prompt: "net", wait: false });
    await until(() => approvalEvents.some((event) => event.type === "pending"));
    // Let the second surface of the same request (view frame) arrive too.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const hints = approvalEvents.filter((event) => event.type === "pending");
    assert.equal(hints.length, 1);
    assert.equal(hints[0]?.kind, "approval");
    assert.equal(hints[0]?.phase, "requested");
    assert.equal(hints[0]?.requestId, `ap-${spawned.session_id}`);
  } finally {
    await approvalBox.service.shutdown();
  }

  const questionBox = harness("user-input");
  const questionEvents: StreamEvent[] = [];
  questionBox.service.setStreamSink((event) => {
    questionEvents.push(event);
  });
  try {
    const spawned = await questionBox.service.spawn({ workspace: questionBox.workspace, prompt: "ask", wait: false });
    await until(() => questionEvents.some((event) => event.type === "pending"));
    const hints = questionEvents.filter((event) => event.type === "pending");
    assert.equal(hints.length, 1);
    assert.equal(hints[0]?.kind, "userInput");
    assert.equal(hints[0]?.requestId, `ui-${spawned.session_id}`);
  } finally {
    await questionBox.service.shutdown();
  }
});

test("fingerprint drift keeps the host and stores a warning", async () => {
  const box = harness("ok", "sha256:0000000000000000000000000000000000000000000000000000000000000000");
  try {
    const spawned = await box.service.spawn({ workspace: box.workspace, prompt: "hi", wait: true });
    assert.equal(spawned.status, "completed");
    const warning = box.service.status(spawned.session_id)[0]?.fingerprint_warning;
    assert.equal(typeof warning, "string");
    assert.match(warning ?? "", /sha256:0000000000000000000000000000000000000000000000000000000000000000/);
  } finally {
    await box.service.shutdown();
  }
});

test("wait false returns while a turn is still running", async () => {
  const { service, workspace } = harness("hang");
  try {
    const started = Date.now();
    const spawned = await service.spawn({ workspace, prompt: "stay", wait: false });
    assert.ok(Date.now() - started < 2000);
    assert.equal(typeof spawned.session_id, "string");
    assert.equal(typeof spawned.turn_id, "string");
    assert.equal(spawned.status, "running");
  } finally {
    await service.shutdown();
  }
});

test("idle steer reports the error and sends no frame", async () => {
  const box = harness("ok");
  try {
    const spawned = await box.service.spawn({ workspace: box.workspace, prompt: "done", wait: true });
    await assert.rejects(
      () => box.service.steer(spawned.session_id, "more", spawned.turn_id ?? ""),
      /idle/,
    );
    assert.equal(box.methods().some((entry) => entry.method === "turn/steer"), false);
  } finally {
    await box.service.shutdown();
  }
});

test("muse_decide approves the once choice", async () => {
  const box = harness("approve");
  try {
    const spawned = await box.service.spawn({ workspace: box.workspace, prompt: "net", wait: false });
    await until(async () => (await box.service.pending()).some((item) => item.kind === "approval"));
    const pending = (await box.service.pending()).find((item) => item.kind === "approval");
    assert.ok(pending);
    const payload = pending?.payload as { toolName?: string; subject?: { host?: string } };
    assert.equal(payload.toolName, "network");
    assert.equal(payload.subject?.host, "example.com");
    await box.service.decide(pending.requestId, "approve", "orchestrator");
    await until(() => box.service.result(spawned.session_id).answer === "APPROVED");
    const decide = box.methods().find((entry) => entry.method === "approval/decide");
    assert.equal(decide?.params.choiceId, "allow_once");
  } finally {
    await box.service.shutdown();
  }
});

test("muse_answer returns the selected label", async () => {
  const box = harness("user-input");
  try {
    const spawned = await box.service.spawn({ workspace: box.workspace, prompt: "ask", wait: false });
    await until(async () => (await box.service.pending()).some((item) => item.kind === "userInput"));
    const pending = (await box.service.pending()).find((item) => item.kind === "userInput");
    assert.ok(pending);
    await box.service.answer(pending.requestId, "user", "beta.txt");
    await until(() => box.service.result(spawned.session_id).answer === "beta.txt");
  } finally {
    await box.service.shutdown();
  }
});

test("a rejected user-input answer stays pending and is not audited", async () => {
  const box = harness("user-input");
  const reject = join(box.home, "reject-answer");
  box.env.MUSE_FAKE_REJECT_ANSWER_FILE = reject;
  try {
    await box.service.spawn({ workspace: box.workspace, prompt: "ask", wait: false });
    await until(async () => (await box.service.pending()).some((item) => item.kind === "userInput"));
    const pending = (await box.service.pending()).find((item) => item.kind === "userInput");
    assert.ok(pending);
    writeFileSync(reject, "1");
    await assert.rejects(() => box.service.answer(pending.requestId, "user", "nope"), /userInputAnswerInvalid|does not match/);
    assert.equal((await box.service.pending()).some((item) => item.requestId === pending.requestId), true);
    const audit = readAudit(box.home);
    assert.equal(audit.some((event) => event.kind === "answer"), false);
    await box.service.answer(pending.requestId, "user", "beta.txt");
    assert.equal(audit.some((event) => event.kind === "answer"), false);
    assert.equal(readAudit(box.home).some((event) => event.kind === "answer"), true);
  } finally {
    await box.service.shutdown();
  }
});

test("a rejected approval decide stays pending and can be retried", async () => {
  const box = harness("approve");
  const reject = join(box.home, "reject-decide");
  box.env.MUSE_FAKE_REJECT_DECIDE_FILE = reject;
  try {
    await box.service.spawn({ workspace: box.workspace, prompt: "net", wait: false });
    await until(async () => (await box.service.pending()).some((item) => item.kind === "approval"));
    const pending = (await box.service.pending()).find((item) => item.kind === "approval");
    assert.ok(pending);
    writeFileSync(reject, "1");
    await assert.rejects(() => box.service.decide(pending.requestId, "approve", "orchestrator"), /approvalRequirementStale|stale/);
    assert.equal((await box.service.pending()).some((item) => item.requestId === pending.requestId), true);
    await box.service.decide(pending.requestId, "approve", "orchestrator");
    assert.equal((await box.service.pending()).some((item) => item.requestId === pending.requestId), false);
    const decides = box.methods().filter((entry) => entry.method === "approval/decide");
    assert.equal(decides.length, 2);
    assert.equal(decides[1]?.params.choiceId, "allow_once");
  } finally {
    await box.service.shutdown();
  }
});

test("pending resumes an orphaned session and lists the host's approval", async () => {
  const box = harness("approve-crash");
  box.env.MUSE_FAKE_PENDING_FILE = join(box.home, "pending.json");
  try {
    const spawned = await box.service.spawn({ workspace: box.workspace, prompt: "net", wait: false });
    await until(() => box.service.status(spawned.session_id)[0]?.status === "orphaned");
    assert.equal(box.service.status(spawned.session_id)[0]?.pending_approvals, 0);
    box.env.MUSE_FAKE_SCENARIO = "ok";
    const items = await box.service.pending();
    assert.equal(items.some((item) => item.kind === "approval" && item.sessionId === spawned.session_id), true);
    const resumes = box.methods().filter((entry) => entry.method === "session/resume");
    assert.equal(resumes.length, 1);
  } finally {
    await box.service.shutdown();
  }
});

test("muse_raw forwards compact and refuses login before any frame", async () => {
  const box = harness("ok");
  try {
    const spawned = await box.service.spawn({ workspace: box.workspace });
    const raw = await box.service.raw(spawned.session_id, "session/compact", { note: "keep" });
    assert.equal(raw.method, "session/compact");
    const params = raw.params as { note?: string };
    assert.equal(params.note, "keep");
    await assert.rejects(() => box.service.raw(spawned.session_id, "account/loginStart", { secret: "nope" }), /refused/);
    assert.equal(box.methods().some((entry) => entry.method === "account/loginStart"), false);
    const audit = readAudit(box.home);
    assert.equal(audit.some((event) => event.kind === "refuse"), true);
    assert.equal(JSON.stringify(audit).includes("nope"), false);
  } finally {
    await box.service.shutdown();
  }
});
