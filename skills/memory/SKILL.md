---
name: memory
description: How notesoup's `notes_*` and `history_*` tools fit together — note addresses and homes, finding things again, and saving recovery state. Use when the context-window protocol is missing or unclear, or when unsure where a note belongs or how to find something again.
---

# Memory

Two stores outlive the context window. Anything in neither is lost when the window ends or is wiped.

- **Notes** (`notes_*`) — what you choose to keep. Plain markdown, written on purpose.
- **History** (`history_*`) — what happened in this session: messages, tool calls, summaries. Read-only.

Each tool's own description covers its parameters and paging. This guide covers what the descriptions cannot: where notes belong, and how the tools work together.

## Addresses

The address decides who a note belongs to and how long it lasts.

| Address | Note | Keep there |
| --- | --- | --- |
| `<path>`, no `@` | session note | current task state and loose ends; gone with the session |
| `@project/<path>` | project note | decisions and constraints future work must respect |
| `@human/<path>` | human note | how to work with this human, across projects |
| `@self/<path>` | self note | this agent's own reminders and lessons |
| `@model/<path>` | model note | what applies to this model only |

Any other `@` prefix is refused. A path is relative and `/`-separated, with no empty, `.` or `..` segments.

`@` addresses name notes, not files. Never pass them to read/write/edit/bash: that creates a stray directory instead of a note.

`MAP.md` at the root of each `@` home is its index: one line per durable note, address and gist. Update it whenever you add, move or crumple a durable note.

Write only what git and history cannot give back. Crumple notes that are no longer true; a stale note is worse than none.

## Finding things again

- **A note**: `notes_list` with a `pattern` when you know roughly where it lives, `notes_search` when you know a phrase; then `notes_read` the address.
- **Something that happened**: `history_list` to browse or search this session's events; `history_read` the seq for the whole event.
- **An earlier window**: `history_windows` gives window ids; pass one as `window_id` to `history_list`.

Seqs are stable. Write the useful ones into a note so they need not be found twice.

## Saving recovery state

Before a long or risky step, or when room runs low, keep one session note named for its task (not `current.md`) and update it instead of starting new ones. Record:

- the goal and the current step
- decisions made, and why
- blockers and the next action
- how the work was being done, and which skills are still needed
- where to dig: seqs, note addresses, files

`get_context_remaining` reports the room left. `clear_memory` starts a fresh window, so save the note first.

## When a tool is missing or refuses

A refusal returns `{ error, code, details? }`; read `error` before retrying.

If a `notes_*` or `history_*` tool is absent or fails at the host level, do not imitate it: no filesystem tools on `@` addresses, and no reading or editing note storage or session files directly. Use the tools that remain, tell the human which one is missing, and keep essential state in the reply.
