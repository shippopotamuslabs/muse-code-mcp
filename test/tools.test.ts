import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readAudit } from "../src/audit.ts";
import { ensureHome } from "../src/config.ts";
import { createMcpServer } from "../src/server.ts";
import { MuseService } from "../src/sessions.ts";
import type { StreamEvent } from "../src/stream.ts";

const FAKE = join(import.meta.dirname, "fake-muse.mjs");

const NAMES = [
  "muse_spawn",
  "muse_turn",
  "muse_steer",
  "muse_pending",
  "muse_answer",
  "muse_decide",
  "muse_status",
  "muse_result",
  "muse_cancel",
  "muse_close",
  "muse_message",
  "muse_models",
  "muse_raw",
];

test("an MCP client lists every Muse tool", async () => {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-tools-"));
  const config = ensureHome(home, {});
  const service = new MuseService({
    home,
    config,
    bin: join(import.meta.dirname, "fake-muse.mjs"),
    shutdownTimeoutMs: 0,
  });
  const mcp = createMcpServer(service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "muse-mcp-test", version: "0" });
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...NAMES].sort());
    const spawn = listed.tools.find((tool) => tool.name === "muse_spawn");
    assert.equal(JSON.stringify(spawn?.inputSchema).includes("output_schema"), false);
  } finally {
    await client.close();
    await service.shutdown();
  }
});

function streamHarness() {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-stream-"));
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-ws-"));
  const config = ensureHome(home, {});
  const service = new MuseService({
    home,
    config,
    bin: FAKE,
    env: {
      MUSE_FAKE_SCENARIO: "stream",
      MUSE_FAKE_ARGV_LOG: join(home, "argv.log"),
      MUSE_FAKE_METHOD_LOG: join(home, "methods.log"),
    },
    shutdownTimeoutMs: 0,
  });
  return { home, workspace, service };
}

async function untilStream(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for stream events");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a streaming-capable client receives the turn as notifications", async () => {
  const { workspace, service } = streamHarness();
  const mcp = createMcpServer(service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "muse-mcp-test", version: "0" },
    { capabilities: { experimental: { "muse.stream": {} } } },
  );
  const events: StreamEvent[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === "notifications/muse/event") {
      events.push(notification.params as unknown as StreamEvent);
    }
  };
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const spawned = await client.callTool({
      name: "muse_spawn",
      arguments: { workspace, prompt: "go", wait: true },
    });
    assert.equal(spawned.isError, undefined);
    await untilStream(() => events.some((event) => event.type === "turn-completed"));
    assert.deepEqual(
      events.map((event) => event.type),
      ["turn-started", "item-started", "item-delta", "item-completed", "turn-completed"],
    );
    const delta = events.find((event) => event.type === "item-delta");
    assert.equal(delta?.delta, "MSP STREAM OK");
    const result = await client.callTool({
      name: "muse_result",
      arguments: { session_id: events[0]?.sessionId },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.equal((JSON.parse(content[0]?.text ?? "{}") as { answer: string }).answer, delta?.delta);
  } finally {
    await client.close();
    await service.shutdown();
  }
});

test("a client without the streaming capability receives no notifications", async () => {
  const { workspace, service } = streamHarness();
  const mcp = createMcpServer(service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "muse-mcp-test", version: "0" }, { capabilities: {} });
  const methods: string[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    methods.push(notification.method);
  };
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const spawned = await client.callTool({
      name: "muse_spawn",
      arguments: { workspace, prompt: "go", wait: true },
    });
    assert.equal(spawned.isError, undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(methods.filter((method) => method === "notifications/muse/event"), []);
    const spawnContent = spawned.content as Array<{ type: string; text?: string }>;
    const sessionId = (JSON.parse(spawnContent[0]?.text ?? "{}") as { session_id: string }).session_id;
    const result = await client.callTool({ name: "muse_result", arguments: { session_id: sessionId } });
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.equal((JSON.parse(content[0]?.text ?? "{}") as { answer: string }).answer, "MSP STREAM OK");
  } finally {
    await client.close();
    await service.shutdown();
  }
});

test("an MCP client calls muse_models by workspace", async () => {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-models-"));
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-ws-"));
  const config = ensureHome(home, {});
  const service = new MuseService({
    home,
    config,
    bin: FAKE,
    env: {
      MUSE_FAKE_SCENARIO: "ok",
      MUSE_FAKE_ARGV_LOG: join(home, "argv.log"),
      MUSE_FAKE_METHOD_LOG: join(home, "methods.log"),
    },
    shutdownTimeoutMs: 0,
  });
  const mcp = createMcpServer(service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "muse-mcp-test", version: "0" });
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "muse_models", arguments: { workspace } });
    assert.equal(result.isError, undefined);
    const content = result.content as Array<{ type: string; text?: string }>;
    const parsed = JSON.parse(content[0]?.text ?? "{}") as { models: Array<{ id: string }> };
    assert.equal(parsed.models[0]?.id, "muse-spark-1.3");
  } finally {
    await client.close();
    await service.shutdown();
  }
});

test("an elicitation answer decides a pending approval", async () => {
  const home = mkdtempSync(join(tmpdir(), "muse-mcp-elicit-"));
  const workspace = mkdtempSync(join(tmpdir(), "muse-mcp-ws-"));
  const methodLog = join(home, "methods.log");
  const config = ensureHome(home, {});
  const service = new MuseService({
    home,
    config,
    bin: FAKE,
    env: {
      MUSE_FAKE_SCENARIO: "approve",
      MUSE_FAKE_ARGV_LOG: join(home, "argv.log"),
      MUSE_FAKE_METHOD_LOG: methodLog,
    },
    shutdownTimeoutMs: 0,
  });
  const mcp = createMcpServer(service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "muse-mcp-test", version: "0" },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({
    action: "accept" as const,
    content: { decision: "approve" },
  }));
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const spawned = await client.callTool({
      name: "muse_spawn",
      arguments: { workspace, prompt: "net", wait: false },
    });
    const content = spawned.content as Array<{ type: string; text?: string }>;
    const sessionId = (JSON.parse(content[0]?.text ?? "{}") as { session_id: string }).session_id;
    const start = Date.now();
    while (service.result(sessionId).answer !== "APPROVED") {
      if (Date.now() - start > 5000) throw new Error("timed out waiting for the elicited approval");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const methods = readFileSync(methodLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    const decide = methods.find((entry) => entry.method === "approval/decide");
    assert.equal(decide?.params.choiceId, "allow_once");
    assert.equal(readAudit(home).some((event) => event.kind === "decision" && event.actor === "user"), true);
  } finally {
    await client.close();
    await service.shutdown();
  }
});
