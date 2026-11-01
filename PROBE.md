# PROBE — Muse Code 1.4.14 on this machine

Status words: the captures below are **probed**. The server that follows them is **implemented** and **unit-verified** against a fake host that replays these shapes. Live calls through the server are recorded separately and are not claimed here.

Captured 2026-11-01. CLI: `Muse Code 1.4.14 (1.4.14-R7309.1)`. Binary: `muse` on `PATH` (`~/.local/bin/muse` is a wrapper; this probe did not read it). No auth file was read, printed, or copied.

## SDK choice

**Chose `@muse-code/sdk@1.4.14`.** `muse schema` and the package pin the same stable fingerprint:

`sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6`

The live `initialize` result returned that exact fingerprint (`probe/logs/handshake.jsonl`). The SDK is the TypeScript client for MSP, zero runtime dependencies, Node 20+. This machine is Node v24.14.0. The server drives the public `spawnMspConnection` / `Connection` / `Session` layer rather than `MuseClient`, because `session/start.worktree`, `turn/steer`, `turn/cancel`, `session/leave`, and `muse_raw` need the connection. `MuseClient.startSession` does not forward the experimental worktree field.

Fingerprint drift is a warning (`checkServedFingerprint`), not a failed handshake.

## Divergences from the build brief

The CLI schema wins.

- Public `approval_mode` stays `yolo | on-request | judge`. The wire values are not those words. `yolo` sends permission profile `:unrestricted` and `approvalMode: allowAll`. `on-request` sends `:ask-me` and `onRequest`. `judge` sends `:auto-review` and `onRequest`. CLI flags `untrusted | on-request | never`, `--yolo`, and `--approval-judge` are not MSP fields.
- Profiles come from experimental `permissionProfile/list` (requires `experimentalApi: true`). On this host the ids that exist are `:read-only`, `:ask-me`, `:auto-review`, `:unrestricted`. Guessed ids (`:workspace`, `:untrusted`, `:default`, `read-only`) return `-32030 commandRejected` / `permission_profile_unknown`. Calling `permissionProfile/list` without experimental API returns `-32601 experimentalRequired`.
- This machine's Muse settings default the profile to `:unrestricted`. Omitting `permissionProfile` produced **zero** `approval/request` frames even with `approvalMode: onRequest`. The server always sends both.
- Under `:ask-me`, `echo hello` and a workspace `write_file` did not prompt. A new network host did. The subject was `kind: network`, `toolName: network`, `host: example.com`, shell command absent. The policy match line is tool name, subject kind, command, host, path, subject tool name, and raw args.
- This host's reject choice is `choiceId: abort`, `decision: abort`, `scope: once`, `acceptsFeedback: true`, label "Reject". There is no `decision: denied` choice. A plain approve must pick `approved` + `scope: once` (`allow_once`), never `allow_session` or `allow_local_network`.
- `session/start.worktree` is experimental: `{mode:"create", baseRef?}` or `{mode:"existing", path}`. It is absent from the stable `session/start` params. Sending it requires `experimentalApi: true`. A live start through the server failed. The server returned the host error and did not run `git worktree`. See "Live worktree start" below.
- No MSP field, stable or experimental, for `muse exec --output-schema`, `--max-model-steps`, or `--user-input-auto-resolve`. Those knobs are not on the tool schema. `pending_timeout_sec` is this server's timer, not the exec flag. User-input also has the host's own `autoResolutionMs` and `userInput/cancel`.
- `--preset` and `--contributor-mode` are host-lifetime flags (`muse serve`), not per-session wire fields. The server pools one host per workspace + contributor + preset + trust. Sandbox stays on. `yolo` does not pass `--disable-sandbox`. `--trust-workspace` is passed so workspace skills load. Contributor mode is passed explicitly `off` unless the caller sets it, because this machine's settings have contributor mode on.
- `session-message list --json` returned `{"schema_version":1,"status":"unavailable","error_code":"external_agent_ingress_closed"}`. Inter-session messaging is gated off. It is not implemented.
- `turn/steer` idle refusal is schema-mined (`expectedTurnId` must be the running turn) and unit-verified against the fake. It was not part of the live probe.
- Goal and compaction methods are reachable through `muse_raw` only.

## Handshake (probed, passing)

Host: `muse serve --trust-workspace`. Client `initialize` then notification `initialized`. Session `01a1982b-5b01-7b03-a4c3-3a55bb597ebb`, model `muse-spark-1.3`, turn `01a1982b-5bca-7790-8fc9-46936238bf77`, disposition `started`, status `accepted`. Prompt: "Reply with exactly: MSP OK". `reasoningEffort: minimal`. Final agent message text: `MSP OK`. `turn/completed` terminal `completed`. `session/tokenUsage` cumulative prompt 57064, output 16, total 57080; that completion's usage included reasoning tokens 5 and `durationMs` 2069. Stdin EOF did not reap the host within 8 seconds; the probe sent SIGTERM. The server uses the SDK's EOF, drain, then signal shutdown.

Full frames: `probe/logs/handshake.jsonl`.

## User input (probed, passing)

Session `01a1982c-d563-7fb2-a17d-48eacfbdd964`, turn `01a1982c-d5e6-7fd9-82d9-6f13f0f279df`. The agent called tool `request_user_input`. Server request `userInput/request` (and the `userInput/requested` twin) carried `userInputId` `01a1982c-dede-7233-86c9-434886d4a28c`, question id `filename`, options `alpha.txt` and `beta.txt`. The client answered `userInput/answer` with `selectedLabel: beta.txt`. `userInput/settled` outcome `answered`. The turn completed. Scratch file `/tmp/muse-mcp-probe-rt/beta.txt` contains `picked`.

`userInput/answer` answers must match the offered options or the host returns `-32057 userInputAnswerInvalid`. Free text is limited to 500 characters. The presentation receipt for the server request is `{}`; the answer is a later command.

Full frames: `probe/logs/roundtrip.jsonl`.

## Approval (probed, passing)

Profile `:ask-me`, `approvalMode: onRequest`, spawn `muse serve --contributor-mode off` (sandbox left on).

`echo hello` on session `01a1982e-fddc-7573-b068-24ad4fff2683` completed with no `approval/request`.

`curl https://example.com` on session `01a1982f-1b7d-7293-a7da-e673d53d38df` raised approval `01a1982f-2b1a-70b2-b919-ba403bff4786` (tool `network`, host `example.com`). The client sent `approval/decide` choice `allow_once`. `approval/resolved` decision `approved`, `resolvedBy: user`, `policyResult: allow`. The turn completed.

Deny, separate log: session `01a19832-3b8b-77b2-8092-c2872dfb3f61`, turn `01a19832-3c15-75d2-8c97-4957b4a12304`, approval `01a19832-48b9-7ed0-b41f-356a2e8057ed`, host `example.net`. Decide choice `abort` with feedback `probe deny: do not run this command`. Resolved decision `abort`, `resolvedBy: user`, `policyResult: deny`. Final answer text: `DENIED`.

`probe/logs/approval.jsonl` also contains an earlier example.org turn from a probe attempt that did not answer on the first request. The clean deny round-trip is `probe/logs/deny.jsonl`.

`approval/decide` also requires `requirementId` equal to the request's `currentRequirementId`. The SDK's `onApproval` path sends that. The server holds the handler's promise until `muse_decide`, policy, or timeout, and returns the presentation receipt `{}` immediately.

## Live spark scout (live-verified)

`MUSE_MCP_LIVE=1` ran `test/live.test.ts` on 2026-11-01. `muse_spawn` of `muse-spark-1.3` with `reasoning_effort: minimal`, `approval_mode: yolo`, `wait: true`, and prompt `Reply with exactly: LIVE OK` returned status `completed` and `muse_result` matched `/LIVE OK/`. Duration about 4.2s. No error text.

## Live question, approval, and a second session (live-verified)

A later `MUSE_MCP_LIVE=1` run, after the worktree start below was left as a surfaced error, spawned two sessions. The first used `approval_mode: on-request` and no worktree. It asked a `request_user_input` question (`alpha.txt` / `beta.txt`). The test answered `beta.txt` with actor `user`. It then raised an approval. The test decided `approve` with actor `orchestrator`. The turn finished. The audit log contained an `answer` from `user` and a `decision` from `orchestrator`. A second session, on another directory, with `approval_mode: yolo` and prompt `Reply with exactly: PARALLEL`, completed with that text and was still intact after the first session finished. Duration of that test was about 13s. The written file check accepts either `beta.txt` in the workspace or those words in the final answer.

## Live worktree start (failed; surfaced, not worked around)

The same suite, and an earlier run, spawned a session with `worktree: "create"` against a fresh git repo under `/tmp`. The host was `muse serve --contributor-mode off --trust-workspace` with `cwd` set to that repo, and `initialize` had `experimentalApi: true`. `session/start` included `worktree: { mode: "create" }`. The live test now expects this rejection. No `git worktree` command was run.

Verbatim error:

```
Error [MspError]: Repository '/tmp/muse-mcp-live-wt-Av44wJ' is not trusted; worktree create, attach, and list require a trusted repository.
    at #response (file:///home/sean/Code/muse-code-mcp/node_modules/@muse-code/sdk/dist/src/connection/connection.js:527:24)
    code: -32029,
    kind: 'workspaceNotTrusted',
    data: { kind: 'workspaceNotTrusted', path: '/tmp/muse-mcp-live-wt-Av44wJ', retryable: false },
    retryable: false
```

`--trust-workspace` on a stdio host loads skills and rules. The schema's project-trust error (ADR 31776) is a different gate, and `session/start.limits.workspaceTrusted` is documented as socket-only. No `git worktree` command was run. The question and approval half of this live test did not start, because `session/start` failed first.

## session-message (probed, not built)

`muse session-message list --json` → `external_agent_ingress_closed`. Ingress depends on `MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS` / `MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING` having been set when the target processes started. Stretch goal only.

## Option map

| muse exec / CLI | MSP |
| --- | --- |
| `--model` | `session/start.modelId`, `session/resume.modelId`, `session/setModel`. Omitted means the host's configured model (`muse-wonder-full-1.0` on this machine). |
| `--reasoning-effort` none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra | `session/setReasoningEffort` and `turn/start.reasoningEffort` / `turn/steer.reasoningEffort`. CLI default is high. |
| `--preset` | Host argv `muse serve --preset`. Not a session field. Pool key. |
| `-w/--worktree` off\|create\|existing, `--worktree-base`, `--worktree-existing` | Experimental `session/start.worktree`. `off` omits the field. |
| `--permission-profile` | `session/start.permissionProfile` / `session/resume.permissionProfile`. |
| `--approval-mode`, `--yolo`, `--approval-judge` | Not wire names. Mapped as in Divergences. `session/setApprovalMode` exists for a later change. |
| `--contributor-mode on\|off` | Host argv. Pool key. Server default `off`. |
| `--trust-workspace` | Host argv. Server default on. |
| `--output-schema` | No MSP field. Omitted. |
| `--max-model-steps` | No MSP field. Omitted. |
| `--user-input-auto-resolve` | No MSP field. Omitted. Server `pending_timeout_sec` (default 1800) denies stale approvals and cancels stale questions. |
| `--workspace` / cwd | `session/start.workspaceRoot`. |
| `--no-session-log`, `--disable-sandbox`, `--disable-write`, `--disable-shell`, `--sandbox-network`, `-c` | Host argv. Not exposed. Sandbox stays on. |
| `model/list` ids seen | `muse-wonder-1.0`, `muse-wonder-full-1.0`, `muse-spark-1.3`, `muse-spark-1.2`. |

## Method catalog

Stable methods, notifications, and server requests are the lists `muse schema generate-ts` wrote. Experimental adds the lines that follow. Generated files were `/tmp/muse-msp-schema` and `/tmp/muse-msp-schema-exp` (not committed; the lists below are the export).

### Stable methods

```
initialize
subagent/sendMessage
subagent/followupTask
subagent/interrupt
subagent/stop
subagent/resume
subagent/reopen
subagent/close
subagent/readResult
session/start
session/resume
session/fork
session/leave
session/list
session/read
session/sideChat
turn/start
turn/steer
turn/interrupt
turn/cancel
turn/unqueue
session/compact
session/setModel
session/rename
session/setReasoningEffort
session/userShell
model/list
skill/list
skill/setActivation
skill/import
hook/list
plugin/list
plugin/install
plugin/marketplaceAdd
plugin/marketplaceUpdate
plugin/marketplaceRemove
task/background
task/stop
task/stopAll
task/list
goal/set
goal/edit
goal/clear
goal/pause
goal/resume
workflow/cancel
workflow/childControl
workflow/pause
workflow/resume
media/upload
view/subscribe
view/unsubscribe
view/page
item/readOutput
approval/decide
approval/listPending
session/setApprovalMode
userInput/answer
userInput/cancel
userInput/clarify
userInput/interrupt
usage/read
feedback/submit
recap/request
recap/cancel
computerUseSettings/read
computerUseSettings/update
computerUseSetup/read
computerUseSetup/start
computerUseSetup/check
```

### Stable notifications

```
initialized
session/started
session/closed
session/leaveCompleted
skill/changed
turn/started
turn/completed
turn/retracted
turn/retryScheduled
turn/modelRetryScheduled
turn/unqueued
turn/foregroundCompleted
item/started
item/updated
item/delta
item/completed
view/gap
approval/requested
approval/updated
approval/reviewing
approval/resolved
userInput/requested
userInput/settled
userInput/engaged
session/modelChanged
session/reasoningEffortChanged
session/statusChanged
session/goalChanged
session/todoListChanged
session/branchChanged
session/tokenUsage
session/contextUsage
session/approvalModeChanged
recap/completed
session/modelRouteUnserved
session/nameChanged
session/viewHealthChanged
session/listChanged
usage/changed
computerUseSetup/changed
plugin/changed
plugin/marketplaceChanged
monitor/inboxItemAdmitted
monitor/inboxItemDrained
monitor/inboxItemVoided
```

### Stable server requests

```
approval/request
userInput/request
```

### Experimental methods not in the stable list

```
session/requestDrive
session/releaseDrive
session/promptHint
session/reportStartupPhases
session/readLimits
host/readLimits
session/setPermissionProfile
permissionProfile/list
account/read
account/loginStart
account/loginCancel
account/logout
mcpServer/oauthLogin
mcpServer/oauthLoginCancel
mcpServer/oauthLogout
mcpServer/list
usage/refresh
log/streams
log/page
log/subscribe
log/unsubscribe
log/physicalSubscribe
log/physicalUnsubscribe
log/physicalFiles
projection/list
projection/read
worktree/list
settings/read
settings/readSchema
settings/writeValue
settings/writeMany
peer/list
admission/decide
admission/listPending
peer/settlements
```

### Experimental notifications not in the stable list

```
session/driveChanged
session/permissionProfileChanged
account/changed
account/loginCompleted
mcpServer/oauthLoginCompleted
log/record
log/gap
log/physicalLine
log/physicalReset
admission/requested
admission/resolved
peer/settlementsChanged
```

### Experimental server requests not in the stable list

```
admission/request
```

View-stream names the server folds: `item/started`, `item/delta`, `item/completed`, `turn/started`, `turn/completed`, `session/tokenUsage`, `usage/changed`, `approval/requested`, `approval/resolved`, `userInput/requested`, `userInput/settled`. Goal methods (`goal/set`, `goal/edit`, `goal/clear`, `goal/pause`, `goal/resume`) and `session/compact` are `muse_raw` only.

## Verbatim help

The same bytes are in `probe/help/`.

### muse --version

```
Muse Code 1.4.14 (1.4.14-R7309.1)
```

### muse --help

```
muse — interactive terminal coding agent

If no subcommand is given, options run the interactive TUI; pass a prompt to start
a session, or use a command below.

Usage: muse [OPTIONS] [PROMPT]
       muse [OPTIONS] <COMMAND>

Commands:
  resume           Resume a previous session (--last or <session-ref>)
  exec             Run one prompt non-interactively (headless)
  config           Validate enterprise configuration documents
  export           Export a session transcript to a file
  trace            Inspect a recorded session or run trace
  model-profile    Show what a model resolves to per knob and effort tier
  skills           List, inspect, enable, or disable skills
  voice            Transcribe an audio clip into text
  plugins          Validate and manage plugin bundles
  sandbox          Check or set up the OS sandbox
  schema           Export the MSP wire schema (JSON Schema or TypeScript)
  serve            Serve an MSP session host over stdio
  session-message  List or send cross-session messages
  mcp              Log in to or out of an MCP server (OAuth)
  auth             Store provider API credentials
  login            Log in to a provider
  logout           Remove stored provider credentials
  usage            Show your subscription allowance
  init             Scaffold agent config in this workspace

Options:
  -h, --help
          Print help
  -V, --version
          Print version
      --agents <JSON>
          Supply one ephemeral agent-definition overlay
      --provider <MODE>
          Startup provider: echo, meta, or local (default: meta)
      --preset <NAME>
          Run a built-in preset: native-basic, miniswe, empty, ac_orch,
          openai-apply-patch
      --model <MODEL>
          Model id for non-echo providers
      --contributor-mode <on|off>
          Per-run contributor mode override (this run only; never persisted)
  -c, --config <KEY=VALUE>
          Set one setting for this run (repeatable; values are JSON). Secrets
          only as whole-value ${VAR}; unknown or clashing keys refuse the run.
      --reasoning-effort <EFFORT>
          Meta reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra
          (default: high; alias: --effort)
      --base-url <URL>
          Override the Meta provider base URL
      --image <PATH>
          Attach a local image file to the next submitted prompt
      --workspace <PATH>
          Register policy-gated workspace tools rooted at PATH
  -w, --worktree [<MODE>]
          Session Git worktree: off|create|existing; a bare -w means create
          (default: off)
      --worktree-base <REF>
          Base ref for --worktree create (default: HEAD)
      --worktree-existing <PATH>
          Existing worktree path for --worktree existing
      --parallel-tool-calls
          Enable Meta API parallel tool calls
      --no-parallel-tool-calls
          Disable Meta API parallel tool calls
      --subagent-worktree-isolation
          Compatibility flag; capability defaults on. Only an affirmative
          per-child request asks for isolation; omission stays shared. Requests
          may reject when capability, provider, or Git prerequisites are
          unavailable.
      --approval-mode <MODE>
          Tool approval mode: untrusted|on-request|never (default: on-request)
      --permission-profile <ID>
          Select a named permission profile for this session.
      --approval-judge <off|on>
          LLM approval judge for Prompt-bound calls (default: on)
      --no-session-log
          Do not persist session event logs to disk
      --echo-delay-ms <MS>
          Deterministic echo reply delay (echo provider only)

Safety (approval and the sandbox are ON by default):
      --yolo
          Disable approval and sandbox, trust this workspace, enable async
          questions (this run)
      --disable-request-user-input
          Withhold request_user_input for this run
      --trust-workspace
          Trust this workspace for this run (load its skills and rules); does
          not save trust
      --disable-approval
          Disable tool approval prompts for this workspace run
      --disable-sandbox
          Disable shell filesystem/network sandboxing for this run
      --sandbox-network <MODE>
          Sandbox network mode: restricted|enabled|proxy-only (default:
          proxy-only)
      --disable-write
          Disable non-shell workspace filesystem writes
      --disable-shell
          Disable workspace shell execution
      --enable-shell-tool
          Use the legacy shell tool instead of the managed platform shell

Run `muse <command> --help` for command-specific options.
```

### muse serve --help

```
muse serve — serve an MSP session host over stdio

Usage: muse serve [--provider <PROVIDER>] [--model <MODEL>] [--preset <PRESET>] [OPTIONS]

The client owns this process's stdin and stdout and is its only
connection. Sandbox posture and session durability are constructed
here and apply to every session the host loads; neither is negotiable
over the wire. With `--listen` the same binary serves a multi-client
socket daemon instead, and each session narrows trust under the
ceiling. Approval mode is the other way round — it is selected
on the wire, so there is no approval flag here.

Options:
  -h, --help
          Print this help
      --no-session-log
          Use memory-only sessions
  -c, --config <KEY=VALUE>
          Set one setting for this host (repeatable; values are JSON). Secrets
          only as whole-value ${VAR}; unknown or clashing keys refuse the run.

Provider selection (this process only; never rewrites settings):
      --preset <PRESET>
          Existing preset for this host (this process only; never rewrites
          settings)
      --provider <PROVIDER>
          Startup provider for this host: echo, meta, or local (default: from
          your settings, else meta)
      --model <MODEL>
          Model id for non-echo providers (default: your configured model, else
          the provider's default)
      --contributor-mode <on|off>
          Per-process contributor mode override (this host only; never
          persisted)
      --disable-request-user-input
          Withhold request_user_input from the main conversation of every served
          session (side chats keep it)

Sandbox posture (fixed for the host's lifetime):
      --disable-sandbox
          Disable shell filesystem/network sandboxing for this host
      --sandbox-network <MODE>
          Sandbox network mode (default: proxy-only)
      --disable-write
          Disable non-shell workspace filesystem writes
      --disable-shell
          Disable workspace shell execution
      --trust-workspace
          Load each session workspace's skills and rules

Socket daemon (multi-client; sessions choose trust per session):
      --listen [unix:<PATH>]
          Serve a multi-client socket daemon instead of the stdio host (bare:
          the well-known per-user-machine socket)
      --allow-workspace-trust
          Allow sessions on this daemon to choose workspace trust (socket-only:
          requires --listen; sessions default untrusted)
      --vacate-on-upgrade
          Opt this daemon spawn into vacating and draining when its executable
          is replaced by an upgrade (socket-only: requires --listen)
      --join
          Serve through this machine's session daemon when one runs; otherwise
          serve in-process, as without --join
      --client-started
          Mark this daemon as started by an interactive client: it exits once it
          has no connection and no loaded session (socket-only: requires
          --listen)

Examples:
  muse serve --provider meta
  muse serve --model <MODEL>
  muse serve --provider meta --model <MODEL>
  muse serve --preset native-basic
```

### muse schema --help

```
muse schema — export the MSP wire schema embedded in this binary

Usage: muse schema generate-json-schema --out DIR [--experimental]
       muse schema generate-ts --out DIR [--experimental]

Both exports are offline and instant: the bundles are precomputed at build
time, so the output is exact for this binary. The error table describes every
error this binary can emit, and the method index describes every served
method except the members of the parity gate's owned deferral register
(`register_names` in bundle_surface_parity.rs; #33065); the exported methods
table plus that register is the authoritative list, and the parity gate
keeps the index exact in both directions.

Options:
      --out DIR       Directory to write the export into (created if absent)
      --experimental  Export the experimental surface instead of the stable one
  -h, --help          Print this help
```

### muse session-message --help

```
usage: muse session-message <command> [options]

commands:
  muse session-message list [--json]
  muse session-message send --target <session-uuid-or-name> [--in-reply-to <reply-token>] [--display-context <json>] [--json] < body
```

### muse session-message list --json

```
{"schema_version":1,"status":"unavailable","error_code":"external_agent_ingress_closed"}
```

### muse exec --help

```
muse exec — run one prompt non-interactively (headless)

Usage: muse exec [OPTIONS] [PROMPT]

Options:
      --json
          Emit machine-readable JSONL events on stdout
      --prompt-file <PATH>
          Read the prompt from a file instead of an argument
      --api-key-stdin
          Read the provider API key from stdin
      --provider <MODE>
          Startup provider: echo or meta (default: meta)
      --preset <NAME>
          Run a built-in preset: native-basic, miniswe, empty, ac_orch,
          openai-apply-patch
      --permission-profile <ID>
          Select a named permission profile for this session.
      --model <ID>
          Model id for non-echo providers
      --contributor-mode <on|off>
          Per-run contributor mode override (this run only; never persisted)
  -c, --config <KEY=VALUE>
          Set one setting for this run (repeatable; values are JSON). Secrets
          only as whole-value ${VAR}; unknown or clashing keys refuse the run.
      --reasoning-effort <EFFORT>
          Meta reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra
          (default: high; alias: --effort)
      --parallel-tool-calls
          Enable Meta API parallel tool calls
      --no-parallel-tool-calls
          Disable Meta API parallel tool calls
      --base-url <URL>
          Override the provider base URL
      --image <PATH>
          Attach a local image file (repeatable)
      --workspace <PATH>
          Root policy-gated workspace tools at PATH
  -w, --worktree [<MODE>]
          Session git worktree: off|create|existing
      --worktree-base <REF>
          Base ref for --worktree create (default: HEAD)
      --worktree-existing <PATH>
          Existing worktree path for --worktree existing
      --context-compaction-strategy <ID>
          Context compaction strategy: summary-preserved-suffix/v1,
          prefix-extension-summary/v1, prefix-extension-inventory-summary/v1
      --context-compaction-soft-threshold <FRAC>
          Soft compaction threshold
      --context-compaction-hard-threshold <FRAC>
          Hard compaction threshold
      --output-schema <FILE>
          Shape the final answer with the JSON schema in FILE (meta provider
          only)
      --max-model-steps <N>
          Cap the number of model steps
      --max-tool-output-bytes <N>
          Cap tool output bytes fed back to the model (0 or >=9)
      --session-id <UUID>
          Use a specific session id
      --allow-workspace-switch
          Allow switching the workspace mid-run
      --user-input-auto-resolve
          Offer request_user_input and auto-cancel prompts (headless)
      --subagent-worktree-isolation
          Compatibility flag; capability defaults on. Only an affirmative
          per-child request asks for isolation; omission stays shared. Requests
          may reject when capability, provider, or Git prerequisites are
          unavailable.
      --disable-web-tools
          Disable web tools for this run
      --disable-reminders
          Disable reminder agents for this run
      --disable-request-user-input
          Withhold request_user_input for this run
      --no-foreign-personal-context
          Exclude foreign personal rules and skills from this run
      --no-session-log
          Do not persist session event logs to disk
      --approval-mode <MODE>
          Tool approval mode: untrusted|on-request|never (default: on-request)
      --approval-judge <off|on>
          LLM approval judge for Prompt-bound calls (default: on)
  -h, --help
          Print this help

Safety (approval and the sandbox are ON by default):
      --yolo
          Disable approval and sandbox, trust this workspace (this run)
      --trust-workspace
          Load this workspace's skills and rules (this run)
      --disable-approval
          Disable tool approval prompts for this run
      --disable-sandbox
          Disable shell filesystem/network sandboxing for this run
      --sandbox-network <MODE>
          Sandbox network mode (default: proxy-only)
      --disable-write
          Disable non-shell workspace filesystem writes
      --disable-shell
          Disable workspace shell execution
      --enable-shell-tool
          Use the legacy shell tool instead of the managed platform shell
```
