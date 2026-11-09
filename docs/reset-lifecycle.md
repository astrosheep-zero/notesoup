# Reset lifecycle

Pi reset control lives in `plugins/pi/reset/lifecycle.ts`: the pure `reduceResetControl` selects state transitions or boundary intents; after asynchronous construction, `finalizeResetBoundary` owns final state, carried inputs and continuation. `registerResetLifecycle` adapts public Pi events, constructs boundaries and applies the finalizer's result unchanged. `budget.ts` stages reminders and checks settings; `reset/artifacts.ts` builds and repairs ordered artifacts; `reset/committed.ts` confirms durable boundaries. `window.ts` owns identities and provider projection; `runtime.ts` wires commands and tools. No Pi source patches, native summarization requests, or second commit database are used.

## Lifecycle at a glance

**Never replay input already submitted to a model request. Resume from notes, the continuation and optional `last_word`; use history for earlier details. Every `/empty` or `/fresh-window` stops after resetting unless separate human input arrives during emptying.**

| Trigger | Behavior |
| --- | --- |
| `empty_brain` tool | Record the actual call and optional last word. Without command policy, reset after the whole tool batch at `turn_end` and continue unless `terminate: true` (default: false). Termination stops automatic continuation, not the session or new user input. Under command policy, wait for settlement. |
| `/empty <text>` or `/fresh-window <text>` | Send a hidden close-out warning (trigger when idle, steer when busy), with the argument verbatim as context for notes, then reset and stop unless separate human input arrives during emptying. |
| Bare `/empty` or `/fresh-window` | Close out, reset, and stop, unless more human input arrives while close-out is pending. |
| Human input during command close-out | Intercept public `input` events except source `extension`, return `handled`, and keep the original text/images in command state for the reset boundary. Do not steer the input into the closing model; use `/empty <text>` for close-out context. |
| Model-requested `empty_brain` reset | Do not carry the human input already present in model context; the model owns its handoff through notes/`last_word`. |
| Passive provider overflow / recoverable length | With automatic reset enabled, force a retain-none reset and continue once from notes, without replaying the failed request's input. |
| Command close-out overflow | Force a reset even if automatic reset is disabled. Apply command policy: continue with separate carried input, otherwise stop. The recovery attempt is spent, so an oversized carried prompt cannot loop. |
| Budget warning | Stage reminders when automatic reset is enabled. Warnings alone never authorize reset. |
| Hard reserve | Independently reset at `turn_end` when automatic reset is enabled and continue without replaying submitted text/images. A command stop latch cancels empty tool follow-ups, but never real queued or carried human input. |
| Abort / ordinary error | Restore stashed originals as visible user-content custom messages before clearing command state. Explicit abort stays stopped; ordinary close-out errors trigger a turn for the restored input without forcing a reset. |
| `/compact` while active | Cancel native compaction; manual attempts receive a `/fresh-window` notice. |

The same input boundary applies to tool, hard-reserve and overflow resets, including failed or unanswered requests. Input already submitted stays in raw history. New input not yet submitted remains in Pi's native queue, or in command-close-out state when intercepted, and reaches the fresh window once.

## Boundary order and handoff

One public boundary draft contains, in order:

1. A native `compaction` with `summary: ""` and `firstKeptEntryId: null` (Pi materializes its own ID: retain none).
2. A `notesoup/reset-marker` custom entry with `{ windowId, origin }`.
3. A hidden `notesoup/boot` custom message with matching `details.windowId`.
4. One hidden continuation paragraph, selected once when the artifact is built.
5. An optional visible `notesoup/reset-last-word` sticky note.
6. One visible `notesoup/carried-input` custom message per carried human input, preserving original text/image content and order.

Boundary drafts cannot contain ordinary user entries. Pi's public custom-message conversion supplies role `user` to the provider, including text/image arrays. Carried inputs are appended atomically with the reset artifacts, not queued as separate prompts; any carried input returns `continue: true`.

The origin is `normal` for an actual tool request, otherwise `forced`; overflow recovery is always forced. Each origin has an approved complete-paragraph pool. Construction draws once and persists the paragraph verbatim; rendering, reads, reloads and repair never redraw an existing continuation. Legacy markers without a valid origin default to normal. Other hosts retain their own scheduling: dsh shares one draw across checkpoint and continuation; Claude caches its forced handoff per window.

Raw session history remains available. The retain-none checkpoint excludes old conversational context while preserving Pi's empty summary wrapper and system/tool state. Marker-only legacy sessions use boot slicing as a compatibility fallback. A marker is checkpoint-backed only if it directly follows a self-retaining, empty native compaction.

## Reducer and run state

`ResetControlState` combines a request, a bounded overflow phase, and an optional run-scoped `stopAfterReset` latch:

| Request | Meaning |
| --- | --- |
| `none` | No command or tool request. |
| `pending` | Current `windowId`, optional `tool: { lastWord?, terminate? }`, and optional `command: { continueAfterReset, inputs? }`. Command inputs retain their original text/images. Separate human input during close-out is intercepted and carried, never steered. Duplicate commands retain the first policy/text; tool calls do not overwrite command policy. |

`stopAfterReset` is separate from the request. It retains the safety boundary's intent after construction, while `request` becomes `none`. Settlement waits for queued work; if the window changed, it stops without a second wipe. If the window did not change, the boundary never committed, so settlement retries the retained intent with its stop policy and tool origin intact. A successful settle retry consumes the latch.

Overflow phases are `idle`, `pending`, `spent`, and `pending-spent`. `turn_end` arms enabled recovery; `agent_before_settle` waits for queued work and selects recovery intent. Only successful, current construction reaches finalization and spends the attempt. A successful queued turn supersedes the failure. Command overflow spends the same bounded attempt before continuing. Abort, final settlement, session start/tree/shutdown and `/notesoup off` clear transient state.

The adapter does not collect user `message_end` content for replay. Pi owns native queued steering and follow-up messages; only command-close-out input withheld from the closing model is carried by the reset adapter.

Command state remains live during asynchronous notes acquisition so separately arriving input joins the reset boundary. Handled command-close-out input is not delivered to the closing model and is carried as original text/images. Command text is included as plain close-out context by `/empty <text>`. After construction passes the currentness guard, finalization takes only command-owned input withheld from the closing model. It resolves `resumeModel` and the next control state together. Separate human inputs are never sent as hidden steers. Construction captures session/window generations and rechecks identity, enabled state and abort status before returning drafts; stale work preserves incoming/budget entries but discards reset drafts. If close-out cannot commit, stashed originals are restored with public `sendMessage(..., { triggerTurn: false })` except on an ordinary turn-end error, which triggers a turn for the restored input; abort and other restore paths stay stopped.

After a manual safety reset, `context_with_system` checks the committed boundary before using public `ctx.abort()` to cancel an unavoidable empty tool follow-up with system-only context. Pending messages, ordinary user entries or carried inputs after the marker bypass cancellation. Later user prompts are not affected by the run-scoped stop latch.

## Warnings, projection and repair

Budget reminders are staged once per window at reserve plus reminder margin, then reserve plus warning runway. Hard reserve remains independent. Budget and command warnings use different types. The final budget warning notifies at first provider injection, not durability; early guidance stays UI-silent. Budget drafts are instance-local and discarded on abort, failed turn, transition or window mismatch. Active-window usage and the exact public `SettingsManager` authority determine thresholds.

Pi and Claude use the same budget warning: budget timing, the handoff checklist, note maintenance (including updating and trimming pinned pages, CHEATSHEET.md and MAP.md by default), a warning against large tool outputs, then `empty_brain` and the countdown. Pi's manual warnings replace the budget opening with the `/empty` notice inside `<notesoup:budget_notice>`. Optional command text sits after the closing tag as plain text for the closing model's notes; separate human input during close-out is intercepted and carried, never steered. The first-tier reminder reports the remaining room, explains that notes survive the wipe, asks for updated notes and offers an optional `empty_brain`, warning that it also clears what the model says to the human right before emptying. Pi's fixed system protocol retains its existing pre-reset hints; warnings no longer repeat those or the tool's `last_word` description.

`before_agent_start` supplies fixed protocol/maps teaching through the public named system sections, without promoting any note body. The hidden user boot remains the closed per-window identity/notes snapshot. `context_with_system` selects that boot by durable window identity, using Pi's canonical checkpoint projection or legacy slicing, and removes only recognized top-level teaching from older combined boots in the request projection; raw history and note quotations remain unchanged. Missing boot aborts safely instead of exposing raw history. Usage estimates use the same projection decision, and pre-send checks include the complete system/tool state. `/tree` summaries are suppressed when crossing reset branches because native branch summarization bypasses this projection.

`resetBoundaryCommitted` validates checkpoint -> marker -> matching hidden boot -> hidden continuation; trailing last words, carried input or later conversation cannot undo that committed prefix. `inspectResetTail` checks the entire repairable suffix: optional last word and carried inputs must follow the continuation, with no duplicate/misordered artifacts or later conversation. A carried input before boot/continuation blocks repair rather than allowing metadata to be appended after human content. Startup/tree repair only fills missing boot/continuation when safe, rechecking lifecycle identity after notes acquisition. UI success notices use committed confirmation, not repairability.

## Validation

Scripted SDK tests run Pi's real agent loop without network calls: smaller-model overflow, no replay of submitted text/images after forced resets, command text, bare stop, intercepted text/images, hard-reserve handling, overflowing close-out and bounded recovery. They also cover queued steering/follow-ups arriving while forced reset boundaries await commit, and input-free automatic continuations. Focused tests check late input during asynchronous construction, absence of input steers, abort/error restoration, ordered carry artifacts, commit confirmation, safe repair, canonical projection and persisted history. External-provider behavior and every malformed persisted/filesystem case are not established by this suite.
