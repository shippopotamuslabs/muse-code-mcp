# Muse MCP

Stdio MCP server that lets any MCP client spawn and drive Muse Code agents on this machine. The server speaks MSP (Muse Session Protocol): newline-delimited JSON-RPC 2.0 to a long-lived `muse serve` host. Sessions outlive turns. Approvals and user-input prompts arrive as server requests while a turn is live, and the client answers them through tools.

Muse Code stays the billing client. This server never reads, stores, prints, or forwards Muse OAuth tokens, API keys, or `~/.config/muse/auth.json`.

## Default approval mode is yolo

**Spawned sessions default to `approval_mode = "yolo"`.** On the wire that is permission profile `:unrestricted` and `approvalMode: allowAll`. Tool calls are not held for a person. The shipped `~/.muse-mcp/config.toml` has an empty `auto_approve` list, so nothing is auto-approved by policy unless you add a rule. The sandbox stays on: yolo does not pass `--disable-sandbox`.

This is the standing posture for agents on your own machine. It is the wrong default for a shared or untrusted workspace. Pass `approval_mode: "on-request"` (`:ask-me`) or `"judge"` (`:auto-review`) on `muse_spawn`, or set `approval_mode` in the config file, when you want a gate.

## Why TypeScript

Phase 0 matched the installed CLI (Muse Code 1.4.14) to `@muse-code/sdk@1.4.14` on schema fingerprint `sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6`. The SDK is the official MSP client, has no runtime dependencies, and already implements framing, `initialize`, session folds, and the approval handshake. Node on this machine is v24, which runs the sources with `--experimental-strip-types`, so the server is TypeScript with no compile step. `MuseClient` is not the seam: `session/start.worktree` is experimental and only the raw `Connection` can send it.

## Run

Requires Node 20+ and `muse` on `PATH` (override with `MUSE_MCP_BIN`).

```bash
npm install
./bin/muse-mcp
```

The process speaks MCP on stdin/stdout and opens no port. State lives in `~/.muse-mcp/` (`MUSE_MCP_HOME`):

| File | Role |
| --- | --- |
| `config.toml` | Written on first start if missing. |
| `state.json` | Sessions this server started. After a restart, idle and running rows load as `orphaned` and resume on next use. |
| `audit.log` | Append-only JSONL of requests, decisions, answers, expiries, and refusals. |

One `muse serve` host is kept per workspace + contributor mode + preset + trust. A crashed host restarts on the next call. Its sessions are marked `orphaned` and resumed with `session/resume` when the protocol allows. `sessionInUse` is returned to the caller and not retried: this server does not attach to a session an interactive TUI already owns, and it only drives sessions it started.

## Tools

| Tool | What it does |
| --- | --- |
| `muse_spawn` | Start a session and optionally its first turn. Returns `{session_id, turn_id, status}` immediately unless `wait` is true. |
| `muse_turn` | Follow-up turn on a session this server started. |
| `muse_steer` | Mid-turn input. Requires the running turn id. Idle sessions error and send no frame. |
| `muse_pending` | Pending approvals and questions: request id, session, kind, payload, age. |
| `muse_answer` | Answer a pending question (`request_id`, `answer`). |
| `muse_decide` | `approve` or `deny` a pending approval. Deny can include `reason`. |
| `muse_status` | One session or all: state, turn, model, workspace, token usage, pending counts. |
| `muse_result` | Latest completed turn, final answer text, and a short in-memory event tail. |
| `muse_cancel` | Cancel the current turn. |
| `muse_close` | End a session. |
| `muse_raw` | Send any MSP method with raw params. Credential methods are refused before a frame is written. |

`muse_answer` and `muse_decide` take an optional `actor` of `user` or `orchestrator` (default `orchestrator`). Policy decisions are logged as `policy`. Unanswered approvals expire to deny and unanswered questions are cancelled after `pending_timeout_sec` (default 1800). If the MCP client advertises elicitation, pending items are also offered that way. The tools still work when it does not.

`muse_spawn` arguments: `workspace` (required, absolute, must exist), `prompt` or `prompt_file`, `model`, `reasoning_effort` (`none|minimal|low|medium|high|xhigh|max|ultra`), `preset`, `worktree` (`off|create|existing`) with `worktree_base` or `worktree_path`, `approval_mode` (`yolo|on-request|judge`), `contributor_mode` (default false), `wait` (default false). There is no `output_schema` argument. MSP has no field for it.

Tool arguments win over environment variables, which win over `config.toml`.

| Env | Effect |
| --- | --- |
| `MUSE_MCP_BIN` | Muse binary. Default `muse`. |
| `MUSE_MCP_HOME` | State directory. Default `~/.muse-mcp`. |
| `MUSE_MCP_MODEL` | Model when a spawn omits `model`. |
| `MUSE_MCP_REASONING_EFFORT` | Effort when a spawn omits `reasoning_effort`. |
| `MUSE_MCP_APPROVAL_MODE` | `yolo`, `on-request`, or `judge`. |
| `MUSE_MCP_PENDING_TIMEOUT_SEC` | Pending-request timeout. |

`auto_approve` rules are `{ match = "<regex>", decision = "approve" }`. `match` is tested against one line of tool name, subject kind, command, host, path, and raw args. A hit approves with the once-only choice and is audit-logged as `policy`.

## Streaming

Rich clients can watch turns live instead of polling `muse_result`. Streaming is opt-in: a client declares the experimental capability `muse.stream` in its initialize capabilities. A client that does not declare it receives no stream traffic and its tool results are unchanged.

```json
{ "capabilities": { "experimental": { "muse.stream": {} } } }
```

The server sends one notification method, `notifications/muse/event`, with a plain JSON event object as params:

| Field | Meaning |
| --- | --- |
| `type` | `turn-started`, `item-started`, `item-delta`, `item-completed`, `turn-completed`, `usage`, or `pending`. |
| `sessionId` | The session the event belongs to. Events cover every session on the connection. |
| `turnId` | Present when the host frame carries one. |
| `viewCursor` | The host view cursor, verbatim, on item, usage, and turn-completed events (`turn-started` carries none). Strictly increasing per session; a jump means a gap. |
| `item` | The full item object on `item-started` and `item-completed`. Passed through uninterpreted. |
| `itemId`, `field`, `delta` | On `item-delta`: the item, the dotted field path (`"text"` when the host omits it), and the appended text. |
| `terminal`, `answer` | On `turn-completed`: the turn's terminal word and its final answer text. |
| `droppedDeltas` | On `turn-completed`: delta events whose send failed during that turn. `muse_status` reports the same count cumulatively as `stream_dropped_deltas`. |
| `usage`, `usageKind` | On `usage`: the host's raw token-usage params, plus which frame they came from: `tokenUsage` (a cumulative snapshot) or `changed` (a change notice). |
| `requestId`, `kind`, `phase` | On `pending`: a hint that an approval or user-input request was `requested` or `settled`. |

Client guidance:

- Text deltas for one item field are coalesced over 30 ms, so a delta event may carry several host deltas merged. Concatenating a field's delta events in order rebuilds the field, with one exception: if the host surface saturated, the concatenation can fall short. `item-completed` carries the full item and is authoritative. Reconcile from it.
- A `pending` event is a signal to call `muse_pending`, which stays the source of truth for approval and question payloads. Approvals and questions still arrive through elicitation and the broker exactly as before.
- A client that cannot keep up loses delta events, never the turn. Sends never block the host, failures are counted in `droppedDeltas`, and the first failure per turn is written to the audit log. The `turn-completed` event waits, up to 250 ms, for the turn's in-flight delta sends to settle before its count is stamped; sends that outlive the wait, and the count on a `turn-completed` whose own send fails, still land in the cumulative `stream_dropped_deltas` in `muse_status`, which persists across restarts.

## Register with Grok Build

User scope writes `~/.grok/config.toml`:

```bash
grok mcp add muse-mcp -- /path/to/muse-code-mcp/bin/muse-mcp
```

## Generic MCP client

```json
{
  "mcpServers": {
    "muse-mcp": {
      "command": "/path/to/muse-code-mcp/bin/muse-mcp",
      "args": []
    }
  }
}
```

The server makes no Grok-specific calls. The same command works in Cursor or any other stdio MCP client.

## Protocol notes

`docs/PROTOCOL.md` is the source of truth where it disagrees with any summary. Short version:

- `yolo` / `on-request` / `judge` are public names. The wire values are `:unrestricted`+`allowAll`, `:ask-me`+`onRequest`, and `:auto-review`+`onRequest`. Both the profile and the approval mode are always sent. Omitting the profile on this machine produced no approval prompts.
- Approve selects the once-only `approved` choice (`allow_once`). Deny selects `abort` on this host and passes `reason` when that choice accepts feedback.
- `worktree` is the experimental `session/start.worktree` field. `off` omits it. On this machine, create and attach against a repository Muse has not marked trusted fail with `-32029` `workspaceNotTrusted`. `--trust-workspace` loads skills and rules and does not grant that trust. The server returns the host error and does not run `git worktree`.
- `--preset` and `--contributor-mode` are host process flags, not session fields. Contributor mode is sent as `off` unless the caller sets it.
- No MSP equivalent, so these `muse exec` knobs are not exposed: `--output-schema`, `--max-model-steps`, `--user-input-auto-resolve`.
- `muse session-message list --json` returned `external_agent_ingress_closed`. `muse_message` is not implemented.

`muse_raw` refuses methods under `account/`, `mcpServer/oauth`, and any method whose name contains `login` or `logout`, and writes an audit line with the method name only.

## Tests

```bash
npm test
npm run typecheck
```

`npm test` uses a scripted fake `muse serve`. It does not launch the real CLI.

Live checks against the installed `muse` are off unless you opt in. They spend model calls:

```bash
MUSE_MCP_LIVE=1 node --experimental-strip-types --test --test-timeout=300000 test/live.test.ts
```

## License

Licensed under the 0BSD license (see `LICENSE`).

This is an independent project. It is not affiliated with or
endorsed by Meta. Muse and Muse Code are trademarks of Meta
Platforms, Inc.
