import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureHome, loadConfig } from "../src/config.ts";

test("missing config is created with yolo and no auto-approvals", () => {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-cfg-"));
  const config = ensureHome(home, {});
  assert.equal(config.approvalMode, "yolo");
  assert.equal(config.pendingTimeoutSec, 1800);
  assert.deepEqual(config.autoApprove, []);
  const text = readFileSync(join(home, "config.toml"), "utf8");
  assert.match(text, /approval_mode = "yolo"/);
  assert.match(text, /auto_approve ships empty/);
  assert.equal(readFileSync(join(home, "state.json"), "utf8").includes('"sessions"'), true);
});

test("env timeout overrides the file", () => {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-cfg-"));
  ensureHome(home, {});
  const config = loadConfig(home, { MUSE_MCP_PENDING_TIMEOUT_SEC: "10" });
  assert.equal(config.pendingTimeoutSec, 10);
  assert.equal(loadConfig(home, {}).pendingTimeoutSec, 1800);
});
