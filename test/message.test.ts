import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readAudit } from "../src/audit.ts";
import { ensureHome } from "../src/config.ts";
import { createMcpServer } from "../src/server.ts";
import { MuseService } from "../src/sessions.ts";

const FAKE = join(import.meta.dirname, "fake-session-message.mjs");

function harness(mode?: "crash") {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-msg-"));
  const log = join(home, "message.log");
  const config = ensureHome(home, {});
  const env: NodeJS.ProcessEnv = { MUSE_FAKE_MESSAGE_LOG: log };
  if (mode === "crash") env.MUSE_FAKE_MESSAGE = "crash";
  const service = new MuseService({ home, config, bin: FAKE, env, shutdownTimeoutMs: 0 });
  return { home, log, service };
}

test("list returns closed ingress as a normal tool result", async () => {
  const { home, service } = harness();
  const mcp = createMcpServer(service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "muse-mcp-test", version: "0" });
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.callTool({ name: "muse_message", arguments: { action: "list" } });
    assert.equal(listed.isError, undefined);
    const content = listed.content as Array<{ text?: string }>;
    const body = JSON.parse(content[0]?.text ?? "{}") as {
      exit_code: number;
      stderr: string;
      result: { error_code: string };
    };
    assert.equal(body.exit_code, 1);
    assert.equal(body.result.error_code, "external_agent_ingress_closed");
    assert.match(body.stderr, /external agent ingress is unavailable/);
    const audit = readAudit(home).find((event) => event.kind === "message");
    const detail = audit?.detail as { exit_code?: number; error_code?: string; body_bytes?: number };
    assert.equal(detail.exit_code, 1);
    assert.equal(detail.error_code, "external_agent_ingress_closed");
    assert.equal(detail.body_bytes, 0);
  } finally {
    await client.close();
    await service.shutdown();
  }
});

test("send is refused before spawn when body is missing", async () => {
  const { home, log, service } = harness();
  try {
    await assert.rejects(() => service.message({ action: "send", target: "sess-1" }), /send requires body/);
    assert.equal(existsSync(log), false);
    assert.equal(readFileSync(join(home, "audit.log"), "utf8"), "");
  } finally {
    await service.shutdown();
  }
});

test("send forwards the body and flags and audits length, not text", async () => {
  const { home, log, service } = harness();
  const body = "ping UNIQUE-PHRASE-do-not-log";
  try {
    const result = await service.message({
      action: "send",
      target: "sess-1",
      body,
      in_reply_to: "reply-9",
      display_context: { surface: "tui" },
    });
    assert.equal(result.exit_code, 0);
    assert.deepEqual(result.result, { schema_version: 1, status: "accepted" });
    const recorded = JSON.parse(readFileSync(log, "utf8")) as { argv: string[]; stdin: string };
    assert.deepEqual(recorded.argv, [
      "session-message",
      "send",
      "--json",
      "--target",
      "sess-1",
      "--in-reply-to",
      "reply-9",
      "--display-context",
      JSON.stringify({ surface: "tui" }),
    ]);
    assert.equal(recorded.stdin, body);
    const raw = readFileSync(join(home, "audit.log"), "utf8");
    assert.equal(raw.includes(body), false);
    assert.equal(raw.includes("UNIQUE-PHRASE-do-not-log"), false);
    const detail = readAudit(home).find((event) => event.kind === "message")?.detail as {
      action?: string;
      target?: string;
      in_reply_to?: string;
      body_bytes?: number;
      exit_code?: number;
    };
    assert.equal(detail.action, "send");
    assert.equal(detail.target, "sess-1");
    assert.equal(detail.in_reply_to, "reply-9");
    assert.equal(detail.body_bytes, Buffer.byteLength(body));
    assert.equal(detail.exit_code, 0);
  } finally {
    await service.shutdown();
  }
});

test("a non-object display_context is rejected before spawn", async () => {
  const { log, service } = harness();
  try {
    await assert.rejects(
      () => service.message({ action: "send", target: "sess-1", body: "hi", display_context: "nope" }),
      /display_context must be a JSON object/,
    );
    await assert.rejects(
      () => service.message({ action: "send", target: "sess-1", body: "hi", display_context: ["nope"] }),
      /display_context must be a JSON object/,
    );
    assert.equal(existsSync(log), false);
  } finally {
    await service.shutdown();
  }
});

test("a non-JSON exit is an MCP error", async () => {
  const { service } = harness("crash");
  const mcp = createMcpServer(service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "muse-mcp-test", version: "0" });
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const crashed = await client.callTool({ name: "muse_message", arguments: { action: "list" } });
    assert.equal(crashed.isError, true);
    const content = crashed.content as Array<{ text?: string }>;
    assert.match(content[0]?.text ?? "", /without JSON/);
  } finally {
    await client.close();
    await service.shutdown();
  }
});
