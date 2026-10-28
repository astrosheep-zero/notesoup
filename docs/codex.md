# Codex plugin (native mode)

`plugins/codex/` makes notesoup a native Codex plugin: the five notebooks and the two history tools over a bundled stdio MCP server, plus a SessionStart/SubagentStart hook that writes the notes boot into the window Codex is actually opening. It does not wrap Codex's conversation or replace its context engine. Reset and budget stay native.

Targets **Codex 0.160.1 only**, with the rollout format source-checked against the official 0.160.1 tree. No live Codex host or config-parser evidence is claimed at this stage. The rollout decoder rejects any other `cli_version`; it is not a forward-compatible reader. A `.jsonl.zst` rollout needs **Node >=22.15** (`zstdDecompressSync`); the plugin invokes `node`, which must resolve to that version.

## Install (from this checkout)

Build the bundled helper first; `plugins/codex/dist/codex/notesoup.js` is generated and is not committed.

```sh
npm ci
npm run build
codex plugin marketplace add /absolute/path/to/notesoup
codex plugin add notesoup@notesoup
```

`codex plugin add` copies the plugin into Codex's plugin cache, so the marketplace path is needed only to add it. Approve the plugin's `SessionStart`, `SubagentStart` and `PreCompact` hooks when Codex asks; an untrusted hook does not run, and notesoup will then refuse its MCP calls as `unknown_thread`. Restart Codex or resume the thread after installing.

Native mode is switched on in `~/.codex/config.toml`. This is the source-checked shape (the stage does not run Codex's config parser):

```toml
[features]
context_management = false
retain_client_developer_messages = false

[features.token_budget]
enabled = true
use_history_notes_extension = false
```

Keep the forms separate: `token_budget` is a table here, so do not also write `token_budget = true`. These are under-development Codex flags; a different Codex release may rename them, which is one more reason this adapter pins 0.160.1. `retain_client_tool_outputs`, where a newer Codex provides it, is a separate flag from `retain_client_developer_messages`; do not assume one setting covers both.

`context_management = false` disables the experiment notesoup replaces. `[features.token_budget]` supplies the native `new_context` and `get_context_remaining` tools; notesoup does not implement either one. `use_history_notes_extension = false` leaves notes and history to notesoup.

## What the agent gets

- **A boot per native window.** The `SessionStart` hook reads the thread's native rollout, binds the thread to this Codex root session, cwd, model, transcript and current window, and returns the shared notes boot with a window marker. The boot is deduped by the host's own persisted `hooks.additional_context` record for that exact thread and window, never by a quoted marker. A compact creates a new native window and therefore a fresh boot.
- **Codex's `new_context` and `get_context_remaining`.** They remain Codex's tools. notesoup has no MCP reset or budget fallback, and an MCP call cannot trigger a reset.
- **Five notebooks** through `notes_write`, `notes_update`, `notes_read`, `notes_list` and `notes_search`. `NOTESOUP_HOME` overrides the root (default `~/.agents/notes`); a root thread's agent name is `NOTESOUP_AGENT` or `anonymous`.
- **Native history** through `history_list` and `history_read`: the root thread's events and a child's own ancestry, addressed by stable session-wide seqs. The boot's window tree retains native window UUIDs for orientation. Optional `session` targets other local sessions/harnesses, and `history_list` accepts `session: "*"` with a query for cross-session search; see [cross-session history](history-sessions.md).
- **Per-turn model identity.** `@model` follows the current turn's `x-codex-turn-metadata.model`, not the model recorded at thread start. The start model only labels the boot.
- **Subagents and forks.** `SubagentStart` binds the child or fork to its own transcript while keeping the parent's root session. Its `@self` notebook is the slugged `agent_type` (for example `worker`), not the parent's.

Codex may prefix MCP tool names with a server namespace. Use the names that appear in the session's tool list; the boot says the same.

## Native-window and identity rules

Hooks are the only source of identity. The MCP server never guesses a project from its own cwd, and it reads exactly one binding per thread from `PLUGIN_DATA`.

A notes or history call refuses, without reading or writing anything, when:

- the thread has no hook binding (`unknown_thread`);
- the binding's root session disagrees with the call's `sessionId` (`stale_thread_binding`);
- the call carries no `windowId` (`missing_window`) or a different one from the binding (`stale_thread_binding`);
- the turn supplies no model (`missing_model`);
- history finds the transcript's root session or current window no longer matches the binding (`stale_native_state`).

Resume or compact once to let `SessionStart` rebind a stale thread. A root-session disagreement is never overwritten during a hook run; the message asks for a resume instead.

The boot marker records the native thread and window. The transcript decoder is strict about producer facts: unknown record/response types, malformed committed JSONL, non-increasing ordinals, copied `session_meta` ancestry and `thread_rolled_back` selection are refusals, not skipped data. An incomplete final line is ignored as an append tail rather than treated as history.

## Child limitation

Codex 0.160.1 has no supported child post-compact boot or recovery hook. notesoup therefore answers a **child** `PreCompact` with `continue: false`, before native history is cut, and tells the child to save a handoff note and finish. A root `PreCompact` is transparent. Continue a child by starting a fresh child from its handoff note; do not expect notesoup to recover a child after a native rollover.

## Limits

| Limit | What to expect |
| --- | --- |
| Codex versions | 0.160.1 only; other `cli_version` values are refused. |
| Node | >=22.15 for compressed rollouts. |
| Boot size | Local cap 128 KiB. The hook sets `additionalContextLimit: 0` so the host does not spill or silently truncate the boot; an oversized boot becomes a warning and nothing is injected. Slim the notebook MAPs. |
| Tool output | Shared 32 KiB result bound; use continuation fields or narrower filters. |
| History sources | Local Pi/Claude/Codex transcripts through the shared corpus; current Codex and targeted Codex use the same strict rollout decoder. DSH discovery needs its query service and is unavailable inside Codex. No app-server/remote history or text from opaque/encrypted payloads. |
| Reset/budget | Codex-native only. No MCP fallback, no notesoup budget warning or close-out turn. |
| Child rollover | Unsupported; blocked at `PreCompact` as above. |
| Dream | No Codex dream backend or dream skill registration. |
| Notifications/commands | No custom UI notification, runtime toggle or `/fresh-window` command is installed. |

## Validation stage

This is a fixture- and SDK-validated stage, **not a verified real host loop**. The tests use producer-shaped synthetic rollouts derived from the frozen official 0.160.1 source (`d27764b8`), drive the bundled stdio MCP server through the official SDK client, and run the hook code both in-process and as the real bundled executable. They pin root and child history, forks, boot deduping by host provenance, stale identity/window refusals, native-window addresses and child `PreCompact`.

The stage has not been published, installed into a live Codex session, or exercised against a real model turn. A local build and the scripted tests only establish the adapter's behavior against those fixtures and the documented hook/MCP surfaces. Before relying on it in a real thread, install it as above and verify that the boot appears once per window and that a `notes_write` succeeds from a model turn.

```sh
npm run typecheck
npm test
node --test dist/test/codex-plugin.test.js
```
