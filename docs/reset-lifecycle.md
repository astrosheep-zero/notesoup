# Reset lifecycle

All lifecycle control flow is native Pi integration. `src/pi/reset/lifecycle.ts` owns actual tool requests, command settlement policy, bounded overflow recovery and scheduling. `src/pi/budget.ts` reads usage/settings and stages reminders; `src/budget/policy.ts` derives thresholds. `src/pi/reset/artifacts.ts` constructs ordered drafts and repairs incomplete suffixes; `src/pi/reset/committed.ts` confirms durable boundaries. `src/pi/window.ts` owns markers and provider projection. `src/pi/runtime.ts` wires commands, tools and public Pi hooks.

Boot acquisition/rendering is shared: `src/boot/snapshot.ts` receives explicit identity, a captured time and an optional scope loader; `src/boot/render.ts` receives the snapshot and logical tool bindings. Pi supplies its existing names. Shared history is an addressed query projection, never an inference transcript or reset scheduler. There is no generic HostEvent or Harness reducer, and no second commit database.

## Lifecycle at a glance

| Trigger | Behavior |
| --- | --- |
| `empty_brain` tool | Record an actual tool request for the current window, including any last word. Without command policy it commits at `turn_end` after the complete tool batch and continues. Under command policy the request remains recorded but waits for settlement. |
| `/fresh-window` or `/empty-brain` | Store command policy and send a hidden warning (start a turn when idle, steer when running). Wait for successful settlement after queued messages drain, then reset and stop for a bare command or continue for a command with text. Model tool calls remain actual requests; they do not change settlement policy. The text reaches the closing model only, never the new window directly. |
| Budget warning | Inject a warning at reserve plus runway when automatic reset is enabled. This creates no lifecycle state. A warning alone never authorizes a reset; a tool call or the independent hard-reserve check does. |
| Hard reserve | Independent safety path: if automatic resets are enabled and completed-turn usage reaches Pi's reserve, commit a boundary at `turn_end`. A pending manual stop survives in a run-scoped `stop-pending` phase; empty automatic follow-up is cancelled before provider work, while real queued user input is answered before stopping. |
| Abort or error | Never count as successful close-out. Abort clears lifecycle state. An ordinary close-out error is dropped without reset. Manual overflow clears and stops without retry, even with automatic reset disabled; automatic provider-overflow recovery remains separately bounded. |
| `/compact` while active | Cancel native compaction, which could otherwise summarize pre-reset history back into the active window. A manual attempt receives an actionable `/fresh-window` notice. |

A new boundary is ordered as:

1. A native `compaction` entry with `summary: ""` and `firstKeptEntryId` set to its own ID. This is Pi's retain-none canonical checkpoint; it is not a generated summary request.
2. A `notesoup/reset-marker` custom entry with `{ windowId, origin }`.
3. A hidden `notesoup/boot` custom message with matching `details.windowId`.
4. A hidden continuation message carrying the paragraph drawn for that boundary.
5. If the closing window passed a `last_word`, a visible `notesoup/reset-last-word` message carrying it. Pi boundary drafts do not support ordinary user entries, so the parting line is committed with the reset instead of queued separately.

## Handoff origin and the continuation pools

The continuation is one randomly selected, complete paragraph from an approved pool, drawn when a new boundary artifact is created and persisted verbatim in the continuation entry; the marker's `origin` field records which pool was used. Rendering, history reads, and reloads never draw again, so a window keeps the handoff it was opened with.

The origin comes directly from the recorded tool request: with a call it is `normal`, without one it is `forced`. Command policy affects timing and continuation, never origin. A hard-reserve stop latch retains the tool request for construction retry. No separate acknowledgement flag or warning-source inference is needed. Legacy markers without a valid origin default to normal.

Each host draws once per artifact and shares that value across every representation of it: Pi persists one entry, dsh writes the same paragraph into its checkpoint text and its steered continuation, and Claude — which has no model-facing reset tool, so every Claude reset is forced — caches one line per window so a retried compaction cannot redraw it. A generic read-only text endpoint never draws.

A manual `/empty-brain <prompt>` command line is not persisted after the reset: it reaches the closing window inside the warning, and the closing model records what the next window needs in notes.

The raw session branch is preserved for history. New checkpoint-backed branches use Pi's canonical retain-none projection, which preserves the empty summary wrapper and system/tool state while excluding earlier conversational context. Older marker-only sessions use marker slicing as a narrow compatibility fallback. A marker is trusted as checkpoint-backed only when it directly follows an empty native compaction whose `firstKeptEntryId` is the compaction's own ID; a generic preceding compaction is not enough.

`turn_end` preserves incoming entries, consumes budget drafts and appends a reset only for a tool-only request or hard reserve. `agent_before_settle` executes command policy after queued work drains, or performs bounded overflow recovery. Pi owns ensuing continuation and scheduling. Async reset construction captures session/window generations and rechecks them, enabled state and abort status before returning drafts. Stale results are discarded without losing incoming/budget entries; construction failures notify only while current and do not claim a continuation.

## Reducer state

`reduceResetControl` is pure: the adapter supplies all lifecycle facts, and the reducer returns the next state plus a named effect. Its state combines a request phase with a bounded overflow phase:

| State | Meaning |
| --- | --- |
| `{ phase: "none" }` | No request or command policy is pending. |
| `{ phase: "pending", windowId, command?, tool? }` | `command: { continueAfterReset }` is settlement policy. `tool: { lastWord? }` records an actual model call, even without a last word. Either or both may exist; neither overwrites the other. No warning source or raw prompt is stored. |
| `{ phase: "stop-pending", windowId, tool? }` | A manual hard-reserve reset was proposed for the given old window. The stop survives a committed window change; settlement stops without a second wipe (or retries construction if the old window is still active). New wipe requests only acknowledge it. |

| `overflow: "idle"` | No overflow recovery is pending. |
| `overflow: "pending"` | An overflow failure may recover once at pre-settlement. |
| `overflow: "pending-spent"` | Recovery was already spent in this failure chain. |
| `overflow: "spent"` | The one recovery has been used until the chain settles. |

### Transition rules

- `command(windowId, continueAfterReset)` stores settlement policy. Duplicate same-window commands retain the first policy; a pending tool request is retained.
- `tool_request(windowId, lastWord?)` records an actual call without changing command policy. Tool-only duplicates keep the first request; under command policy, repeated calls may supply the first nonempty last word.
- `turn_end` clears on abort. Overflow preserves command policy and its tool request; otherwise automatic recovery is armed only when enabled and unqueued. Other errors drop pending requests. Success commits a tool-only request or hard-reserve reset. Hard reserve under a bare command retains the cross-window `stop-pending` latch; a continuing command needs no stop latch.
- `agent_before_settle` waits for queued work. Command overflow resets even with automatic recovery disabled, honoring command continuation policy. Other overflow recovery gets one attempt. A committed stop latch stops without a second wipe; an uncommitted one can retry construction. Otherwise a successful command settles and resets. No command means no ordinary settle reset.
- `agent_settled`, session start/tree navigation/shutdown, `/notesoup off`, and abort clear transient request state. Durable checkpoint/marker history remains authoritative after transient state is gone.

After a manual safety reset, `context_with_system` verifies the committed checkpoint/marker/boot/continuation before using public `ctx.abort()` to cancel Pi's otherwise unavoidable tool-batch follow-up, returning a system-only safe context. Pending messages or a real user message after the reset marker bypass cancellation so queued work is not swallowed. A follow-up queue may require Pi's ordinary tool follow-up to finish before delivery; the stop intent remains armed until that work settles. Abort/settlement clears the run-scoped latch, so later user prompts work normally.

Budget warnings need no rearming or consumption in the lifecycle. Direct tool calls remain valid without a warning. Actual abort, synthetic assistant abort and generic provider failure keep their existing cleanup semantics.

## Budget staging and notifications

The early reminder is staged once per window at `reserve + reminderMarginTokens`; the final warning at `reserve + WARNING_RUNWAY_TOKENS`, only when automatic compaction is enabled. Hard reserve remains independent. Budget and command warnings have distinct message types, so an aborted command cannot suppress a later budget warning. Durable warning deduplication concerns only injection; no transient automatic close-out is armed or rearmed.

Pi's boot protocol and second-tier warning include pre-reset hints: the reset clears the human's chat view, so long explanations belong after it; the model manages reset timing unless directed otherwise. Those hints are Pi-only. Dsh's second-tier notice ends with the same countdown as Pi and Claude.

Budget drafts are instance-local and are consumed at turn end. They are discarded on abort, failed turn, transition, or window mismatch. The final warning notifies the UI when first injected into a model request, before the response or tool execution, rather than waiting for durability. Aborting the request does not retract the notice or repeat it on retry in the same window; early guidance remains UI-silent. Active-window usage and the exact `SettingsManager` authority drive threshold checks; default file-backed policy is cached per extension instance, while injected managers are read through their public API.

## Projection, repair, and history

`context_with_system` selects the active boot by durable `details.windowId`. For a verified native checkpoint, Pi's canonical projection is used directly; for a legacy marker-only reset, the compatibility projection slices at the matching boot. The projection preserves system/tool state and later prompt patches. If the boot is absent, the runtime aborts safely instead of sending raw history. Usage estimation uses the same checkpoint-aware projection decision.

Commit confirmation and repair are different native facts. `resetBoundaryCommitted` validates a checkpoint-backed marker followed by its matching hidden boot and hidden continuation; later conversation does not undo that commit. `inspectResetTail` instead asks whether the entire suffix remains safe to repair, refusing later conversation, foreign messages, later markers or misordered/duplicate artifacts. UI success notices use confirmation, not the repair predicate, and remain committed-only.

Startup/tree repair is narrow: it may complete a repairable marker tail when later conversation does not make the missing metadata ambiguous. It awaits the notes snapshot and rechecks lifecycle/window identity before sending a repaired boot or continuation. A missing continuation is drawn from the pool its marker's `origin` names; an existing continuation is never replaced, never redrawn, and its marker is never rewritten. Legacy marker-only tails remain supported; repair never moves a boundary or promotes an arbitrary compaction to a retain-none checkpoint. `/tree` summary generation is suppressed with an empty summary when either branch crosses a reset, because the raw summary generator bypasses the provider projection.

## Validation and known limits

The test suite combines isolated reducer tests with scripted SDK tests executing Pi's real agent loop without model/network calls. The retained scripted AgentSession tests cover idle and streaming manual commands whose close-outs commit at settlement and stop without a fresh-window continuation, direct wipe without warning, budget close-out, same-window concurrent command deduplication, actual and synthetic abort/error cleanup, queued steering/follow-up delivery before the stop, hard-reserve and bounded-overflow recovery, successive resets, and real SessionManager file reopen after two retain-none checkpoints. It also checks raw-history preservation, canonical projection, empty-summary retention, system/tool state, warning/marker order, and fresh-window continuation.

Focused regression tests distinguish committed-boundary confirmation from safe suffix repair even after later work. Resolved-AST dependency tests reject shared imports of native adapters and SDKs, including indirect type/re-export/dynamic paths. Retained behavioral cases are representative rather than exhaustive. Tree-summary suppression has no dedicated retained test, and external-provider behavior, every malformed persisted shape, and every filesystem failure mode are not established by this suite.
