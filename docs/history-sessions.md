# Cross-session history

`history_list` and `history_read` accept one optional `session` selector. This is read-only inspection of local transcripts, not a session switch or a note-notebook selector. Seq numbers are local to a session; keep a returned `session` together with its `seq`.

## Current session or one target

Omit `session` to keep the current host's behavior unchanged. Items/read results do not contain `session`, headers remain `seq <seq> | <role>`, and the printed paging, expand and neighborhood recipes do not contain a session selector.

Pass an ID or unique prefix, optionally qualified by `pi:`, `claude:`, `codex:` or `dsh:`:

```js
history_list({ session: "claude:target-prefix", query: "deployment" })
history_read({ session: "claude:full-session-id", seq: 42 })
```

Within the requested harness an exact ID wins over prefixes. Without a harness, resolution checks the current harness first (exact ID, then prefixes); only if it has no matches are the other harnesses checked. No match returns `unknown_session`. Multiple matches return `ambiguous_session` with up to five qualified candidates; specify a harness or a longer ID rather than guessing.

Explicit targeting always returns the canonical `session: "<harness>:<full-id>"`, even when the target happens to be the current session. Headers become `session <harness>:<id> | seq <seq> | <role>`. `page_older`, `page_newer`, folded-row `expand`, and read `neighborhood` recipes carry that same canonical selector. Copy it into subsequent `history_read` calls, including reads continued with `next_offset_chars`.

## Search across sessions

Any selector containing `*` is a multi-session search; `*` matches any string and all other characters are literal. `*` covers all available harnesses, `pi:*` restricts to Pi, and `claude:prefix*` narrows by session ID.

```js
history_list({ session: "*", query: ["deployment", "rollback"], limit: 20 })
history_list({ session: "codex:*", query: "migration", roles: ["tool"], since: "2026-10-01" })
```

- A non-empty `query` is required (`missing_query`). Empty strings/lists and lists containing only empty entries do not count. Matching is literal, case-insensitive, and ORs a list of texts, as in one-session search.
- `before_seq` and `after_seq` refuse with `invalid_bounds`: seqs from different sessions cannot define a common range.
- `history_read` refuses wildcard selectors with `invalid_session`; take a specific `session` and `seq` from a search hit instead.
- Every role is searched, including tool arguments/output and context; `roles` can narrow this. There are no folded rows.
- `since` is inclusive and `until` exclusive. Time-bounded searches exclude events with no usable timestamp.
- Files are discovered newest-modified first. Hits are merged by event time, oldest first, with a deterministic session/seq tie-break; untimed events sort before timed events. `limit` counts from the newest end by default, or the oldest with `from: "oldest"`. The complete text and structured result still share the 32 KiB budget, so a large hit can reduce the admitted page.
- Each event carries its canonical `session`. `page_older` and `page_newer` are always null. Narrow by session pattern, query, roles or time rather than trying to page across per-session seqs.

## Local discovery and limits

| Harness | Default source | Selection/decoding |
| --- | --- | --- |
| Pi | `~/.pi/agent/sessions/<workspace>/<timestamp>_<id>.jsonl` | Current session uses the native active branch. Offline current-format files follow persisted parent links from the last tree entry, preserving append seqs and inactive-branch holes. |
| Claude | `~/.claude/projects/<project>/<id>.jsonl` | The current session still requires its live, confirmed append head. Offline files require a unique graph leaf (including logical compact links); multiple possible leaves refuse rather than choosing by append order. Only confirmed ancestors are exposed. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-...-<threadId>.jsonl(.zst)` | The same strict 0.160.1 rollout/lineage decoder as current-session history; compressed files need Node >=22.15. Root `session_id` is not a child thread ID. |
| DSH | `ctx.sessionQuery.listSessions()` / `readSession(id)` | Available inside DSH only, over its live-preferred local session corpus. Other hosts cannot discover DSH files themselves. |

Filesystem discovery does not follow directory symlinks or recurse into Claude subagent stores. Missing roots are empty. Repeated native files for one qualified ID produce one descriptor (newest modified); the current live binding wins over its on-disk descriptor. Discovery and decoding never mutate transcript bytes or modification times. Unsupported/corrupt or unreadable selected transcripts return `history_unavailable` naming the session; a wildcard search does not silently present partial results as complete. A readable Claude ancestry gap appears as an optional `notice` in cross-session page/read data and in rendered text; it stays outside event text and search/read offsets and counts against the output budget.

The default roots respect `PI_CODING_AGENT_DIR` (Pi agent directory), `CLAUDE_CONFIG_DIR` (Claude config directory), and `CODEX_HOME` (Codex home). For direct root overrides use absolute paths in `NOTESOUP_HISTORY_PI_ROOT`, `NOTESOUP_HISTORY_CLAUDE_ROOT`, and `NOTESOUP_HISTORY_CODEX_ROOT`; these name the **sessions**, **projects**, and **sessions** directories respectively, not notes storage. `NOTESOUP_HOME` only changes notes.

Embedders/tests can use `localHistoryCorpus({ current, roots, home, env, dshSessions })` from the source module `src/history/local.ts`. Each `roots` member overrides that harness's discovery directory; `null` disables it. A supplied `home` with `env: {}` makes the defaults hermetic. These source-module helpers are not new package exports.

The shared operations still accept a bare `HistoryProjection` for current-session calls. Host adapters instead supply a `HistoryContext` with a lazy `current()` projection and a `HistoryCorpus`. Filesystem wire decoders live under `src/history/`, import no host SDK/plugin, and are shared by native adapter entries and corpus reads. DSH contributes descriptors through its public query service. Foreign reads do not require loading the current projection; Codex still validates the caller's hook binding and native identity/window before serving them.
