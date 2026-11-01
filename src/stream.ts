import type { HostFrame } from "./host.ts";

/**
 * The stream contract for rich clients (see plans/streaming/plan.md).
 * Events are plain JSON objects sent as `notifications/muse/event` params.
 * `item/completed` is authoritative: delta text for a field concatenates to
 * the field value on the completed item unless the host surface saturated.
 */
export type StreamEventType =
  | "turn-started"
  | "item-started"
  | "item-delta"
  | "item-completed"
  | "turn-completed"
  | "usage"
  | "pending";

export interface StreamEvent {
  type: StreamEventType;
  sessionId: string;
  /** Host view cursor, verbatim. Strictly monotonic per session. Present on item, usage, and turn-completed events; turn-started carries none. */
  viewCursor?: string;
  turnId?: string;
  /** Full item object on item-started and item-completed. Passed through, never interpreted. */
  item?: unknown;
  itemId?: string;
  /** Dotted field path a delta appends to. Defaults to "text". */
  field?: string;
  delta?: string;
  /** Turn terminal word on turn-completed ("completed", "cancelled", ...). */
  terminal?: string;
  /** Final agent text on turn-completed, as `muse_result` would report it. */
  answer?: string;
  /** Delta events whose send failed during this turn. Loss is a value, never silent. */
  droppedDeltas?: number;
  /** Raw usage params on usage events (`session/tokenUsage` or `usage/changed`). */
  usage?: unknown;
  /** Which host frame a usage event came from: a cumulative snapshot or a change notice. */
  usageKind?: "tokenUsage" | "changed";
  /** Pending hint fields. A hint means "refresh muse_pending"; muse_pending is the truth. */
  requestId?: string;
  kind?: "approval" | "userInput";
  phase?: "requested" | "settled";
}

export type StreamSink = (event: StreamEvent) => void | Promise<void>;

/** Translate one host frame into a stream event. Unmapped frames return undefined. */
export function translateFrame(frame: HostFrame): StreamEvent | undefined {
  const params = isRecord(frame.params) ? frame.params : undefined;
  if (!params) return undefined;
  const sessionId = str(params, "sessionId");
  if (!sessionId) return undefined;
  const base: StreamEvent = { type: "usage", sessionId };
  const viewCursor = str(params, "viewCursor");
  if (viewCursor) base.viewCursor = viewCursor;
  const turnId = str(params, "turnId");
  if (turnId) base.turnId = turnId;
  switch (frame.method) {
    case "turn/started":
      return { ...base, type: "turn-started" };
    case "turn/completed": {
      const event: StreamEvent = { ...base, type: "turn-completed" };
      const terminal = str(params, "terminal");
      if (terminal) event.terminal = terminal;
      return event;
    }
    case "item/started":
      return { ...base, type: "item-started", item: params.item };
    case "item/completed":
      return { ...base, type: "item-completed", item: params.item };
    case "item/delta": {
      const itemId = str(params, "itemId");
      const delta = str(params, "delta");
      if (!itemId || delta === undefined) return undefined;
      return { ...base, type: "item-delta", itemId, field: str(params, "field") ?? "text", delta };
    }
    case "session/tokenUsage":
      return { ...base, type: "usage", usageKind: "tokenUsage", usage: params };
    case "usage/changed":
      return { ...base, type: "usage", usageKind: "changed", usage: params };
    case "approval/requested":
    case "approval/request": {
      // Both names describe the same approval: the view frame and the
      // host's synthesized request frame. MuseService dedupes the hint.
      const requestId = str(params, "approvalId");
      if (!requestId) return undefined;
      return { ...base, type: "pending", requestId, kind: "approval", phase: "requested" };
    }
    case "approval/resolved": {
      const requestId = str(params, "approvalId");
      if (!requestId) return undefined;
      return { ...base, type: "pending", requestId, kind: "approval", phase: "settled" };
    }
    case "userInput/requested": {
      const requestId = str(params, "userInputId");
      if (!requestId) return undefined;
      return { ...base, type: "pending", requestId, kind: "userInput", phase: "requested" };
    }
    case "userInput/settled": {
      const requestId = str(params, "userInputId");
      if (!requestId) return undefined;
      return { ...base, type: "pending", requestId, kind: "userInput", phase: "settled" };
    }
    default:
      return undefined;
  }
}

interface BufferedDelta {
  event: StreamEvent;
  since: number;
}

/**
 * Merges rapid `item/delta` events per (session, item, field) and flushes
 * every `flushMs`. A non-delta event flushes its session's buffered deltas
 * first, so per-session order always holds. The clock is injected so tests
 * are deterministic; the owner calls `tick()` on a timer.
 */
export class Coalescer {
  private readonly buffers = new Map<string, BufferedDelta>();
  private readonly flushMs: number;
  private readonly now: () => number;
  private readonly sink: (event: StreamEvent) => void;

  constructor(options: { sink: (event: StreamEvent) => void; flushMs?: number; now?: () => number }) {
    this.sink = options.sink;
    this.flushMs = options.flushMs ?? 30;
    this.now = options.now ?? Date.now;
  }

  push(event: StreamEvent): void {
    if (event.type !== "item-delta") {
      this.flushSession(event.sessionId);
      this.sink(event);
      return;
    }
    const key = `${event.sessionId}\0${event.itemId ?? ""}\0${event.field ?? "text"}`;
    const existing = this.buffers.get(key);
    if (existing) {
      existing.event = {
        ...existing.event,
        delta: (existing.event.delta ?? "") + (event.delta ?? ""),
        ...(event.viewCursor ? { viewCursor: event.viewCursor } : {}),
      };
      return;
    }
    this.buffers.set(key, { event, since: this.now() });
  }

  tick(): void {
    const at = this.now();
    for (const [key, buffered] of this.buffers) {
      if (at - buffered.since < this.flushMs) continue;
      this.buffers.delete(key);
      this.sink(buffered.event);
    }
  }

  flushSession(sessionId: string): void {
    for (const [key, buffered] of this.buffers) {
      if (buffered.event.sessionId !== sessionId) continue;
      this.buffers.delete(key);
      this.sink(buffered.event);
    }
  }

  flushAll(): void {
    for (const buffered of this.buffers.values()) this.sink(buffered.event);
    this.buffers.clear();
  }
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
