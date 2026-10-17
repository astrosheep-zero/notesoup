# Notes and history tool results

The eight notes/history tools have one business result model. Pi exposes compact results as `structuredContent` to codemode and renders them as `content` for ordinary model calls. Claude uses the same business handlers and text rendering. Neither host re-runs a query, truncates a different page, or parses formatted text to recover data.

This is a breaking tool protocol change: successes no longer have `ok/data` wrappers, errors are flat, and read fields no longer sit under `window`. History execution details live once in the pageable document. Stored notes and raw Pi session entries are not deleted or rewritten by this change. `empty_brain` and `get_context_remaining` are outside this protocol.

## Results

```ts
type Result<T> = T | { error: string; code: string };
```

Each operation declares its concrete success schema; `error` is reserved for a refusal message. Success and expected failure both have a structured result; Pi's `isError` follows the outcome. Host-level argument validation, blocked execution and transport errors remain host failures. Shared handlers and the private Claude helper transport retain an internal `Outcome<T>` (`{ ok: true, data }` or `{ ok: false, error: { code, message } }`); this envelope is not the Pi wire result. The Claude hook returns rendered text as a string result and sets `isError: true` only on a refusal.

```js
const result = await tools.notes_list({ glob: "@project/**" });
if ("error" in result) return result.error;
return result.files;
```

The text representation uses short mutation receipts, lists, search hits or raw text windows. It reports omissions and errors rather than hiding them. A refusal renders as one line, `error: <code>: <message>`, and the message carries every fact a caller needs to recover: the known window ids for `unknown_window_id`, the edit index and match lines for a note edit refusal.

## Read windows

Both read operations return these fields at the result root, alongside identity and metadata:

```ts
{
  text: string;
  total_chars: number;
  next_offset_chars: number | null;
}
```

Positions count Unicode code points, not UTF-16 units or UTF-8 bytes. The returned text is a contiguous unmodified prefix of the requested range, without ellipsis markers. `next_offset_chars` names the first undelivered character, or is null at the true end. A negative input offset selects a tail; the delivered window does not echo the offset it resolved.

- `notes_read`: `address`, optional `project_key`, and `metadata` accompany the text fields. Positions address only the note **body**. Access counts and last-access times remain stored but are omitted from results.
- `history_read`: `seq`, `window_id`, `role`, `created_at`, and a tool summary accompany the text fields. Positions address one deterministic document derived from the event's facts. Query matches address that same document, not its decorated presentation.

Repeated note reads observe the current file; this is not a retained snapshot service. A concurrent body edit can change positions. History reflects the active branch and recorded facts, including a result that may arrive after a pending call was first observed.

Text rendering puts identity and relevant metadata above the payload. Only an incomplete read receives a continuation suffix, which says where to continue and nothing about why the window stopped:

```text
[truncated; continue at offset_chars=12000]
```

The suffix and presentation header are never part of `text`, search offsets or total character counts. At the end there is no completion footer.

## History identity and execution evidence

The native adapter allocates seqs from session append order, selects the active branch and decodes facts. Shared history pairs calls and results without allocating a second transcript. A paired execution is addressed by its call seq. Its result's raw slot is not a public event address; list/search provide the canonical seq. Unpaired results remain independently addressable. Inactive-branch addresses are not readable.

Tool events expose `tool`, `tool_status`, and, when recorded, `output_truncated` and `full_output_path`; a truncated run is named even when the host recorded no path, and the full text path is named only when it exists. `history_read` also reports `nested_calls`; a page row does not. Full arguments and nested-call records live only in the searchable/readable document, avoiding a second structured copy on every read.

Pi's nested records contain child ID, name, optional arguments, status, timing and error, plus completeness. They contain **no child result bodies**. Absent records do not establish that no nested work occurred. Host-omitted arguments and unfinished calls remain visible as incomplete evidence. Child records belong to their parent event and do not consume seqs.

`history_read` reports `nested_calls.call_count` and `nested_calls.complete` exactly as recorded: the count is every record the host stored, even if the current text slice contains none of them. Continue with `next_offset_chars` to recover the entire recorded document. Both a call's result and an unpaired result carry their recorded evidence; neither invents the call the other one is missing. Query results contain event rows only; folded rows exist only in the browse view.

## Bounds and continuation

One selection determines the structured result and its text. Both complete representations must fit the 32 KiB output budget, including metadata, cursor and rendered notice. A programmatic caller does not receive an unbounded hidden payload beside a truncated textual one. History operations accept an optional pure text wrapper from the host: selection and read-window checks measure that wrapper around the shared rendering, and the caller must apply the same wrapper at delivery. Host prose stays in its plugin; no final clipping or separate query is involved.

History pages carry `page_older` and `page_newer`, the exact params to merge into the next call; `from` picks which end of a bounded range `limit` counts from, `since`/`until` narrow that range by event `created_at`, and only a call without roles or a non-empty query folds tool/context runs. Omitted queries, empty strings and empty lists all disable search filtering; empty entries in a query list are ignored. Without a query, notes search returns scoped notes with empty `matches`, not every body line. Notes listings/search are snapshots with a `more` count and can be narrowed by `glob`; they are not falsely advertised as paginated. `history_windows` is a snapshot too: its `more` counts the windows the budget left out and there is no window cursor, because `history_list` rows also expose `window_id`. A read can stop anywhere in the event document, including inside serialized arguments; concatenate its verbatim text slices before parsing any arguments. There is no separately truncated arguments object.

A note read reports unrecognized frontmatter under `metadata.extra`; a value too large to carry, or past the verbatim budget, is named in place as `[omitted: too large]` under its key rather than delivered in part, and the value itself stays in the note file. A rename receipt uses `address` for the destination and `rename_from` for the source; it has no duplicate `rename_to` field.

`output_too_large` is not one failure, and a refusal does not mean nothing happened. Each operation's own message says what it means: a `notes_update` whose receipt cannot fit reports that the update was already applied, so read the note before retrying, and a read that cannot deliver a single advancing character is refused rather than answered with an empty window. A receipt whose diff or search-match line cannot fit is cut to the longest prefix that does, and its own text ends with the marker: `[diff truncated; update applied]` for a diff, ` [truncated]` for a match line. Narrowing helps only where a parameter genuinely reduces the selection — `glob` or `query`, `roles`, `window_id`, `limit`, `max_chars_per_item`, a `before_seq`/`after_seq` range, or a `since`/`until` time window — and cannot help a read whose own metadata is what overflows. History pages refuse with `page_too_large` for the same reason. Nothing is ever quietly delivered short: every other omission is reported on the successful result that carries it.

## Ownership

- The notes store owns addressing, file contents, metadata and mutations.
- The history adapter owns native decoding, seq allocation and branch visibility.
- Shared operations own the typed result, filtering, paging, character windows and refusal messages.
- Shared renderers derive text from that result.
- Pi/Claude adapters supply host identity, projections, optional pure text decoration and transport packaging only.

There is no second query implementation for codemode, no copy of session storage and no migration of user records.
