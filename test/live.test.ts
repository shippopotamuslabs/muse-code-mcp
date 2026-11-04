import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAudit } from "../src/audit.ts";
import { ensureHome } from "../src/config.ts";
import { MuseService } from "../src/sessions.ts";
import type { StreamEvent } from "../src/stream.ts";

const live = process.env.MUSE_MCP_LIVE === "1";

function service() {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-live-"));
  const config = ensureHome(home, {});
  return {
    home,
    svc: new MuseService({ home, config, bin: process.env.MUSE_MCP_BIN || "muse", shutdownTimeoutMs: 0 }),
  };
}

async function until(check: () => boolean | Promise<boolean>, ms = 120_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for the live session");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test("live spark scout returns its answer", { skip: !live, timeout: 180_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-live-ws-"));
  const { svc } = service();
  try {
    const spawned = await svc.spawn({
      workspace,
      prompt: "Reply with exactly: LIVE OK",
      model: "muse-spark-1.3",
      reasoning_effort: "minimal",
      approval_mode: "yolo",
      wait: true,
    });
    assert.equal(spawned.status, "completed");
    assert.match(svc.result(spawned.session_id).answer, /LIVE OK/);
  } finally {
    await svc.shutdown();
  }
});

test("live spawn settles a server-minted canonical name", { skip: !live, timeout: 180_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-live-ws-"));
  const { svc } = service();
  const events: StreamEvent[] = [];
  svc.setStreamSink((event) => {
    events.push(event);
  });
  try {
    const spawned = await svc.spawn({
      workspace,
      prompt: "Reply with exactly: LIVE OK",
      model: "muse-spark-1.3",
      reasoning_effort: "minimal",
      approval_mode: "yolo",
      wait: true,
    });
    assert.equal(spawned.status, "completed");
    // The rename fold may land just after the turn completes.
    await until(() => (svc.status(spawned.session_id)[0]?.name_origin ?? "fallback") !== "fallback");
    const row = svc.status(spawned.session_id)[0];
    assert.ok(row?.name);
    assert.match(row.name, /^[a-z]+-[a-z]+$/);
    assert.notEqual(row.name, "Reply with exactly: LIVE OK");
    assert.equal(row.name_origin, "custom");
    const renamed = events.find((event) => event.type === "name-changed" && event.name === row.name);
    assert.ok(renamed, "expected a name-changed event matching the status name");
    assert.equal(renamed.origin, "custom");
  } finally {
    await svc.shutdown();
  }
});

test("live worktree create on an untrusted repo surfaces workspaceNotTrusted", { skip: !live, timeout: 60_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-live-wt-"));
  execFileSync("git", ["init"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "muse-mcp@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "muse-mcp"], { cwd: workspace });
  writeFileSync(join(workspace, "README"), "fixture\n");
  execFileSync("git", ["add", "README"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: workspace });
  const { svc } = service();
  try {
    await assert.rejects(
      () =>
        svc.spawn({
          workspace,
          model: "muse-spark-1.3",
          reasoning_effort: "minimal",
          approval_mode: "on-request",
          worktree: "create",
          wait: false,
          prompt: "Reply with exactly: SHOULD NOT RUN",
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /not trusted/);
        assert.equal((error as { kind?: string }).kind, "workspaceNotTrusted");
        return true;
      },
    );
  } finally {
    await svc.shutdown();
  }
});

test("live session asks, waits for approval, and leaves a parallel session alone", { skip: !live, timeout: 300_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-live-ask-"));
  const side = mkdtempSync(join(tmpdir(), "muse-mcp-live-side-"));
  const { home, svc } = service();
  try {
    const coding = await svc.spawn({
      workspace,
      model: "muse-spark-1.3",
      reasoning_effort: "minimal",
      approval_mode: "on-request",
      wait: false,
      prompt: [
        "Do these steps in order.",
        "First call request_user_input and ask which filename to create: alpha.txt or beta.txt.",
        "Do not create a file and do not run a command until that question is answered.",
        "After the answer, run exactly: curl -fsS -o /dev/null -w '%{http_code}' https://example.com",
        "If that command needs approval, wait for the decision. If it is denied, do not retry it.",
        "Then create only the chosen filename in the workspace root with the exact contents: picked",
        "Reply with the filename.",
      ].join("\n"),
    });
    const parallel = await svc.spawn({
      workspace: side,
      model: "muse-spark-1.3",
      reasoning_effort: "minimal",
      approval_mode: "yolo",
      prompt: "Reply with exactly: PARALLEL",
      wait: true,
    });
    assert.match(svc.result(parallel.session_id).answer, /PARALLEL/);
    assert.equal(svc.status(coding.session_id)[0]?.status === "closed", false);

    await until(async () =>
      (await svc.pending()).some((item) => item.sessionId === coding.session_id && item.kind === "userInput"),
    );
    const question = (await svc.pending()).find((item) => item.sessionId === coding.session_id && item.kind === "userInput");
    assert.ok(question);
    await svc.answer(question.requestId, "user", "beta.txt");

    await until(
      async () => (await svc.pending()).some((item) => item.sessionId === coding.session_id && item.kind === "approval"),
      120_000,
    );
    const approval = (await svc.pending()).find((item) => item.sessionId === coding.session_id && item.kind === "approval");
    assert.ok(approval);
    svc.decide(approval.requestId, "approve", "orchestrator", "live test");

    await until(() => svc.result(coding.session_id).terminal === "completed", 120_000);
    const audit = readAudit(home);
    assert.equal(audit.some((event) => event.kind === "answer" && event.actor === "user"), true);
    assert.equal(audit.some((event) => event.kind === "decision" && event.actor === "orchestrator"), true);
    assert.equal(svc.result(parallel.session_id).answer.includes("PARALLEL"), true);
    const body = readFileSync(join(workspace, "beta.txt"), "utf8").trim();
    assert.equal(body, "picked");
  } finally {
    await svc.shutdown();
  }
});

test("live stream delivers deltas that build the answer", { skip: !live, timeout: 180_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-live-ws-"));
  const { svc } = service();
  const events: StreamEvent[] = [];
  svc.setStreamSink((event) => {
    events.push(event);
  });
  try {
    const spawned = await svc.spawn({
      workspace,
      prompt: "Write a short paragraph about the ocean. At least three sentences, plain text only.",
      model: "muse-spark-1.3",
      reasoning_effort: "minimal",
      approval_mode: "yolo",
      wait: true,
    });
    assert.equal(spawned.status, "completed");
    const answer = svc.result(spawned.session_id).answer;
    assert.ok(answer.length > 0);
    // Find the completed agentMessage item whose text is the answer, then
    // check that item's deltas alone: they must form a prefix of the answer
    // (saturation can only cut the tail; item/completed stays authoritative).
    let answerItemId: string | undefined;
    for (const event of events) {
      if (event.type !== "item-completed") continue;
      const item = event.item as { itemId?: string; kind?: string; text?: string } | undefined;
      if (item?.kind === "agentMessage" && item.text === answer) answerItemId = item.itemId;
    }
    assert.ok(answerItemId, "expected a completed agentMessage item matching the answer");
    const streamed = events
      .filter((event) => event.type === "item-delta" && event.itemId === answerItemId)
      .map((event) => event.delta ?? "")
      .join("");
    assert.ok(streamed.length > 0, "expected at least one delta for the answer item");
    assert.equal(answer.startsWith(streamed), true);
    const completed = events.find((event) => event.type === "turn-completed");
    assert.equal(completed?.answer, answer);
    assert.equal(completed?.droppedDeltas, 0);
  } finally {
    await svc.shutdown();
  }
});

test("live models lists the catalog without running a turn", { skip: !live, timeout: 60_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-live-ws-"));
  const { svc } = service();
  try {
    const listed = await svc.models({ workspace });
    assert.ok(listed.models.length > 0);
    assert.ok(listed.models.some((row) => row.id === "muse-spark-1.3"));
    for (const row of listed.models) {
      assert.ok(row.id.length > 0);
      assert.ok(row.display_label.length > 0);
    }
    assert.ok(listed.source.length > 0);
  } finally {
    await svc.shutdown();
  }
});

test("live catalog lists skills, plugins, hooks, and MCP servers for a session", { skip: !live, timeout: 60_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-live-ws-"));
  const { svc } = service();
  try {
    const spawned = await svc.spawn({ workspace, approval_mode: "yolo" });
    const skills = await svc.skills(spawned.session_id);
    for (const row of skills.skills) assert.ok(row.selector.length > 0);
    const plugins = await svc.plugins(spawned.session_id);
    for (const row of plugins.plugins) assert.ok(row.id.length > 0);
    const hooks = await svc.hooks(spawned.session_id);
    for (const row of hooks.hooks) assert.ok(row.key.length > 0);
    const servers = await svc.mcpServers(spawned.session_id);
    for (const row of servers.servers) assert.ok(row.name.length > 0);
  } finally {
    await svc.shutdown();
  }
});

test("live session-message list reports closed ingress", { skip: !live, timeout: 30_000 }, async () => {
  const { svc } = service();
  try {
    const listed = await svc.message({ action: "list" });
    assert.equal(listed.exit_code, 1);
    assert.deepEqual(listed.result, {
      schema_version: 1,
      status: "unavailable",
      error_code: "external_agent_ingress_closed",
    });
    assert.match(listed.stderr, /external agent ingress is unavailable/);
  } finally {
    await svc.shutdown();
  }
});
