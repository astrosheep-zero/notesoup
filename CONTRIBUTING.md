# Contributing

Read [architecture](docs/architecture.md) and [reset lifecycle](docs/reset-lifecycle.md) before changing ownership or lifecycle behavior.

## Ownership

- `src/notes`, `src/boot`, `src/history`, `src/budget`, `src/tools` and shared `src/dream` are SDK-independent domains. Explicit identity, captured time, decoded data and logical tool bindings cross the boundary; `ExtensionContext` does not.
- Shared imports cannot reach an SDK or anything under `plugins/`, directly or transitively. Types, re-exports, literal dynamic imports and import-type expressions count. Use `test/dependencies.test.ts` to enforce this; do not add temporary exemptions.
- Native host integration lives in that host's plugin: Pi sessions/events/settings, seq allocation, branch selection, markers/checkpoints, inference projection, registration, UI, reset reducer/repair/confirmation and the dream backend/CLI belong in `plugins/pi`; the Claude Code helper and transcript decoding in `plugins/claude`; the Cordis rows in `plugins/dsh`. A plugin cannot import another plugin or a foreign host SDK. Host-specific prose belongs in the plugin's own text module, never in `src/`.
- Shared history is for queries, not reconstructing inference messages. Repairable-suffix inspection is not evidence that a historical reset remains uncommitted.
- Declare shared runtime dependencies in `dependencies` (TypeBox is direct), not as undeclared Pi peers. No generic Harness, event emulator, capability registry or catchall domain.

## APIs and persistence

The package root exports the curated host-neutral core surface, `notesoup/pi` exports the default Pi extension and `createNotesoup`, and `/notes` exports the standalone notes API with `NotesIdentity`. Tests import implementation owners, not a root internal bag. Source/API breaking changes are allowed in this refactor: do not restore old-path shims, `NotesContext` aliases or deep-entry export aliases to satisfy legacy packaging tests.

Preserve tool/command names, model-facing copy, note homes/addresses/metadata and raw session archives unless a separately authorized change requires otherwise. No storage migration accompanies this refactor. Retain native checkpoints, branch isolation, stable seq/result aliases, abort/error refusal, queued-batch boundaries, stale async guards, warning-runway countdown and committed-only notices. Keep dream jail, live-note deletion refusal, lock ownership and partial-failure audit/report assertions intact.

## Local verification

Use the appointed worktree when working under a contract; do not change unrelated checkouts or start competing writers.

```sh
npm ci --ignore-scripts  # only when dependency installation is needed
npm run typecheck
npm test
git diff --check
```

`npm test` cleans/builds `dist`, checks current configured entries, and runs the existing Node tests plus focused domain/dependency guards. Scripted Pi SDK tests use temporary directories and fake credentials without live model calls. Optional `node scripts/check-notes-package.mjs` exercises the built intentional `/notes` entry; it does not install or validate an old package. Keep meaningful behavioral assertions when adapting imports. Commit coherent phases, report exact commands/results and known gaps, and leave publication/version changes to a separately authorized release.
