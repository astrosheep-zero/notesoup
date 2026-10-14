# Skills, dream, and the notes doctor

## Memory skill

The package provides `/skill:memory`, a short self-contained guide to the notes and history tools: note addresses and homes, finding and paging notes, searching and paging history, saving recovery state, and what to do when a memory tool is unavailable. It is a fallback for sessions where the boot protocol is missing or unclear and a reference on demand; normal tool calls do not require reading it. It is written independently of the boot text rather than generated from it. The Claude Code Mod ships the same guide; its history tools require the documented main-session transcript path and a confirmed append head.

## Dream skill

The package also provides `/skill:dream` for reviewing notes in the current agent session. The skill reads the same `playbook.md` used by the `dream` CLI; there is only one set of dream instructions.

Scope comes from the invocation directory: inside the notes store, dream may inspect across homes; in a project, it extracts from that project's material and all session notes with matching project metadata, and organizes only that project's notes. New session notes record their project key in the frontmatter `project` field. Standard linked Git worktrees resolve to the main checkout's repository root, sharing its project key and `@project/` home. Older metadata and homes remain untouched by the code: there is no automatic migration or backfill; existing data can be migrated manually. Notes without project metadata are skipped in project-only discovery. Changing directories later does not broaden the scope.

The skill stays in the current agent session. Its wrapper and shared playbook describe the dreamer's task, not runtime setup: the execution entry point is responsible for supplying readable/writable scope and establishing write permission, including locking and Git audit safeguards. The CLI supplies its own safeguards; the bare skill does not install them. Without an established scope and write permission, the dreamer asks rather than improvising runtime setup. Session records and unapproved homes stay untouched.

## Check the notes store

Run `dream doctor` (or `dream doctor --notes-home <dir>`) to check home layout, note frontmatter, concrete backtick-quoted note addresses, MAP entries, and lock presence/format. It is read-only: no model, git commits, directory creation, or repairs. Exit status is 0 when clean and 1 when issues are found. References needing an unavailable project context are reported as unresolved; prose and example/glob addresses are not validated. A present lock is reported without inferring process liveness.

## The dream lock

The `dream` CLI takes an exclusive `.dream.lock` in the notes home with a single O_CREAT|O_EXCL creation. The lock is Git-style existence locking: an existing lock refuses a new run regardless of its contents, PID, or age, and `--force` bypasses only the scheduling and material gates, never the lock. A lock is released only by the run that acquired it (and repeated cleanup is harmless), so a live dream is never displaced.

If a dream process crashed, its lock remains and later runs refuse to start. There is no automatic recovery and no force-unlock command: after you have confirmed that no dream process is running, remove the stale lock by hand.

```sh
# only when no dream is running
rm "${PI_NOTES_HOME:-$HOME/.agents/notes}/.dream.lock"
```

Removing a lock while a holder is running is outside the supported cooperative protocol and can let two dreams run at once.
