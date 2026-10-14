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

`/notes` ships JavaScript and TypeScript declarations. It does not import Pi or read `PI_*` environment variables. Pi packages are optional peers: a notes-only installation does not install them. Using the plugin, root SDK entry, or `dream` CLI still requires Pi. This is a filesystem library for Node, not a browser storage API.

## API and identity

`createNotesStore(identity)` snapshots the five required identity fields; changing the supplied object afterward does not retarget the store. It resolves `home` once, validates identity components, and creates no files until an operation needs to write. Create a new store to change identity. Multiple stores can use independent roots and identities without changing process environment.

- `write(address, content, { origin? }?)` returns `Promise<{ meta, outcome }>` (`created`, `overwritten` or `uncrumpled`). New notes default to origin `self`; overwriting preserves the existing origin unless explicitly supplied, creation time, project ownership, and unknown metadata, and always produces an uncrumpled note (it clears any `crumpledAt`).
- `read(address)` returns `Promise<{ meta, body, resolvedScope } | undefined>`. **Reads update** `lastAccessed` and `accessCount` on disk. The body is separate from metadata; the serialized frontmatter is not part of the read API.
- `update(address, edits?, { origin?, crumpled?, replaceAll?, renameTo? }?)` returns `Promise<{ meta, applied, resolvedScope, change, moved, replacedCrumpledTarget }>`. Body edits, origin, crumpled state and a move can be combined. Every edit, destination and size check passes before saving; a live target refuses with `already_exists`, while a crumpled target can be replaced. Cross-session moves update project ownership. Each replacement uses the evolving body in array order. `crumpled: true` keeps an existing `crumpledAt` or adds it; false removes it; omitted preserves it. `updatedAt` advances for body/origin changes and actual moves, not crumpling alone. `change` contains `{ kind, before, after }`, with kind `body`, `metadata` or `none`; a body edit that also changes metadata or moves includes the whole serialized file in its diff inputs. Moves lock both paths in stable order, atomically write the destination, then remove the source; this is not a crash-atomic two-file transaction.
- `rename(fromAddress, toAddress)` returns `Promise<{ meta, replacedCrumpledTarget }>`. It delegates to the same update path with `renameTo`, preserving metadata. A same-file destination is a successful no-op, and can accompany edits without taking a second lock.
- `list({ glob?, crumpled? }?)` returns `Promise<NoteRow[]>`, sorted by update time descending with address tie-breaking. Rows contain address, scope, virtual path, metadata, body, and body byte size. Crumpled notes are excluded by default; `crumpled: true` returns only crumpled notes.
- `search(queries: string[], { glob?, crumpled? }?)` returns `Promise<NoteSearchRow[]>`, sorted by address, with the same selection and crumpled-note rules. An empty queries array returns matching notes with empty `matches`. Otherwise search is case-insensitive literal OR over body lines; matches contain one-based `line`, `text`, and code-point `offsetChars` into the body. Neither listing nor search increments access metadata.

`list` and `search` share `NotesQuery`: **glob is the only home/path selector**. Omit it for the five current homes; use `@project/**`, `@self/**`, or `@projects/<name>/**` to select a home. The former `scope`/`who` query parameters are removed, without compatibility aliases. Row metadata still includes scope.

The library returns full data, not tool envelopes or paginated/truncated output. `NoteError` exposes the existing named store refusals through `code`, with `lineNumbers` for ambiguous edits and `editIndex` for a failed edit. Runtime API fields and known persisted note metadata use camelCase; Pi tool wire fields such as `updated_at`, `offset_chars`, and `replace_all` retain their established names. Unrecognized frontmatter keys, including old snake_case metadata, are preserved as ordinary extras; they are not interpreted as current camelCase fields or migrated automatically. Invalid addresses/identities and filesystem failures reject; only a missing `read` returns `undefined`. Notes remain markdown files with the existing size limits and same-directory atomic rename. Same-file read/modify/write work is serialized by absolute physical filename across all store instances in this process (including `.md` address aliases); symlink/case aliases and cross-process locking are not guaranteed. `list` and `search` asynchronously traverse homes and serialize each discovered file read against pending mutations, but are not global snapshots and may not discover a file created after traversal. Foreign named homes can be read (including the access-metadata update), but their bodies cannot be written or edited through the store. These are cooperative address rules, not an OS security sandbox.

Addresses are a path with no `@` (a session note), `@project/`, `@human/`, `@self/`, `@model/`, or explicit `@agents/<slug>/` and `@models/<slug>/`. Relative self/model addresses resolve to the supplied identity. Results show the current agent's and model's notes as `@self/` and `@model/`; only other agents' or models' notes carry an explicit `@agents/<slug>/` or `@models/<slug>/`. Globs accept either form. The disk layout remains `pi/session/<sessionId>/`, `project/<projectKey>/`, `human/`, `agents/<agent>/`, and `models/<model>/`. No data migration happens on library import or construction. Notes already using camelCase metadata retain their metadata; old snake_case keys are preserved as unrecognized extras, not interpreted or migrated. New session notes record the supplied project key.

## Library and plugin boundary

Ownership is explicit in the file tree:

```text
src/
  index.ts               # only the Pi extension and createNotesoup factory
  notes/                 # filesystem semantics and explicit NotesIdentity
  boot/                  # five-home snapshot and pure rendering with tool bindings
  history/               # decoded query projection, pairing, paging and folding
  budget/                # pure thresholds, countdown policy and reminder text
  tools/                 # operation schemas, typed outcomes and bounded presentation
  dream/                 # jail, deletion policy, locks, gates, audit, reports, doctor
  settings.ts            # SDK-independent settings keys and per-key parsing
  pi/                    # native integration, not part of /notes
    extension.ts         # registration composition
    runtime.ts           # native lifecycle, commands, provider projection and UI
    window.ts            # native markers, checkpoints, branches and usage
    history.ts           # native decoding, seq allocation and branch selection
    notes/               # live identity extraction, registration and native diffs
    reset/               # reducer, boundary drafts, commit confirmation and repair
    dream/               # Pi session backend, settings reads and CLI
```

The public runtime exports are `createNotesStore`, `NoteError`, `projectKey(cwd)`, and `slugify(value)`, alongside the API's TypeScript types. The factory and `projectKey` remain synchronous; `projectKey` provides the existing repository/worktree identity algorithm, while `slugify` normalizes an agent/model name. The six primary store methods return promises and use asynchronous filesystem operations. Path/glob helpers, serialization, validation internals and constants are implementation details, not exported through `/notes`.

The Pi adapter supplies the root and live session/project/agent/model identity on each call. Tools and boot use the same storage implementation. Shared tool schemas use `typebox`, declared as a peer supplied by Pi and as a dev dependency for standalone development; their handlers accept explicit identities or decoded history projections. Pi owns registration, execution-context extraction and native edit diff rendering. Boot snapshot acquisition receives identity, a captured timestamp and an optional home loader; rendering receives explicit logical tool names. Native session traversal, stable seq allocation, branch selection and inference projection stay in Pi. Shared history is a query view, never a way to reconstruct inference messages. There are no compatibility shims or generic host runtime. Internal source paths are not the supported library API.
