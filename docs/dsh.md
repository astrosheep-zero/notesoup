# DeepSeek Harness adapter

notesoup for **dsh 0.2.1-alpha.2** gives the agent a fresh notebook when context runs low: frozen boot text, the five notes homes, eight notes/history tools, `get_context_remaining`, and `empty_brain`. A reset makes **zero model calls**. The old conversation leaves the model surface and remains in the session log for history reads. Dream is not registered on dsh.

Install the package in your chosen dsh profile with `dsh plugin --profile <profile> add notesoup`, then copy the model declaration from [the profile patch example](dsh.profile.patch.yml) into `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. The package bundle patch disables `compaction-basic` and inserts `notesoup-engine` and `notesoup`. Do not duplicate those rows when adding the model declaration. A source checkout needs `npm ci --ignore-scripts` and `npm run build`; use absolute `file:///.../dist/plugins/dsh/engine.js` and `file:///.../dist/plugins/dsh/index.js` module names. The example shows all rows for a profile assembled without the package bundle.

Declare explicit `models` for `llm-deepseek`, with `contextWindow` and `maxTokens` appropriate to your provider. The shipped `deepseek-flash` declaration uses `systemPromptUpdate: in-history`; changing the boot under that route can leave an earlier system prompt in the leading slot. The example uses **200000 context tokens and 8192 output tokens**. Those numbers are test inputs, not a promise about your provider's capacity.

On load and before requests, preflight probes `systemPrompt.section`, `tools.register`, `sessionQuery.readSession`, `tokenMeter.measure`, and `llm.resolveModelInfo`. It requires our compaction service and its automatic listener. It inspects public loader entries when available and rejects an enabled `compaction-basic` row or registered `BasicCompactionEngine` fiber. An error names the row or capability to fix. Peer dependencies use `*`, so a newer preview is tested by capability rather than silently skipped by an upper version bound. Cordis can contain a plugin-load failure and continue loading other plugins: inspect startup errors before using a profile.

## Notes, boot and history

`notesHome` defaults to `~/.agents/notes`; `agentName` defaults to `dsh`. The filesystem layout and addressing match Pi and Claude: bare paths are session notes, with `@project`, `@human`, `@self`, and `@model` durable homes. Project identity uses the shared `resolveProjectHome(cwd, notesHome)` resolver: readable slug homes with a `.project` marker, including repository/worktree and origin identity. Other marked projects are readable through `@projects/<name>/`; named-home reads do not update access metadata and named-home writes are refused. Receipts, boot protocol (including separate CHEATSHEET.md and MAP.md pages), and bounds come from the shared modules, not dsh copies. A model change changes subsequent tools' `@model` identity; the boot remains frozen until reset.

The boot is a `systemPrompt.section` at order **2450**, with `interpolate: false`. Shared snapshot/render functions read the five homes once, using a captured timestamp. Rendering is deterministic for those inputs. A `plugin:notesoup/window` record stores the ordinal, id, timestamp, digest and exact boot text. `agent/created` adopts it before the first assembly. Notes written later appear in the next window's boot. Missing records reconstruct from the notesoup compact checkpoint, or from the marked root system section. Neither path rereads notes or regenerates a summary. Records are informational; checkpoints control the model surface.

`history_windows`, `history_list`, and `history_read` obtain the full raw log through `ctx.sessionQuery.readSession`, then feed the shared pairing, paging and literal-search operations. Public history seq **1** is native dsh seq **0**; always use the seq a notesoup tool returns. A fork's selected seed prefix is available in its history; no sibling or parent suffix is fetched. Tool results are paired at their call seq. Text blocks are verbatim; other recorded blocks are shown as JSON. These tools browse one session, not the host's entire session corpus.

## Reset and budget

The engine owns the compaction transaction, rather than inheriting a summarizer. It validates the complete balanced surface span at positions **1..last**, acquires `compaction/start`, loads and mints the new notebook, writes `compaction/summary` and the replacement checkpoint synchronously, closes with `compaction/end`, then appends the window record. Node **0** stays host-owned. Nothing from the old conversation is retained on the surface. The checkpoint contains only the frozen boot and a complete handoff paragraph, randomly selected once at reset creation. A model reset call selects the normal pool; other resets select the forced pool. The checkpoint and steered copy reuse the same paragraph. A one-message span can reset even when its replacement is larger.

Cancellation or a snapshot/checkpoint failure before replacement restores the old notebook. If replacement has already landed, it is authoritative even if closing or flushing fails; rolling back then would send stale boot text. An unmatched close keeps the durable lock until reload. A lost window record is recoverable from the checkpoint. Manual `compactNow` uses host maintenance and flushes through `ctx.sessions.flush`; the host `/compact` command, when installed, therefore uses this reset engine too.

Automatic resets run in the awaited prompt-assembly waterfall. Assembly happens before `agent/pre-step`, so the adapter refreshes its accepted section after reset to make the same request carry the new boot. It never adopts a window in pre-step; that listener always delegates with `return next()`.

The host-owned reset line is:

```text
resetAt = floor(min(contextWindow * thresholdRatio,
                    contextWindow - maxTokens - headroomTokens))
reserve = contextWindow - resetAt
warning = reserve + 16384
reminder = reserve + reminderMarginTokens
```

The defaults are `auto: true`, `thresholdRatio: 0.8`, `headroomTokens: 65536`, and `reminderMarginTokens: 24576`. For the example's **200000/8192/0.7/32768**, resetAt is **140000**, reserve **60000**, warning **76384** remaining, and reminder **84576** remaining. `get_context_remaining` and the numeric reminder report room to resetAt: physical remaining minus reserve, clamped at zero. The warning runway is included. Missing model capacity returns null. A profile with no positive reset budget fails with `BUDGET_CONFIG` and the numbers to fix. No independent percentage cutoff is added by notesoup.

The adapter uses `tokenMeter.measure`, model context from `resolveModelInfo`, and the mounted engine's resolved `config`. Alpha.2 keeps an old provider-usage anchor across surface replacement; until the fresh window has a response, notesoup uses the meter's current `surfaceTokens` plus its public tool-schema estimator instead of that stale anchor.

The reminder and close-out warning go through `agent.steer`. Close-out remains an instruction to write notes and call `empty_brain`; a normal stop alone does not consume the warning runway. `empty_brain` arms a reset after the entire tool batch. Independently, reaching the hard reserve resets at assembly or a successful stopping boundary and continues from the notes. Abort and ordinary errors drop the pending tool request. `auto: false` disables reminders and reserve resets while keeping explicit `empty_brain` and the listener installed.

## What this does not promise

| Limit | What to expect / next step |
| --- | --- |
| dsh versions | Tested against **0.2.1-alpha.2**. Capability checks do not establish wire or persistence compatibility with every newer preview. Run the scripted tests before upgrading. |
| Model calls per reset | **0** auxiliary model calls. The agent's note-writing turns and fresh-window continuation still make ordinary calls. |
| Retention | Surface node **0**, one boot/continuation checkpoint, and subsequent messages. An unfinished tool batch postpones reset; no partial tool pairs are discarded. |
| Boot bounds | Up to **4096 code points per MAP** and **3 recent notes per home**, from the shared renderer. Slim large MAPs; follow note addresses for full bodies. |
| Tool output | Shared **32 KiB** bounds; use `next_offset_chars`, history cursors, or narrower filters. There is no unbounded hidden result. |
| Warning timing | Steering enters the next step; a large current response/tool batch can spend the runway. The hard reserve protects the next balanced boundary, not an in-flight provider call. |
| Unknown capacity | Countdown is **null** and automatic reserve checks skip. Add `models[].contextWindow` to `llm-deepseek`; explicit resets still work. |
| Storage | Raw log remains available while the host keeps it. Notesoup does not back up session files or guarantee that an unflushed append survives a crash. |
| Plugin records | Best-effort across dsh migrations. Missing records recover from native checkpoints/root system text; unknown future record or checkpoint formats are not migrated by notesoup. |
| Tools and errors | Full shared TypeBox validation runs in the adapter because dsh supports a smaller schema subset. Expected operation errors become dsh failures with the shared code; successes use the shared bounded value and renderer. |
| Notifications and commands | No custom UI notifications, settings card, runtime toggle or `/fresh-window`/`/empty` command is installed. Configure engine rows in the profile/home patch; call `empty_brain` or the host's `/compact`. |
| Untested host features | Real providers, reasoning/image wire behavior, cache metrics, actual context-overflow retry, HMR, migrations, ACP/Web/SDK profiles and large histories are not established by the scripted tests. |
| Dream | **No dsh dream backend or dream skill registration.** Use the existing supported host workflow. |

Run `npm run typecheck` and `npm test` from a checkout. The dsh tests drive the actual loop and tools with a local Messages/SSE server, temporary notes homes and the SQLite session query service. The compaction parity test runs the installed `BasicCompactionEngine` and our own engine through open-turn and idle success paths and a rejected-checkpoint path. It pins native event/result fields, replacement references, and node-zero preservation; it names the intentional differences (Basic's LLM call fields and retained tail, notesoup's model-free template and ignorable window record). Other tests pin codes, token values, window ordinals and request content rather than prose.
