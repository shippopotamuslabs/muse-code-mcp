import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureHome } from "../src/config.ts";
import { SessionStore, type SessionRecord } from "../src/state.ts";

function record(status: SessionRecord["status"]): SessionRecord {
  return {
    sessionId: "sess-1",
    workspace: "/tmp/ws",
    approvalMode: "yolo",
    hostKey: "host",
    status,
    contributorMode: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

test("a state file with no sessions object is corrupt, not empty", () => {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-state-"));
  ensureHome(home, {});
  const store = new SessionStore(home);
  writeFileSync(store.path(), '{"sessions":[]}\n');
  assert.throws(() => store.load(), /corrupt/);
  writeFileSync(store.path(), '{"other":{}}\n');
  assert.throws(() => store.list(), /corrupt/);
});

test("a running session is orphaned when the store is loaded again", () => {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-state-"));
  ensureHome(home, {});
  const first = new SessionStore(home);
  first.upsert(record("running"));
  const second = new SessionStore(home);
  const loaded = second.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.status, "orphaned");
  assert.equal(second.get("sess-1")?.status, "orphaned");
});
