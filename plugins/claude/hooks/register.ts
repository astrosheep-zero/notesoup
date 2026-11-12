import type { EngineInterface, On, ProcessRunResult, ToolCallInput, ToolCallResult, ToolSpec } from "claude-code"

const PREFIX = "mcp__notesoup__"
const HELPER = `${import.meta.dir}/../dist/claude/helper.js`
const TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 1024 * 1024

type Identity = { home: string; sessionId: string; cwd: string; agent: string; model: string }
type SchemaRow = { name: string; description: string; inputSchema: Record<string, unknown> }
type HistorySource = { sessionId: string; transcriptPath: string; headUuid?: string }
type Engine = Pick<EngineInterface, "process" | "session" | "ui" | "prompt" | "env" | "settings" | "command">
/** The measured context, as much of it as the engine reported. */
type ContextUsage = { tokens?: number; window?: number; percent?: number }
/** Shared reset prose, fetched once per session so Pi and Claude cannot drift apart. */
type SharedTexts = { warning?: string; historyUnavailableSentence?: string }
type ClaudeLimits = {
  source: string; autoCompact: boolean; unit: "tokens" | "percent"
  native: number; reset: number; warn: number; resetMargin: number; warningRunway: number
}
type ResetRequest = { tool?: { lastWord?: string }; resume: boolean }
/** Request: until consumed/cancelled. Cutoff: one turn, even after auto consumes the request.
 * Commit lives separately in ResetState: one native command attempt, proved by kept rows. */
class ResetFlow {
  request?: ResetRequest
  cutoffTurnId?: string
  turnId?: string
  pendingInputTurnId?: string
  running = false

  requestReset(tool?: { lastWord?: string; terminate: boolean }): boolean {
    const first = tool ? this.request?.tool === undefined : this.request === undefined
    const request = this.request ??= { resume: true }
    if (tool) {
      if (first) {
        request.tool = { lastWord: tool.lastWord }
        request.resume &&= !tool.terminate
      }
      this.cutoffTurnId = this.turnId
    } else request.resume = false
    return first
  }
  requestAutomatic() {
    this.request ??= { resume: true }
    this.cutoffTurnId = this.turnId
  }
  input(turnId?: string) {
    if (turnId !== undefined) this.pendingInputTurnId = turnId
    if (this.request) this.request.resume = false
  }
  start(turnId: string) {
    if (this.request) this.request.resume = false
    this.turnId = turnId
    this.running = true
  }
  cutoff(turnId: string): boolean {
    // Input may predate the tool latch. Release the whole workflow, not just one request.
    if (this.pendingInputTurnId !== undefined && this.pendingInputTurnId === turnId) {
      this.pendingInputTurnId = undefined
      this.cutoffTurnId = undefined
      if (this.request) this.request.resume = false
      return false
    }
    return turnId === this.cutoffTurnId
  }
  complete(reason: string): boolean {
    this.running = false
    const cancelled = reason !== "answer" && this.request !== undefined
    if (cancelled || !this.request) this.cancel()
    return cancelled
  }
  get ready(): boolean {
    return !!this.request && !this.running && !(this.pendingInputTurnId !== undefined && this.pendingInputTurnId === this.turnId)
  }
  consume(auto = false): boolean {
    const request = this.request
    // Another auto reset must not disarm an already consumed request's cutoff.
    if (auto && !request) return false
    this.cutoffTurnId = auto && request && !request.resume ? this.cutoffTurnId ?? (!request.tool ? this.turnId : undefined) : undefined
    this.request = undefined
    return request?.resume ?? false
  }
  cancel() {
    this.request = undefined
    this.cutoffTurnId = undefined
  }
}
type ResetState = {
  identity?: Identity; history?: HistorySource; historyWindowHead?: string; generation: number; window: number; disabled: boolean; flow: ResetFlow
  headless: boolean; usageFailureLogged: boolean; commit?: { instructions: string; boot?: string; boundary: boolean; resolve: (kept: boolean) => void }; retainedBoot?: string
  continuation?: { window: number; text: string }
  compactDisabled: boolean; limitsFailureLogged: boolean; limitsAttempts: number; limitsKey?: string
  capTokens?: number; limits?: ClaudeLimits; warnedWindow?: number; warningPending?: number; texts?: SharedTexts; settingsFailureLogged: boolean
}
type ResetWork = { kind: "closeout" | "reset"; generation: number }
type ResetSignal = { wake?: (work: ResetWork) => void }
const COMPACT_DISABLED = "Brain can't be emptied with DISABLE_COMPACT"
const NOTESOUP_DISABLED = "Notesoup is off with NOTESOUP_DISABLED"
const THRESHOLDS_UNAVAILABLE = "Brain size unknown · no budget warning"
const SETTINGS_UNAVAILABLE = "Notesoup settings unreadable · using the default flush margins"
/** Bounded retries: a transient helper failure must not disable thresholds for a whole window. */
const MAX_LIMITS_ATTEMPTS = 3
const RESET_INSTRUCTIONS = "notesoup: reset to a fresh notes-only context window."
const BOOT_TOOLS = {
  notes: `${PREFIX}notes_*`, notesList: `${PREFIX}notes_list`,
  history: "history_* (unavailable: no main transcript_path)",
  remaining: "get_context_remaining (unavailable in Claude)", wipe: `${PREFIX}empty_brain`,
}

/** Bind the shared protocol to the registered Claude tools. */
async function buildBoot($: Engine, identity: Identity, window: number, texts?: SharedTexts, history?: HistorySource) {
  const available = history?.sessionId === identity.sessionId
  const tools = { ...BOOT_TOOLS, ...(available ? { history: `${PREFIX}history_*` } : { historySentence: texts?.historyUnavailableSentence }) }
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
    ...(state.flow.request?.tool?.lastWord ? [{ role: "user" as const, text: `*You peel a sticky note off your forehead.*\n${state.flow.request.tool.lastWord}`, toolUses: [] as [] }] : []),
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
/** Presence-style env switch; the same convention as DISABLE_COMPACT. The loader requires literal env names. */
function envFlag(value: string | undefined): boolean {
  const text = value?.trim().toLowerCase() ?? ""
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
      log($, "Brain fullness unknown · no budget warning")
    }
    return undefined
  }
}
async function breakdownContext($: Engine): Promise<Record<string, unknown> | undefined> {
  try {
    const breakdown = (await $.session.usage({ breakdown: "summary" })).context.breakdown
    return typeof breakdown === "object" && breakdown !== null ? breakdown as unknown as Record<string, unknown> : undefined
  } catch { return undefined }
}
/** Threshold inputs only: changing fill must not invalidate the resolved points. */
async function limitFacts($: Engine, state: ResetState, usage: ContextUsage): Promise<Record<string, unknown>> {
  const capTokens = state.capTokens
  const breakdown = await breakdownContext($)
  return {
    capTokens,
    usage: { window: usage.window },
    breakdown: { model: breakdown?.model, autoCompactThreshold: breakdown?.autoCompactThreshold, isAutoCompactEnabled: breakdown?.isAutoCompactEnabled },
    settings: await readSettings($, state),
    env: {
      pctOverride: await envPctOverride($),
      autoCompactWindow: await envAutoCompactWindow($),
      disableAutoCompact: await envDisableAutoCompact($),
    },
  }
}
/** Reuse points only while their inputs match; bound retries per configuration, not capacity. */
async function limitsOf($: Engine, state: ResetState, usage: ContextUsage): Promise<ClaudeLimits | undefined> {
  const generation = state.generation
  const facts = await limitFacts($, state, usage)
  if (generation !== state.generation) return undefined
  const key = JSON.stringify([state.identity?.model, facts])
  const sameFacts = state.limitsKey === key
  if (sameFacts && state.limits !== undefined) return state.limits
  if (sameFacts && state.limitsAttempts >= MAX_LIMITS_ATTEMPTS) return undefined
  const response = await run($, { op: "limits", facts })
  if (generation !== state.generation) return undefined
  const limits = response.ok ? limitsShape(response.result) : undefined
  state.limitsKey = key
  state.limits = limits
  state.limitsAttempts = limits ? 0 : sameFacts ? state.limitsAttempts + 1 : 1
  if (!limits && !state.limitsFailureLogged) {
    state.limitsFailureLogged = true
    log($, THRESHOLDS_UNAVAILABLE)
  }
  return limits
}
/** The measured value the points are expressed in; tokens win, percent × window stands in. */
function measuredValue(limits: ClaudeLimits, usage: ContextUsage): number | undefined {
  if (limits.unit === "percent") return usage.percent
  if (usage.tokens !== undefined) return usage.tokens
  return usage.percent !== undefined && usage.window !== undefined && usage.window > 0 ? (usage.percent / 100) * usage.window : undefined
}
/** The warning and hard clear share one policy; only a safe main-loop boundary acts on it. */
async function hardResetDue($: Engine, state: ResetState): Promise<boolean> {
  if (state.disabled || state.compactDisabled || !state.identity || state.commit) return false
  const generation = state.generation, window = state.window, cap = state.capTokens
  const usage = await contextUsage($, state)
  if (generation !== state.generation || usage === undefined) return false
  const limits = await limitsOf($, state, usage)
  if (generation !== state.generation || window !== state.window || cap !== state.capTokens || !limits?.autoCompact) return false
  const measured = measuredValue(limits, usage)
  return measured !== undefined && measured >= limits.reset
}

/** Runtime-only capacity; never writes Claude's settings or its process environment. */
async function capCommand($: Engine, state: ResetState, args: string): Promise<{ text: string }> {
  if (!await refreshIdentity($, state)) return { text: "🥣 Different brain now · try /notesoup again" }
  const parts = args.trim().toLowerCase().split(/\s+/)
  if (parts[0] !== "" && (parts[0] !== "cap" || parts.length > 2)) return { text: "Usage: /notesoup cap [100k|1m|tokens|off]" }
  if (parts.length === 2) {
    const generation = state.generation
    const usage = await contextUsage($, state) ?? {}
    const facts = await limitFacts($, state, usage)
    const result = await run($, { op: "cap", value: parts[1], facts })
    if (generation !== state.generation) return { text: "🥣 Different brain now · try /notesoup again" }
    if (!result.ok) return { text: result.error }
    const cap = typeof result.result === "object" && result.result !== null ? (result.result as { cap?: unknown }).cap : undefined
    if (cap !== null && (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0)) return { text: "🥣 Invalid cap from helper" }
    state.capTokens = cap ?? undefined
  }
  return { text: `🥣 notesoup · cap ${state.capTokens === undefined ? "off" : state.capTokens.toLocaleString("en-US")} · current session only` }
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
/** One draw per reset artifact, reused on retry; only a real tool request is voluntary. */
async function continuationFor($: Engine, state: ResetState): Promise<string | undefined> {
  if (state.continuation?.window === state.window) return state.continuation.text
  const generation = state.generation
  const response = await run($, { op: "continuation", origin: state.flow.request?.tool ? "normal" : "forced" })
  if (generation !== state.generation) return undefined
  const result = response.ok ? response.result : undefined
  const text = typeof result === "object" && result !== null ? (result as { text?: unknown }).text : undefined
  if (typeof text !== "string" || text.length === 0) return undefined
  state.continuation = { window: state.window, text }
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
  state.flow = new ResetFlow()
  state.usageFailureLogged = false
  state.commit?.resolve(false)
  state.commit = undefined
  state.retainedBoot = undefined
  state.capTokens = undefined
  state.texts = state.limits = undefined
  state.continuation = undefined
  state.limitsAttempts = 0
  state.limitsKey = undefined
  state.settingsFailureLogged = state.limitsFailureLogged = false
  state.warnedWindow = state.warningPending = undefined
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
    return generation === state.generation ? state.identity : undefined
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
  if (!state.identity || !state.history?.headUuid || state.history.sessionId !== state.identity.sessionId || state.commit || state.historyWindowHead === state.history.headUuid) return
  const generation = state.generation, head = state.history.headUuid
  const response = await run($, { op: "history_state", identity: state.identity, history: state.history })
  if (generation !== state.generation || state.history?.headUuid !== head || !response.ok || typeof response.result !== "object" || response.result === null) return
  const window = (response.result as { window?: unknown }).window
  if (typeof window !== "number" || !Number.isSafeInteger(window) || window < 0) return
  state.historyWindowHead = head
  if (state.window !== window) { state.window = window; state.retainedBoot = undefined }
}

export function register(on: On) {
  const resetSignal: ResetSignal = {}
  const state: ResetState = { generation: 0, window: 0, disabled: false, flow: new ResetFlow(), headless: false, usageFailureLogged: false, compactDisabled: false, limitsFailureLogged: false, limitsAttempts: 0, settingsFailureLogged: false }
  const registered = new Set<string>()
  let keepMemory = false
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
    const generation = state.generation, commit = state.commit
    const sessionId = await $.session.id(), source = state.history
    const result = await next(e)
    if (e.agentId === undefined && result.uuid !== undefined && generation === state.generation) {
      if (state.history === source && source?.sessionId === sessionId) {
        source.headUuid = result.uuid
        state.historyWindowHead = undefined
      }
      // A native command resolves before its compaction rows finish appending;
      // session.messages() still exposes the last request's snapshot. Observe
      // the host's kept boundary and first plugin row, including rewrites.
      if (commit && commit === state.commit && state.identity?.sessionId === sessionId) {
        if (e.door === "compaction" && result.message.name === "compact_boundary") commit.boundary = true
        if (e.origin.kind === "plugin" && "name" in e.origin && e.origin.name === "notesoup") {
          if (commit.boundary && e.door === "prompt") {
            const blocks = result.message.content
            commit.resolve(result.message.type === "user" && blocks.length === 1 && blocks[0]?.type === "text" && blocks[0].text === commit.boot)
          } else if (e.door === "command") commit.resolve(false)
        }
      }
    }
    return result
  })
  on("session.start", async ($, e, next) => {
    forgetSession(state)
    state.disabled = envFlag(await $.env.get("NOTESOUP_DISABLED").catch(() => undefined))
    if (state.disabled) {
      registered.clear()
      log($, NOTESOUP_DISABLED)
      return next(e)
    }
    keepMemory = envFlag(await $.env.get("NOTESOUP_KEEP_MEMORY").catch(() => undefined))
    await refreshIdentity($, state)
    state.headless = !e.isInteractive
    // Compaction is the capability explicit resets and budget warnings depend on.
    state.compactDisabled = envFlag(await $.env.get("DISABLE_COMPACT").catch(() => undefined))
    if (state.compactDisabled) log($, COMPACT_DISABLED)
    registered.clear()
    await loadTexts($, state)
    armReset($, state, resetSignal)
    await $.command.register({ name: "notesoup", description: "Show or cap the notesoup context capacity: cap [100k|1m|tokens|off]", immediate: true })
    await $.command.register({ name: "empty", description: "Reset context to a fresh notes-only window", immediate: true })
    await $.command.register({ name: "fresh-window", description: "Reset context to a fresh notes-only window", immediate: true })
    const wipe = await $.tool.register({
      name: "empty_brain",
      description: "Clear your in-context memory and start a fresh context window. Your session, notes, and history survive. Pass `last_word` to stick a tiny note on your forehead for after the wipe.",
      inputSchema: { type: "object", properties: { last_word: { type: "string", description: "A tiny sticky note, at most 300 characters. After the wipe it is slapped on your forehead; longer notes are refused." }, terminate: { type: "boolean", description: "Stop after the wipe. Default: false.", default: false } }, additionalProperties: false },
      isDeferred: false,
    } satisfies ToolSpec)
    registered.add(wipe.tool)
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
    const generation = state.generation
    const result = registered.has(e.tool) ? await callNotesTool($, state, e) : await next(e)
    if (e.agentId !== undefined || result.deny !== undefined || generation !== state.generation) return result
    return withWarning($, state, (warning) => warning === undefined ? result : { ...result, context: [...(result.context ?? []), warning] })
  })
  on("prompt.submit", async ($, e, next) => {
    const generation = state.generation
    const result = await withWarning($, state, (warning) =>
      next(warning === undefined ? e : { ...e, context: [...(e.context ?? []), warning] }))
    // Our own submissions skip this hook; accepted input owns the continuation.
    if (generation === state.generation && result.drop === undefined) state.flow.input(e.turnId)
    return result
  })
  on("turn.start", async ($, e, next) => {
    // The documented turn.start is main-loop only. Guard tagged host events too:
    // only a main-agent turn.complete clears this latch.
    if (state.disabled) return next(e)
    if ("agentId" in e && e.agentId !== undefined) return next(e)
    if (!await refreshIdentity($, state)) return next(e)
    state.flow.start(e.turnId)
    return next(e)
  })
  on("turn.step", async function* ($, e, next) {
    if (state.disabled || e.agentId !== undefined) return yield* next(e)
    // Like the warning, the hard point consumes the same resolved limits. This boundary
    // follows the whole previous tool batch; no sibling tool or in-flight request is aborted.
    if (await hardResetDue($, state)) state.flow.requestAutomatic()
    if (!state.flow.cutoff(e.turnId)) return yield* next(e)
    // This boundary follows the entire tool batch. A synthetic streamed stop
    // ends the main turn without aborting siblings or making an old-window request.
    yield { kind: "stop", stopReason: "end_turn", usage: null }
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: null }
  })
  on("turn.complete", async ($, e, next) => {
    const generation = state.generation
    const result = await next(e)
    if (e.agentId !== undefined || generation !== state.generation) return result
    const cancelled = state.flow.complete(e.reason)
    if (state.disabled) return result
    // A failed turn proves nothing about whether its notes were saved.
    if (cancelled) log($, `Brain emptying cancelled · turn ended ${e.reason}; ask /fresh-window again`)
    if (!await refreshIdentity($, state)) return result
    if (e.reason === "answer") {
      if (!state.flow.request && await hardResetDue($, state)) state.flow.requestAutomatic()
      if (state.flow.request) resetSignal.wake?.({ kind: "reset", generation: state.generation })
    }
    return result
  })
  on("command.run", async ($, e, next) => {
    if (state.disabled) return next(e)
    if (e.command === "notesoup") return capCommand($, state, e.args)
    if (e.command !== "empty" && e.command !== "fresh-window") return next(e)
    if (!await refreshIdentity($, state)) return { text: "🥣 Different brain now · try /fresh-window again" }
    if (state.compactDisabled) return { text: `🥣 ${COMPACT_DISABLED}` }
    const first = state.flow.requestReset()
    if (state.commit || !first) return { text: "🥣 Brain already being emptied" }
    // command.run holds a turn even when idle; close out from the non-held waiter.
    if (!state.flow.running) resetSignal.wake?.({ kind: "closeout", generation: state.generation })
    return { text: "🥣 Dumping Brain" }
  })
  on("session.compact", async ($, e, next) => {
    // Disabled means fully transparent: native compaction runs exactly as if the mod were absent.
    if (state.disabled) return next(e)
    if (e.agentId !== undefined) return next(e)
    const generation = state.generation
    const identity = await refreshIdentity($, state)
    // Every pass-through keeps the current boot unless the engine's own summary replaced it.
    const passThrough = async () => {
      const result = await next(e)
      // Precompute installs nothing; a veto or subagent compact cannot remove our boot.
      if (generation === state.generation && e.trigger !== "precompute" && result.skip === undefined) {
        state.retainedBoot = result.messages.some((message) => message.text === state.retainedBoot) ? state.retainedBoot : undefined
        if (state.commit) state.commit.boot = undefined
      }
      return result
    }
    // Native compaction never runs the summarizer while notesoup is on: user
    // manual and precompute are vetoed; auto becomes the notes-only reset.
    const own = state.commit !== undefined && identity !== undefined && e.trigger === "manual" && e.instructions === state.commit.instructions
    if (e.trigger === "manual" && !own) return { skip: "No compacting brains here · use /fresh-window" }
    if (e.trigger === "precompute") return { skip: "No precomputing brains here" }
    if (!own && e.trigger !== "auto") return passThrough()
    if (identity === undefined) return passThrough()
    const built = await resetMessages($, state, identity)
    if ("skip" in built) {
      if (own) return { skip: built.skip }
      // An over-long prompt must still compact: fall back to the engine's summary.
      log($, `Notes didn't load (${built.skip}) · Claude compacted natively`)
      return passThrough()
    }
    if (state.commit) state.commit.boot = own ? built.boot : undefined
    if (!own) retainReset($, state, built.boot, true)
    return { messages: built.messages }
  })
  // notesoup replaces Claude's summarization and auto-memory guidance; memory can be kept on request.
  on("prompt.section", { name: "context_management" }, ($, e, next) => state.disabled ? next(e) : { text: null })
  on("prompt.section", { name: "memory" }, ($, e, next) => state.disabled || keepMemory ? next(e) : { text: null })
  on("prompt.context", async ($, e, next) => {
    if (state.disabled) return next(e)
    const result = await next(e)
    const identity = await refreshIdentity($, state)
    const generation = state.generation
    // The reset already retained its boot as the sole conversation message.
    // Prompt context still recomputes, but must not inject a duplicate snapshot.
    const retained = state.retainedBoot !== undefined
    let blocks = result.blocks.filter((block) => {
      if (block.name !== "notesoup:boot" || !identity) return true
      const marker = bootWindow(block.text)
      return !retained && (!marker || (marker.sessionId === identity.sessionId && marker.window === state.window))
    })
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
    return { ...result, blocks }
  })

}

async function callNotesTool($: Engine, state: ResetState, e: ToolCallInput): Promise<ToolCallResult> {
  const identity = await refreshIdentity($, state)
  if (!identity) return errorResult("session changed during identity lookup")
  const { tool, tool_use_id: _toolUseId, agentId, ...params } = e
  const name = tool.slice(PREFIX.length)
  if (name === "empty_brain") {
    if (agentId !== undefined) return errorResult("only the main agent can empty this brain")
    if (state.compactDisabled) return errorResult(COMPACT_DISABLED)
    if (params.last_word !== undefined && typeof params.last_word !== "string") return errorResult("last_word must be a string")
    if (params.terminate !== undefined && typeof params.terminate !== "boolean") return errorResult("terminate must be a boolean")
    const lastWord = typeof params.last_word === "string" ? params.last_word.trim() || undefined : undefined
    const length = lastWord ? Array.from(lastWord).length : 0
    if (length > 500) return errorResult(`last_word is ${length} characters; the sticky note holds 500. Shorten it and call again.`)
    if (state.flow.requestReset({ lastWord, terminate: params.terminate === true })) state.continuation = undefined
    return { result: `Brain reset requested. This tool batch will finish, then the turn stops before its next model request unless it has new user input to handle. Your notes and sticky note survive the reset.${state.flow.request!.resume ? " You will continue in a fresh window after the reset." : " No automatic continuation will be submitted."}` }
  }
  if (name.startsWith("history_") && agentId !== undefined) return errorResult("history is unavailable for subagents; main-session history is not their transcript")
  const result = await run($, { op: "tool", tool: name, params, identity, history: state.history })
  if (!result.ok) return errorResult(result.error)
  const outcome = toolResultOf(result.result)
  if (!outcome) return errorResult("helper returned an invalid tool result")
  return outcome.ok ? { result: outcome.text } : { result: outcome.text, isError: true }
}

/** Read the warning without consuming this window's delivery. */
async function warningText($: Engine, state: ResetState): Promise<string | undefined> {
  if (state.disabled || state.compactDisabled || !state.identity || state.warnedWindow === state.window || state.warningPending === state.window) return undefined
  const generation = state.generation
  const usage = await contextUsage($, state)
  if (generation !== state.generation || usage === undefined) return undefined
  const limits = await limitsOf($, state, usage)
  if (limits === undefined) return undefined
  const measured = measuredValue(limits, usage)
  if (measured === undefined || measured < limits.warn) return undefined
  const texts = await loadTexts($, state)
  return generation === state.generation ? texts?.warning : undefined
}

/** Reserve across next(), but consume only context the chain actually accepted. */
async function withWarning<T extends { context?: readonly string[]; drop?: string; deny?: string }>($: Engine, state: ResetState, deliver: (warning?: string) => T | Promise<T>): Promise<T> {
  if (state.disabled || state.compactDisabled || !await refreshIdentity($, state)) return deliver()
  const generation = state.generation, window = state.window
  const warning = await warningText($, state)
  if (warning === undefined || generation !== state.generation || window !== state.window || state.warnedWindow === window || state.warningPending === window) return deliver()
  state.warningPending = window
  try {
    const result = await deliver(warning)
    if (generation === state.generation && window === state.window && result.drop === undefined && result.deny === undefined && result.context?.includes(warning)) state.warnedWindow = window
    return result
  } finally {
    if (generation === state.generation && state.warningPending === window) state.warningPending = undefined
  }
}

/** The boot's identity line; `context_window` is the pre-rename tag still in old transcripts. */
const BOOT_IDENTITY = /<(?:notesoup:window_identity|context_window)>\nAgent name: claude /

/** Old and new tag spellings, including a boot copied into a fork. */
function bootWindow(text: string): { sessionId: string; window: number } | undefined {
  if (!BOOT_IDENTITY.test(text)) return undefined
  const marker = /^Current context window id: claude:([^\n]+):(\d+)$/m.exec(text)
  if (!marker) return undefined
  const window = Number(marker[2])
  return Number.isSafeInteger(window) ? { sessionId: marker[1]!, window } : undefined
}
/** Keep the copied boot ordinal, but rebuild its snapshot and identity for the new session. */
function restoreWindow(state: ResetState, messages: readonly { role: string; text: string }[]) {
  if (!state.identity) return
  for (const message of messages) {
    if (message.role !== "user") continue
    const marker = bootWindow(message.text)
    if (!marker || marker.window <= state.window) continue
    state.window = marker.window
    state.retainedBoot = marker.sessionId === state.identity.sessionId ? message.text : undefined
  }
}

// Create and re-arm this waiter in session.start's non-held context. Timers
// created in a held hook inherit that dispatch even after the hook returns.
function armReset($: Engine, state: ResetState, signal: ResetSignal) {
  let wake!: (work: ResetWork) => void
  const requested = new Promise<ResetWork>((resolve) => { signal.wake = wake = resolve })
  void requested.then((work) => {
    if (signal.wake !== wake) return
    // A close-out submission resolves when its turn starts, so arm the next
    // waiter before submitting: that turn's completion must not lose its wake.
    armReset($, state, signal)
    return runResetWork($, state, work)
  })
}
async function runResetWork($: Engine, state: ResetState, work: ResetWork) {
  const { generation, kind } = work
  if (generation !== state.generation || !state.flow.ready) return
  try {
    let text: string
    if (kind === "reset") {
      const turnId = state.flow.turnId
      if (!await reset($, state) || generation !== state.generation || turnId !== state.flow.turnId || state.flow.request?.resume === false) return
      // The retained handoff is already present; this prompt only starts the next turn.
      text = "Continue from your notes in this fresh context window."
    } else {
      const texts = await loadTexts($, state)
      if (generation !== state.generation) return
      if (texts?.warning === undefined) {
        state.flow.cancel()
        log($, "Brain still full: the close-out prompt didn't load")
        return
      }
      text = texts.warning
    }
    const result = await $.prompt.submit({ text })
    if (result.drop !== undefined) throw result.drop
  } catch (error) {
    if (generation !== state.generation) return
    if (kind === "closeout") state.flow.cancel()
    log($, kind === "closeout" ? "Brain still full: the close-out turn didn't start" : `Brain emptied, but continuation didn't start · ${describeFailure(error)}`)
  }
}

function retainReset($: Engine, state: ResetState, boot: string, auto = false): boolean {
  state.retainedBoot = boot
  state.window++
  const resume = state.flow.consume(auto)
  log($, "Brain emptied")
  return resume
}

// The sandbox permits $ forwarding only to file-top-level helpers.
async function reset($: Engine, state: ResetState): Promise<boolean> {
  if (!state.identity || state.compactDisabled || state.commit) return false
  const generation = state.generation
  let resolveCommit!: (kept: boolean) => void
  const committed = new Promise<boolean>((resolve) => { resolveCommit = resolve })
  const commit = state.commit = { instructions: `${RESET_INSTRUCTIONS} ${crypto.randomUUID()}`, boot: undefined as string | undefined, boundary: false, resolve: resolveCommit }
  try {
    // Both modes need the native command; direct compact skips our hook or is unavailable.
    const receipt = await $.command.run({ command: "compact", args: commit.instructions })
    if (generation !== state.generation) return false
    let failure = commit.boot === undefined ? receipt.text ?? "notes boot was not retained" : undefined
    if (failure === undefined) {
      // Interactive command completion exposes the newly installed rows here;
      // headless completion still sees the old request and appends afterwards.
      const messages = await $.session.messages()
      if (generation !== state.generation) return false
      if (messages.some((message) => message.role === "user" && message.text === commit.boot)) commit.resolve(true)
      else if (!state.headless) commit.resolve(false)
      if (!await committed) failure = "notes boot was not committed"
    }
    if (generation !== state.generation) return false
    if (failure !== undefined || commit.boot === undefined) {
      log($, `Brain not emptied · ${failure ?? "notes boot was not retained"}`)
      return false
    }
    return retainReset($, state, commit.boot)
  } catch (error) {
    if (generation !== state.generation) return false
    const text = String(error)
    if (!/a turn is (running|in flight)/.test(text)) {
      log($, `Brain still full: ${text.replace(/[\r\n].*$/s, "")}`)
    }
    return false
  } finally {
    commit.resolve(false)
    if (state.commit === commit) state.commit = undefined
  }
}
