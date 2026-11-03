#!/usr/bin/env node
// Scripted MSP host. Scenarios are selected with MUSE_FAKE_SCENARIO.
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const scenario = process.env.MUSE_FAKE_SCENARIO || "ok";
const fingerprint =
  process.env.MUSE_FAKE_FINGERPRINT ||
  "sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6";

if (process.env.MUSE_FAKE_ARGV_LOG) {
  appendFileSync(process.env.MUSE_FAKE_ARGV_LOG, JSON.stringify(process.argv) + "\n");
}

let seq = 0;
let serverId = 1_000_000;
const waiting = new Map();

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function logMethod(method, params) {
  if (!process.env.MUSE_FAKE_METHOD_LOG) return;
  appendFileSync(process.env.MUSE_FAKE_METHOD_LOG, JSON.stringify({ method, params }) + "\n");
}

function range() {
  seq += 1;
  const id = `e${seq}`;
  return {
    viewCursor: `c${seq}`,
    sourceRange: {
      stream: { id: "fake", kind: "session" },
      first: { id, sequence: seq },
      last: { id, sequence: seq },
    },
  };
}

function reply(id, params, extra) {
  const result = { ...extra };
  if (params && typeof params.commandId === "string") result.commandId = params.commandId;
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message, kind) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message, data: { kind, retryable: false } },
  });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function sessionObject(sessionId, workspace) {
  return {
    sessionId,
    activeTurnId: null,
    status: "idle",
    workspaceRoot: workspace ?? "/tmp",
    modelId: "fake",
  };
}

const CHOICES = [
  { choiceId: "allow_once", decision: "approved", scope: "once", label: "Allow once", acceptsFeedback: false },
  { choiceId: "allow_session", decision: "approvedForSession", scope: "session", label: "Allow for this session", acceptsFeedback: false },
  { choiceId: "abort", decision: "abort", scope: "once", label: "Reject", acceptsFeedback: true },
];

function completeTurn(sessionId, turnId, text, terminal = "completed", revision = 1) {
  const meta = range();
  notify("item/completed", {
    sessionId,
    ...meta,
    item: {
      itemId: `msg-${turnId}`,
      kind: "agentMessage",
      messagePhase: "finalAnswer",
      text,
      status: "completed",
      revision,
      turnId,
    },
  });
  notify("turn/completed", {
    sessionId,
    turnId,
    terminal,
    ...range(),
  });
}

function beginTurn(sessionId, turnId) {
  // Real TurnStartedParams carry a sourceRange but no viewCursor.
  notify("turn/started", { sessionId, turnId, commandId: turnId, sourceRange: range().sourceRange });
}

function pendingFile() {
  return process.env.MUSE_FAKE_PENDING_FILE;
}

function readPending() {
  const file = pendingFile();
  if (!file || !existsSync(file)) return { approvals: [], userInputs: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
      userInputs: Array.isArray(parsed.userInputs) ? parsed.userInputs : [],
    };
  } catch {
    return { approvals: [], userInputs: [] };
  }
}

function writePending(data) {
  const file = pendingFile();
  if (!file) return;
  writeFileSync(file, JSON.stringify(data));
}

function consumeReject(fileEnv) {
  const file = process.env[fileEnv];
  if (!file || !existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

function askApproval(sessionId, turnId) {
  const approvalId = `ap-${sessionId}`;
  const params = {
    approvalId,
    sessionId,
    currentRequirementId: { approvalId, sourceIndex: 0 },
    availableChoices: CHOICES,
    toolName: "network",
    rawArgs: "{}",
    subject: { kind: "network", host: "example.com", toolName: "network" },
    itemId: `item-${approvalId}`,
    judgeEscalated: false,
    protectedWrite: false,
    taskId: `task-${approvalId}`,
    toolCallId: `call-${approvalId}`,
    turnId,
    ...range(),
  };
  waiting.set(sessionId, { kind: "approval", turnId });
  const stored = readPending();
  stored.approvals.push(params);
  writePending(stored);
  send({ jsonrpc: "2.0", id: serverId++, method: "approval/request", params });
  // The real host also folds the request into the view stream under this name.
  notify("approval/requested", { sessionId, approvalId, ...range() });
}

function askUser(sessionId, turnId) {
  const params = {
    userInputId: `ui-${sessionId}`,
    sessionId,
    itemId: `item-ui-${sessionId}`,
    toolCallId: `call-ui-${sessionId}`,
    toolName: "request_user_input",
    turnId,
    questions: [
      {
        id: "filename",
        header: "File",
        question: "Which file?",
        selection: { mode: "single" },
        options: [{ label: "alpha.txt" }, { label: "beta.txt" }],
      },
    ],
    ...range(),
  };
  waiting.set(sessionId, { kind: "userInput", turnId });
  send({ jsonrpc: "2.0", id: serverId++, method: "userInput/request", params });
}

function streamTurn(sessionId, turnId) {
  beginTurn(sessionId, turnId);
  const itemId = `msg-${turnId}`;
  notify("item/started", {
    sessionId,
    ...range(),
    item: {
      itemId,
      kind: "agentMessage",
      messagePhase: "finalAnswer",
      text: "",
      status: "inProgress",
      revision: 1,
      turnId,
    },
  });
  for (const part of ["MSP ", "STREAM ", "OK"]) {
    seq += 1;
    notify("item/delta", { sessionId, itemId, delta: part, viewCursor: `c${seq}` });
  }
  // Revision 2: the fold ignores a completion that does not advance the started item's revision.
  completeTurn(sessionId, turnId, "MSP STREAM OK", "completed", 2);
}

function afterStart(sessionId, turnId) {
  if (scenario === "stream") {
    streamTurn(sessionId, turnId);
    return;
  }
  if (scenario === "hang") {
    beginTurn(sessionId, turnId);
    return;
  }
  if (scenario === "approve" || scenario === "approve-crash") {
    beginTurn(sessionId, turnId);
    askApproval(sessionId, turnId);
    if (scenario === "approve-crash") setTimeout(() => process.exit(1), 40);
    return;
  }
  if (scenario === "user-input") {
    beginTurn(sessionId, turnId);
    askUser(sessionId, turnId);
    return;
  }
  beginTurn(sessionId, turnId);
  completeTurn(sessionId, turnId, "MSP OK");
}

async function handle(msg) {
  const method = msg.method;
  const params = msg.params ?? {};
  logMethod(method, params);
  if (method === "initialize") {
    reply(msg.id, null, {
      experimentalApi: true,
      grantedCapabilities: [],
      museHome: "/tmp/muse-fake-home",
      platformFamily: "unix",
      platformOs: "linux",
      sandboxAvailability: "available",
      schema: { fingerprint, version: 1 },
      serverInfo: { name: "muse-fake", version: "0" },
      sessionDurability: "durable",
      userAgent: "muse-fake",
    });
    return;
  }
  if (method === "session/resume" && scenario === "in-use") {
    fail(msg.id, -32021, "session is in use by another client", "sessionInUse");
    return;
  }
  if (method === "session/start" || method === "session/resume") {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : `sess-${++seq}`;
    reply(msg.id, params, { session: sessionObject(sessionId, params.workspaceRoot), viewCursor: "c0" });
    if (method === "session/start" && scenario === "crash-after-start") {
      setTimeout(() => process.exit(1), 40);
    }
    return;
  }
  if (method === "turn/start") {
    const turnId = typeof params.commandId === "string" ? params.commandId : `turn-${++seq}`;
    reply(msg.id, params, { turnId, disposition: "started", startedNewTurn: true, status: "accepted" });
    afterStart(params.sessionId, turnId);
    return;
  }
  if (method === "approval/decide") {
    if (consumeReject("MUSE_FAKE_REJECT_DECIDE_FILE")) {
      fail(msg.id, -32053, "requirement is stale", "approvalRequirementStale");
      return;
    }
    const stored = readPending();
    stored.approvals = stored.approvals.filter((entry) => entry.approvalId !== params.approvalId);
    writePending(stored);
    const pending = waiting.get(params.sessionId);
    reply(msg.id, params, { approvalId: params.approvalId, status: "accepted", terminal: true });
    if (pending) {
      waiting.delete(params.sessionId);
      const text = params.choiceId === "abort" ? "DENIED" : "APPROVED";
      completeTurn(params.sessionId, pending.turnId, text);
    }
    return;
  }
  if (method === "userInput/answer" || method === "userInput/cancel") {
    if (method === "userInput/answer" && consumeReject("MUSE_FAKE_REJECT_ANSWER_FILE")) {
      fail(msg.id, -32057, "answer does not match the offered options", "userInputAnswerInvalid");
      return;
    }
    const pending = waiting.get(params.sessionId);
    reply(msg.id, params, { status: "accepted", userInputId: params.userInputId });
    if (pending) {
      waiting.delete(params.sessionId);
      const label = params.answers?.[0]?.selectedLabel ?? params.answers?.[0]?.freeText ?? "cancelled";
      completeTurn(params.sessionId, pending.turnId, String(label), method === "userInput/cancel" ? "cancelled" : "completed");
    }
    return;
  }
  if (method === "approval/listPending") {
    const stored = readPending();
    reply(msg.id, params, {
      approvals: stored.approvals.filter((entry) => entry.sessionId === params.sessionId),
      userInputs: stored.userInputs.filter((entry) => entry.sessionId === params.sessionId),
    });
    return;
  }
  if (method === "skill/list") {
    if (scenario === "catalog-malformed") {
      reply(msg.id, params, {});
      return;
    }
    if (scenario === "catalog-empty") {
      reply(msg.id, params, { skills: [] });
      return;
    }
    reply(msg.id, params, {
      skills: [
        {
          selector: "fix-bug",
          displayName: "Fix Bug",
          description: "Diagnose and fix a bug",
          source: "user",
          argumentHint: "<description>",
        },
        {
          selector: "acme:deploy",
          displayName: "Deploy",
          description: "Deploy with the Acme plugin",
          source: "plugin",
          pluginId: "acme",
          title: "Acme Deploy",
        },
        { displayName: "Row with no selector is skipped" },
      ],
    });
    return;
  }
  if (method === "plugin/list") {
    if (scenario === "catalog-empty") {
      reply(msg.id, params, { plugins: [] });
      return;
    }
    reply(msg.id, params, {
      plugins: [
        { id: "acme", version: "1.2.0", source: "marketplace", enabled: true },
        { id: "local-tools", version: "0.1.0", source: "local", enabled: false },
      ],
    });
    return;
  }
  if (method === "hook/list") {
    if (scenario === "catalog-empty") {
      reply(msg.id, params, { hooks: [] });
      return;
    }
    reply(msg.id, params, {
      hooks: [
        { key: "lint-on-save", event: "postToolUse", handlerKind: "user", enabled: true },
        { key: "block-push", event: "preToolUse", handlerKind: "project", enabled: false },
      ],
    });
    return;
  }
  if (method === "mcpServer/list") {
    if (scenario === "catalog-malformed") {
      reply(msg.id, params, {});
      return;
    }
    if (scenario === "catalog-empty") {
      reply(msg.id, params, { servers: [] });
      return;
    }
    if (scenario === "mcp-servers-alt-key") {
      reply(msg.id, params, { mcpServers: [{ id: "alt-server", state: "ready" }] });
      return;
    }
    reply(msg.id, params, {
      servers: [
        { name: "github", status: "connected", transport: "streamableHttp", url: "https://example.invalid/mcp" },
        { name: "local-db", transport: "stdio" },
      ],
    });
    return;
  }
  if (method === "model/list") {
    const top = { providerId: "fake", profileId: null, source: "fakeCatalog" };
    if (scenario === "models-empty") {
      reply(msg.id, params, { ...top, models: [] });
      return;
    }
    if (scenario === "models-no-identity") {
      reply(msg.id, params, { models: [], profileId: null, source: "fakeCatalog" });
      return;
    }
    const active = typeof params.sessionId === "string" && params.sessionId.length > 0;
    reply(msg.id, params, {
      ...top,
      models: [
        {
          modelId: "muse-spark-1.3",
          displayLabel: "Muse Spark 1.3",
          description: "Fast model for everyday coding",
          isDefault: true,
          isActive: active,
          providerId: "fake",
          profileId: null,
          contextLimit: 200000,
          outputLimit: 32000,
          releaseDate: "2026-01-01",
          cost: { cached: "0.15", currency: "USD", input: "0.30", output: "1.20" },
          defaultReasoningEffort: "high",
          reasoningEffortVariants: [{ tier: "high", description: "Thorough reasoning" }],
          variants: ["minimal", "low", "medium", "high"],
        },
        {
          modelId: "muse-wonder-full-1.0",
          displayLabel: "Muse Wonder Full 1.0",
          description: null,
          isDefault: false,
          isActive: false,
          providerId: "fake",
          profileId: null,
          contextLimit: null,
          outputLimit: null,
          releaseDate: null,
          cost: null,
        },
      ],
    });
    return;
  }
  reply(msg.id, params, { ok: true, method, params });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined || msg.id === undefined) return;
  handle(msg).catch((error) => {
    if (msg.id !== undefined) fail(msg.id, -32603, String(error), "internal");
  });
});
rl.on("close", () => process.exit(0));
