import type { EngineInterface, On, ProcessRunResult, ToolCallResult, ToolSpec } from "claude-code"

const PREFIX = "mcp__notesoup__"
const TOOL_NAMES = ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"] as const
// @ts-expect-error Claude's hook sandbox supplies import.meta.dir; Node's typings do not.
const HELPER = `${import.meta.dir}/../dist/claude/helper.js`
const TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 1024 * 1024

type Identity = { home: string; sessionId: string; cwd: string; agent: string; model: string }
type SchemaRow = { name: string; description: string; inputSchema: Record<string, unknown> }
type Engine = Pick<EngineInterface, "process" | "session" | "ui" | "clock" | "prompt">
type ResetState = {
  identity?: Identity; window: number; turnRunning: boolean; resetting: boolean
  manualPending: boolean; headless: boolean; usageFailureLogged: boolean; preparedBoot?: string; retainedBoot?: string
}
const HEADLESS = "Clear-memory is off in headless (-p / SDK) sessions"
const RESET_INSTRUCTIONS = "notesoup: reset to a fresh notes-only context window."
const BOOT_TOOLS = {
  notes: `${PREFIX}notes_*`, notesList: `${PREFIX}notes_list`,
  history: "history_* (unavailable in Claude)",
  remaining: "get_context_remaining (unavailable in Claude)", wipe: "/clear-memory (user command; no model reset tool in Claude)",
}

async function buildBoot($: Engine, identity: Identity, window: number) {
  return run($, { op: "boot", identity, window, tools: BOOT_TOOLS }, identity.cwd)
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
  const state: ResetState = { window: 0, turnRunning: false, resetting: false, manualPending: false, headless: false, usageFailureLogged: false }
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
    // The engine's history view includes retained boots on resume/reload.
    // Recover their ordinal without treating that view as inference context.
    try { restoreWindow(state, await $.session.messages()) } catch { /* A fresh session starts at zero. */ }
    registered.clear()
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
    const boot = await buildBoot($, identity, state.window + 1)
    if (!boot.ok) return { skip: `notes didn't load: ${boot.error}` }
    state.preparedBoot = String(boot.result)
    return { messages: [{ role: "user", text: state.preparedBoot, toolUses: [] }] }
  })
  on("prompt.context", async ($, e, next) => {
    const result = await next(e)
    // The reset already retained its boot as the sole conversation message.
    // Prompt context still recomputes, but must not inject a duplicate snapshot.
    if (state.retainedBoot !== undefined) return { ...result, blocks: result.blocks.filter((block) => block.name !== "notesoup:boot") }
    if (result.blocks.some((block) => block.name === "notesoup:boot")) return result
    if (!identity) return result
    const boot = await buildBoot($, identity, state.window)
    if (!boot.ok) {
      try {
        await $.ui.notify("🥣 Notes didn't load")
      } catch { /* Notification failure must not suppress the fallback block. */ }
    }
    const block = { name: "notesoup:boot", text: boot.ok ? String(boot.result) : `# notesoup\n${boot.error}` }
    return { ...result, blocks: [...result.blocks, block] }
  })

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
      await $.prompt.submit({ text: "A context reset was requested. Save any essential checkpoint to session notes now, then end this turn. notesoup will reset to a fresh notes-only window after the turn completes." })
    }
  } catch {
    state.manualPending = false
    log($, "Couldn't clear memory: the close-out turn didn't start")
  } finally { armManual($, state, signal) }
}

// The sandbox permits $ forwarding only to file-top-level helpers.
async function maybeReset($: Engine, state: ResetState, complete: boolean) {
  if (!state.identity || state.resetting || state.headless) return
  let percent: number | undefined
  try { percent = (await $.session.usage()).context?.percent }
  catch {
    if (!state.usageFailureLogged) {
      state.usageFailureLogged = true
      log($, "Context usage unavailable · automatic clear-memory skipped")
    }
  }
  if (state.turnRunning) return
  if ((complete && state.manualPending) || (typeof percent === "number" && Number.isFinite(percent) && percent >= 85)) {
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
