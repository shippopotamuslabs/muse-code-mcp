# AGENTS.md — muse-code-mcp contributor notes

Agents working in this repo start here. README.md describes the
server for human readers; this file is the governing agent contract.

## What this server is

A stdio MCP server that spawns and drives Muse Code agents on
this machine over `muse serve` (MSP, the Muse Session Protocol).
It owns the session bookkeeping around that protocol: one `muse
serve` host per workspace posture, a broker for the approval and
user-input requests a live turn raises, policy auto-approvals, an
append-only audit log, and session state under `~/.muse-mcp/` that
survives a server restart. Muse Code stays the billing client.

The credential rule is absolute: this server never reads, stores,
prints, or forwards Muse OAuth tokens, API keys, or
`~/.config/muse/auth.json`. `muse_raw` enforces it in code —
`src/raw.ts` refuses credential methods (`account/`, `mcpServer/oauth`,
anything containing `login` or `logout`) before a frame is written.
Keep it that way.

## The shape

- `src/server.ts` and `src/tools.ts` are the MCP edge: transport
  wiring and the seventeen `muse_*` tool registrations. Tool handlers
  stay thin and delegate to the service.
- `src/sessions.ts` (`MuseService`) owns orchestration: hosts,
  sessions, turns, steering, pending requests, resume after restart.
- `src/host.ts` owns the `muse serve` process seam over
  `@muse-code/sdk`. MSP and SDK types live in `host.ts` and
  `sessions.ts`; the modules below import neither SDK.
- `src/broker.ts`, `src/policy.ts`, and `src/answers.ts` are the
  pending-request machinery: queueing, auto-approve matching, and
  shaping answers back onto the wire. Plain data in, plain data out.
- `src/config.ts`, `src/state.ts`, `src/audit.ts`, `src/raw.ts`, and
  `src/message.ts` are the plain support modules: TOML config and
  env layering, session records, the JSONL audit log, the
  credential-method refusal list, and the `muse session-message`
  subprocess. `message.ts` does not speak MSP and does not touch
  the session store or the broker.
- `src/stream.ts` is the plain stream module: it translates host
  view frames into the client stream contract and coalesces text
  deltas. `MuseService` taps its ordered frame flow in `deliver()`
  and hands events to a sink the server edge injects; the contract
  lives in the README's Streaming section.

`docs/PROTOCOL.md` is the source of truth for the protocol where
it disagrees with any summary: its frames were recorded against
the real CLI. The raw captures are kept locally and are not part
of this repo.

## Gospels

The cross-repo canon lives in the `shippopotamuslabs/gospels` repo,
pinned in this repo as a submodule at `contracts/gospel/`. Read the
gospels there; bump the pin deliberately, and never edit the
submodule's contents from this repo.

- Architecture follows the dependency rule in
  `contracts/gospel/ARCHITECTURE-GOSPEL.md`: dependencies point
  inward, and framework types stay at the edges. That gospel states
  the rule in Android/Kotlin form and its
  `RUST-ARCHITECTURE-GOSPEL.md` sibling restates it for Rust;
  neither file's language specifics govern this TypeScript repo.
  The binding part here is the rule itself, in the shape above:
  the MCP edge and the MSP host are adapters, orchestration sits
  in `MuseService`, and the broker, policy, config, and state
  modules stay free of MCP and MSP types.
- Failure classification follows `contracts/gospel/CODE-STYLE-GOSPEL.md`
  §§10–11, which are cross-stack canon: expected vs exceptional
  failures, partial success as diagnostics carried in values, one
  handler per boundary. The mechanism this repo uses is named
  under "Failure handling" below.
- Tests follow `contracts/gospel/TESTING-GOSPEL.md`: the general
  sections apply in full; its Android-specific §6 does not apply
  here.
- Anything a person reads — README, docs, comments, plan
  write-ups, error text — follows
  `contracts/gospel/WUMBO-GOSPEL.md`.
- `CODE-STYLE-GOSPEL.md` is the Kotlin and Compose style canon;
  apart from §§10–11 above, it does not govern TypeScript. This
  repo's style is the style already in `src/`: TypeScript ESM,
  `.ts` import specifiers, explicit exported types, no build step.
- The UI gospels (Palette, Compose, Glass Bars, Button Shape) do
  not apply to this repo; it has no UI surface.

## Failure handling

The §11 classification, in this repo's terms:

- **Expected failures** are the routine refusals: unknown or
  closed session, idle steer, bad workspace, missing or double
  prompt, invalid config, unknown pending id, a refused credential
  method, `sessionInUse`, `workspaceNotTrusted`. The pure modules
  carry them as Result-style unions where the caller branches
  (`policy.selectChoice`) or as `BrokerError` in the broker.
  `MuseService` raises the rest as plain `Error`s. That is this
  surface's named fallback under §11: the MCP tool edge is the one
  handler, converting each failure exactly once into an `isError`
  tool result with the message. Nothing below the edge logs an
  error it propagates; there is no logger in `src/`.
- **Exceptional failures** (host crash, corrupt state, protocol
  breakage) propagate to the same edge, or to `main()` at startup,
  which writes the message to stderr and exits 1. Stdout carries
  MCP frames only.
- **Partial success** rides as values: a host fingerprint drift is
  a `fingerprint_warning` on `muse_status`, a dead host marks its
  sessions `orphaned` in state, and policy or expiry actions are
  audit lines. A degradation with no value and no audit line is a
  bug against §10.

## Tests

CI is not wired yet, and a change should pass these locally before
pushing:

- `npm test` — the suite runs against a scripted fake `muse serve`
  (`test/fake-muse.mjs`) and does not launch the real CLI.
- `npm run typecheck`

Live tests spend real model calls and stay opt-in:
`MUSE_MCP_LIVE=1 node --experimental-strip-types --test --test-timeout=300000 test/live.test.ts`.
Run them when a change touches the MSP wire behavior, and say in
the commit or PR which live checks ran.

## Conventions

- Spawned sessions default to `approval_mode` yolo. That is the
  owner's standing posture for agents on his own machine, set
  deliberately in the README. Keep the default; `on-request` and
  `judge` stay available per spawn and per config.
- This server drives only sessions it started. A `sessionInUse`
  error is returned to the caller, never retried against a session
  an interactive TUI owns.
- A failed worktree request surfaces the host error (e.g.
  `workspaceNotTrusted`). The server never falls back to running
  `git worktree` itself.
- `muse_message` lists and sends `muse session-message` traffic to
  sessions this server did not start. It does not set
  `MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS` or
  `MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING`. Those have to be
  present on the target process when it starts. A closed ingress
  is a normal tool result with `error_code`
  `external_agent_ingress_closed`. A session this server started
  is still driven with `muse_turn`.
- Work state (Synthitect plans and status files) lives in a local
  `plans/` directory, which is gitignored. This repo carries code
  and contracts; process commentary stays off it.
- PR titles follow the org convention — `type(scope): imperative
  subject (KEY-123)` — with the ticket key when the work has one.
  Individual commit messages are not linted; write them for the
  humans and agents reading the branch.
