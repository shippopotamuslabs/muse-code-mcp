import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AuditActor = "user" | "orchestrator" | "policy";

export type AuditKind = "request" | "decision" | "answer" | "expiry" | "refuse" | "error";

export interface AuditEvent {
  ts?: string;
  kind: AuditKind;
  actor?: AuditActor;
  sessionId?: string;
  requestId?: string;
  detail?: unknown;
}

export function auditPath(home: string): string {
  return join(home, "audit.log");
}

/** Append one complete JSON line. A crash after this write cannot tear the line. */
export function appendAudit(home: string, event: AuditEvent): void {
  const line = JSON.stringify({ ...event, ts: event.ts ?? new Date().toISOString() }) + "\n";
  appendFileSync(auditPath(home), line);
}

export function readAudit(home: string): AuditEvent[] {
  const raw = readFileSync(auditPath(home), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEvent);
}
