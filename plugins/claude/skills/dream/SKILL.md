---
name: dream
description: Review and consolidate durable notes using notesoup's shared dream playbook. Use when the human asks to dream over notes, merge genuine duplicates, update maps, or promote durable findings.
---

# Dream

Read `../../playbook.md` completely, resolving the path from this skill's directory. It is the shared guide to reviewing and organizing notes. Standing reminders belong in a separate `CHEATSHEET.md` (five lines); `MAP.md` holds only the note index. Both load every window when present.

Dream in this agent's current session. Do not start another agent or model unless the human asks.

Work within the supplied readable and writable scope. If the scope or permission to write has not been established, ask rather than inventing it or setting up execution machinery yourself.

## Tools

Use `dream_begin`, `dream_forget`, and `dream_end` for the dream lifecycle. If any are missing from the current tool list, search for them before proceeding. If they remain unavailable, report that limitation rather than inventing a replacement backend.

- Every dream starts with `dream_begin`, before reading or editing any notes.
- Use `notes_*` to read and organize notes within the established scope. `dream_forget` permanently deletes a crumpled note when the playbook permits it; never delete a live note.
- `dream_end` closes the open dream. Close it when finished, and report any partial failures.
