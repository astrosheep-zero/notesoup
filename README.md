# notesoup

Your agent's memory gets wiped when the context fills. notesoup makes that survivable: the agent writes itself a checkpoint before the wipe, wakes up in a fresh window, and digs up whatever it still needs from the old conversation. For you it's mostly invisible — an occasional notification, `/fresh-window` to force a fresh window, `/notesoup` to toggle.

The architecture — durable context windows, model-authored notes, searchable history — is the one OpenAI prototyped in Codex's `context_management` experiment and switched off ten days later, because it was welded to their backend. notesoup is the same architecture running entirely on your machine, built only on [Pi](https://github.com/earendil-works/pi)'s public extension APIs. No backend, no subscription gate, no server that can 404 at the worst possible moment. It can't be switched off from far away, because there is no far away.

## Renamed from pi-context

The old name is retired: `@astrosheep/pi-context` is deprecated, and the package is now `notesoup`. The settings key renamed from `pi-context` to `notesoup`, and the Claude Code Mod's MCP tool prefix renamed from `mcp__pi-context__` to `mcp__notesoup__` (reinstall the mod). Old notes data is unaffected.

## Why not just compaction?

- **Reset ≠ summary.** Compaction is lossy compression you sit and wait for — and the next one summarizes the summary of the summary. A notesoup reset summarizes *nothing*: the window closes in O(1), because whatever mattered was already written to notes beforehand. Fast because there's nothing to compute; safe because the raw history never leaves disk.
- **Notes are files you can open.** Plain Markdown in `~/.agents/notes`, in named homes (`@project`, `@human`, `@self`, `@model`, plus per-session). Readable, editable, greppable, git-able. Not an encrypted blob — and not a secret the model is instructed to keep from you. (Yes, that was a real instruction. No, we didn't port it.)
- **History never forgets.** Every closed window — messages, tool calls, tool output — stays fully searchable through the `history_*` tools. Notes are the agent's lossy index; history is the lossless record underneath. This is the half the original experiment never shipped.

## Install

```sh
pi install npm:notesoup
```

Or load it for a single invocation without installing:

```sh
pi -e npm:notesoup
```

## What you get

- **Durable context windows.** `/fresh-window` (alias `/empty-brain`) clears and stops; `/fresh-window Continue reviewing the implementation` clears and continues. The model can also request a window itself with `empty_brain`, and a budget close-out fires automatically before the window runs out. Abort and ordinary errors never count as completion; the raw conversation stays in the session, just out of the next context.
- **A boot block at every window head.** Static once-per-window content (cache-stable) with the window identity, the recent-notes index, and a short protocol teaching the model how to recover: notes for its own bookkeeping, history tools for everything before the reset.
- **`get_context_remaining`** — the live countdown to the close-out line, so the agent can see the cliff before it drives off it.
- **Eight history/notes tools**, flattened from the original Codex actions:

| Codex action | Pi tool |
| --- | --- |
| `history.list_windows` | `history_windows` |
| `history.list_items` | `history_list` |
| `history.read_item` | `history_read` |
| `history.search_contents` | `history_list` (`query`) |
| `notes.write` | `notes_write` |
| `notes.update` | `notes_update` |
| `notes.rename` | `notes_update` (`rename_to`) |
| `notes.read` | `notes_read` |
| `notes.list` | `notes_list` |
| `notes.search` | `notes_search` |

- **Migration**: `history_search` is gone; pass `query` to `history_list`.
- **Migration (0.40.0)**: parameters renamed: `order` → `from`, `before`/`after` → `before_seq`/`after_seq`, `limit_chars` → `max_chars`, `wastebasket` → `crumpled`, `pattern` → `glob` (the standalone library's options included), and `notes_update`'s `change_kind` value `file` → `moved`. Old names are refused.

- **Runtime toggle** — `/notesoup off` stops new automatic resets; `/notesoup on` re-enables them; bare `/notesoup` reports the state.

## Configuration

The reminder threshold is Pi's compaction reserve plus a margin, configured under the top-level `notesoup` key in `~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json` (project values win per key):

```json
{
  "compaction": { "reserveTokens": 16384 },
  "notesoup": { "reminderMarginTokens": 24576 }
}
```

The dreamer model is configured under the same key; `--dreamer <model pattern>` on the `dream` CLI wins, then a non-empty `notesoup.dreamer` string, then the automatic model:

```json
{
  "notesoup": { "reminderMarginTokens": 24576, "dreamer": "anthropic/claude-sonnet-4-5" }
}
```

## Documentation

- [Architecture](docs/architecture.md) and [reset lifecycle](docs/reset-lifecycle.md) — how windows, checkpoints, markers and branches actually work
- [Tool results](docs/tool-results.md) — receipts, paging, and error shapes
- [Standalone notes library](docs/notes-library.md) — use the notes store from Node, no Pi required
- [SDK integration](docs/sdk-integration.md) — binding notesoup to a host-built session
- [DeepSeek Harness](docs/dsh.md) — adapter and profile patch for dsh 0.2.1-alpha.2
- [Claude Code Mod](docs/claude-code-mod.md) — early-access notes and persisted-session history tools for Claude Code
- [Skills, dream, and the notes doctor](docs/skills.md) — `/skill:memory`, `/skill:dream`, `dream doctor`, the dream lock

## Development

```sh
npm test            # build from a clean dist, then run the suite
npm run typecheck
git diff --check
node scripts/check-notes-package.mjs  # optional built /notes CRUD smoke; no install
```

The harness runs against the real installed Pi `SessionManager`/`SettingsManager` in temporary directories with fake credentials — no model or network calls, and the real `~/.pi` is never touched. See [CONTRIBUTING.md](CONTRIBUTING.md) for ownership and verification rules.

## License

MIT
