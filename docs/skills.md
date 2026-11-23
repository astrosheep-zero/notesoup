# Skills and dream

## Memory skill

The package provides `/skill:memory`, a short self-contained guide to the notes and history tools: note addresses and notebooks, finding and paging notes, searching and paging history, saving recovery state, and what to do when a memory tool is unavailable. It is a fallback for sessions where the boot protocol is missing or unclear and a reference on demand; normal tool calls do not require reading it. It is written independently of the boot text rather than generated from it. The Claude Code Mod ships the same guide; current-session history requires the documented main-session transcript path and a confirmed append head, while explicit `session` selectors use the local cross-harness corpus (offline Claude prefers non-attachment leaves, then the last leaf in transcript order).

## Dream

`/skill:dream` reviews notes in the current agent session, following the shared `playbook.md`.

In Pi the session gets three hidden `dream_*` tools; they are not declared to the model and are found with `tool_search` or codemode's `searchTools("dream")`:

- `dream_begin(project?)` opens one project, by default the current one, as in `@projects/<name>/`. It lists that project's notes and every session note whose frontmatter `project` names it, crumpled notes included. While it is open, `notes_write` and `notes_update` may edit those addresses (existing notes only in other sessions), and reads leave no access stamp. Other projects stay read-only.
- `dream_forget(address)` permanently deletes one crumpled note within reach; live notes refuse.
- `dream_end()` closes the dream.

One session dreams over one project at a time. New session notes record their project key in `project`; notes without it never appear in a project's dream. Standard linked Git worktrees share the main checkout's project key.

## The dream lock and Git audit

`dream_begin` takes a SQLite writer transaction on `<home>/.dream.lock.sqlite` and commits a Git baseline. Only one dream can run per notes home, even across projects; competing dreams refuse immediately. This lock is separate from project claims and does not block ordinary note reads or writes. The baseline and end commits snapshot the whole home, so they can include ordinary edits made by other sessions as well as edits made by the dream.

`dream_end` commits and releases the lock. Session shutdown releases it without a final commit. If the process dies, the OS releases the lock; completed note edits stay on disk. Leave the SQLite file in place. Stop older processes sharing this home when upgrading: the old existence lock and the transaction lock do not coordinate.
