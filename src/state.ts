import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalModeName, ReasoningEffortName } from "./config.ts";

export const SESSION_STATUSES = ["idle", "running", "orphaned", "closed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionRecord {
  sessionId: string;
  workspace: string;
  /** The session's display name (MFST-33): the host's allocated name once a
   * session/nameChanged frame lands, else the provisional spawn-prompt
   * fallback seeded at spawn. Absent when the session has no name yet. */
  name?: string;
  /** How `name` was set: the host's nameOrigin verbatim ("automatic",
   * "custom", or a later value), or "fallback" while the provisional
   * spawn-prompt label stands. Absent when the origin is unknown. */
  nameOrigin?: string;
  model?: string;
  reasoningEffort?: ReasoningEffortName;
  approvalMode: ApprovalModeName;
  hostKey: string;
  status: SessionStatus;
  turnId?: string;
  contributorMode: boolean;
  preset?: string;
  worktree?: "off" | "create" | "existing";
  worktreePath?: string;
  fingerprintWarning?: string;
  /** Cumulative stream delta sends that failed for this session. */
  streamDroppedDeltas?: number;
  lastAnswer?: string;
  lastTerminal?: string;
  createdAt: string;
  updatedAt: string;
}

interface StateFile {
  sessions: Record<string, SessionRecord>;
}

export class SessionStore {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  path(): string {
    return join(this.home, "state.json");
  }

  /** Load records. Live statuses from a previous process become orphaned. */
  load(): SessionRecord[] {
    const file = this.read();
    let changed = false;
    for (const record of Object.values(file.sessions)) {
      if (record.status === "idle" || record.status === "running") {
        record.status = "orphaned";
        changed = true;
      }
    }
    if (changed) this.write(file);
    return Object.values(file.sessions);
  }

  list(): SessionRecord[] {
    return Object.values(this.read().sessions);
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.read().sessions[sessionId];
  }

  upsert(record: SessionRecord): void {
    const file = this.read();
    file.sessions[record.sessionId] = record;
    this.write(file);
  }

  private read(): StateFile {
    const parsed = JSON.parse(readFileSync(this.path(), "utf8")) as StateFile;
    if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)) {
      throw new Error(`state file is corrupt: ${this.path()} has no sessions object`);
    }
    return parsed;
  }

  private write(file: StateFile): void {
    writeFileSync(this.path(), JSON.stringify(file, null, 2) + "\n");
  }
}
