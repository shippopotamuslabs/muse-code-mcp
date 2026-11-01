import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { ensureHome, museBin, museMcpHome } from "./config.ts";
import type { PendingItem } from "./broker.ts";
import { MuseService } from "./sessions.ts";
import { registerTools } from "./tools.ts";

export function createMcpServer(service: MuseService): McpServer {
  const mcp = new McpServer({ name: "muse-mcp", version: "0.2.0" });
  registerTools(mcp, service);
  service.setElicitor((item) => {
    const caps = mcp.server.getClientCapabilities();
    if (!caps?.elicitation) return;
    void elicit(mcp, service, item);
  });
  service.setStreamSink((event) => {
    const caps = mcp.server.getClientCapabilities();
    if (!caps?.experimental?.["muse.stream"]) return;
    return mcp.server.notification({
      method: "notifications/muse/event",
      params: event as unknown as Record<string, unknown>,
    });
  });
  return mcp;
}

async function elicit(mcp: McpServer, service: MuseService, item: PendingItem): Promise<void> {
  try {
    const result =
      item.kind === "approval"
        ? await mcp.server.elicitInput({
            mode: "form",
            message: `Muse approval ${item.requestId} is waiting.`,
            requestedSchema: {
              type: "object",
              properties: {
                decision: { type: "string", enum: ["approve", "deny"], title: "Decision" },
                reason: { type: "string", title: "Reason" },
              },
              required: ["decision"],
            },
          })
        : await mcp.server.elicitInput({
            mode: "form",
            message: `Muse question ${item.requestId} is waiting.`,
            requestedSchema: {
              type: "object",
              properties: { answer: { type: "string", title: "Answer" } },
              required: ["answer"],
            },
          });
    if (result.action !== "accept" || !result.content) return;
    const content = result.content;
    if (item.kind === "approval") {
      const decision = content.decision === "deny" ? "deny" : content.decision === "approve" ? "approve" : undefined;
      if (!decision) return;
      await service.decide(item.requestId, decision, "user", typeof content.reason === "string" ? content.reason : undefined);
      return;
    }
    if (typeof content.answer === "string") await service.answer(item.requestId, "user", content.answer);
  } catch {
    // The tools path remains the way to answer. A declined or unsupported elicit is not a failure.
  }
}

async function main(): Promise<void> {
  const home = museMcpHome();
  const config = ensureHome(home);
  const service = new MuseService({ home, config, bin: museBin() });
  const mcp = createMcpServer(service);
  await mcp.connect(new StdioServerTransport());
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
