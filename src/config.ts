import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export const APPROVAL_MODES = ["yolo", "on-request", "judge"] as const;
export type ApprovalModeName = (typeof APPROVAL_MODES)[number];

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ReasoningEffortName = (typeof REASONING_EFFORTS)[number];

export interface AutoApproveRule {
  match: string;
  decision: "approve";
}

export interface MuseMcpConfig {
  pendingTimeoutSec: number;
  approvalMode: ApprovalModeName;
  model?: string;
  reasoningEffort?: ReasoningEffortName;
  autoApprove: AutoApproveRule[];
}

export const DEFAULT_CONFIG_TOML = `# Muse MCP configuration.
#
# approval_mode defaults to "yolo".
# Spawned sessions use Muse permission profile :unrestricted and approval
# mode allowAll. Tool calls are not held for a person. This is the standing
# posture for agents on your own machine. It is not a safe default for a
# shared or untrusted workspace. Use "on-request" (:ask-me) or "judge"
# (:auto-review) when you want a gate.
#
# auto_approve ships empty. Each rule's match is a JavaScript regex tested
# against one line: tool name, subject kind, command, host, path, and raw
# args. A hit approves with the once-only choice and is audit-logged as
# actor "policy".

pending_timeout_sec = 1800
approval_mode = "yolo"

# Uncomment to override Muse's own settings when a spawn omits model or effort.
# model = "muse-spark-1.3"
# reasoning_effort = "high"

# [[auto_approve]]
# match = "network example\\\\.com"
# decision = "approve"
`;

export function museMcpHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MUSE_MCP_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".muse-mcp");
}

export function museBin(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MUSE_MCP_BIN?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "muse";
}

export function ensureHome(home: string, env: NodeJS.ProcessEnv = process.env): MuseMcpConfig {
  mkdirSync(home, { recursive: true });
  const configPath = join(home, "config.toml");
  if (!existsSync(configPath)) writeFileSync(configPath, DEFAULT_CONFIG_TOML);
  const statePath = join(home, "state.json");
  if (!existsSync(statePath)) writeFileSync(statePath, '{"sessions":{}}\n');
  const auditPath = join(home, "audit.log");
  if (!existsSync(auditPath)) writeFileSync(auditPath, "");
  return loadConfig(home, env);
}

export function loadConfig(home: string, env: NodeJS.ProcessEnv = process.env): MuseMcpConfig {
  const raw = readFileSync(join(home, "config.toml"), "utf8");
  const parsed = parse(raw) as Record<string, unknown>;
  const fileMode = parsed.approval_mode === undefined ? "yolo" : String(parsed.approval_mode);
  const fileTimeout = parsed.pending_timeout_sec === undefined ? 1800 : Number(parsed.pending_timeout_sec);
  const fileModel = optionalString(parsed.model);
  const fileEffort = parsed.reasoning_effort === undefined ? undefined : String(parsed.reasoning_effort);
  const rules = parseRules(parsed.auto_approve);

  const approvalMode = parseApprovalMode(env.MUSE_MCP_APPROVAL_MODE ?? fileMode);
  const pendingTimeoutSec = parseTimeout(env.MUSE_MCP_PENDING_TIMEOUT_SEC ?? String(fileTimeout));
  const model = optionalString(env.MUSE_MCP_MODEL) ?? fileModel;
  const effortSource = env.MUSE_MCP_REASONING_EFFORT ?? fileEffort;
  const reasoningEffort = effortSource === undefined ? undefined : parseEffort(effortSource);

  return { pendingTimeoutSec, approvalMode, model, reasoningEffort, autoApprove: rules };
}

function parseRules(value: unknown): AutoApproveRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("auto_approve must be an array of tables");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`auto_approve[${index}] is not a table`);
    const row = entry as Record<string, unknown>;
    const match = optionalString(row.match);
    if (!match) throw new Error(`auto_approve[${index}].match is required`);
    try {
      new RegExp(match);
    } catch (err) {
      throw new Error(`auto_approve[${index}].match is not a regex: ${(err as Error).message}`, { cause: err });
    }
    if (row.decision !== "approve") {
      throw new Error(`auto_approve[${index}].decision must be "approve"`);
    }
    return { match, decision: "approve" };
  });
}

export function parseApprovalMode(value: string): ApprovalModeName {
  if ((APPROVAL_MODES as readonly string[]).includes(value)) return value as ApprovalModeName;
  throw new Error(`approval_mode must be yolo, on-request, or judge (got ${value})`);
}

export function parseEffort(value: string): ReasoningEffortName {
  if ((REASONING_EFFORTS as readonly string[]).includes(value)) return value as ReasoningEffortName;
  throw new Error(`reasoning_effort must be one of ${REASONING_EFFORTS.join(", ")} (got ${value})`);
}

function parseTimeout(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`pending_timeout_sec must be a non-negative integer (got ${value})`);
  return Number(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

export function approvalWire(mode: ApprovalModeName): {
  permissionProfile: ":unrestricted" | ":ask-me" | ":auto-review";
  approvalMode: "allowAll" | "onRequest";
} {
  if (mode === "yolo") return { permissionProfile: ":unrestricted", approvalMode: "allowAll" };
  if (mode === "judge") return { permissionProfile: ":auto-review", approvalMode: "onRequest" };
  return { permissionProfile: ":ask-me", approvalMode: "onRequest" };
}
