# Notes and history tool results

The eight notes/history tools have one business result model. Pi exposes compact results as `structuredContent` to codemode and renders them as `content` for ordinary model calls. Claude uses the same business handlers and text rendering. Neither host re-runs a query, truncates a different page, or parses formatted text to recover data.

This is a breaking tool protocol change: successes no longer have `ok/data` wrappers, errors are flat, and read fields no longer sit under `window`. History execution details live once in the pageable document. Stored notes and raw Pi session entries are not deleted or rewritten by this change. `clear_memory` and `get_context_remaining` are outside this protocol.

## Results

```ts
type Result<T> = T | { error: string; code: string; details?: Record<string, unknown> };
```

Each operation declares its concrete success schema; `error` is reserved for a refusal message. Success and expected failure both have a structured result; Pi's `isError` follows the outcome. Host-level argument validation, blocked execution and transport errors remain host failures. Shared handlers and the private Claude helper transport retain an internal `Outcome<T>` (`{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`); this envelope is not the Pi wire result. The Claude hook returns rendered text as a string result and sets `isError: true` only on a refusal.

```js
const result = await tools.notes_list({ pattern: "@project/**" });
if ("error" in result) return result.error;
return result.files;
```

The text representation uses short mutation receipts, lists, search hits or raw text windows. It reports omissions and errors rather than hiding them. `details` contains error context, not a second copy of the payload.

## Read windows

Both read operations return these fields at the result root, alongside identity and metadata:

```ts
{
  text: string;
  offset_chars: number;
  total_chars: number;
  next_offset_chars: number | null;
  limited_by: "limit" | "bytes" | null;
}
```

Positions count Unicode code points, not UTF-16 units or UTF-8 bytes. The echoed offset is absolute even when a negative input selects a tail. The returned text is a contiguous unmodified prefix of the requested range, without ellipsis markers. `next_offset_chars` names the first undelivered character, or is null at the true end.

- `notes_read`: `address`, optional `project_key`, and `metadata` accompany the text fields. Positions address only the note **body**. Access counts and last-access times remain stored but are omitted from results.
- `history_read`: `seq`, `window_id`, `role`, `created_at`, and a tool summary accompany the text fields. Positions address one deterministic document derived from the event's facts. Query matches address that same document, not its decorated presentation.

Repeated note reads observe the current file; this is not a retained snapshot service. A concurrent body edit can change positions. History reflects the active branch and recorded facts, including a result that may arrive after a pending call was first observed.

Text rendering puts identity and relevant metadata above the payload. Only an incomplete read receives a native-Pi-style suffix:

```text
[12000 more characters. Use offset_chars=12000 to continue.]
```

If the output byte budget, rather than the requested character count, stops the window:

```text
[Showing chars [0, 11000) of 24000 (32KB limit). Use offset_chars=11000 to continue.]
```

The suffix and presentation header are never part of `text`, search offsets or total character counts. At the end there is no completion footer.

## History identity and execution evidence

The native adapter allocates seqs from session append order, selects the active branch and decodes facts. Shared history pairs calls and results without allocating a second transcript. A paired execution is addressed by its call seq. Its result's raw slot is not a public event address; list/search provide the canonical seq. Unpaired results remain independently addressable. Inactive-branch addresses are not readable.

Tool events expose `tool`, `tool_status`, and, when recorded, `output_truncated`, `full_output_path`, and `nested_calls`. Full arguments and nested-call records live only in the searchable/readable document, avoiding a second structured copy on every read.

Pi's nested records contain child ID, name, optional arguments, status, timing and error, plus completeness. They contain **no child result bodies**. Absent records do not establish that no nested work occurred. Host-omitted arguments and unfinished calls remain visible as incomplete evidence. Child records belong to their parent event and do not consume seqs.

List and read report `nested_calls.call_count` and `nested_calls.complete` exactly as recorded: the count is every record the host stored, even if the current text slice contains none of them. Continue with `next_offset_chars` to recover the entire recorded document. Both a call's result and an unpaired result carry their recorded evidence; neither invents the call the other one is missing. Query results contain event rows only; folded rows exist only in the browse view.

## Bounds and continuation

One selection determines the structured result and its text. Both complete representations must fit the 32 KiB output budget, including metadata, cursor and rendered notice. A programmatic caller does not receive an unbounded hidden payload beside a truncated textual one.

History pages carry `page_older` and `page_newer`, the exact params to merge into the next call; `order` picks which end of a bounded range `limit` counts from, and only a call without roles or query folds tool/context runs. Notes listings/search are snapshots with a `more` count and can be narrowed by `pattern`; they are not falsely advertised as paginated. `history_windows` is a snapshot too: its `more` counts the windows the budget left out and there is no window cursor, because `history_list` rows also expose `window_id`. A read can stop anywhere in the event document, including inside serialized arguments; concatenate its verbatim text slices before parsing any arguments. There is no separately truncated arguments object.

A note read reports unrecognized frontmatter under `metadata.extra`, and any entry too large to show is counted in `metadata.omitted_extra` instead of being listed. The omitted values stay in the note file. A rename receipt uses `address` for the destination and `rename_from` for the source; it has no duplicate `rename_to` field.

Error `details` is sanitized context with its own bound: a stable refusal code is an internal identifier and is never clipped, a runaway message is clipped with its lost length, and details that would exceed their budget are replaced by `{ truncated: true, details_bytes }` rather than partly serialized. Context that cannot be serialized at all is a defect in the operation, and surfaces as one rather than as a bounded refusal. A refusal never enumerates the keys it could not report.

`output_too_large` is not one failure, and a refusal does not mean nothing happened. Each operation's own message says what it means: a `notes_update` whose receipt cannot fit reports that the update was already applied, so read the note before retrying, and a read that cannot deliver a single advancing character is refused rather than answered with an empty window. Narrowing helps only where a parameter genuinely reduces the selection — `pattern` or `query`, `roles`, `window_id`, `limit`, `max_chars_per_item`, or a `before`/`after` range — and cannot help a read whose own metadata is what overflows. History pages refuse with `page_too_large` for the same reason. Nothing is ever quietly delivered short: every other omission is reported on the successful result that carries it.

## Ownership

- The notes store owns addressing, file contents, metadata and mutations.
- The history adapter owns native decoding, seq allocation and branch visibility.
- Shared operations own the typed result, filtering, paging, character windows and error data.
- Shared renderers derive text from that result.
- Pi/Claude adapters supply host identity, projections and transport packaging only.

There is no second query implementation for codemode, no copy of session storage and no migration of user records.
