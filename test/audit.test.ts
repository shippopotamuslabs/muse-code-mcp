import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendAudit, auditPath, readAudit } from "../src/audit.ts";
import { ensureHome } from "../src/config.ts";

test("an audit append is one complete JSON object", () => {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-audit-"));
  ensureHome(home, {});
  appendAudit(home, { kind: "request", sessionId: "s", requestId: "r", detail: { kind: "approval" } });
  const lines = readFileSync(auditPath(home), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? "");
  assert.equal(parsed.kind, "request");
  assert.equal(parsed.sessionId, "s");
  assert.equal(typeof parsed.ts, "string");
  assert.equal(readAudit(home).length, 1);
});
