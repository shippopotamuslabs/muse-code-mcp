# PROTOCOL — Muse Session Protocol (MSP), probed against Muse Code 1.4.14

Everything below was probed against the real CLI on 2026-11-01. CLI: `Muse Code 1.4.14 (1.4.14-R7309.1)`. No auth file was read, printed, or copied. The raw capture files are kept locally and are not part of this repo.

## SDK choice

**Chose `@muse-code/sdk@1.4.14`.** `muse schema` and the package pin the same stable fingerprint:

`sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6`

The live `initialize` result returned that exact fingerprint. The SDK is the TypeScript client for MSP, zero runtime dependencies, Node 20+. This machine is Node v24.14.0. The server drives the public `spawnMspConnection` / `Connection` / `Session` layer rather than `MuseClient`, because `session/start.worktree`, `turn/steer`, `turn/cancel`, `session/leave`, and `muse_raw` need the connection. `MuseClient.startSession` does not forward the experimental worktree field.

Fingerprint drift is a warning (`checkServedFingerprint`), not a failed handshake.

## Behavior notes

The CLI schema is the authority wherever a summary disagrees with it.

- Public `approval_mode` stays `yolo | on-request | judge`. The wire values are not those words. `yolo` sends permission profile `:unrestricted` and `approvalMode: allowAll`. `on-request` sends `:ask-me` and `onRequest`. `judge` sends `:auto-review` and `onRequest`. CLI flags `untrusted | on-request | never`, `--yolo`, and `--approval-judge` are not MSP fields.
- Profiles come from experimental `permissionProfile/list` (requires `experimentalApi: true`). On this host the ids that exist are `:read-only`, `:ask-me`, `:auto-review`, `:unrestricted`. Guessed ids (`:workspace`, `:untrusted`, `:default`, `read-only`) return `-32030 commandRejected` / `permission_profile_unknown`. Calling `permissionProfile/list` without experimental API returns `-32601 experimentalRequired`.
- This machine's Muse settings default the profile to `:unrestricted`. Omitting `permissionProfile` produced **zero** `approval/request` frames even with `approvalMode: onRequest`. The server always sends both.
- Under `:ask-me`, `echo hello` and a workspace `write_file` did not prompt. A new network host did. The subject was `kind: network`, `toolName: network`, `host: example.com`, shell command absent. The policy match line is tool name, subject kind, command, host, path, subject tool name, and raw args.
- This host's reject choice is `choiceId: abort`, `decision: abort`, `scope: once`, `acceptsFeedback: true`, label "Reject". There is no `decision: denied` choice. A plain approve must pick `approved` + `scope: once` (`allow_once`), never `allow_session` or `allow_local_network`.
- `session/start.worktree` is experimental: `{mode:"create", baseRef?}` or `{mode:"existing", path}`. It is absent from the stable `session/start` params. Sending it requires `experimentalApi: true`. A live start through the server failed. The server returned the host error and did not run `git worktree`. See "Live worktree start" below.
- No MSP field, stable or experimental, for `muse exec --output-schema`, `--max-model-steps`, or `--user-input-auto-resolve`. Those knobs are not on the tool schema. `pending_timeout_sec` is this server's timer, not the exec flag. User-input also has the host's own `autoResolutionMs` and `userInput/cancel`.
- `--preset` and `--contributor-mode` are host-lifetime flags (`muse serve`), not per-session wire fields. The server pools one host per workspace + contributor + preset + trust. Sandbox stays on. `yolo` does not pass `--disable-sandbox`. `--trust-workspace` is passed so workspace skills load. Contributor mode is passed explicitly `off` unless the caller sets it, because this machine's settings have contributor mode on.
- `session-message list --json` exits 1. Stdout is `{"schema_version":1,"status":"unavailable","error_code":"external_agent_ingress_closed"}`. Stderr is `external agent ingress is unavailable`. `muse_message` returns that JSON as a normal result. Ingress opens only when the target process was started with `MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS` or `MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING`. Neither variable was live-tested as an opener. Setting them on the `session-message` client does not open a target that was started without them.
- `turn/steer` idle refusal is schema-mined (`expectedTurnId` must be the running turn) and unit-verified against the fake. It was not part of the live probe.
- `muse_spawn` and `muse_turn` accept `parts`, an ordered array of `{type: "text", text}` and `{type: "skill", selector, source?, arguments?}` objects. Provided parts are sent as the `turn/start` `input` verbatim, in order. `source` is the closed `skill/list` row vocabulary (`bundled|user|project|plugin`); when present the host resolves that exact `(selector, source)` row, when absent it resolves the selector as the TUI shortcut does. A non-empty `parts` wins and `prompt`/`prompt_file` are ignored; when `parts` is absent the prompt spellings keep their old meaning (one text part). Skill invocation itself was not part of the live probe; the fake host records `turn/start` input in its method log, and the service tests assert verbatim order there. An unknown skill selector is the host's typed `skillNotFound` request error.
- Goal and compaction methods are reachable through `muse_raw` only.
- The per-session catalog queries have typed tools: `skill/list` (`muse_skills`), `plugin/list` (`muse_plugins`), and `hook/list` (`muse_hooks`) are stable, with result types in the stable SDK bundle. `mcpServer/list` (`muse_mcp_servers`) is experimental only; its result shape is not in the stable SDK types and it was not called in the 2026-11-01 probe, so the tool's decoder accepts a row array under `servers` or `mcpServers`, normalizes name/status/transport, and carries each host row verbatim under `raw`. The opt-in live catalog test in `test/live.test.ts` is the check that pins the real shape. There is no MSP method that lists the TUI's built-in slash commands; `skill/list` is the user-invocable catalog, and the built-ins map to individual methods (`model/list`, `session/compact`, `goal/*`, and peers).

## Handshake (probed, passing)

Host: `muse serve --trust-workspace`. Client `initialize` then notification `initialized`. Session `01a1982b-5b01-7b03-a4c3-3a55bb597ebb`, model `muse-spark-1.3`, turn `01a1982b-5bca-7790-8fc9-46936238bf77`, disposition `started`, status `accepted`. Prompt: "Reply with exactly: MSP OK". `reasoningEffort: minimal`. Final agent message text: `MSP OK`. `turn/completed` terminal `completed`. `session/tokenUsage` cumulative prompt 57064, output 16, total 57080; that completion's usage included reasoning tokens 5 and `durationMs` 2069. Stdin EOF did not reap the host within 8 seconds; the probe sent SIGTERM. The server uses the SDK's EOF, drain, then signal shutdown.

## User input (probed, passing)

Session `01a1982c-d563-7fb2-a17d-48eacfbdd964`, turn `01a1982c-d5e6-7fd9-82d9-6f13f0f279df`. The agent called tool `request_user_input`. Server request `userInput/request` (and the `userInput/requested` twin) carried `userInputId` `01a1982c-dede-7233-86c9-434886d4a28c`, question id `filename`, options `alpha.txt` and `beta.txt`. The client answered `userInput/answer` with `selectedLabel: beta.txt`. `userInput/settled` outcome `answered`. The turn completed. Scratch file `/tmp/muse-mcp-probe-rt/beta.txt` contains `picked`.

`userInput/answer` answers must match the offered options or the host returns `-32057 userInputAnswerInvalid`. Free text is limited to 500 characters. The presentation receipt for the server request is `{}`; the answer is a later command.

## Approval (probed, passing)

Profile `:ask-me`, `approvalMode: onRequest`, spawn `muse serve --contributor-mode off` (sandbox left on).

`echo hello` on session `01a1982e-fddc-7573-b068-24ad4fff2683` completed with no `approval/request`.

`curl https://example.com` on session `01a1982f-1b7d-7293-a7da-e673d53d38df` raised approval `01a1982f-2b1a-70b2-b919-ba403bff4786` (tool `network`, host `example.com`). The client sent `approval/decide` choice `allow_once`. `approval/resolved` decision `approved`, `resolvedBy: user`, `policyResult: allow`. The turn completed.

Deny, separate log: session `01a19832-3b8b-77b2-8092-c2872dfb3f61`, turn `01a19832-3c15-75d2-8c97-4957b4a12304`, approval `01a19832-48b9-7ed0-b41f-356a2e8057ed`, host `example.net`. Decide choice `abort` with feedback `probe deny: do not run this command`. Resolved decision `abort`, `resolvedBy: user`, `policyResult: deny`. Final answer text: `DENIED`.

`approval/decide` also requires `requirementId` equal to the request's `currentRequirementId`. The SDK's `onApproval` path sends that. The server holds the handler's promise until `muse_decide`, policy, or timeout, and returns the presentation receipt `{}` immediately.

## Worktree start (the host rejects untrusted repositories)

A session start with `worktree: { mode: "create" }` against a repository Muse has not marked trusted fails at `session/start`, even with host flags `--contributor-mode off --trust-workspace` and `experimentalApi: true` at initialize. The server returns this host error and never falls back to running `git worktree` itself.

Verbatim error, with the temp path as generated:

```
Error [MspError]: Repository '/tmp/muse-mcp-live-wt-Av44wJ' is not trusted; worktree create, attach, and list require a trusted repository.
    code: -32029,
    kind: 'workspaceNotTrusted',
    data: { kind: 'workspaceNotTrusted', path: '/tmp/muse-mcp-live-wt-Av44wJ', retryable: false },
    retryable: false
```

`--trust-workspace` on a stdio host loads skills and rules; it does not grant this trust. The schema's project-trust error (ADR 31776) is a different gate, and `session/start.limits.workspaceTrusted` is documented as socket-only.

## session-message

`muse session-message list [--json]` and `muse session-message send --target <session-uuid-or-name> [--in-reply-to <reply-token>] [--display-context <json>] [--json]`, with the message body on stdin.

Probed `muse session-message list --json` on 2026-11-01: exit code 1. Stdout is one JSON object, `{"schema_version":1,"status":"unavailable","error_code":"external_agent_ingress_closed"}`. Stderr is the line `external agent ingress is unavailable`.

`muse_message` wraps those two subcommands and does not set `MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS` or `MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING`. Ingress opens only when the target Muse process was started with one of them. Neither variable was live-tested as an opener. The success payload of `send` was not probed; the tool returns stdout JSON as-is.

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

Naming is server-driven: `session/start` never allocates a name for MSP-started sessions (the TUI's in-process allocate has no MSP equivalent — there is no allocate method, stable or experimental), so `session/rename` is the only naming method and the server mints a canonical name at spawn and settles it with `session/rename`. `generatedName` rides `session/nameChanged` and the Session snapshots (`session/start`, `session/resume`) additive-optionally: present when the host published a generated short title, omitted otherwise, and a frame without one never clears a recorded value.

View-stream names the server folds: `item/started`, `item/delta`, `item/completed`, `turn/started`, `turn/completed`, `session/tokenUsage`, `usage/changed`, `session/contextUsage`, `approval/requested`, `approval/resolved`, `userInput/requested`, `userInput/settled`, `skill/changed`, `plugin/changed`, `session/goalChanged`, `session/todoListChanged`, `session/nameChanged`. `session/contextUsage` becomes a `context-usage` stream event and the `context_usage` field on `muse_status`. `session/nameChanged` becomes a `name-changed` stream event carrying the canonical name (and the frame's nameOrigin when it carries one, plus its generatedName when it publishes one); the service also records the name on the session record, and `muse_status` reports it as `name` with `name_origin` — the fold fallback there reads the name field off the stored nameChanged params, which the fold keeps whole. `generated_name` on `muse_status` follows the same record-then-fold shape. A `usage/changed` frame whose params are the subscription usage observation (window + weekly blocks) becomes an account-scoped `subscription-usage` stream event with no session id — including frames that arrive with no sessionId at all, which the router forwards to the stream instead of dropping; observations are deduped by content across hosts. `skill/changed` and `plugin/changed` become `catalog-changed` stream events carrying `catalog: "skill"` or `"plugin"` — a hint to re-issue the matching list tool, the same hint/refresh shape as `pending`. `session/goalChanged` becomes a `goal-changed` stream event carrying the goal block verbatim (`null` clears), the same verbatim-carry shape as `usage`. Goal methods (`goal/set`, `goal/edit`, `goal/clear`, `goal/pause`, `goal/resume`) and `session/compact` are `muse_raw` only.

## Verbatim help

The findings above were checked against the installed CLI's own
help and schema output: `muse --help`, `muse serve --help`,
`muse schema --help`, `muse exec --help`, and
`muse session-message --help`. Run those against the installed
version when a detail matters. The raw captures are kept locally
and are not part of this repo.
