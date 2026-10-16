# Skills and dream

## Memory skill

The package provides `/skill:memory`, a short self-contained guide to the notes and history tools: note addresses and homes, finding and paging notes, searching and paging history, saving recovery state, and what to do when a memory tool is unavailable. It is a fallback for sessions where the boot protocol is missing or unclear and a reference on demand; normal tool calls do not require reading it. It is written independently of the boot text rather than generated from it. The Claude Code Mod ships the same guide; its history tools require the documented main-session transcript path and a confirmed append head.

## Dream

`/skill:dream` reviews notes in the current agent session, following the shared `playbook.md`.

In Pi the session gets three hidden `dream_*` tools; they are not declared to the model and are found with `tool_search` or codemode's `searchTools("dream")`:

- `dream_begin(project?)` opens one project, by default the current one, as in `@projects/<name>/`. It lists that project's notes and every session note whose frontmatter `project` names it, crumpled notes included. While it is open, `notes_write` and `notes_update` may edit those addresses (existing notes only in other sessions), and reads leave no access stamp. Other projects stay read-only.
- `dream_forget(address)` permanently deletes one crumpled note within reach; live notes refuse.
- `dream_end()` closes the dream.

One session dreams over one project at a time. New session notes record their project key in `project`; notes without it never appear in a project's dream. Standard linked Git worktrees share the main checkout's project key.

## The dream lock and Git audit

`dream_begin` takes an exclusive `.dream.lock.<project>` in the notes home with a single O_CREAT|O_EXCL creation, then commits a baseline of the notes home to its Git repository (initialized on first use). `dream_end` commits the dream's changes and releases the lock, so `git show` reviews a dream and `git revert` rolls it back. A session shutdown releases the lock without the final commit.

An existing lock refuses a new dream regardless of its age. If a Pi process crashed mid-dream, remove the stale lock by hand after confirming no dream is running:

```sh
rm "${NOTESOUP_HOME:-$HOME/.agents/notes}/.dream.lock.<project>"
```
