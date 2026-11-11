# Standalone notes library

The same package provides a **Node.js TypeScript library independent of Pi**:

```sh
npm install notesoup
```

```ts
import { createNotesStore, type NotesIdentity } from "notesoup/notes";

const identity: NotesIdentity = {
  home: "/path/to/notes",          // explicit filesystem root
  sessionId: "my-session",        // safe single directory component
  projectKey: "my-project-a1b2c3d4",
  agent: "my-agent",              // canonical lowercase slug
  model: "my-model",              // canonical lowercase slug
};
const notes = createNotesStore(identity);
await notes.write("@project/decisions.md", "Use a shared notes library.", { origin: "user" });
await notes.update("@project/decisions.md", [
  { oldText: "shared", newText: "host-independent" },
]);
const note = await notes.read("@project/decisions.md"); // body and metadata, or undefined
const files = await notes.list({ glob: "@project/**" });
const matches = await notes.search(["library"]);
```

`/notes` ships JavaScript and TypeScript declarations. It does not import Pi or read `PI_*` environment variables. Pi packages are optional peers: a notes-only installation does not install them. Using the Pi plugin or the dsh rows (`notesoup/dsh`) still requires its host. This is a filesystem library for Node, not a browser storage API.

## API and identity

`createNotesStore(identity)` snapshots the five required identity fields; changing the supplied object afterward does not retarget the store. It resolves `home` once, validates identity components, and creates no files until an operation needs to write. Create a new store to change identity. Multiple stores can use independent roots and identities without changing process environment.

The standalone store does **not** accept `cwd`: its `projectKey` is already the resolved storage identity. The shared model-tool operations exported from the package root instead take a `NotesToolContext`, constructed with `notesToolContext(identity, baseCwd)`. Their optional `cwd` parameter selects the current project for one call. A relative override resolves against the host-supplied `baseCwd`, never a helper or MCP process cwd; an explicit override must be an existing directory or the operation refuses with `invalid_cwd`. The resolver preserves the session, notes root, agent, model, and dream marker while replacing only `projectKey`. It does not mutate the context or affect later calls. Bare session notes stay in that session, although a newly created one records the selected project in its ownership metadata.

- `write(address, content, { origin?, pinned?, budget?, readonly? }?)` returns `Promise<{ meta, outcome, warnings }>` (`created`, `overwrote` or `uncrumpled`). New notes default to origin `self`; overwriting preserves the existing origin unless explicitly supplied, creation time, project ownership, and unknown metadata, and always produces an uncrumpled note (it clears any `crumpledAt`).
- `read(address)` returns `Promise<{ meta, body, resolvedScope } | undefined>`. Reads update `lastAccessed` and `accessCount` on disk, except explicit named project/session reads, which leave the file untouched. The body is separate from metadata; the serialized frontmatter is not part of the read API.
- `update(address, edits?, { origin?, pinned?, budget?, readonly?, crumpled?, replaceAll?, renameTo? }?)` returns `Promise<{ meta, warnings, applied, resolvedScope, change, moved, replacedCrumpledTarget }>`. Body edits, origin, crumpled state and a move can be combined. Every edit, destination and size check passes before saving; a live target refuses with `already_exists`, while a crumpled target can be replaced. Moves into or out of the current session notebook update project ownership; explicit named session addresses are read-only. Each replacement uses the evolving body in array order. `crumpled: true` keeps an existing `crumpledAt` or adds it; false removes it; omitted preserves it. `updatedAt` advances for body/origin/policy changes and actual moves, not crumpling alone. `change` contains `{ kind, before, after }`, with kind `body`, `metadata` or `none`; a body edit that also changes metadata or moves includes the whole serialized file in its diff inputs. Moves lock both paths in stable order, atomically write the destination, then remove the source; this is not a crash-atomic two-file transaction.
- `rename(fromAddress, toAddress)` returns `Promise<{ meta, warnings, replacedCrumpledTarget }>`. It delegates to the same update path with `renameTo`, preserving metadata. A same-file destination, including a case or symlink alias resolved by the filesystem, applies accompanying edits without removing the source. An exact path alias needs only one lock.
- `list({ glob?, crumpled? }?)` returns `Promise<NoteRow[]>`, sorted by update time descending with address tie-breaking. Rows contain address, scope, virtual path, metadata, body, and body byte size. Crumpled notes are excluded by default; `crumpled: true` returns only crumpled notes.
- `search(queries: string[], { glob?, crumpled? }?)` returns `Promise<NoteSearchRow[]>`, sorted by address, with the same selection and crumpled-note rules. Rows also carry body-budget `warnings`. An empty queries array returns matching notes with empty `matches`. Otherwise search is case-insensitive literal OR over body lines; matches contain one-based `line`, `text`, and code-point `offsetChars` into the body. Neither listing nor search increments access metadata.

`list` and `search` share `NotesQuery`: **glob is the only notebook/path selector**. Omit it or use the bare collection alias `@default` for the five current notebooks. Explicit `*` or `**` searches all notebooks, including other sessions, projects, agents and models (any pattern without `@` or `/` matches note filenames at any depth as `**/<pattern>`); `@sessions/*/**` selects all session notebooks. Use `@project/**`, `@self/**`, or `@projects/<name>/**` to select a notebook. `@default` is query-only, not a directory or a read/write address; `@default/**` is not its spelling. The former `scope`/`who` query parameters are removed, without compatibility aliases. Row metadata still includes scope.

The library returns full data, not tool envelopes or paginated/truncated output. `NoteError` exposes the existing named store refusals through `code`, with `lineNumbers` for ambiguous edits and `editIndex` for a failed edit. Runtime API fields and known persisted note metadata use camelCase; Pi tool wire fields such as `updated_at`, `offset_chars`, and `replace_all` retain their established names. The notes partition status field is `NoteQueryStatus.namespacesUnavailable` in the library and `namespaces_unavailable` on the `notes_list`/`notes_search` wire; both replace `NoteQueryStatus.homesUnavailable` and `homes_unavailable` with no compatibility alias, and the on-disk layout is unchanged. Unrecognized frontmatter keys, including old snake_case metadata, are preserved as ordinary extras; they are not interpreted as current camelCase fields or migrated automatically. Invalid addresses/identities and filesystem failures reject; only a missing `read` returns `undefined`. Notes remain markdown files with the existing size limits and same-directory atomic rename. Same-file read/modify/write work is serialized by absolute physical filename across all store instances in this process (including `.md` address aliases). Mutations additionally acquire notebook admission locks in stable order before file locks so concurrent stores cannot admit a sixth pin; reads/scans only acquire file locks. Symlink/case aliases and cross-process locking are not guaranteed. `list` and `search` asynchronously traverse notebooks and serialize each discovered file read against pending mutations, but are not global snapshots and may not discover a file created after traversal. Foreign named notebooks can be read, but their bodies cannot be written or edited through the store. Named project and session reads do not update access metadata. These are cooperative address rules, not an OS security sandbox.

Addresses are a relative path (a current-session note), `@project/`, `@human/`, `@self/`, `@model/`, or explicit `@projects/<slug>/`, `@sessions/<id>/`, `@agents/<slug>/` and `@models/<slug>/`. Named project and session addresses are read-only, including for rename sources and destinations. Session IDs use the same safe single-directory-component grammar as `NotesIdentity.sessionId`, not the agent/model slug grammar. Only the first character of an address is sigil-position: an unknown leading `@head` refuses, while `@` inside the path (`release@v1.md`, `@project/mail/alice@example.com.md`) is an ordinary character. Relative self/model addresses resolve to the supplied identity. Results show the current agent's and model's notes as `@self/` and `@model/`; only other agents' or models' notes carry an explicit `@agents/<slug>/` or `@models/<slug>/`. Globs accept either form. The disk layout remains `pi/session/<sessionId>/`, `project/<projectKey>/`, `human/`, `agents/<agent>/`, and `models/<model>/`. No data migration happens on library import or construction. Notes already using camelCase metadata retain their metadata; old snake_case keys are preserved as unrecognized extras, not interpreted or migrated. New session notes record the supplied project key.

## Per-note policy

`NoteMeta` has optional `pinned?: boolean`, `budget?: number`, and `readonly?: boolean` fields. Set these in on-disk frontmatter or in write/update options. Values are validated on parse and mutation: booleans must be actual booleans; budget must be a positive safe integer. Invalid values raise `NoteError("invalid_policy", ...)` without saving. Unknown frontmatter remains intact across rewrites. As before, a leading frontmatter block in `write`'s **content** is stripped, not used to set metadata; use the options or edit the on-disk frontmatter instead.

`effectiveNotePolicy(meta, path)` returns `{ pinned, budget, readonly }` for a notebook-relative Markdown path (`MAP.md`, not an `@` address). This is the shared default resolver used by storage, tools and boot:

- Ordinary pages have a default budget of **4096 Unicode code points**; root `CHEATSHEET.md` and `MAP.md` default to **2048**, adjustable to any positive safe integer. `warnings` on write/update/rename results report body overflow but do not reject it. Astral characters count once. The separate serialized-file byte limit still applies.
- Only root `CHEATSHEET.md` and `MAP.md` default to pinned; all other paths, including nested files with those names, default false. Explicit false overrides the default. Raw `meta` keeps absent policy fields absent, so implicit defaults are re-evaluated at a move's destination; explicitly set values travel with the note.
- Every physical notebook allows **5 live pins**, including existing default pages. Crumpled pins don't count. New pinning, writes that restore notes, explicit restores, and moves/renames all check admission and refuse with `pin_limit` before mutation if they would add a sixth pin. Same-notebook moves of an already-live pin don't consume another slot. Existing over-cap notes can still be edited, unpinned or crumpled. Boot defensively selects at most five pins, default-page-first then path order, visibly naming omitted pins in a manually over-cap notebook. Pinned bodies are injected whole, with budget warnings rather than truncation.
- `readonly: true` is a **soft lock**, not an authorization/security boundary. Existing locked notes refuse changes, overwrite, crumple/restore, rename/move, and dream deletion with `readonly`. Explicit `readonly: false` permits a metadata-only unlock or unlock plus the requested mutation in one call. A new/unlocked note may be written and locked together. Replacing a locked crumpled move target also requires explicit false. Reads/access counters still write, and filesystem edits can bypass the lock.

The five model tools accept the same policy options (write/update) and return effective policy visibly in receipts, read metadata, list and search rows, alongside budget warnings. Notebook pin admission is serialized across stores **within this process**; manual edits and other processes are not locked by this cooperative API.

## Library and plugin boundary

Ownership is explicit in the file tree:

```text
src/                     # host-neutral core; never imports a plugin or an SDK
  index.ts               # curated core surface: notes, boot, operations, budget prose
  notes/                 # filesystem semantics and explicit NotesIdentity
  boot/                  # five-notebook snapshot and pure rendering with tool bindings
  history/               # decoded query projection, pairing, paging and folding
  budget/                # pure thresholds, countdown policy and reminder text
  tools/                 # operation schemas, typed outcomes and bounded presentation
  dream/                 # jail, deletion policy, locks, gates, audit, reports, doctor
  settings.ts            # SDK-independent settings keys and per-key parsing
plugins/                 # one directory per host; each owns its SDK and its words
  pi/                    # Pi plugin; index.ts is the extension entry
    extension.ts         # registration composition
    runtime.ts           # native lifecycle, commands, provider projection and UI
    window.ts            # native markers, checkpoints, branches and usage
    history.ts           # native decoding, seq allocation and branch selection
    notes/               # live identity extraction, registration and native diffs
    reset/               # reducer, boundary drafts, commit confirmation and repair
    dream/               # Pi session backend, settings reads and CLI
    text.ts              # Pi-only pre-reset hints, last-word nudge, prompted close-out
  claude/                # the self-contained Claude Code plugin (hooks, dist, skills)
    src/                 # helper, transcript decoding, threshold derivation, text
  dsh/                   # Cordis plugin rows (notesoup, notesoup-engine)
```

A note **namespace** is a partition of the note store: a `Scope` plus its storage directory, including named `@projects`/`@agents`/`@models` members. It is unrelated to Pi's `ToolNamespace` (`plugins/pi/tool-result.ts`), which groups registered tools (`notes`, `history`); `home` names only the store root directory.

The disk layout is older than this split and is shared by every host: `pi/session/<sessionId>/` is a historical directory name, not the Pi adapter's private layout, and nothing here migrates or renames it.

The public runtime exports include `createNotesStore`, `effectiveNotePolicy(meta, path)`, `noteIdentity`, `NoteError`, `projectKey(cwd)`, and `slugify(value)`, alongside the API's TypeScript types. The factory and `projectKey` remain synchronous; `projectKey` provides the existing repository/worktree identity algorithm, while `slugify` normalizes an agent/model name. The six primary store methods return promises and use asynchronous filesystem operations. Path/glob helpers, serialization, validation internals and constants are implementation details, not exported through `/notes`.

The Pi plugin supplies the root and live session/project/agent/model identity on each call. Tools and boot use the same storage implementation. Shared tool schemas use `typebox`, declared as a peer supplied by Pi and as a dev dependency for standalone development; note handlers accept a `NotesToolContext` containing the explicit default identity and host base cwd, while history handlers accept decoded history projections or a lazy `HistoryContext`/`HistoryCorpus` for optional cross-session lookup. Pi owns registration, execution-context extraction and native edit diff rendering. Boot snapshot acquisition receives identity, a captured timestamp and an optional notebook loader; rendering receives explicit logical tool names. Native live session traversal and active-head/branch identity stay in each adapter; SDK-free persisted wire decoding and stable seq allocation are shared under `src/history/` for native and cross-harness reads. Shared history is a query view, never a way to reconstruct inference messages. There are no compatibility shims or generic host runtime. Internal source paths are not the supported library API.
