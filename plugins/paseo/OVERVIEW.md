# Notesoup

Displays notesoup last-word messages already present in Paseo’s timeline as expanded, selectable paper cards. Last-word and notes cards share a paper palette that follows Paseo’s theme: pale paper in light themes and warm charcoal paper in dark themes, with matching ink, tape and diff colors. Both keep small corners and compact spacing; a crumple call dulls its paper and strikes the address. Requires Paseo 0.11.2 or newer on the client and daemon.

This client-only plugin transforms existing timeline rows in place: last-word custom messages become sticky cards, and notes_read/notes_write/notes_update tool calls become paper cards with the address, state, and a content or diff preview. It accepts the bare Pi tool names and Claude's exact `mcp__notesoup__` prefix; same-named tools from other MCP servers are unchanged. It does not read session files or append messages. Other timeline items are unchanged.

Notes cards start collapsed; update cards also show the sentence just added. The whole header row expands and collapses the body. Long content scrolls inside a bounded panel. Read text comes from the existing tool-result text, update diffs come from Pi's `details.diff` (falling back to legacy diff text or `input.edits` on MCP hosts), and writes come from the call's content argument. Live and history use the same projection without a persisted copy. Each displayed body/diff is capped at 32,000 UTF-16 units, retaining the beginning and end with a visible omission line; collapsed previews are capped at 1,000 units before layout. Expanding does not fetch more content; original tool results and notes are unchanged. Diff lines of the same color share a text run rather than one component per line.

Notes cards use the same projection for Pi live events and replayed history; Claude supplies its receipt text under the adapter's `output` field and its edits under `input.edits`. The UI does not depend on Pi's live-only `structuredContent`. Failed calls also read the adapter's error content (string or text blocks) or transport message when no result is available.

`empty_brain` (including `mcp__notesoup__empty_brain`) becomes a divider for running, completed and failed calls. Pi's JSON rollover outcomes are preserved. A successful `brain emptied` divider with a `last_word` argument opens a selectable last-word modal when clicked. Claude's plain acknowledgement only completes the tool call; it does not invent a Pi outcome or assert that the deferred reset has committed.

Automated tests check transformer payloads with source-derived adapter fixtures, not a live Paseo UI session.

Paseo 0.11.2 drops Pi boundary `entry_appended` events from its live timeline. This plugin cannot display messages that Paseo has not received; that adapter gap needs an upstream fix. Messages available through history can be rendered.
