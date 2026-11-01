import { spawn } from "node:child_process";

/** Bytes of body, stdout, and stderr kept or accepted. */
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 15_000;

export interface MessageInput {
  action: "list" | "send";
  target?: string;
  body?: string;
  in_reply_to?: string;
  display_context?: unknown;
}

export interface MessageResult {
  action: "list" | "send";
  exit_code: number;
  /** Parsed stdout. Present only when stdout is one JSON value. */
  result: unknown;
  stderr: string;
}

/** A session-message process that started and then failed to produce JSON. */
export class SessionMessageError extends Error {
  readonly exitCode?: number;

  constructor(message: string, exitCode?: number) {
    super(message);
    this.name = "SessionMessageError";
    this.exitCode = exitCode;
  }
}

/**
 * Run `muse session-message`. A non-zero exit whose stdout is one JSON value
 * is a result: closed ingress is exit 1 plus `error_code`. Spawn failures,
 * timeouts, and non-JSON output throw.
 */
export function runSessionMessage(
  bin: string,
  input: MessageInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MessageResult> {
  if (input.action !== "list" && input.action !== "send") {
    throw new Error("action must be list or send");
  }
  const argv = ["session-message", input.action, "--json"];
  let body: string | undefined;
  if (input.action === "send") {
    if (!input.target) throw new Error("send requires target");
    if (input.body === undefined || input.body.length === 0) throw new Error("send requires body");
    if (Buffer.byteLength(input.body) > MAX_BYTES) throw new Error("body exceeds 64 KiB");
    argv.push("--target", input.target);
    if (input.in_reply_to) argv.push("--in-reply-to", input.in_reply_to);
    if (input.display_context !== undefined) argv.push("--display-context", displayContextArg(input.display_context));
    body = input.body;
  }
  return spawnMessage(bin, argv, body, env, input.action);
}

export function messageErrorCode(result: unknown): string | undefined {
  if (result === null || typeof result !== "object" || Array.isArray(result) || !("error_code" in result)) {
    return undefined;
  }
  const code = (result as { error_code: unknown }).error_code;
  return typeof code === "string" ? code : undefined;
}

function displayContextArg(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("display_context must be a JSON object");
  }
  return JSON.stringify(value);
}

function spawnMessage(
  bin: string,
  argv: string[],
  body: string | undefined,
  env: NodeJS.ProcessEnv,
  action: MessageInput["action"],
): Promise<MessageResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error?: Error, result?: MessageResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result as MessageResult);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new SessionMessageError("muse session-message timed out after 15s"));
    }, TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes = pushCapped(stdout, stdoutBytes, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = pushCapped(stderr, stderrBytes, chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8").trimEnd();
      let parsed: unknown;
      try {
        parsed = JSON.parse(out);
      } catch {
        const snippet = (err || out.trim()).slice(0, 500);
        finish(
          new SessionMessageError(
            `muse session-message exited ${exitCode} without JSON${snippet ? `: ${snippet}` : ""}`,
            exitCode,
          ),
        );
        return;
      }
      finish(undefined, { action, exit_code: exitCode, result: parsed, stderr: err });
    });

    if (body === undefined) child.stdin?.end();
    else child.stdin?.end(body);
  });
}

function pushCapped(parts: Buffer[], received: number, chunk: Buffer): number {
  if (received >= MAX_BYTES) return received;
  const slice = chunk.subarray(0, MAX_BYTES - received);
  parts.push(slice);
  return received + slice.length;
}
