# notesoup

Your agent's memory gets wiped when the context fills. notesoup makes that survivable: the agent writes itself a checkpoint before the wipe, wakes up in a fresh window, and digs up whatever it still needs from the old conversation. For you it's mostly invisible — an occasional notification, `/fresh-window` to force a fresh window, `/notesoup` to toggle.

The architecture — durable context windows, model-authored notes, searchable history — is the one OpenAI prototyped in Codex's `context_management` experiment and switched off ten days later, because it was welded to their backend. notesoup is the same architecture running entirely on your machine, built only on [Pi](https://github.com/earendil-works/pi)'s public extension APIs. No backend, no subscription gate, no server that can 404 at the worst possible moment. It can't be switched off from far away, because there is no far away.

## Renamed from pi-context

The old name is retired: `@astrosheep/pi-context` is deprecated, and the package is now `notesoup`. The settings key renamed from `pi-context` to `notesoup`, and the Claude Code Mod's MCP tool prefix renamed from `mcp__pi-context__` to `mcp__notesoup__` (reinstall the mod). Old notes data is unaffected.

## Why not just compaction?

- **Reset ≠ summary.** Compaction is lossy compression you sit and wait for — and the next one summarizes the summary of the summary. A notesoup reset summarizes *nothing*: the window closes in O(1), because whatever mattered was already written to notes beforehand. Fast because there's nothing to compute; safe because the raw history never leaves disk.
- **Notes are files you can open.** Plain Markdown in `~/.agents/notes`, in named notebooks (`@project`, `@human`, `@self`, `@model`, plus per-session). Readable, editable, greppable, git-able. Not an encrypted blob — and not a secret the model is instructed to keep from you. (Yes, that was a real instruction. No, we didn't port it.)
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

- **Durable context windows.** `/fresh-window` (alias `/empty`) clears and stops; `/fresh-window Continue reviewing the implementation` clears and continues. The model can also request a window itself with `empty_brain`, and a budget close-out fires automatically before the window runs out. Abort and ordinary errors never count as completion; the raw conversation stays in the session, just out of the next context.
- **A boot block at every window head.** Static once-per-window content (cache-stable) with the window identity, the recent-notes index, and a short protocol teaching the model how to recover: notes for its own bookkeeping, history tools for everything before the reset.
- **`get_context_remaining`** — how much room the brain has left before the hard-reserve wipe, including the warning runway.
- **Seven history/notes tools**, flattened from the original Codex actions:

| Codex action | Pi tool |
| --- | --- |
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
- **Cross-session history**: both history tools accept `session: "<id-or-prefix>"` or `"<harness>:<id>"` (`pi`, `claude`, `codex`, `dsh`). `history_list({ session: "*", query: "phrase" })` searches local transcripts across harnesses; hits carry the session to copy into `history_read`. Omit `session` for unchanged current-session behavior. See [cross-session history](docs/history-sessions.md) for discovery roots, refusals and offline limits.
- **Migration (0.40.0)**: parameters renamed: `order` → `from`, `before`/`after` → `before_seq`/`after_seq`, `limit_chars` → `max_chars`, `wastebasket` → `crumpled`, `pattern` → `glob` (the standalone library's options included), and `notes_update`'s `change_kind` value `file` → `moved`. Old names are refused.

- **Runtime toggle** — `/notesoup off` stops new automatic resets; `/notesoup on` re-enables them; bare `/notesoup` reports the state.

## Configuration

Pi budget settings live under the top-level `notesoup` key in `~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json`. Trusted project values win **per key**: a project override of `reserveTokens` still inherits a global `warningRunwayTokens`. Each value must be a positive safe integer (numeric strings are also accepted). An absent value uses its fallback; an invalid value emits a warning and uses that same fallback, not a lower-precedence global value.

| Setting | Meaning | Fallback |
| --- | --- | --- |
| `notesoup.reserveTokens` | Remaining tokens at the hard-reserve wipe. Also subtracted by `get_context_remaining`. | The active Pi compaction reserve, including provider/model overrides. |
| `notesoup.warningRunwayTokens` | Room between the final warning and the hard-reserve wipe. Warning fires at remaining tokens ≤ reserve + runway. | Shared default: `16384`. |
| `notesoup.reminderMarginTokens` | Early reminder margin above the resolved notesoup reserve. | `24576`. |

For example, explicitly configure an `8192` hard reserve and a `16384` warning runway:

```json
{
  "notesoup": {
    "reserveTokens": 8192,
    "warningRunwayTokens": 16384
  }
}
```

This warns at **24576 remaining tokens** and hard-wipes at **8192**; `get_context_remaining` reports `16384` at the warning line. These are example settings, not changed defaults. Without overrides, the reserve still inherits Pi's active compaction reserve, and the warning runway remains `16384`. The early reminder uses reserve + reminder margin; if usage crosses both reminder and warning, the final warning takes precedence.

These settings only change notesoup's budget thresholds. They do not modify Pi's native `compaction` settings or enable automatic resets when Pi's compaction is disabled (or notesoup is off). Other hosts retain their existing host-specific settings.

Environment variables:

- `NOTESOUP_DISABLED` — presence-style kill switch: any value but an explicit no (`0`, `false`, `no`, `off`) turns notesoup off. On Pi the extension registers nothing at all; on Claude the mod passes every event through and native compaction behaves as if the mod were absent.
- `NOTESOUP_KEEP_MEMORY` — Claude only: keep Claude Code's auto-memory guidance, which notesoup omits by default (its summarization guidance is always omitted). Enabled by any non-empty value except `0`, `false`, `no`, or `off` (case-insensitive); read at session startup.
- `NOTESOUP_HOME` — overrides the notes root (default `~/.agents/notes`).
- `NOTESOUP_AGENT` — overrides the root agent name on Pi and Codex (default `anonymous`; Codex children use `agent_type`).
- `NOTESOUP_HISTORY_PI_ROOT`, `NOTESOUP_HISTORY_CLAUDE_ROOT`, `NOTESOUP_HISTORY_CODEX_ROOT` — override local transcript discovery directories, independently of the notes root; see [cross-session history](docs/history-sessions.md).

## Documentation

- [Architecture](docs/architecture.md) and [reset lifecycle](docs/reset-lifecycle.md) — how windows, checkpoints, markers and branches actually work
- [Tool results](docs/tool-results.md) — receipts, paging, and error shapes
- [Cross-session history](docs/history-sessions.md) — one-session lookup, wildcard search, local discovery and harness limits
- [Standalone notes library](docs/notes-library.md) — use the notes store from Node, no Pi required
- [DeepSeek Harness](docs/dsh.md) — adapter and profile patch for dsh 0.2.1-alpha.2
- [Claude Code Mod](docs/claude-code-mod.md) — early-access notes and persisted-session history tools for Claude Code
- [Codex plugin](docs/codex.md) — native notes boot, persisted history and native `new_context` for Codex 0.160.1
- [Skills and dream](docs/skills.md) — `/skill:memory`, `/skill:dream`, the `dream_*` tools and the dream lock

## Development

```sh
npm test            # build from a clean dist, then run the suite
npm run typecheck
git diff --check
node scripts/check-notes-package.mjs  # optional built /notes CRUD smoke; no install
npx tsx scripts/boot-smoke.mts [cwd]  # optional live boot render against the real notes notebooks
```

The repository splits host-neutral code from host plugins:

| Path | What it is |
| --- | --- |
| `src/` | The core: notes library, boot snapshot/renderer, history projection, budget policy and the shared tool operations. It never imports an SDK or a plugin. |
| `plugins/pi/` | The Pi extension (`plugins/pi/index.ts` is what `pi.extensions` loads from source). |
| `plugins/claude/` | The self-contained Claude Code plugin (`.claude-plugin/`, `hooks/`, bundled `dist/claude/helper.js`, skills and playbook), with its adapter sources in `plugins/claude/src/`. |
| `plugins/dsh/` | The Cordis rows published as `notesoup/dsh` and `notesoup/dsh/engine`. |
| `plugins/codex/` | The Agent Plugins package for Codex 0.160.1: manifests, hooks, and the bundled `dist/codex/notesoup.js` MCP/hook helper. |

Each plugin owns its host's words — Pi's pre-reset hints and `last_word` nudge live in `plugins/pi/text.ts`, Claude's reset and missing-history prose in `plugins/claude/src/text.ts` — while the shared boot, protocol and warning bodies stay in `src/boot/text.ts` and `src/budget/text.ts`.

The harness runs against the real installed Pi `SessionManager`/`SettingsManager` in temporary directories with fake credentials — no model or network calls, and the real `~/.pi` is never touched. See [CONTRIBUTING.md](CONTRIBUTING.md) for ownership and verification rules.

## License

MIT
