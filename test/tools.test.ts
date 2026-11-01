import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureHome } from "../src/config.ts";
import { createMcpServer } from "../src/server.ts";
import { MuseService } from "../src/sessions.ts";

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
