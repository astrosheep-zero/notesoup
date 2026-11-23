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

Explicit targeting always returns the canonical `session: "<harness>:<full-id>"`, even when the target is the current session. Headers become `session <harness>:<id> | seq <seq> | <role>`. Copy that session into `history_read` and any continuation reads. Paging, `expand` and `neighborhood` recipes already carry it. Structured pages expose `has_older` and `has_newer`; use the first or last non-context row's seq as `before` or `after`, respectively. For example: `→ newer: {"session":"<harness>:<full-id>","after":42}`. An `after` bound pages forward; otherwise the page starts at the newest eligible end. See [tool results](tool-results.md#bounds-and-continuation) for query context and bounds.

## Browse or search across sessions

Any selector containing `*` selects multiple sessions; `*` matches any string and all other characters are literal. `*` covers all available harnesses, `pi:*` restricts to Pi, and `claude:prefix*` narrows by session ID.

```js
history_list({ session: "*" }) // Recent sessions, one opening prompt/topic each
history_list({ session: "*", query: ["deployment", "rollback"], limit: 20 })
history_list({ session: "codex:*", query: "migration", roles: ["tool"], after: "2026-10-01", context: 1 })
```

- With a non-empty `query`, matching is literal, case-insensitive, and ORs a list of texts, as in one-session search. Local files are conservatively pre-filtered before full decoding: JSON escapes, Unicode case folding, generated event text and inherited Codex history must not lose hits. Uncertain cases use the full decoder. A possible hit in a Pi or Claude file stops the prefilter early: the strict decoder will read and validate the file next.
- Without a non-empty `query`, return a recent-sessions overview. Consider sessions newest-modified first, or oldest-modified first with `after`; stop loading once `limit` sessions (default 20) produce a representative. Apply `roles`, `after` and `before` before choosing a representative. Without roles, prefer the first visible user event, falling back to the latest visible assistant event or the latest event of any role. With roles, choose the latest matching visible event. Return the representatives oldest first by event time.
- Wildcard bounds take only ISO 8601 times, both exclusive. Seqs from different sessions cannot define a common range. Time bounds exclude events with no usable timestamp.
- `history_read` refuses wildcard selectors with `invalid_session`; take a specific `session` and `seq` from the result instead.
- A query searches all roles, including tool arguments/output and injected context; `roles` can narrow the hits. `context: N` includes up to N neighbors on each side from the hit’s own session, even outside the hit bounds. There are no folded rows.
- Hits and context are merged oldest first by event time, with a deterministic session/seq tie-break; untimed events sort first. `limit` counts hits from the newest end by default or from the oldest end with `after`. The complete text and structured result still share the 32 KiB budget.
- Each event carries its canonical `session`. `has_older` and `has_newer` indicate more matching results beyond the page; an overview with unvisited sessions may have more even if those sessions have no representative. Narrow by session pattern, query, roles or time rather than trying to page across per-session seqs.

## Local discovery and limits

| Harness | Default source | Selection/decoding |
| --- | --- | --- |
| Pi | `~/.pi/agent/sessions/<workspace>/<timestamp>_<id>.jsonl` | Current session uses the native active branch. Offline current-format files follow persisted parent links from the last tree entry, preserving append seqs and inactive-branch holes. |
| Claude | `~/.claude/projects/<project>/<id>.jsonl` | The current session still requires its live, confirmed append head. Offline files account for logical compact links, prefer non-attachment graph leaves when available, and select the last remaining leaf in transcript order. Only that leaf's confirmed ancestors are exposed; a graph with no leaves still refuses. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-...-<threadId>.jsonl(.zst)` | The same strict 0.160.1 rollout/lineage decoder as current-session history; compressed files need Node >=22.15. Root `session_id` is not a child thread ID. |
| DSH | `ctx.sessionQuery.listSessions()` / `readSession(id)` | Available inside DSH only, over its live-preferred local session corpus. Other hosts cannot discover DSH files themselves. |

Filesystem discovery does not follow directory symlinks or recurse into Claude subagent stores. Missing roots are empty. Repeated native files for one qualified ID produce one descriptor (newest modified); the current live binding wins over its on-disk descriptor. Discovery and decoding never mutate transcript bytes or modification times. Unsupported/corrupt or unreadable selected transcripts return `history_unavailable` naming the session for single-session list/read calls. Wildcard searches and overviews skip individual sessions that cannot load; an empty wildcard result is not proof that an event never happened. A readable Claude ancestry gap appears as an optional `notice` in cross-session page/read data and in rendered text; it stays outside event text and search/read offsets and counts against the output budget.

The default roots respect `PI_CODING_AGENT_DIR` (Pi agent directory), `CLAUDE_CONFIG_DIR` (Claude config directory), and `CODEX_HOME` (Codex home). For direct root overrides use absolute paths in `NOTESOUP_HISTORY_PI_ROOT`, `NOTESOUP_HISTORY_CLAUDE_ROOT`, and `NOTESOUP_HISTORY_CODEX_ROOT`; these name the **sessions**, **projects**, and **sessions** directories respectively, not notes storage. `NOTESOUP_HOME` only changes notes.

## Strict recent-session cache

Only an unfiltered wildcard overview uses the persistent offline representative cache: no nonempty query and no `roles`, `after`, or `before`. Empty queries still mean an overview. Explicit session reads/lists, searches, filtered overviews, DSH service descriptors and the current live binding do not use this cache. Session discovery, modified-time ordering, representative ordering, output budgeting and full event-preview limits are unchanged.

A cold miss deliberately reads and strictly decodes the whole transcript, including selected Codex ancestry. It saves only the complete selected event, canonical session identity, notice and source metadata—not a projection, header-only approximation or full-text index. Entries are versioned with the decoder/selection contract; decoder or presentation changes must bump that version. The key includes the canonical root transcript path, harness and session ID. Every source has a `dev`/`ino`/size/nanosecond mtime/ctime fingerprint taken before reading and checked after decoding. Codex records the actual root and ancestor files, and cache hits re-run native lineage discovery so newly ambiguous or missing sources cannot be hidden by unchanged file fingerprints. The fingerprint list must exactly match the root and lineage witness list.

Cache storage is `~/Library/Caches/notesoup/history` on macOS, or `$XDG_CACHE_HOME/notesoup/history` (`~/.cache/notesoup/history` by default) elsewhere. Entries use atomic temporary-file rename and are individually capped at 8 MiB, both on admission and before/after reading. Oversized representatives still use normal strict decoding and normal output budgets; they are not truncated for cache admission. Missing, corrupt or unwritable caches are transparent misses. Raced decodes are returned without persistence. Transcript failures are never cached: wildcard calls still skip those sessions, while explicit calls still refuse. There is no public cache option, background warmup, or whole-corpus index; the internal test-root seam keeps tests out of the user's cache.

### Cold and warm evidence

A November 1, 2026 local read-only measurement used a private empty cache and a fresh Node process for each pass. It ran the default 20-topic overview over offline descriptors last modified at least ten minutes earlier, excluding active work; both passes returned exactly the same serialized result. This is one local sample, not a cold-search or whole-corpus speed claim.

| Measurement | Cold cache | Warm cache |
| --- | ---: | ---: |
| Elapsed | 462.58 ms | 89.63 ms |
| Transcript body reads | 32 | 12 |
| Transcript bytes | 159,240,525 | 70,962,466 |
| JSON parses (including cache entries) | 10,636 | 32 |
| Peak process RSS | 305,200 KiB | 134,208 KiB |

All 20 unchanged supported sessions hit their summaries without body reads on the warm pass. The remaining 12 body reads in **both** passes were unavailable/unsupported sessions intentionally rechecked rather than negatively cached. Twenty entries occupied 184,431 bytes (largest 142,796 bytes). Focused hermetic tests independently prove zero second-call transcript reads for supported Pi and compressed Codex/ancestor fixtures, complete-event preview parity, invalidation, cache-growth fallback and live-binding precedence. Warm calls still pay discovery/stat/cache-validation costs; Codex lineage can require directory discovery. Cold decoding can still use substantial per-transcript memory, and rejected transcripts are retried on each browse.

Embedders/tests can use `localHistoryCorpus({ current, roots, home, env, dshSessions })` from the source module `src/history/local.ts`. Each `roots` member overrides that harness's discovery directory; `null` disables it. A supplied `home` with `env: {}` makes the defaults hermetic. These source-module helpers are not new package exports.

The shared operations still accept a bare `HistoryProjection` for current-session calls. Host adapters instead supply a `HistoryContext` with a lazy `current()` projection and a `HistoryCorpus`. Filesystem wire decoders live under `src/history/`, import no host SDK/plugin, and are shared by native adapter entries and corpus reads. DSH contributes descriptors through its public query service. Foreign reads do not require loading the current projection; Codex still validates the caller's hook binding and native identity/window before serving them.

In single-session browse pages, `items` contains events only. A folded tool/context run appears in `folded_before` on the following event, or in `folded_after` at the end of the page. Folded runs do not count toward the event limit.
