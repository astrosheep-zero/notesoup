# Reset lifecycle

Pi reset control lives in `plugins/pi/reset/lifecycle.ts`: the pure `reduceResetControl` selects state transitions or boundary intents; after asynchronous construction, `finalizeResetBoundary` owns final state, carried inputs and continuation. `registerResetLifecycle` adapts public Pi events, constructs boundaries and applies the finalizer's result unchanged. `budget.ts` stages reminders and checks settings; `reset/artifacts.ts` builds and repairs ordered artifacts; `reset/committed.ts` confirms durable boundaries. `window.ts` owns identities and provider projection; `runtime.ts` wires commands and tools. No Pi source patches, native summarization requests, or second commit database are used.

## Lifecycle at a glance

**Human input not yet answered must survive a reset and be answered afterward. Only a bare `/empty` with no later human input stops after resetting.**

| Trigger | Behavior |
| --- | --- |
| `empty_brain` tool | Record the actual call and optional last word. Without command policy, reset after the whole tool batch at `turn_end` and continue. Under command policy, wait for settlement. |
| `/empty <text>` or `/fresh-window <text>` | Send a hidden close-out warning (trigger when idle, steer when busy), then reset and continue. Carry the argument text verbatim as the next window's human message; it is not merely a notes hint. |
| Bare `/empty` or `/fresh-window` | Close out, reset, and stop, unless more human input arrives while close-out is pending. |
| Human input during command close-out | Intercept public `input` events except source `extension`, return `handled`, and stash text/images in command state. Also hidden-steer the bare `<notesoup:next_window_prompt>` block plus original images to the closing model. The originals are carried even if that steer never arrives; any carried input makes the reset continue. |
| Passive provider overflow / recoverable length | With automatic reset enabled, force a retain-none reset and continue once. Carry the failed logical run's human messages: starting prompt and delivered steering/follow-ups. A run started by our own continuation has no human input to carry. |
| Command close-out overflow | Force a reset even if automatic reset is disabled. Apply command policy: continue with text/carried input, otherwise stop. The recovery attempt is spent, so an oversized carried prompt cannot loop. |
| Budget warning | Stage reminders when automatic reset is enabled. Warnings alone never authorize reset. |
| Hard reserve | Independently reset at `turn_end` when automatic reset is enabled. A bare-command stop latch cancels empty tool follow-ups, but never real queued or carried human input. |
| Abort / ordinary error | Restore stashed originals as visible user-content custom messages before clearing command state. Explicit abort stays stopped; ordinary close-out errors do not force reset. |
| `/compact` while active | Cancel native compaction; manual attempts receive a `/fresh-window` notice. |

Switching to a smaller model does not proactively reset or select another model. If its request overflows, the same bounded automatic recovery carries the unanswered prompt into a fresh window on the selected model. Disabling automatic reset disables passive overflow recovery.

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
| `pending` | Current `windowId`, optional `tool: { lastWord? }`, and optional `command: { continueAfterReset, inputs? }`. Command inputs retain originals, not prompt-block wrappers. Duplicate commands retain the first policy/text; tool calls do not overwrite command policy. |

`stopAfterReset` is separate from the request. It retains the safety boundary's intent after construction, while `request` becomes `none`. Settlement waits for queued work; if the window changed, it stops without a second wipe. If the window did not change, the boundary never committed, so settlement retries the retained intent with its stop policy and tool origin intact. A successful settle retry consumes the latch.

Overflow phases are `idle`, `pending`, `spent`, and `pending-spent`. `turn_end` arms enabled recovery; `agent_before_settle` waits for queued work and selects recovery intent. Only successful, current construction reaches finalization and spends the attempt. A successful queued turn supersedes the failure. Command overflow spends the same bounded attempt before continuing. Abort, final settlement, session start/tree/shutdown and `/notesoup off` clear transient state.

The adapter collects actual user `message_end` content until settlement or a successful reset boundary. Low-level `agent_start` events do not clear it: Pi can start additional loops while draining follow-ups/recovering. Custom boot/warning/continuation messages are never mistaken for human input. Successful boundary construction clears this run collection, so an automatic continuation does not replay old input.

Command state remains live during asynchronous notes acquisition. Boundary intent captures the trigger, explicit `continueAfterReset` policy, tool fact and origin, but contains no final state or continuation decision. After construction passes the currentness guard, the pure finalizer selects live command-owned originals, or the current run's inputs only for passive recovery, and resolves `resumeModel` and the next control state together. `resumeModel` is true when the policy requests continuation or carried input needs an answer; the adapter maps it to Pi's `continue` field. Late originals therefore join the same boundary and prevent a stop latch from being installed; delivery contents never replace explicit command policy. Hidden steers carry window/command identity; provider projection excludes them once that command ends, including steers Pi delivers only after the reset. Originals remain available exactly once as carried input. Construction captures session/window generations and rechecks identity, enabled state and abort status before returning drafts. Clearing the run invalidates any unfinished construction before resetting its input collection. Stale work preserves incoming/budget entries but discards reset drafts; construction failures notify only while current and do not claim continuation. If close-out cannot commit, stashed originals are restored with public `sendMessage(..., { triggerTurn: false })`, including cancellation during construction; clearing command state must not erase input already reported as handled.

After a manual safety reset, `context_with_system` checks the committed boundary before using public `ctx.abort()` to cancel an unavoidable empty tool follow-up with system-only context. Pending messages, ordinary user entries or carried inputs after the marker bypass cancellation. Later user prompts are not affected by the run-scoped stop latch.

## Warnings, projection and repair

Budget reminders are staged once per window at reserve plus reminder margin, then reserve plus warning runway. Hard reserve remains independent. Budget and command warnings use different types. The final budget warning notifies at first provider injection, not durability; early guidance stays UI-silent. Budget drafts are instance-local and discarded on abort, failed turn, transition or window mismatch. Active-window usage and the exact public `SettingsManager` authority determine thresholds.

Pi and Claude use the same budget warning: budget timing, the handoff checklist, note maintenance (including updating and trimming MAP files), a warning against large tool outputs, then `empty_brain` and the countdown. Pi's manual warnings replace the budget opening with the `/empty` notice inside `<notesoup:budget_notice>`. Optional command text sits after the closing tag in `<notesoup:next_window_prompt>`. The first-tier reminder reports the remaining room, explains that notes survive the wipe, asks for updated notes and offers an optional `empty_brain`, warning that it also clears what the model says to the human right before emptying. Pi's boot retains its existing pre-reset hints; warnings no longer repeat those or the tool's `last_word` description.

`context_with_system` selects the boot by durable window identity, using Pi's canonical checkpoint projection or legacy slicing. Missing boot aborts safely instead of exposing raw history. Usage estimates use the same projection decision. `/tree` summaries are suppressed when crossing reset branches because native branch summarization bypasses this projection.

`resetBoundaryCommitted` validates checkpoint -> marker -> matching hidden boot -> hidden continuation; trailing last words, carried input or later conversation cannot undo that committed prefix. `inspectResetTail` checks the entire repairable suffix: optional last word and carried inputs must follow the continuation, with no duplicate/misordered artifacts or later conversation. A carried input before boot/continuation blocks repair rather than allowing metadata to be appended after human content. Startup/tree repair only fills missing boot/continuation when safe, rechecking lifecycle identity after notes acquisition. UI success notices use committed confirmation, not repairability.

## Validation

Scripted SDK tests run Pi's real agent loop without network calls: smaller-model overflow and prompt replay, command text, bare stop, intercepted text/images, hard-reserve handling, overflowing close-out and bounded retry. They also cover passive tool-loop steering/follow-ups and input-free automatic continuations. Focused tests check late input during asynchronous construction, stale queued steer exclusion, abort/error restoration, ordered carry artifacts, commit confirmation, safe repair, canonical projection and persisted history. External-provider behavior and every malformed persisted/filesystem case are not established by this suite.
