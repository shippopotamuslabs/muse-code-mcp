import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APPROVAL_MODES, REASONING_EFFORTS } from "./config.ts";
import { asActor, type MuseService } from "./sessions.ts";

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

const effort = z.enum(REASONING_EFFORTS);
const approval = z.enum(APPROVAL_MODES);
const actor = z.enum(["user", "orchestrator"]);

export function registerTools(mcp: McpServer, service: MuseService): void {
  mcp.registerTool(
    "muse_spawn",
    {
      description:
        "Start a Muse session on a workspace and optionally send its first turn. Returns immediately unless wait is true. wait is only for short turns; the MCP client's own timeout still bounds the call.",
      inputSchema: {
        workspace: z.string().describe("Absolute path of an existing workspace directory"),
        prompt: z.string().optional(),
        prompt_file: z.string().optional().describe("Absolute path of a prompt file"),
        model: z.string().optional(),
        reasoning_effort: effort.optional(),
        preset: z.string().optional(),
        worktree: z.enum(["off", "create", "existing"]).optional(),
        worktree_base: z.string().optional(),
        worktree_path: z.string().optional(),
        approval_mode: approval.optional(),
        contributor_mode: z.boolean().optional(),
        wait: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        return ok(await service.spawn(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_turn",
    {
      description: "Send a follow-up turn to a session this server started.",
      inputSchema: {
        session_id: z.string(),
        prompt: z.string().optional(),
        prompt_file: z.string().optional(),
        reasoning_effort: effort.optional(),
        wait: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        return ok(await service.turn(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_steer",
    {
      description: "Inject text into the running turn. Fails without sending a frame when the session is idle or the turn id is not the running turn.",
      inputSchema: {
        session_id: z.string(),
        prompt: z.string(),
        turn_id: z.string(),
      },
    },
    async (args) => {
      try {
        return ok(await service.steer(args.session_id, args.prompt, args.turn_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_pending",
    {
      description: "List pending approval and user-input requests across sessions.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await service.pending());
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_answer",
    {
      description: "Answer a pending user-input request.",
      inputSchema: {
        request_id: z.string(),
        answer: z.unknown().describe("A string, a questionId map, or an answers array"),
        actor: actor.optional(),
      },
    },
    async (args) => {
      try {
        return ok(await service.answer(args.request_id, asActor(args.actor), args.answer));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_decide",
    {
      description: "Approve or deny a pending approval. Approve selects the once-only choice. Deny sends reason when that choice accepts feedback.",
      inputSchema: {
        request_id: z.string(),
        decision: z.enum(["approve", "deny"]),
        reason: z.string().optional(),
        actor: actor.optional(),
      },
    },
    async (args) => {
      try {
        return ok(await service.decide(args.request_id, args.decision, asActor(args.actor), args.reason));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_status",
    {
      description: "Session state, model, workspace, token usage, and pending counts. Omit session_id for every session.",
      inputSchema: { session_id: z.string().optional() },
    },
    async (args) => {
      try {
        return ok(service.status(args.session_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_result",
    {
      description: "Latest completed turn output, final answer text, and a compact in-memory event tail.",
      inputSchema: { session_id: z.string() },
    },
    async (args) => {
      try {
        return ok(service.result(args.session_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_cancel",
    {
      description: "Cancel the current turn.",
      inputSchema: { session_id: z.string(), turn_id: z.string().optional() },
    },
    async (args) => {
      try {
        return ok(await service.cancel(args.session_id, args.turn_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_close",
    {
      description: "End a session this server started.",
      inputSchema: { session_id: z.string() },
    },
    async (args) => {
      try {
        return ok(await service.close(args.session_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_message",
    {
      description:
        "List or send muse session-message traffic to a Muse session this server did not start, such as a TUI. send requires target and body. A closed ingress is a normal result with error_code external_agent_ingress_closed, which happens unless that target process was started with MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS or MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING. Does not replace muse_turn.",
      inputSchema: {
        action: z.enum(["list", "send"]),
        target: z.string().optional().describe("Session uuid or name. Required for send."),
        body: z.string().optional().describe("Message text for send, written to the CLI stdin. Empty is rejected. Max 64 KiB."),
        in_reply_to: z.string().optional(),
        display_context: z.record(z.unknown()).optional().describe("JSON object forwarded as --display-context."),
      },
    },
    async (args) => {
      try {
        return ok(await service.message(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_models",
    {
      description: "List the host model catalog. Pass workspace or session_id; session_id flags the session's model active.",
      inputSchema: {
        workspace: z.string().optional().describe("Absolute path of an existing workspace directory"),
        session_id: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return ok(await service.models(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "muse_raw",
    {
      description:
        "Send any MSP method to a session's host and return the raw result. Params are forwarded unchanged. Credential methods (account/*, oauth, login, logout) are refused before anything is sent.",
      inputSchema: {
        session_id: z.string(),
        method: z.string(),
        params: z.record(z.unknown()).optional(),
      },
    },
    async (args) => {
      try {
        return ok(await service.raw(args.session_id, args.method, args.params ?? {}));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
