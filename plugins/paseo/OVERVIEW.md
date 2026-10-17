# Notesoup last word

Displays notesoup last-word messages already present in Paseo’s timeline as expanded, selectable paper cards. Last-word and notes cards share a pale-paper palette, tape accent, small corners, and compact spacing; a crumple call turns its card grey and strikes the address. Requires Paseo 0.11.2 on the client and daemon.

This client-only plugin transforms existing timeline rows in place: last-word custom messages become sticky cards, and notes_read/notes_write/notes_update tool calls become paper cards with the address, state, and a content or diff preview. It accepts the bare Pi tool names and Claude's exact `mcp__notesoup__` prefix; same-named tools from other MCP servers are unchanged. It does not read session files or append messages. Other timeline items are unchanged.

Notes cards start collapsed; update cards also show the sentence just added. The whole header row expands and collapses the body. Long content scrolls inside a bounded panel. Display limits are 4000 characters for reads and writes, and 8000 for diffs; expanding does not fetch more content.

Notes cards prefer Pi's structured tool payload on live events. Pi replayed history carries only rendered text blocks; Claude carries rendered text under the adapter's `output` field. Both use the same text fallback parser, and write previews come from the call arguments. Failed calls also read the adapter's error content (string or text blocks) or transport message when no result is available.

`empty_brain` (including `mcp__notesoup__empty_brain`) becomes a divider for running, completed and failed calls. Pi's JSON rollover outcomes are preserved. Claude's plain acknowledgement only completes the tool call; it does not invent a Pi outcome or assert that the deferred reset has committed.

Automated tests check transformer payloads with source-derived adapter fixtures, not a live Paseo UI session.

Paseo 0.11.2 drops Pi boundary `entry_appended` events from its live timeline. This plugin cannot display messages that Paseo has not received; that adapter gap needs an upstream fix. Messages available through history can be rendered.
