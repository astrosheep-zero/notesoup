# notesoup for Codex

Native notes and history for Codex **0.160.1**. The plugin bundles one stdio MCP server with the five notes homes and three history tools, and one hook helper that injects the notes boot into each native context window. `new_context` and `get_context_remaining` stay Codex's own tools; notesoup does not replace Codex's reset or budget.

## Install

Build the bundle, add this repository as a marketplace, install the plugin, and approve its hooks:

```sh
npm ci && npm run build
codex plugin marketplace add /absolute/path/to/notesoup
codex plugin add notesoup@notesoup
```

Then set the target native-mode configuration in `~/.codex/config.toml` (source-checked, not exercised against a live Codex config parser in this stage):

```toml
[features]
context_management = false
retain_client_developer_messages = false

[features.token_budget]
enabled = true
use_history_notes_extension = false
```

Do not also set `token_budget = true`: the table above is the whole setting. Restart Codex or resume the thread after installing, so `SessionStart` can bind the thread.

## What it does

- The `SessionStart` hook reads the native rollout, binds thread identity from hook facts, and returns the notes boot for the current native window. A restart, resume or compact without an existing boot for that window gets one.
- `notes_*` uses `NOTESOUP_HOME` (default `~/.agents/notes`) and the current turn's model for `@model`.
- `history_*` reads the local rollout: root windows and a child's own ancestry. Window ids are `codex:<thread>:<native-window-uuid>`.
- Stale roots, missing windows, missing turn models and missing bindings are refusals. Resume or compact once to rebind.
- A child `PreCompact` is stopped with `continue: false`: Codex 0.160.1 has no child post-compact recovery hook. Save a handoff and start a fresh child.

Requires Node **>=22.15** for compressed `.jsonl.zst` rollouts.

## Limits

128 KiB boot cap (host spilling disabled), 32 KiB tool results, local rollout history only, no MCP reset or budget fallback, no dream backend, no notifications or commands. Codex versions other than 0.160.1 are refused.

This stage is validated with producer-shaped fixtures and the official MCP SDK client, not against a live Codex model loop. See [docs/codex.md](../../docs/codex.md) for setup, refusal codes, window identity and the validation scope.
