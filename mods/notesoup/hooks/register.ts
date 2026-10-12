import type { EngineInterface, On, ProcessRunResult, ToolCallResult, ToolSpec } from "claude-code"

const PREFIX = "mcp__notesoup__"
const TOOL_NAMES = ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"] as const
// @ts-expect-error Claude's hook sandbox supplies import.meta.dir; Node's typings do not.
const HELPER = `${import.meta.dir}/../dist/claude/helper.js`
const TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 1024 * 1024

type Identity = { home: string; sessionId: string; cwd: string; agent: string; model: string }
type SchemaRow = { name: string; description: string; inputSchema: Record<string, unknown> }
type Engine = Pick<EngineInterface, "process" | "session" | "ui" | "clock" | "prompt" | "env">
type UsageSample = { context?: unknown }
/** `usage({breakdown:true})` is wired in the engine but absent from the public typings. */
type UsageReader = (options?: { breakdown?: boolean }) => Promise<UsageSample | undefined>
/** The measured context, as much of it as the engine reported. */
type ContextUsage = { tokens?: number; window?: number; percent?: number }
/** Shared reset prose, fetched once per session so Pi and Claude cannot drift apart. */
type SharedTexts = { warning?: string; continuation?: string; wipeSentence?: string }
type ClaudeLimits = {
  source: string; autoCompact: boolean; unit: "tokens" | "percent"
  native: number; reset: number; warn: number; resetMargin: number; warningRunway: number
}
type ResetState = {
  identity?: Identity; window: number; turnRunning: boolean; resetting: boolean
  manualPending: boolean; headless: boolean; usageFailureLogged: boolean; preparedBoot?: string; retainedBoot?: string
  compactDisabled: boolean; limitsFailureLogged: boolean; limitsAttempted: boolean; limitsWindow: number
  limits?: ClaudeLimits; warnedWindow?: number; texts?: SharedTexts
}
const HEADLESS = "Clear-memory is off in headless (-p / SDK) sessions"
const COMPACT_DISABLED = "Clear-memory can't run: compaction is off in this session (DISABLE_COMPACT)"
const THRESHOLDS_UNAVAILABLE = "Context thresholds unavailable · automatic clear-memory skipped"
const RESET_INSTRUCTIONS = "notesoup: reset to a fresh notes-only context window."
const BOOT_TOOLS = {
  notes: `${PREFIX}notes_*`, notesList: `${PREFIX}notes_list`,
  history: "history_* (unavailable in Claude)",
  remaining: "get_context_remaining (unavailable in Claude)", wipe: "/clear-memory (user command; no model reset tool in Claude)",
}

/** The boot names the host's own wipe path, so the protocol block speaks about `/clear-memory`. */
async function buildBoot($: Engine, identity: Identity, window: number, texts?: SharedTexts) {
  const tools = texts?.wipeSentence === undefined ? BOOT_TOOLS : { ...BOOT_TOOLS, wipeSentence: texts.wipeSentence }
  return run($, { op: "boot", identity, window, tools }, identity.cwd)
}
function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
function sharedTextsOf(value: unknown): SharedTexts | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Record<string, unknown>
  const texts: SharedTexts = {}
  if (typeof row.warning === "string" && row.warning.length > 0) texts.warning = row.warning
  if (typeof row.continuation === "string" && row.continuation.length > 0) texts.continuation = row.continuation
  if (typeof row.wipeSentence === "string" && row.wipeSentence.length > 0) texts.wipeSentence = row.wipeSentence
  return Object.keys(texts).length > 0 ? texts : undefined
}
/** The helper's resolved points, accepted only when every number is a real number. */
function limitsShape(value: unknown): ClaudeLimits | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Record<string, unknown>
  const unit = row.unit === "tokens" || row.unit === "percent" ? row.unit : undefined
  const native = numberOf(row.native), reset = numberOf(row.reset), warn = numberOf(row.warn)
  const resetMargin = numberOf(row.resetMargin), warningRunway = numberOf(row.warningRunway)
  if (unit === undefined || native === undefined || reset === undefined || warn === undefined || resetMargin === undefined || warningRunway === undefined) return undefined
  return { source: typeof row.source === "string" ? row.source : "unknown", autoCompact: row.autoCompact !== false, unit, native, reset, warn, resetMargin, warningRunway }
}
async function envValue($: Engine, name: string): Promise<string | undefined> {
  try { const value = await $.env.get(name); return typeof value === "string" ? value : undefined } catch { return undefined }
}
/** Presence-style environment flags: any value but an explicit no counts as on. */
async function envFlag($: Engine, name: string): Promise<boolean> {
  const value = await envValue($, name)
  if (value === undefined) return false
  const text = value.trim().toLowerCase()
  return text !== "" && text !== "0" && text !== "false"
}
async function readSettings($: Engine): Promise<unknown> {
  const settings = ($ as { settings?: { read?: (options?: unknown) => Promise<unknown> } }).settings
  if (typeof settings?.read !== "function") return undefined
  try { return await settings.read() } catch { return undefined }
}
/** The measured context, or undefined when the engine cannot report it. The failure logs once. */
async function contextUsage($: Engine, state: ResetState): Promise<ContextUsage | undefined> {
  try {
    const read = $.session.usage as unknown as UsageReader
    const context = (await read())?.context
    if (typeof context !== "object" || context === null) return {}
    const row = context as Record<string, unknown>
    return { tokens: numberOf(row.tokens), window: numberOf(row.window), percent: numberOf(row.percent) }
  } catch {
    if (!state.usageFailureLogged) {
      state.usageFailureLogged = true
      log($, "Context usage unavailable · automatic clear-memory skipped")
    }
    return undefined
  }
}
async function breakdownContext($: Engine): Promise<Record<string, unknown> | undefined> {
  try {
    const read = $.session.usage as unknown as UsageReader
    const context = (await read({ breakdown: true }))?.context
    return typeof context === "object" && context !== null ? context as Record<string, unknown> : undefined
  } catch { return undefined }
}
/** Everything the resolver may read: measured usage plus the raw settings and environment. */
async function limitFacts($: Engine, usage: ContextUsage): Promise<Record<string, unknown>> {
  return {
    usage,
    breakdown: await breakdownContext($),
    settings: await readSettings($),
    env: {
      pctOverride: await envValue($, "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"),
      autoCompactWindow: await envValue($, "CLAUDE_CODE_AUTO_COMPACT_WINDOW"),
      disableAutoCompact: await envValue($, "DISABLE_AUTO_COMPACT"),
    },
  }
}
/**
 * The points the current window is measured against, resolved by the helper's shared
 * derivation. One attempt per reported window value: an unknown window resolves the percent
 * fallback, and a later real window re-resolves against it.
 */
async function limitsOf($: Engine, state: ResetState, usage: ContextUsage): Promise<ClaudeLimits | undefined> {
  const window = usage.window !== undefined && usage.window > 0 ? usage.window : 0
  if (state.limitsAttempted && state.limitsWindow === window) return state.limits
  const response = await run($, { op: "limits", facts: await limitFacts($, usage) }, state.identity?.cwd ?? ".")
  const limits = response.ok ? limitsShape(response.result) : undefined
  state.limitsAttempted = true
  state.limitsWindow = window
  if (limits) state.limits = limits
  else if (!state.limitsFailureLogged) {
    state.limitsFailureLogged = true
    log($, THRESHOLDS_UNAVAILABLE)
  }
  return limits ?? state.limits
}
/** The measured value the points are expressed in; tokens win, percent × window stands in. */
function measuredValue(limits: ClaudeLimits, usage: ContextUsage): number | undefined {
  if (limits.unit === "percent") return usage.percent
  if (usage.tokens !== undefined) return usage.tokens
  return usage.percent !== undefined && usage.window !== undefined && usage.window > 0 ? (usage.percent / 100) * usage.window : undefined
}
/** The shared reset prose: one helper round trip per session, retried until it lands. */
async function loadTexts($: Engine, state: ResetState): Promise<SharedTexts | undefined> {
  if (state.texts) return state.texts
  if (!state.identity) return undefined
  const response = await run($, { op: "texts" }, state.identity.cwd)
  const texts = response.ok ? sharedTextsOf(response.result) : undefined
  if (texts) state.texts = texts
  return texts
}
function log($: Engine, text: string) {
  try { $.ui.log(`🥣 ${text}`) } catch { /* UI must not break a turn or reset. */ }
}

function errorResult(message: string): ToolCallResult { return { result: `notesoup: ${message}`, isError: true } }
/** The helper's tool result: the shared text the model reads, plus whether that outcome refused. */
function toolResultOf(value: unknown): { text: string; ok: boolean } | undefined {
	if (typeof value !== "object" || value === null) return undefined
	const { text, outcome } = value as { text?: unknown; outcome?: unknown }
	if (typeof text !== "string" || typeof outcome !== "object" || outcome === null) return undefined
	const ok = (outcome as { ok?: unknown }).ok
	if (typeof ok !== "boolean") return undefined
	return { text, ok }
}
function decode(result: ProcessRunResult): { ok: true; result: unknown } | { ok: false; error: string } {
  if (result.exitCode !== 0) return { ok: false, error: "helper exited unsuccessfully" }
  if (result.stdout.length > OUTPUT_LIMIT) return { ok: false, error: "helper output exceeded the limit" }
  try {
    const value = JSON.parse(result.stdout.trim()) as { ok?: unknown; result?: unknown; error?: unknown }
    if (value.ok === true) return { ok: true, result: value.result }
    return { ok: false, error: typeof value.error === "string" ? value.error : "helper returned an invalid error" }
  } catch { return { ok: false, error: "helper returned invalid JSON" } }
}
async function run($: { process: { run: (argv: readonly string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number }) => Promise<ProcessRunResult> } }, request: unknown, cwd: string) {
  try { return decode(await $.process.run(["node", HELPER], { cwd, stdin: `${JSON.stringify(request)}\n`, timeoutMs: TIMEOUT_MS })) }
  catch { return { ok: false as const, error: "helper execution failed" } }
}
function identityOf(e: { cwd: string }, sessionId: string, home: string, model: string): Identity {
  return { home, sessionId, cwd: e.cwd, agent: "claude", model: model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "claude" }
}

export function register(on: On) {
  let identity: Identity | undefined
  const manualSignal: { wake?: () => void } = {}
  const state: ResetState = { window: 0, turnRunning: false, resetting: false, manualPending: false, headless: false, usageFailureLogged: false, compactDisabled: false, limitsFailureLogged: false, limitsAttempted: false, limitsWindow: 0 }
  const registered = new Set<string>()
  on("session.start", async ($, e, next) => {
    const home = await $.env.get("PI_NOTES_HOME") ?? `${await $.env.get("HOME") ?? await $.env.get("USERPROFILE") ?? ""}/.agents/notes`
    identity = identityOf(e, await $.session.id(), home, "claude")
    state.identity = identity
    state.window = 0
    state.turnRunning = state.resetting = state.manualPending = state.usageFailureLogged = false
    state.headless = !e.isInteractive
    if (state.headless) log($, HEADLESS)
    state.preparedBoot = state.retainedBoot = undefined
    state.texts = state.limits = undefined
    state.limitsAttempted = false
    state.limitsWindow = 0
    state.warnedWindow = undefined
    // Compaction is the capability the reset is built on; without it, automatic resets stop here.
    state.compactDisabled = await envFlag($, "DISABLE_COMPACT")
    if (state.compactDisabled) log($, COMPACT_DISABLED)
    // The engine's history view includes retained boots on resume/reload.
    // Recover their ordinal without treating that view as inference context.
    try { restoreWindow(state, await $.session.messages()) } catch { /* A fresh session starts at zero. */ }
    registered.clear()
    await loadTexts($, state)
    armManual($, state, manualSignal)
    await $.command.register({ name: "clear-memory", description: "Reset context to a fresh notes-only window", immediate: true })
    const schemas = await run($, { op: "schemas" }, e.cwd)
    if (!schemas.ok || !Array.isArray(schemas.result)) return next(e)
    for (const row of schemas.result as SchemaRow[]) {
      if (!TOOL_NAMES.includes(row.name as typeof TOOL_NAMES[number])) continue
      const full = await $.tool.register({ name: row.name, description: row.description, inputSchema: row.inputSchema, isDeferred: false } satisfies ToolSpec)
      registered.add(full.tool)
    }
    return next(e)
  })
  on("tool.call", async ($, e, next) => {
    if (!registered.has(e.tool) || e.agentId !== undefined || !identity) return next(e)
    const { tool, tool_use_id: _toolUseId, agentId: _agentId, ...params } = e
    const result = await run($, { op: "tool", tool: tool.slice(PREFIX.length), params, identity }, identity.cwd)
    if (!result.ok) return errorResult(result.error)
    // The outcome already decided success or refusal; Claude requires isError: true on errors and no discriminator on success.
    const outcome = toolResultOf(result.result)
    if (!outcome) return errorResult("helper returned an invalid tool result")
    return outcome.ok ? { result: outcome.text } : { result: outcome.text, isError: true }
  })
  on("turn.start", async ($, e, next) => {
    state.turnRunning = true
    return next(e)
  })
  on("turn.complete", async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    state.turnRunning = false
    await maybeReset($, state, true)
    return result
  })
  on("session.measure", async ($, e, next) => {
    const result = await next(e)
    await maybeReset($, state, false)
    return result
  })
  on("command.run", async ($, e, next) => {
    if (e.command !== "clear-memory") return next(e)
    if (state.headless) return { text: `🥣 ${HEADLESS}` }
    if (state.compactDisabled) return { text: `🥣 ${COMPACT_DISABLED}` }
    if (state.resetting || state.manualPending) return { text: "🥣 Clear-memory already queued" }
    if (state.turnRunning) {
      state.manualPending = true
      return { text: "🥣 Clear-memory queued · runs after this turn" }
    }
    // command.run holds a turn even when idle. Start one hidden close-out
    // turn after it returns; turn.complete is the verified self-hook path.
    state.manualPending = true
    manualSignal.wake?.()
    return { text: "🥣 Clearing memory · notes first, then it stops" }
  })
  on("session.compact", async ($, e, next) => {
    // Do not take over native /compact or another plugin's compaction.
    if (!state.resetting || e.trigger !== "plugin" || e.agentId !== undefined || !identity) return next(e)
    const texts = await loadTexts($, state)
    if (texts?.continuation === undefined) return { skip: "reset text didn't load" }
    const boot = await buildBoot($, identity, state.window + 1, texts)
    if (!boot.ok) return { skip: `notes didn't load: ${boot.error}` }
    state.preparedBoot = String(boot.result)
    // The same closed reset shape as Pi: notes boot first, then the one reset message.
    return { messages: [
      { role: "user", text: state.preparedBoot, toolUses: [] },
      { role: "user", text: texts.continuation, toolUses: [] },
    ] }
  })
  on("prompt.context", async ($, e, next) => {
    const result = await next(e)
    // The reset already retained its boot as the sole conversation message.
    // Prompt context still recomputes, but must not inject a duplicate snapshot.
    const retained = state.retainedBoot !== undefined
    let blocks = retained ? result.blocks.filter((block) => block.name !== "notesoup:boot") : [...result.blocks]
    if (!retained && !blocks.some((block) => block.name === "notesoup:boot") && identity) {
      const texts = await loadTexts($, state)
      const boot = await buildBoot($, identity, state.window, texts)
      if (!boot.ok) {
        try {
          await $.ui.notify("🥣 Notes didn't load")
        } catch { /* Notification failure must not suppress the fallback block. */ }
      }
      blocks = [...blocks, { name: "notesoup:boot", text: boot.ok ? String(boot.result) : `# notesoup\nYour notes didn't load this time (${boot.error}). Try \`${PREFIX}notes_list\`; if it fails too, tell the human.` }]
    }
    const warning = await warningBlock($, state)
    return { ...result, blocks: warning === undefined ? blocks : [...blocks, warning] }
  })

}

/**
 * The one warning per window: injected only once the measured context crosses the resolved
 * warn point, and only until the window changes. The reset decision runs independently.
 */
async function warningBlock($: Engine, state: ResetState): Promise<{ name: string; text: string } | undefined> {
  if (state.headless || state.compactDisabled || !state.identity || state.warnedWindow === state.window) return undefined
  const usage = await contextUsage($, state)
  if (usage === undefined) return undefined
  const limits = await limitsOf($, state, usage)
  if (limits === undefined) return undefined
  const measured = measuredValue(limits, usage)
  if (measured === undefined || measured < limits.warn) return undefined
  const texts = await loadTexts($, state)
  if (texts?.warning === undefined) return undefined
  state.warnedWindow = state.window
  return { name: "notesoup:warning", text: texts.warning }
}

function restoreWindow(state: ResetState, messages: readonly { role: string; text: string }[]) {
  if (!state.identity) return
  const prefix = `Current context window id: claude:${state.identity.sessionId}:`
  for (const message of messages) {
    if (message.role !== "user" || !message.text.startsWith("<context_window>\nAgent name: claude ")) continue
    const line = message.text.split("\n").find((value) => value.startsWith(prefix))
    if (!line) continue
    const suffix = line.slice(prefix.length)
    const window = Number(suffix)
    if (!/^\d+$/.test(suffix) || !Number.isSafeInteger(window) || window <= state.window) continue
    state.window = window
    state.retainedBoot = message.text
  }
}

// The waiter is created in session.start, so its Promise continuation keeps
// that non-held host context. Timers started inside command.run inherit its
// held dispatch even after the command returns. No polling timer is needed.
function armManual($: Engine, state: ResetState, signal: { wake?: () => void }) {
  const requested = new Promise<void>((resolve) => { signal.wake = resolve })
  void requested.then(() => {
    signal.wake = undefined
    $.clock.after(0, () => finishManual($, state, signal))
  })
}
async function finishManual($: Engine, state: ResetState, signal: { wake?: () => void }) {
  try {
    if (state.manualPending && !state.turnRunning) {
      const texts = await loadTexts($, state)
      if (texts?.warning === undefined) {
        state.manualPending = false
        log($, "Couldn't clear memory: the close-out prompt didn't load")
        return
      }
      await $.prompt.submit({ text: texts.warning })
    }
  } catch {
    state.manualPending = false
    log($, "Couldn't clear memory: the close-out turn didn't start")
  } finally { armManual($, state, signal) }
}

// The sandbox permits $ forwarding only to file-top-level helpers.
async function maybeReset($: Engine, state: ResetState, complete: boolean) {
  if (!state.identity || state.resetting || state.headless || state.compactDisabled) return
  const usage = await contextUsage($, state)
  if (state.turnRunning) return
  let due = complete && state.manualPending
  if (!due && usage !== undefined) {
    const limits = await limitsOf($, state, usage)
    const measured = limits === undefined ? undefined : measuredValue(limits, usage)
    // Missing measurements do not trigger a reset.
    if (limits !== undefined && measured !== undefined && measured >= limits.reset) due = true
  }
  if (due) {
    state.manualPending = false
    await reset($, state)
  }
}
async function reset($: Engine, state: ResetState): Promise<void> {
  if (!state.identity || state.headless || state.resetting) return
  state.resetting = true
  state.preparedBoot = undefined
  try {
    const result = await $.session.compact({ instructions: RESET_INSTRUCTIONS })
    if (result.skip !== undefined || state.preparedBoot === undefined) {
      log($, `Memory not cleared · ${result.skip ?? "notes boot was not retained"}`)
      return
    }
    state.retainedBoot = state.preparedBoot
    state.window++
    log($, "Memory cleared")
  } catch (error) {
    const text = String(error)
    if (text.includes("headless (-p / SDK)")) {
      state.headless = true
      log($, HEADLESS)
    } else if (/a turn is (running|in flight)/.test(text)) {
      state.manualPending = true
    } else {
      log($, `Couldn't clear memory: ${text.replace(/[\r\n].*$/s, "")}`)
    }
  } finally {
    state.preparedBoot = undefined
    state.resetting = false
  }
}
