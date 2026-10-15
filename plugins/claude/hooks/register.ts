import type { EngineInterface, On, ProcessRunResult, ToolCallResult, ToolSpec } from "claude-code"

const PREFIX = "mcp__notesoup__"
const HELPER = `${import.meta.dir}/../dist/claude/helper.js`
const TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 1024 * 1024

type Identity = { home: string; sessionId: string; cwd: string; agent: string; model: string }
type SchemaRow = { name: string; description: string; inputSchema: Record<string, unknown> }
type HistorySource = { sessionId: string; transcriptPath: string; headUuid?: string }
type Engine = Pick<EngineInterface, "process" | "session" | "ui" | "clock" | "prompt" | "env" | "settings">
/** The measured context, as much of it as the engine reported. */
type ContextUsage = { tokens?: number; window?: number; percent?: number }
/** Shared reset prose, fetched once per session so Pi and Claude cannot drift apart. */
type SharedTexts = { warning?: string; wipeSentence?: string; historyUnavailableSentence?: string }
type ClaudeLimits = {
  source: string; autoCompact: boolean; unit: "tokens" | "percent"
  native: number; reset: number; warn: number; resetMargin: number; warningRunway: number
}
type ResetState = {
  identity?: Identity; history?: HistorySource; historyWindowHead?: string; generation: number; window: number; disabled: boolean; turnRunning: boolean; resetting: boolean
  manualPending: boolean; headless: boolean; usageFailureLogged: boolean; preparedBoot?: string; retainedBoot?: string
  continuation?: string; continuationWindow?: number
  compactDisabled: boolean; limitsFailureLogged: boolean; limitsAttempts: number; limitsWindow: number
  limits?: ClaudeLimits; warnedWindow?: number; texts?: SharedTexts; settingsFailureLogged: boolean
}
const HEADLESS = "No brain when headless"
const COMPACT_DISABLED = "Brain can't be emptied with DISABLE_COMPACT"
const NOTESOUP_DISABLED = "Notesoup is off with NOTESOUP_DISABLED"
const THRESHOLDS_UNAVAILABLE = "Brain size unknown · no automatic emptying"
const SETTINGS_UNAVAILABLE = "Notesoup settings unreadable · using the default flush margins"
/** Bounded retries: a transient helper failure must not disable thresholds for a whole window. */
const MAX_LIMITS_ATTEMPTS = 3
const RESET_INSTRUCTIONS = "notesoup: reset to a fresh notes-only context window."
const BOOT_TOOLS = {
  notes: `${PREFIX}notes_*`, notesList: `${PREFIX}notes_list`,
  history: "history_* (unavailable: no main transcript_path)",
  remaining: "get_context_remaining (unavailable in Claude)", wipe: "/fresh-window (user command; no model reset tool in Claude)",
}

/** The boot names the host's own wipe path, so the protocol block speaks about `/fresh-window`. */
async function buildBoot($: Engine, identity: Identity, window: number, texts?: SharedTexts, history?: HistorySource) {
  const available = history?.sessionId === identity.sessionId
  const tools = { ...BOOT_TOOLS, ...(available ? { history: `${PREFIX}history_*` } : { historySentence: texts?.historyUnavailableSentence }), ...(texts?.wipeSentence === undefined ? {} : { wipeSentence: texts.wipeSentence }) }
  return run($, { op: "boot", identity, window, tools })
}
/** The notes-only reset shape, shared by our own reset and Claude's native auto compaction. */
type ResetMessages = { boot: string; messages: Array<{ role: "user"; text: string; toolUses: [] }> }
async function resetMessages($: Engine, state: ResetState, identity: Identity): Promise<ResetMessages | { skip: string }> {
  const generation = state.generation
  const texts = await loadTexts($, state)
  if (texts === undefined) return { skip: "reset text didn't load" }
  const boot = await buildBoot($, identity, state.window + 1, texts, state.history)
  if (generation !== state.generation) return { skip: "session changed while building the notes boot" }
  if (!boot.ok) return { skip: `notes didn't load: ${boot.error}` }
  const continuation = await continuationFor($, state)
  if (generation !== state.generation) return { skip: "session changed while building the notes boot" }
  if (continuation === undefined) return { skip: "reset text didn't load" }
  // The same closed reset shape as Pi: notes boot first, then the one reset message.
  const text = String(boot.result)
  return { boot: text, messages: [
    { role: "user", text, toolUses: [] },
    { role: "user", text: continuation, toolUses: [] },
  ] }
}
function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
function sharedTextsOf(value: unknown): SharedTexts | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Record<string, unknown>
  const texts: SharedTexts = {}
  if (typeof row.warning === "string" && row.warning.length > 0) texts.warning = row.warning
  if (typeof row.wipeSentence === "string" && row.wipeSentence.length > 0) texts.wipeSentence = row.wipeSentence
  if (typeof row.historyUnavailableSentence === "string" && row.historyUnavailableSentence.length > 0) texts.historyUnavailableSentence = row.historyUnavailableSentence
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
/** Each environment read names its capability literally for Claude's loader scanner. */
async function envPctOverride($: Engine) {
  try { return await $.env.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE") } catch { return undefined }
}
async function envAutoCompactWindow($: Engine) {
  try { return await $.env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") } catch { return undefined }
}
async function envDisableAutoCompact($: Engine) {
  try { return await $.env.get("DISABLE_AUTO_COMPACT") } catch { return undefined }
}
/** Presence-style environment flags: any value but an explicit no counts as on. */
async function compactDisabled($: Engine): Promise<boolean> {
  let value: string | undefined
  try { value = await $.env.get("DISABLE_COMPACT") } catch { return false }
  if (value === undefined) return false
  const text = value.trim().toLowerCase()
  // The same presence convention as the helper's flag parsing: "off"/"no" mean not disabled.
  return text !== "" && text !== "0" && text !== "false" && text !== "no" && text !== "off"
}
/** Presence-style kill switch for the whole mod; the same convention as DISABLE_COMPACT. */
async function notesoupDisabled($: Engine): Promise<boolean> {
  let value: string | undefined
  try { value = await $.env.get("NOTESOUP_DISABLED") } catch { return false }
  if (value === undefined) return false
  const text = value.trim().toLowerCase()
  return text !== "" && text !== "0" && text !== "false" && text !== "no" && text !== "off"
}
async function readSettings($: Engine, state: ResetState): Promise<unknown> {
  try { return await $.settings.read() } catch {
    // A silent fallback would hide a broken settings read behind default margins.
    if (!state.settingsFailureLogged) {
      state.settingsFailureLogged = true
      log($, SETTINGS_UNAVAILABLE)
    }
    return undefined
  }
}
/** The measured context, or undefined when the engine cannot report it. The failure logs once. */
async function contextUsage($: Engine, state: ResetState): Promise<ContextUsage | undefined> {
  try {
    const context = (await $.session.usage()).context
    if (typeof context !== "object" || context === null) return {}
    const row = context as Record<string, unknown>
    return { tokens: numberOf(row.tokens), window: numberOf(row.window), percent: numberOf(row.percent) }
  } catch {
    if (!state.usageFailureLogged) {
      state.usageFailureLogged = true
      log($, "Brain fullness unknown · no automatic emptying")
    }
    return undefined
  }
}
async function breakdownContext($: Engine): Promise<Record<string, unknown> | undefined> {
  try {
    const context = (await $.session.usage({ breakdown: "summary" })).context
    return typeof context === "object" && context !== null ? context as Record<string, unknown> : undefined
  } catch { return undefined }
}
/** Everything the resolver may read: measured usage plus the raw settings and environment. */
async function limitFacts($: Engine, state: ResetState, usage: ContextUsage): Promise<Record<string, unknown>> {
  return {
    usage,
    breakdown: await breakdownContext($),
    settings: await readSettings($, state),
    env: {
      pctOverride: await envPctOverride($),
      autoCompactWindow: await envAutoCompactWindow($),
      disableAutoCompact: await envDisableAutoCompact($),
    },
  }
}
/**
 * The points the current window is measured against, resolved by the helper's shared
 * derivation. One resolved result per reported window value: an unknown window resolves the
 * percent fallback, and a later real window re-resolves against it. A failed round trip is
 * retried a bounded number of times instead of disabling thresholds for the whole window.
 */
async function limitsOf($: Engine, state: ResetState, usage: ContextUsage): Promise<ClaudeLimits | undefined> {
  const window = usage.window !== undefined && usage.window > 0 ? usage.window : 0
  const sameWindow = state.limitsWindow === window
  if (sameWindow && state.limits !== undefined) return state.limits
  if (sameWindow && state.limitsAttempts >= MAX_LIMITS_ATTEMPTS) return undefined
  const generation = state.generation
  const facts = await limitFacts($, state, usage)
  if (generation !== state.generation) return undefined
  const response = await run($, { op: "limits", facts })
  if (generation !== state.generation) return undefined
  const limits = response.ok ? limitsShape(response.result) : undefined
  state.limitsWindow = window
  if (limits) {
    state.limits = limits
    state.limitsAttempts = 0
    return limits
  }
  state.limitsAttempts = sameWindow ? state.limitsAttempts + 1 : 1
  if (!state.limitsFailureLogged) {
    state.limitsFailureLogged = true
    log($, THRESHOLDS_UNAVAILABLE)
  }
  return undefined
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
  const generation = state.generation
  const response = await run($, { op: "texts" })
  if (generation !== state.generation) return undefined
  const texts = response.ok ? sharedTextsOf(response.result) : undefined
  if (texts) state.texts = texts
  return texts
}
/**
 * The one fresh-window line for the artifact being created. Claude has no model reset tool, so
 * every reset here is system-triggered; one draw per window keeps a retried compaction from
 * redrawing a line the same reset already carries.
 */
async function continuationFor($: Engine, state: ResetState): Promise<string | undefined> {
  if (state.continuation !== undefined && state.continuationWindow === state.window) return state.continuation
  const generation = state.generation
  const response = await run($, { op: "continuation", origin: "forced" })
  if (generation !== state.generation) return undefined
  const result = response.ok ? response.result : undefined
  const text = typeof result === "object" && result !== null ? (result as { text?: unknown }).text : undefined
  if (typeof text !== "string" || text.length === 0) return undefined
  state.continuation = text
  state.continuationWindow = state.window
  return text
}
function log($: Engine, text: string) {
  try { $.ui.log(`🥣 ${text}`) } catch { /* UI must not break a turn or reset. */ }
}
/** A rejected call's reason, one line, bounded: the caller reads it, not a stack. */
function describeFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.replace(/[\r\n]+/g, " ").slice(0, 200) || "unknown failure"
}

function errorResult(message: string): ToolCallResult { return { result: `notesoup: ${message}`, isError: true } }
/** The helper's tool result: the shared text the model reads, plus whether that outcome refused. */
function toolResultOf(value: unknown): { text: string; ok: boolean } | undefined {
	if (typeof value !== "object" || value === null) return undefined
	const { text, ok } = value as { text?: unknown; ok?: unknown }
	if (typeof text !== "string" || typeof ok !== "boolean") return undefined
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
async function run($: { process: { run: (argv: readonly string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number }) => Promise<ProcessRunResult> } }, request: unknown) {
  // A session may still name a removed worktree. Project identity travels in stdin;
  // launch from the plugin directory so removing that worktree cannot prevent spawn.
  try { return decode(await $.process.run(["node", HELPER], { cwd: import.meta.dir, stdin: `${JSON.stringify(request)}\n`, timeoutMs: TIMEOUT_MS })) }
  // The host's rejection is the only diagnosis there is: it carries the spawn failure's own
  // reason (`timed out after …`), which a bare phrase would throw away.
  catch (error) { return { ok: false as const, error: `helper execution failed: ${describeFailure(error)}` } }
}
/** Session start does not fire on /clear, /resume or /branch. Forget the old window on end. */
function forgetSession(state: ResetState) {
  state.generation++
  state.identity = undefined
  state.historyWindowHead = undefined
  state.window = 0
  state.turnRunning = state.resetting = state.manualPending = state.usageFailureLogged = false
  state.preparedBoot = state.retainedBoot = undefined
  state.texts = state.limits = undefined
  state.continuation = undefined
  state.continuationWindow = undefined
  state.limitsAttempts = state.limitsWindow = 0
  state.settingsFailureLogged = state.limitsFailureLogged = false
  state.warnedWindow = undefined
}
async function modelOf($: Engine): Promise<string> {
  // session.model() is the documented main-loop model API. Match the notes library's slug.
  try {
    const model = await $.session.model()
    return model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "claude"
  } catch { return "claude" }
}
/** Re-key lazily even if a host switches sessions without another session.start. */
async function refreshIdentity($: Engine, state: ResetState): Promise<Identity | undefined> {
  const generation = state.generation
  const sessionId = await $.session.id()
  const cwd = await $.session.cwd()
  const model = await modelOf($)
  if (generation !== state.generation) return undefined
  if (state.identity?.sessionId === sessionId) {
    state.identity = { ...state.identity, cwd, model }
    await syncHistoryWindow($, state)
    return state.identity
  }
  const home = await $.env.get("NOTESOUP_HOME") ?? `${await $.env.get("HOME") ?? await $.env.get("USERPROFILE") ?? ""}/.agents/notes`
  if (generation !== state.generation) return undefined
  forgetSession(state)
  state.identity = { home, sessionId, cwd, agent: "claude", model }
  if (state.history?.sessionId !== sessionId) state.history = undefined
  const freshGeneration = state.generation
  // History is not inference context; recover a retained boot only for this session id.
  try {
    const messages = await $.session.messages()
    if (freshGeneration === state.generation) restoreWindow(state, messages)
  } catch { /* A fresh session starts at zero. */ }
  await syncHistoryWindow($, state)
  return freshGeneration === state.generation ? state.identity : undefined
}

/** A committed append is the head evidence; the persisted file may trail it briefly. */
async function syncHistoryWindow($: Engine, state: ResetState) {
  if (!state.identity || !state.history?.headUuid || state.history.sessionId !== state.identity.sessionId || state.resetting || state.historyWindowHead === state.history.headUuid) return
  const generation = state.generation, head = state.history.headUuid
  const response = await run($, { op: "history_state", identity: state.identity, history: state.history })
  if (generation !== state.generation || state.history?.headUuid !== head || !response.ok || typeof response.result !== "object" || response.result === null) return
  const window = (response.result as { window?: unknown }).window
  if (typeof window !== "number" || !Number.isSafeInteger(window) || window < 0) return
  state.historyWindowHead = head
  if (state.window !== window) { state.window = window; state.retainedBoot = undefined }
}

export function register(on: On) {
  const manualSignal: { wake?: () => void } = {}
  const state: ResetState = { generation: 0, window: 0, disabled: false, turnRunning: false, resetting: false, manualPending: false, headless: false, usageFailureLogged: false, compactDisabled: false, limitsFailureLogged: false, limitsAttempts: 0, limitsWindow: 0, settingsFailureLogged: false }
  const registered = new Set<string>()
  // Classic SessionStart precedes typed session.start and startup appends. Keep this binding
  // across forgetSession; re-key it only against the actual session id, never a guessed path.
  on("classic.SessionStart", async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e)
    if (e.source !== "compact" || state.history?.sessionId !== e.session_id) {
      state.history = { sessionId: e.session_id, transcriptPath: e.transcript_path }
    } else state.history.transcriptPath = e.transcript_path
    return next(e)
  })
  on("session.append", async ($, e, next) => {
    const sessionId = await $.session.id(), source = state.history
    const result = await next(e)
    if (e.agentId === undefined && result.uuid !== undefined && state.history === source && source?.sessionId === sessionId) {
      source.headUuid = result.uuid
      state.historyWindowHead = undefined
    }
    return result
  })
  on("session.start", async ($, e, next) => {
    forgetSession(state)
    state.disabled = await notesoupDisabled($)
    if (state.disabled) {
      registered.clear()
      log($, NOTESOUP_DISABLED)
      return next(e)
    }
    await refreshIdentity($, state)
    state.headless = !e.isInteractive
    if (state.headless) log($, HEADLESS)
    // Compaction is the capability the reset is built on; without it, automatic resets stop here.
    state.compactDisabled = await compactDisabled($)
    if (state.compactDisabled) log($, COMPACT_DISABLED)
    registered.clear()
    await loadTexts($, state)
    armManual($, state, manualSignal)
    await $.command.register({ name: "empty", description: "Reset context to a fresh notes-only window", immediate: true })
    await $.command.register({ name: "fresh-window", description: "Reset context to a fresh notes-only window", immediate: true })
    const schemas = await run($, { op: "schemas" })
    if (!schemas.ok || !Array.isArray(schemas.result)) return next(e)
    for (const row of schemas.result as SchemaRow[]) {
      const full = await $.tool.register({ name: row.name, description: row.description, inputSchema: row.inputSchema, isDeferred: false } satisfies ToolSpec)
      registered.add(full.tool)
    }
    return next(e)
  })
  on("session.end", async ($, e, next) => {
    state.history = undefined
    forgetSession(state)
    return next(e)
  })
  on("tool.call", async ($, e, next) => {
    if (state.disabled) return next(e)
    if (!registered.has(e.tool)) return next(e)
    const identity = await refreshIdentity($, state)
    if (!identity) return errorResult("session changed during identity lookup")
    const { tool, tool_use_id: _toolUseId, agentId, ...params } = e
    const name = tool.slice(PREFIX.length)
    if (name.startsWith("history_") && agentId !== undefined) return errorResult("history is unavailable for subagents; main-session history is not their transcript")
    const result = await run($, { op: "tool", tool: name, params, identity, history: state.history })
    if (!result.ok) return errorResult(result.error)
    // The outcome already decided success or refusal; Claude requires isError: true on errors and no discriminator on success.
    const outcome = toolResultOf(result.result)
    if (!outcome) return errorResult("helper returned an invalid tool result")
    return outcome.ok ? { result: outcome.text } : { result: outcome.text, isError: true }
  })
  on("turn.start", async ($, e, next) => {
    // The documented turn.start is main-loop only. Guard tagged host events too:
    // only a main-agent turn.complete clears this latch.
    if (state.disabled) return next(e)
    if ("agentId" in e && e.agentId !== undefined) return next(e)
    if (!await refreshIdentity($, state)) return next(e)
    state.turnRunning = true
    return next(e)
  })
  on("turn.complete", async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    if (state.disabled) return result
    if (!await refreshIdentity($, state)) return result
    state.turnRunning = false
    await maybeReset($, state, true)
    return result
  })
  on("session.measure", async ($, e, next) => {
    const result = await next(e)
    if (!state.disabled && await refreshIdentity($, state)) await maybeReset($, state, false)
    return result
  })
  on("command.run", async ($, e, next) => {
    if (state.disabled) return next(e)
    if (e.command !== "empty" && e.command !== "fresh-window") return next(e)
    if (!await refreshIdentity($, state)) return { text: "🥣 Different brain now · try /fresh-window again" }
    if (state.headless) return { text: `🥣 ${HEADLESS}` }
    if (state.compactDisabled) return { text: `🥣 ${COMPACT_DISABLED}` }
    if (state.resetting || state.manualPending) return { text: "🥣 Brain already being emptied" }
    if (state.turnRunning) {
      state.manualPending = true
      return { text: "🥣 Brain being emptied" }
    }
    // command.run holds a turn even when idle. Start one hidden close-out
    // turn after it returns; turn.complete is the verified self-hook path.
    state.manualPending = true
    manualSignal.wake?.()
    return { text: "🥣 Brain being emptied" }
  })
  on("session.compact", async ($, e, next) => {
    // Disabled means fully transparent: native compaction runs exactly as if the mod were absent.
    if (state.disabled) return next(e)
    if (e.agentId !== undefined) return next(e)
    const identity = await refreshIdentity($, state)
    const generation = state.generation
    // Every pass-through keeps the current boot unless the engine's own summary replaced it.
    const passThrough = async () => {
      const result = await next(e)
      // Precompute installs nothing; a veto or subagent compact cannot remove our boot.
      if (generation === state.generation && e.trigger !== "precompute" && result.skip === undefined) {
        state.retainedBoot = result.messages.some((message) => message.text === state.retainedBoot) ? state.retainedBoot : undefined
        state.preparedBoot = undefined
      }
      return result
    }
    // Native compaction never runs the summarizer while notesoup is on: manual and
    // precompute are vetoed, an automatic compaction becomes the notes-only reset.
    if (e.trigger === "manual") return { skip: "No compacting brains here · use /fresh-window" }
    if (e.trigger === "precompute") return { skip: "No precomputing brains here" }
    const own = state.resetting && e.trigger === "plugin" && identity !== undefined
    if (!own && e.trigger !== "auto") return passThrough()
    if (identity === undefined) return passThrough()
    const built = await resetMessages($, state, identity)
    if ("skip" in built) {
      if (own) return { skip: built.skip }
      // An over-long prompt must still compact: fall back to the engine's summary.
      log($, `Notes didn't load (${built.skip}) · Claude compacted natively`)
      return passThrough()
    }
    if (own) {
      state.preparedBoot = built.boot
    } else {
      // The auto hijack keeps the books a successful plugin reset does.
      state.retainedBoot = built.boot
      state.preparedBoot = undefined
      state.window++
      log($, "Brain emptied")
    }
    return { messages: built.messages }
  })
  on("prompt.context", async ($, e, next) => {
    if (state.disabled) return next(e)
    const result = await next(e)
    const identity = await refreshIdentity($, state)
    const generation = state.generation
    // The reset already retained its boot as the sole conversation message.
    // Prompt context still recomputes, but must not inject a duplicate snapshot.
    const retained = state.retainedBoot !== undefined
    let blocks = retained ? result.blocks.filter((block) => block.name !== "notesoup:boot") : [...result.blocks]
    if (!retained && !blocks.some((block) => block.name === "notesoup:boot") && identity) {
      const texts = await loadTexts($, state)
      const boot = await buildBoot($, identity, state.window, texts, state.history)
      if (generation !== state.generation) return result
      if (!boot.ok) {
        try {
          await $.ui.toast("🥣 Notes went missing")
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
  const generation = state.generation
  const usage = await contextUsage($, state)
  if (generation !== state.generation || usage === undefined) return undefined
  const limits = await limitsOf($, state, usage)
  if (limits === undefined) return undefined
  const measured = measuredValue(limits, usage)
  if (measured === undefined || measured < limits.warn) return undefined
  const texts = await loadTexts($, state)
  if (generation !== state.generation || texts?.warning === undefined) return undefined
  state.warnedWindow = state.window
  return { name: "notesoup:warning", text: texts.warning }
}

/** The boot's identity line; `context_window` is the pre-rename tag still in old transcripts. */
const BOOT_IDENTITY = /<(?:notesoup:window_identity|context_window)>\nAgent name: claude /

/**
 * A retained boot carries the window ordinal in a trailing id line. Old and new tag spellings
 * both count: a transcript written before the rename must not lose its window numbering.
 */
function restoreWindow(state: ResetState, messages: readonly { role: string; text: string }[]) {
  if (!state.identity) return
  const prefix = `Current context window id: claude:${state.identity.sessionId}:`
  for (const message of messages) {
    if (message.role !== "user" || !BOOT_IDENTITY.test(message.text)) continue
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
    const generation = state.generation
    $.clock.after(0, () => finishManual($, state, signal, generation))
  })
}
async function finishManual($: Engine, state: ResetState, signal: { wake?: () => void }, generation: number) {
  try {
    if (generation !== state.generation) return
    if (state.manualPending && !state.turnRunning) {
      const texts = await loadTexts($, state)
      if (generation !== state.generation) return
      if (texts?.warning === undefined) {
        state.manualPending = false
        log($, "Brain still full: the close-out prompt didn't load")
        return
      }
      await $.prompt.submit({ text: texts.warning })
    }
  } catch {
    if (generation === state.generation) {
      state.manualPending = false
      log($, "Brain still full: the close-out turn didn't start")
    }
  } finally { armManual($, state, signal) }
}

// The sandbox permits $ forwarding only to file-top-level helpers.
async function maybeReset($: Engine, state: ResetState, complete: boolean) {
  if (!state.identity || state.resetting || state.headless || state.compactDisabled) return
  const generation = state.generation
  const usage = await contextUsage($, state)
  if (generation !== state.generation || state.turnRunning) return
  let due = complete && state.manualPending
  if (!due && usage !== undefined) {
    const limits = await limitsOf($, state, usage)
    const measured = limits === undefined ? undefined : measuredValue(limits, usage)
    // Missing measurements do not trigger a reset.
    if (limits !== undefined && measured !== undefined && measured >= limits.reset) due = true
  }
  if (due && generation === state.generation) {
    state.manualPending = false
    await reset($, state)
  }
}
async function reset($: Engine, state: ResetState): Promise<void> {
  if (!state.identity || state.headless || state.resetting) return
  const generation = state.generation
  state.resetting = true
  state.preparedBoot = undefined
  try {
    const result = await $.session.compact({ instructions: RESET_INSTRUCTIONS })
    if (generation !== state.generation) return
    if (result.skip !== undefined || state.preparedBoot === undefined) {
      log($, `Brain not emptied · ${result.skip ?? "notes boot was not retained"}`)
      return
    }
    state.retainedBoot = state.preparedBoot
    state.window++
    log($, "Brain emptied")
  } catch (error) {
    if (generation !== state.generation) return
    const text = String(error)
    if (text.includes("headless (-p / SDK)")) {
      state.headless = true
      log($, HEADLESS)
    } else if (/a turn is (running|in flight)/.test(text)) {
      state.manualPending = true
    } else {
      log($, `Brain still full: ${text.replace(/[\r\n].*$/s, "")}`)
    }
  } finally {
    if (generation === state.generation) {
      state.preparedBoot = undefined
      state.resetting = false
    }
  }
}
