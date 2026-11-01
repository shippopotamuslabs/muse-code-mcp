import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAudit } from "../src/audit.ts";
import { ensureHome } from "../src/config.ts";
import { MuseService } from "../src/sessions.ts";

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
