# Reset lifecycle

All lifecycle control flow is native Pi integration. `src/pi/reset/lifecycle.ts` owns close-out phases, native turn/settle reducer facts, batching, bounded overflow recovery and scheduling. `src/pi/budget.ts` reads usage/settings, caches and stages reminders/warnings; `src/budget/policy.ts` only derives pure thresholds and the runway-adjusted countdown. `src/pi/reset/artifacts.ts` constructs ordered drafts and safely repairs incomplete suffixes; `src/pi/reset/committed.ts` separately confirms durable native boundaries. `src/pi/window.ts` owns native markers, checkpoints, branch traversal and provider projection. `src/pi/runtime.ts` wires these parts to public Pi lifecycle hooks, commands and UI.

Boot acquisition/rendering is shared: `src/boot/snapshot.ts` receives explicit identity, a captured time and an optional scope loader; `src/boot/render.ts` receives the snapshot and logical tool bindings. Pi supplies its existing names. Shared history is an addressed query projection, never an inference transcript or reset scheduler. There is no generic HostEvent or Harness reducer, and no second commit database.

## Lifecycle at a glance

| Trigger | Behavior |
| --- | --- |
| `empty_brain` tool | Mark the current window tool-requested. At `turn_end`, after the complete tool batch and any accepted budget drafts, append the reset boundary and ask Pi to continue. Repeated requests for that window deduplicate. |
| `/fresh-window` or `/empty-brain` | Acknowledge immediately and arm a manual close-out. The hidden checkpoint warning always goes out: when idle it starts one ordinary model turn; while streaming it steers the running turn so the agent closes out promptly. The agent may write notes/use tools over several turns; its own `empty_brain` call only acknowledges. A successful normal stop commits at `agent_before_settle` after queued messages drain, and the committed reset stops the run unless a trailing prompt was supplied. With a prompt, append it after the unchanged continuation and request one fresh-window continuation. |
| Budget warning | When automatic compaction is enabled and remaining active-window budget reaches reserve plus the warning runway, put the same hidden warning in the request and arm an automatic close-out. An explicit `empty_brain` commits the boundary; a successful normal stop alone never resets or requests continuation. |
| Hard reserve | Independent safety path: if automatic resets are enabled and completed-turn usage reaches Pi's reserve, commit a boundary at `turn_end`. A pending manual stop survives in a run-scoped `stop-pending` phase; empty automatic follow-up is cancelled before provider work, while real queued user input is answered before stopping. |
| Abort or error | Never count as successful close-out. Abort clears lifecycle state. An ordinary close-out error is dropped without reset. Manual overflow clears and stops without retry, even with automatic reset disabled; automatic provider-overflow recovery remains separately bounded. |
| `/compact` while active | Cancel native compaction, which could otherwise summarize pre-reset history back into the active window. A manual attempt receives an actionable `/fresh-window` notice. |

A new boundary is ordered as:

1. A native `compaction` entry with `summary: ""` and `firstKeptEntryId` set to its own ID. This is Pi's retain-none canonical checkpoint; it is not a generated summary request.
2. A `notesoup/reset-marker` custom entry with `{ windowId }`.
3. A hidden `notesoup/boot` custom message with matching `details.windowId`.
4. A hidden continuation message.
5. If the manual command supplied a prompt, a visible `notesoup/reset-prompt` custom message containing that literal text. Pi boundary drafts do not support ordinary user entries; the prompt is committed with the reset instead of queued separately.

The raw session branch is preserved for history. New checkpoint-backed branches use Pi's canonical retain-none projection, which preserves the empty summary wrapper and system/tool state while excluding earlier conversational context. Older marker-only sessions use marker slicing as a narrow compatibility fallback. A marker is trusted as checkpoint-backed only when it directly follows an empty native compaction whose `firstKeptEntryId` is the compaction's own ID; a generic preceding compaction is not enough.

`turn_end` is the sole composer for completed turns. It preserves incoming entries, consumes current-window budget drafts, and appends the ordered reset boundary only when the reducer requests one. Direct tool resets and the hard-reserve safety path commit here. `agent_before_settle` commits only manual close-outs after Pi has drained queued work, stopping the run for a bare command or continuing with its appended prompt. A budget close-out without an explicit wipe is discarded at settlement without resetting. Pi owns any ensuing continuation and request scheduling. Reset construction awaits the asynchronous notes snapshot; the handler captures its session/window generation before awaiting, then rechecks generation, session, window, enabled state, and abort status before returning drafts. A stale completion is discarded while incoming/budget entries survive, and success notices are staged only after that guard. Construction failures notify only while the initiating lifecycle is still current and preserve already-collected entries without claiming a continuation.

## Reducer state

`reduceResetControl` is pure: the adapter supplies all lifecycle facts, and the reducer returns the next state plus a named effect. Its state combines a request phase with a bounded overflow phase:

| State | Meaning |
| --- | --- |
| `{ phase: "none" }` | No close-out/tool request is pending. |
| `{ phase: "close-out", windowId, source, prompt? }` | Manual or automatic warning close-out remains armed across ordinary note/tool turns. |
| `{ phase: "stop-pending", windowId }` | A manual hard-reserve reset was proposed for the given old window. The stop survives a committed window change; settlement stops without a second wipe (or retries construction if the old window is still active). New wipe requests only acknowledge it. |
| `{ phase: "tool-requested", windowId, source }` | A direct `empty_brain` call commits after its complete turn batch and continues in the fresh window. `source` is `"tool"` for direct calls or `"automatic"` when the agent wipes inside a budget close-out; manual requests never occupy this phase. |
| `overflow: "idle"` | No overflow recovery is pending. |
| `overflow: "pending"` | An overflow failure may recover once at pre-settlement. |
| `overflow: "pending-spent"` | Recovery was already spent in this failure chain. |
| `overflow: "spent"` | The one recovery has been used until the chain settles. |

### Transition rules

- `close_out(windowId, source, prompt?)` arms a close-out for that window. Repeating an already-pending request deduplicates and keeps the original prompt (including no prompt); a manual request can upgrade an automatic request for the same window, and a manual request converts a pending tool request into a settle-committed stop.
- `tool_request(windowId)` marks that window for a turn-end reset. Matching duplicates deduplicate. Inside a budget close-out the call upgrades to a turn-end commit because context pressure cannot wait for settlement; inside a manual close-out it is only an acknowledgement, so a manual wipe is never converted into a turn-end commit that Pi's tool-batch continuation would overrun.
- `turn_end` first clears everything on abort. Overflow-like errors preserve a manual close-out, including across queued work; other requests arm automatic overflow recovery only when there is no queued work, the extension is enabled, and automatic reset is enabled. Other failures drop the request but preserve the overflow chain. A successful, enabled turn commits for a tool request or hard-reserve condition; a close-out alone remains armed. Bare manual hard-reserve commits request no continuation and retain `stop-pending` across the window change. A manual request with a prompt instead returns the prompt with the commit effect, clears request state, and continues after the prompt is durably appended; it never enters the stop latch. Further turns cannot reset that stopped run again.
- `agent_before_settle` clears state on actual abort. Pending manual overflow commits a reset without continuation when enabled and unqueued; it does not require automatic reset enablement. Other pending overflow recovery gets its one bounded attempt when enabled and unqueued. A committed `stop-pending` reset needs only a stop, never a second wipe. Otherwise only a manual close-out commits, if the outcome is successful, the request belongs to the current window, the extension is enabled, and no queued work remains. An automatic close-out alone is cleared without a reset.
- `agent_settled`, session start/tree navigation/shutdown, `/notesoup off`, and abort clear transient request state. Durable checkpoint/marker history remains authoritative after transient state is gone.

After a manual safety reset, `context_with_system` verifies the committed checkpoint/marker/boot/continuation before using public `ctx.abort()` to cancel Pi's otherwise unavoidable tool-batch follow-up, returning a system-only safe context. Pending messages or a real user message after the reset marker bypass cancellation so queued work is not swallowed. A follow-up queue may require Pi's ordinary tool follow-up to finish before delivery; the stop intent remains armed until that work settles. Abort/settlement clears the run-scoped latch, so later user prompts work normally.

This separation is intentional: a note write or ordinary tool turn during a budget close-out must not consume it. Direct `empty_brain` remains valid without a prior warning. A user abort, an assistant message with a synthetic `stopReason: "aborted"`, and a generic provider error are distinct cases; none commits an ordinary close-out, while only Pi's actual operation cancellation is a user abort.

## Budget staging and notifications

The early reminder is staged once per window when remaining budget reaches `reserve + reminderMarginTokens`. The final close-out warning is staged/attached at `reserve + WARNING_RUNWAY_TOKENS`, only when automatic compaction is enabled. The hard reserve itself remains a separate safety cutoff. Budget and idle manual requests use the same hidden checkpoint text but distinct message types, so an aborted manual request cannot suppress a later budget warning. The text allows for either reset timing; manual close-outs may span turns and commit at settlement, while budget close-outs commit early only through an explicit `empty_brain` call. After a budget warning is durable, the extension does not repeat it in that window. Warning persistence deduplicates only injection: each eligible low-budget request re-arms transient automatic close-out before checking for the durable warning, so an abort/error can clear its attempt and the next request can retry without another warning.

Budget drafts are instance-local and are consumed at turn end. They are discarded on abort, failed turn, transition, or window mismatch. UI reminder notices are emitted only after the matching hidden entry is durable, so failed requests do not report an uncommitted warning. Active-window usage and the exact `SettingsManager` authority drive threshold checks; default file-backed policy is cached per extension instance, while injected managers are read through their public API.

## Projection, repair, and history

`context_with_system` selects the active boot by durable `details.windowId`. For a verified native checkpoint, Pi's canonical projection is used directly; for a legacy marker-only reset, the compatibility projection slices at the matching boot. The projection preserves system/tool state and later prompt patches. If the boot is absent, the runtime aborts safely instead of sending raw history. Usage estimation uses the same checkpoint-aware projection decision.

Commit confirmation and repair are different native facts. `resetBoundaryCommitted` validates a checkpoint-backed marker followed by its matching hidden boot and hidden continuation; later conversation does not undo that commit. `inspectResetTail` instead asks whether the entire suffix remains safe to repair, refusing later conversation, foreign messages, later markers or misordered/duplicate artifacts. UI success notices use confirmation, not the repair predicate, and remain committed-only.

Startup/tree repair is narrow: it may complete a repairable marker tail when later conversation does not make the missing metadata ambiguous. It awaits the notes snapshot and rechecks lifecycle/window identity before sending a repaired boot or continuation. Legacy marker-only tails remain supported; repair never moves a boundary or promotes an arbitrary compaction to a retain-none checkpoint. `/tree` summary generation is suppressed with an empty summary when either branch crosses a reset, because the raw summary generator bypasses the provider projection.

## Validation and known limits

The test suite combines isolated reducer tests with scripted SDK tests executing Pi's real agent loop without model/network calls. The retained scripted AgentSession tests cover idle and streaming manual commands whose close-outs commit at settlement and stop without a fresh-window continuation, direct wipe without warning, budget close-out, same-window concurrent command deduplication, actual and synthetic abort/error cleanup, queued steering/follow-up delivery before the stop, hard-reserve and bounded-overflow recovery, successive resets, and real SessionManager file reopen after two retain-none checkpoints. It also checks raw-history preservation, canonical projection, empty-summary retention, system/tool state, warning/marker order, and fresh-window continuation.

Focused regression tests distinguish committed-boundary confirmation from safe suffix repair even after later work. Resolved-AST dependency tests reject shared imports of native adapters and SDKs, including indirect type/re-export/dynamic paths. Retained behavioral cases are representative rather than exhaustive. Tree-summary suppression has no dedicated retained test, and external-provider behavior, every malformed persisted shape, and every filesystem failure mode are not established by this suite.
