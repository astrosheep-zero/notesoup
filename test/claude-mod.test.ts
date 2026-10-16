import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { dispatch, handleLine, type ClaudeToolResult } from "../plugins/claude/src/helper.js";
import { DEFAULT_CLAUDE_RESET_MARGIN_TOKENS, resolveClaudeLimits } from "../plugins/claude/src/thresholds.js";
import { WARNING_RUNWAY_TOKENS } from "../src/budget/constants.js";
import { PROTOCOL_WIPE_SENTENCE, renderProtocolBlock } from "../src/boot/text.js";
import { CLAUDE_WARNING_PROMPT, CLAUDE_WIPE_SENTENCE } from "../plugins/claude/src/text.js";
import { COUNTDOWN_LINE, FORCED_CONTINUATIONS } from "../src/budget/text.js";
import { createNotesStore } from "../src/notes/index.js";
import { resolveProjectHome } from "../src/notes/project-home.js";
import { notesIdentityFromPi } from "../plugins/pi/notes/adapter.js";
import { context, manager } from "./helpers/extension.js";

const identity = { home: mkdtempSync(join(tmpdir(), "claude-mod-")), sessionId: "session", cwd: process.cwd(), agent: "claude", model: "claude" };

type HookToolSpec = { name: string; description: string; inputSchema: Record<string, unknown>; isDeferred?: boolean };

/** One engine handler: it receives the engine, the event, and the rest of the chain. */
type HookHandler = ($: HookEngine, e: Record<string, unknown>, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
/** One measured context plus the undocumented breakdown fields the mod reads. */
type HookUsageContext = {
  tokens?: number; window?: number; percent?: number;
  autoCompactThreshold?: number; isAutoCompactEnabled?: boolean; model?: string;
};
/** The engine surface the hook actually touches; no live model or user configuration. */
type HookEngine = {
  env: { get: (name: string) => Promise<string | undefined> };
  session: {
    id: () => Promise<string>;
    cwd: () => Promise<string>;
    model: () => Promise<string>;
    messages: () => Promise<Array<{ role: string; text: string }>>;
    usage: (options?: { breakdown?: "summary" | "full" }) => Promise<{ context: HookUsageContext }>;
    compact: (options: { instructions: string }) => Promise<{ skip?: string; messages?: Array<{ role: string; text: string }> }>;
  };
  settings: { read: () => Promise<unknown> };
  command: { register: (spec: { name: string; description: string; immediate?: boolean }) => Promise<unknown> };
  clock: { after: (ms: number, callback: () => void | Promise<void>) => unknown };
  prompt: { submit: (input: { text: string }) => Promise<unknown> };
  tool: { register: (spec: HookToolSpec) => Promise<{ tool: string }> };
  ui?: { toast?: (text: string, options?: { title?: string }) => Promise<unknown>; log?: (text: string) => void };
  process: { run: (argv: readonly string[], init?: { cwd?: string; stdin?: string }) => Promise<{ exitCode: number; stdout: string }> };
};

async function callTool(tool: string, params: Record<string, unknown>): Promise<ClaudeToolResult> {
  return await dispatch({ op: "tool", tool, identity, params }) as ClaudeToolResult;
}

/**
 * Load the hooks module the way the engine loads it: its own directory decides where the helper is,
 * which `import.meta.dir` expresses at run time. Node has no such global, so the transpiled copy
 * gets the real one; nothing else about the module is changed.
 */
async function loadHookModule(t: test.TestContext): Promise<{ register: (on: (event: string, handler: HookHandler) => void) => void }> {
  const hooksDir = join(process.cwd(), "plugins/claude/hooks");
  const transpiled = await build({
    stdin: { contents: readFileSync(join(hooksDir, "register.ts"), "utf8"), loader: "ts", resolveDir: hooksDir, sourcefile: "register.ts" },
    bundle: false, format: "esm", platform: "node", target: "node22", write: false,
    banner: { js: `import.meta.dir = ${JSON.stringify(hooksDir)};` },
  });
  const loaded = mkdtempSync(join(tmpdir(), "claude-hook-module-"));
  t.after(() => rmSync(loaded, { recursive: true, force: true }));
  const module = join(loaded, "register.mjs");
  writeFileSync(module, transpiled.outputFiles[0]!.text);
  const hooks = await import(pathToFileURL(module).href) as { register: (on: (event: string, matcherOrHandler: Record<string, unknown> | HookHandler, handler?: HookHandler) => void) => void };
  return { register: (on) => hooks.register((event, matcherOrHandler, handler) => {
    if (typeof matcherOrHandler === "function") on(event, matcherOrHandler);
    else on(event, ($, e, next) => Object.entries(matcherOrHandler).every(([key, value]) => e[key] === value) ? handler!($, e, next) : next(e));
  }) };
}

/** An engine that answers the hook by running the real helper against a throwaway notes home. */
function fakeEngine(home: string): { host: HookEngine; registered: HookToolSpec[]; notifications: string[] } {
  const registered: HookToolSpec[] = [];
  const notifications: string[] = [];
  return {
    registered,
    notifications,
    host: {
      env: { get: async (name) => name === "NOTESOUP_HOME" ? home : undefined },
      session: { id: async () => "hook-session", cwd: async () => home, model: async () => "claude", messages: async () => [], usage: async () => ({ context: {} }), compact: async () => ({ skip: "test default" }) },
      settings: { read: async () => ({}) },
      command: { register: async (spec) => ({ command: spec.name }) },
      clock: { after: () => { throw new Error("test has no pending manual timer") } },
      prompt: { submit: async () => undefined },
      tool: { register: async (spec) => { registered.push(structuredClone(spec)); return { tool: `mcp__notesoup__${spec.name}` }; } },
      ui: { toast: async (text) => { notifications.push(text); }, log: (text) => { notifications.push(text); } },
      process: { run: async (argv, init) => ({
        exitCode: 0,
        stdout: execFileSync(argv[0]!, argv.slice(1), { cwd: init?.cwd, input: init?.stdin, encoding: "utf8" }),
      }) },
    },
  };
}

test("Claude notes survive removal of the session's worktree cwd", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "claude-deleted-worktree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), home = join(root, "notes"), worktree = join(repo, ".worktrees", "job");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  git("worktree", "add", "--detach", worktree);
  const { host } = fakeEngine(home);
  host.session.cwd = async () => worktree;
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  await handlers.get("session.start")!(host, { cwd: worktree, isInteractive: true }, async () => ({}));
  const call = (tool: string, params: Record<string, unknown>) => handlers.get("tool.call")!(host,
    { tool: `mcp__notesoup__${tool}`, tool_use_id: "probe", ...params }, async () => ({})) as Promise<{ result: string; isError?: boolean }>;
  for (const address of ["task.md", "@project/task.md"]) {
    assert.equal((await call("notes_write", { address, content: "pending" })).isError, undefined);
  }
  git("worktree", "remove", worktree);
  for (const address of ["task.md", "@project/task.md"]) {
    const updated = await call("notes_update", { address, edits: [{ oldText: "pending", newText: "done" }] });
    assert.equal(updated.isError, undefined, updated.result);
    assert.match((await call("notes_read", { address })).result, /done/);
  }
});

test("Claude helper exposes the eight shared notes/history schemas", async () => {
  const schemas = await dispatch({ op: "schemas" }) as Array<{ name: string; description: string; inputSchema: { type: string } }>;
  assert.deepEqual(schemas.map((schema) => schema.name), ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search", "history_list", "history_read", "history_windows"]);
  assert.ok(schemas.every((schema) => schema.description.length > 20 && schema.inputSchema.type === "object"));
});

test("Claude helper delivers only shared rendered text and success", async () => {
  const write = await callTool("notes_write", { address: "checkpoint.md", content: "hello" });
  assert.equal(write.ok, true);
  assert.match(write.text, /checkpoint\.md/);
  assert.equal(write.text.includes("READ WINDOW"), false, "Claude reads the same presentation as Pi");
  const missing = await callTool("notes_read", { address: "absent.md" });
  assert.equal(missing.ok, false);
  assert.deepEqual(Object.keys(missing).sort(), ["ok", "text"]);
  assert.match(missing.text, /^error: not_found: /, "the refusal renders as the shared error line");
});

test("Claude helper rejects malformed or unknown requests", async () => {
  const malformed = JSON.parse(await handleLine("not json")) as { ok: boolean; error: string };
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /Unexpected|malformed/);
  const unknown = JSON.parse(await handleLine(JSON.stringify({ op: "tool", tool: "history_search", identity, params: {} }))) as { ok: boolean; error: string };
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "unknown tool");
});

test("Claude helper refuses schema-invalid parameters before any operation runs", async () => {
  const address = "boundary.md";
  const written = await callTool("notes_write", { address, content: "boundary body" });
  assert.equal(written.ok, true, "the fixture note exists before anything is refused");

  const cases: Array<{ name: string; params: Record<string, unknown> }> = [
    { name: "a string offset", params: { address, offset_chars: "0" } },
    { name: "a fractional offset", params: { address, offset_chars: 0.5 } },
    { name: "a zero limit", params: { address, max_chars: 0 } },
    { name: "a limit past the maximum", params: { address, max_chars: 999_999_999 } },
  ];
  for (const { name, params } of cases) {
    const refused = JSON.parse(await handleLine(JSON.stringify({ op: "tool", tool: "notes_read", identity, params }))) as { ok: boolean; error?: string };
    assert.equal(refused.ok, false, `${name} is refused at the boundary`);
    assert.match(refused.error ?? "", /^invalid notes_read parameters: (offset_chars|max_chars) /, `${name} names the refused parameter`);
  }
  await assert.rejects(callTool("notes_read", { address, offset_chars: "0" }), /invalid notes_read parameters/);

  // Refusal happens before execute: a rejected mutation leaves nothing on disk.
  await assert.rejects(callTool("notes_write", { address: "rejected.md", content: 42 }), /invalid notes_write parameters/);
  const absent = await callTool("notes_read", { address: "rejected.md" });
  assert.equal(absent.ok, false);
  assert.match(absent.text, /^error: not_found: /, "the refused write never reached the store");

  const valid = await callTool("notes_read", { address, offset_chars: 0, max_chars: 8 });
  assert.equal(valid.ok, true, "a schema-valid window still reads");
  assert.match(valid.text, /^boundary\.md/);
});

test("Claude helper boot uses actual Claude note tool bindings and a fresh snapshot", async () => {
  const boot = await dispatch({ op: "boot", identity, openedAt: 1700000000000, tools: {
    notes: "mcp__notesoup__notes_*", notesList: "mcp__notesoup__notes_list",
    history: "history unavailable",
    remaining: "remaining unavailable", wipe: "wipe unavailable",
  } }) as string;
  assert.match(boot, /mcp__notesoup__notes_\*/);
  assert.match(boot, /claude:session/);
  assert.doesNotMatch(boot, /brain empty|continuation/);
  assert.equal(boot.includes("chat view"), false, "a Claude boot never claims a reset clears the human's view");
});

test("Claude helper serves the shared reset prose and the host's wipe sentence", async () => {
  const texts = await dispatch({ op: "texts" }) as { warning: string; wipeSentence: string; continuation?: unknown };
  assert.equal(texts.warning, CLAUDE_WARNING_PROMPT, "the helper owns the one warning text the mod shows");
  assert.equal(texts.wipeSentence, CLAUDE_WIPE_SENTENCE);
  assert.match(texts.warning, /end your turn; the reset runs after it\./);
  assert.equal(texts.warning.endsWith(COUNTDOWN_LINE), true, "the Claude notice also ends with the countdown");
  assert.equal(texts.continuation, undefined, "a plain text read never draws the reset handoff");
  const random = Math.random;
  Math.random = () => 0;
  try {
    assert.deepEqual(await dispatch({ op: "continuation", origin: "forced" }), { text: FORCED_CONTINUATIONS[0] }, "Claude's system-triggered reset draws the forced pool");
    await assert.rejects(dispatch({ op: "continuation", origin: "user" }), /invalid reset origin/, "a third origin is refused, not invented");
  } finally {
    Math.random = random;
  }
});

/** The point values the resolver produced, without the margin bookkeeping. */
function limitPoints(facts: unknown): { source: string; unit: string; autoCompact: boolean; native: number; reset: number; warn: number } {
  const limits = resolveClaudeLimits(facts);
  return { source: limits.source, unit: limits.unit, autoCompact: limits.autoCompact, native: limits.native, reset: limits.reset, warn: limits.warn };
}

// Claude compacts at min(floor((W-20000)*pct/100), W-20000-13000); notesoup resets 8192 below
// that and warns 16384 earlier. These are the numbers, not prose.
const CLAUDE_200K = { native: 167_000, reset: 158_808, warn: 142_424 };

test("Claude limits derive from Claude's own auto-compact point, never a fixed percent", () => {
  // (a) Claude's own threshold is the most faithful source, and the percent override can only lower it.
  const fromBreakdown = { usage: { tokens: 166_000, window: 200_000 }, breakdown: { autoCompactThreshold: 167_000, isAutoCompactEnabled: true } };
  assert.deepEqual(limitPoints(fromBreakdown), { source: "auto-compact", unit: "tokens", autoCompact: true, ...CLAUDE_200K });
  assert.deepEqual(limitPoints({ ...fromBreakdown, env: { pctOverride: "50" } }),
    { source: "auto-compact", unit: "tokens", autoCompact: true, native: 90_000, reset: 81_808, warn: 65_424 }, "floor((167000+13000)*50/100)");
  assert.deepEqual(limitPoints({ ...fromBreakdown, env: { pctOverride: "96" } }), { source: "auto-compact", unit: "tokens", autoCompact: true, ...CLAUDE_200K }, "an override above the default cannot raise the point");
  for (const pctOverride of ["0", "101", "abc", ""])
    assert.deepEqual(limitPoints({ ...fromBreakdown, env: { pctOverride } }), { source: "auto-compact", unit: "tokens", autoCompact: true, ...CLAUDE_200K }, `pct ${pctOverride} is ignored`);

  // (b) The same point computed from the reported window, settings and environment.
  assert.deepEqual(limitPoints({ usage: { tokens: 960_000, window: 1_000_000 } }),
    { source: "window", unit: "tokens", autoCompact: true, native: 967_000, reset: 958_808, warn: 942_424 });
  assert.equal(limitPoints({ usage: { window: 1_000_000 }, settings: { autoCompactWindow: 500_000 } }).native, 467_000);
  assert.equal(limitPoints({
    usage: { window: 1_000_000 },
    breakdown: { model: "claude-opus-4-6" },
    env: { autoCompactWindow: "400000" },
    settings: { autoCompactWindow: 500_000, modelSettings: { "claude-opus-4-6": { autoCompactWindow: 300_000 } } },
  }).native, 267_000, "the smallest configured window wins");

  // Auto-compact off: the point moves to the hard window, and the margins stay.
  const offSettings = { usage: { tokens: 171_808, window: 200_000 }, settings: { autoCompactEnabled: false } };
  assert.deepEqual(limitPoints(offSettings), { source: "window", unit: "tokens", autoCompact: false, native: 180_000, reset: 171_808, warn: 155_424 });
  assert.deepEqual(limitPoints({ usage: { window: 200_000 }, env: { disableAutoCompact: "1" } }), { source: "window", unit: "tokens", autoCompact: false, native: 180_000, reset: 171_808, warn: 155_424 });
  assert.deepEqual(limitPoints({ usage: { window: 200_000 }, breakdown: { isAutoCompactEnabled: false } }), { source: "window", unit: "tokens", autoCompact: false, native: 180_000, reset: 171_808, warn: 155_424 });
  assert.deepEqual(limitPoints({ usage: { window: 200_000 }, breakdown: { autoCompactThreshold: 167_000, isAutoCompactEnabled: false } }), { source: "window", unit: "tokens", autoCompact: false, native: 180_000, reset: 171_808, warn: 155_424 }, "an off session ignores a stale threshold");

  // (c) No window, no breakdown: the same reserves expressed on the classic 200K window.
  const percent = limitPoints({});
  assert.equal(percent.source, "percent");
  assert.equal(percent.unit, "percent");
  assert.ok(Math.abs(percent.native - 83.5) < 1e-9 && Math.abs(percent.reset - 79.404) < 1e-9 && Math.abs(percent.warn - 71.212) < 1e-9, "83.5 / 79.4 / 71.2 on 200K");
  assert.equal(limitPoints({ env: { pctOverride: "50" } }).native, 50);
  // A real window is never re-expressed on the assumed 200K window, and no point is zero:
  // the mod treats `measured >= reset` as due, so a zero point would clear memory every turn.
  const tiny = limitPoints({ usage: { window: 8_000 } });
  assert.deepEqual({ source: tiny.source, unit: tiny.unit }, { source: "window", unit: "tokens" }, "a real window answers even below the reserves");
  assert.ok(tiny.reset >= 1 && tiny.warn >= 1, "a window smaller than the reserves still has a point");
  const absurdMargin = limitPoints({ settings: { notesoup: { resetMarginTokens: 400_000 } } });
  assert.equal(absurdMargin.source, "percent");
  assert.ok(absurdMargin.reset > 0 && absurdMargin.warn > 0, "an absurd margin cannot zero the percent fallback either");
});

test("Claude limits read margins from the notesoup settings shape and ignore garbage", () => {
  const base = { usage: { window: 200_000 }, breakdown: { autoCompactThreshold: 167_000, isAutoCompactEnabled: true } };
  assert.deepEqual(limitPoints({ ...base, settings: { notesoup: { resetMarginTokens: 10_000, warningRunwayTokens: 5_000 } } }),
    { source: "auto-compact", unit: "tokens", autoCompact: true, native: 167_000, reset: 157_000, warn: 152_000 });
  for (const notesoup of [{ resetMarginTokens: 0 }, { resetMarginTokens: 8.5 }, { warningRunwayTokens: -1 }, { warningRunwayTokens: "big" }, "nonsense", null])
    assert.deepEqual(limitPoints({ ...base, settings: { notesoup } }),
      { source: "auto-compact", unit: "tokens", autoCompact: true, ...CLAUDE_200K }, `notesoup ${JSON.stringify(notesoup)} degrades to the defaults`);
  assert.equal(limitPoints({ ...base, settings: "nonsense", env: "nonsense", usage: "nonsense", breakdown: "nonsense" }).unit, "percent", "malformed facts degrade rather than throw");
  // Malformed facts never throw: the resolver is the mod-helper boundary.
  for (const facts of [undefined, null, "x", 7, [], { usage: { window: "nope" }, breakdown: { autoCompactThreshold: null } }])
    assert.equal(resolveClaudeLimits(facts).unit, "percent");
});

test("Claude helper resolves limits across the boundary and never throws on nonsense", async () => {
  const resolved = await dispatch({ op: "limits", facts: { usage: { window: 200_000 }, breakdown: { autoCompactThreshold: 167_000 } } }) as { native: number; reset: number };
  assert.equal(resolved.native, 167_000);
  assert.equal(resolved.reset, 167_000 - DEFAULT_CLAUDE_RESET_MARGIN_TOKENS);
  assert.equal(DEFAULT_CLAUDE_RESET_MARGIN_TOKENS, 8_192);
  assert.equal(WARNING_RUNWAY_TOKENS, 16_384);
  const nonsense = JSON.parse(await handleLine(JSON.stringify({ op: "limits", facts: "nonsense" }))) as { ok: boolean; result: { unit: string; warn: number } };
  assert.equal(nonsense.ok, true);
  assert.equal(nonsense.result.unit, "percent");
  assert.ok(nonsense.result.warn > 0 && nonsense.result.warn < 100);
});

test("Claude's wipe sentence replaces only that sentence in the shared protocol block", () => {
  const piTools = { notes: "notes_*", notesList: "notes_list", history: "history_*", remaining: "get_context_remaining", wipe: "empty_brain" };
  const pi = renderProtocolBlock(piTools);
  assert.ok(pi.includes(PROTOCOL_WIPE_SENTENCE), "Pi keeps the default sentence, byte for byte");
  const claude = renderProtocolBlock({ ...piTools, wipeSentence: CLAUDE_WIPE_SENTENCE });
  assert.equal(claude, pi.replace(PROTOCOL_WIPE_SENTENCE, CLAUDE_WIPE_SENTENCE), "only that sentence changes");
  assert.equal(claude.includes("erase yourself with dignity"), false);
  assert.ok(claude.includes("end your turn and ask the human to run `/fresh-window`."));
});


test("Claude Mod helper runs from a standalone copied plugin directory", () => {
  const fixture = mkdtempSync(join(tmpdir(), "claude-mod-install-"));
  try {
    const plugin = join(fixture, "notesoup");
    cpSync(join(process.cwd(), "plugins/claude"), plugin, { recursive: true });
    const hook = readFileSync(join(plugin, "hooks/register.ts"), "utf8");
    assert.ok(hook.includes('${import.meta.dir}/../dist/claude/helper.js'));
    const helper = join(plugin, "dist/claude/helper.js");
    const run = (input: string) => JSON.parse(execFileSync(process.execPath, [helper], {
      cwd: fixture, input, encoding: "utf8",
    })) as { ok: boolean; result?: Array<{ name: string }>; error?: string };
    const schemas = run('{"op":"schemas"}');
    assert.equal(schemas.ok, true);
    assert.equal(schemas.result?.length, 8);
    assert.equal(run("not json").ok, false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Claude Mod appends boot once and reuses persisted blocks after re-registration", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-hook-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // Count the boot requests the hook actually sends while the real helper still answers every one.
  let bootRequests = 0;
  const { host, notifications } = fakeEngine(home);
  const runProcess = host.process.run;
  host.process.run = async (argv, init) => {
    const request = JSON.parse(String(init?.stdin ?? "")) as { op?: string };
    if (request.op === "boot") bootRequests += 1;
    return await runProcess(argv, init);
  };

  // Each registration is a fresh hook closure, so any dedup it shows lives in the persisted result.
  const registerSession = async () => {
    const hooks = await loadHookModule(t);
    const handlers = new Map<string, HookHandler>();
    hooks.register((event, handler) => handlers.set(event, handler));
    await handlers.get("session.start")!(host, { cwd: home, isInteractive: true }, async (event: unknown) => event);
    return handlers;
  };

  let nextCalls = 0;
  const promptContext = (handlers: Map<string, HookHandler>, result: Record<string, unknown>) =>
    handlers.get("prompt.context")!(host, { cwd: home }, async () => { nextCalls += 1; return result; }) as Promise<{ blocks: Array<{ name: string; text: string }> } & Record<string, unknown>>;

  const upstream = { blocks: [{ name: "claude:user-context", text: "unrelated upstream block" }], sentinel: "kept" };

  const first = await promptContext(await registerSession(), structuredClone(upstream));
  assert.equal(first.blocks.length, 2, "exactly one boot block joins the upstream blocks");
  assert.deepEqual(first.blocks[0], upstream.blocks[0], "the upstream block is preserved untouched");
  const boot = first.blocks[1]!;
  assert.equal(boot.name, "notesoup:boot");
  assert.ok(boot.text.length > 0, "the boot block carries real boot text");
  assert.match(boot.text, /mcp__notesoup__notes_\*/, "the boot text names the actual Claude note tool binding");
  assert.ok(boot.text.includes(CLAUDE_WIPE_SENTENCE), "the boot speaks the Claude wipe path");
  assert.equal(boot.text.includes("erase yourself with dignity"), false);
  assert.equal(boot.text.includes("chat view"), false, "the Claude boot block carries no Pi-only pre-reset hints");
  assert.equal(first.sentinel, "kept", "unrelated result fields survive");
  assert.equal(bootRequests, 1, "the first prompt makes exactly one boot helper request");
  assert.equal(nextCalls, 1, "the upstream chain runs exactly once per prompt");

  const second = await promptContext(await registerSession(), structuredClone(first));
  assert.deepEqual(second, first, "the persisted result, boot block and sentinel included, is reused unchanged");
  assert.equal(bootRequests, 1, "a persisted boot block needs no second boot helper request");
  assert.equal(nextCalls, 2, "the upstream chain still runs exactly once per prompt");
  assert.deepEqual(notifications, [], "successful boot never notifies");
});

test("Claude Mod with NOTESOUP_DISABLED registers nothing and passes every event through", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-hook-disabled-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host, registered, notifications } = fakeEngine(home);
  const readEnv = host.env.get;
  host.env.get = async (name) => name === "NOTESOUP_DISABLED" ? "1" : await readEnv(name);
  const commands: string[] = [];
  host.command.register = async (spec) => { commands.push(spec.name); return spec; };
  let helperCalls = 0;
  const runProcess = host.process.run;
  host.process.run = async (argv, init) => { helperCalls += 1; return await runProcess(argv, init); };

  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const startResult = { session: "started" };
  const started = await handlers.get("session.start")!(host, { cwd: home, isInteractive: true }, async () => startResult);
  assert.equal(started, startResult, "session.start passes through untouched");
  assert.deepEqual(registered, [], "no tools are registered");
  assert.deepEqual(commands, [], "no commands are registered");
  assert.ok(notifications.some((text) => text.includes("NOTESOUP_DISABLED")), "the off state is logged");

  const upstream = { blocks: [{ name: "claude:user-context", text: "unrelated upstream block" }] };
  const prompt = await handlers.get("prompt.context")!(host, {}, async () => upstream);
  assert.equal(prompt, upstream, "prompt.context gets no boot block");

  const native = { skip: "engine default" };
  const compact = await handlers.get("session.compact")!(host, { trigger: "auto" }, async () => native);
  assert.equal(compact, native, "native compaction runs exactly as if the mod were absent");

  const completed = await handlers.get("turn.complete")!(host, {}, async () => ({ done: true }));
  assert.deepEqual(completed, { done: true }, "turn.complete passes through without a reset");
  const measured = await handlers.get("session.measure")!(host, {}, async () => ({ marks: true }));
  assert.deepEqual(measured, { marks: true }, "session.measure passes through without a reset");
  assert.equal(helperCalls, 0, "the helper never runs while disabled");
  const event = { text: "continue", context: ["upstream"] };
  assert.equal(await handlers.get("prompt.submit")!(host, event, async (e) => e), event);
  const tool = { result: "upstream" };
  assert.equal(await handlers.get("tool.call")!(host, { tool: "Read" }, async () => tool), tool);
  assert.equal(helperCalls, 0, "disabled warning routes are transparent too");
});

test("Claude Mod omits context_management always and memory unless kept; disabled passes through", async (t) => {
  for (const mode of ["default", "keep", "disabled"] as const) {
    await t.test(mode, async (t) => {
      const home = mkdtempSync(join(tmpdir(), "claude-context-section-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const { host } = fakeEngine(home);
      const readEnv = host.env.get;
      host.env.get = async (name) => name === "NOTESOUP_KEEP_MEMORY" ? (mode === "keep" ? " YES " : undefined)
        : name === "NOTESOUP_DISABLED" && mode === "disabled" ? "1" : readEnv(name);
      const handlers = new Map<string, HookHandler>(), sections: HookHandler[] = [];
      (await loadHookModule(t)).register((event, handler) => event === "prompt.section" ? sections.push(handler) : handlers.set(event, handler));
      await handlers.get("session.start")!(host, { cwd: home, isInteractive: true }, async () => ({}));

      for (const name of ["context_management", "memory"]) {
        const event = { name, text: `engine ${name}` };
        const upstream = { text: event.text };
        let calls = 0;
        const next = async (e: unknown) => { assert.equal(e, event); calls++; return upstream; };
        // Chain the section hooks as the engine does; each matcher passes other names along.
        const result = await sections.reduceRight<(e: unknown) => Promise<unknown>>((rest, handler) => (e) => handler(host, e as Record<string, unknown>, rest), next)(event);
        const kept = mode === "disabled" || (mode === "keep" && name === "memory");
        if (kept) { assert.equal(result, upstream); assert.equal(calls, 1); }
        else { assert.deepEqual(result, { text: null }); assert.equal(calls, 0); }
      }
    });
  }
});

test("Claude Mod boot failure preserves fallback with available, absent, or failing notifications", async (t) => {
  for (const mode of ["available", "no ui", "no toast", "throws", "rejects"] as const) {
    await t.test(mode, async (t) => {
      const hooks = await loadHookModule(t);
      const home = mkdtempSync(join(tmpdir(), "claude-hook-home-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const { host, notifications } = fakeEngine(home);
      if (mode === "no ui") delete host.ui;
      else if (mode === "no toast") host.ui = {};
      else if (mode === "throws" || mode === "rejects") {
        host.ui = { toast: (text) => {
          notifications.push(text);
          if (mode === "throws") throw new Error("notification unavailable");
          return Promise.reject(new Error("notification unavailable"));
        } };
      }

      let bootRequests = 0;
      const runProcess = host.process.run;
      host.process.run = async (argv, init) => {
        const request = JSON.parse(String(init?.stdin ?? "")) as { op?: string };
        if (request.op === "boot") {
          bootRequests += 1;
          return { exitCode: 1, stdout: "" };
        }
        return await runProcess(argv, init);
      };
      const handlers = new Map<string, HookHandler>();
      hooks.register((event, handler) => handlers.set(event, handler));
      await handlers.get("session.start")!(host, { cwd: home, isInteractive: true }, async (event: unknown) => event);
      let nextCalls = 0;
      const promptContext = (result: Record<string, unknown>) =>
        handlers.get("prompt.context")!(host, { cwd: home }, async () => { nextCalls += 1; return result; });
      const upstream = { blocks: [{ name: "claude:user-context", text: "unrelated upstream block" }], sentinel: "kept" };
      const failed = await promptContext(structuredClone(upstream));
      assert.deepEqual(failed, {
        ...upstream,
        blocks: [...upstream.blocks, { name: "notesoup:boot", text: "# notesoup\nYour notes didn't load this time (helper exited unsuccessfully). Try `mcp__notesoup__notes_list`; if it fails too, tell the human." }],
      }, "boot failure keeps the original fallback and upstream fields even if notify is absent or fails");
      const expectedNotifications = mode === "no ui" || mode === "no toast" ? [] : ["🥣 Notes went missing"];
      assert.deepEqual(notifications, expectedNotifications, "one user-facing notification reports the notes boot failure");
      assert.equal(bootRequests, 1);
      assert.equal(nextCalls, 1);

      assert.deepEqual(await promptContext(structuredClone(failed) as Record<string, unknown>), failed);
      assert.deepEqual(notifications, expectedNotifications, "a persisted fallback does not notify again");
      assert.equal(bootRequests, 1, "a persisted fallback needs no second boot request");
      assert.equal(nextCalls, 2, "the upstream chain still runs exactly once per prompt");
    });
  }
});

test("Claude Mod hook delivers the helper's shared text, and marks only a refusal as an error", async (t) => {
  const hooks = await loadHookModule(t);
  const home = mkdtempSync(join(tmpdir(), "claude-hook-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host, registered } = fakeEngine(home);
  const handlers = new Map<string, HookHandler>();
  hooks.register((event, handler) => handlers.set(event, handler));
  await handlers.get("session.start")!(host, { cwd: home, isInteractive: true }, async (event: unknown) => event);
  assert.deepEqual(registered.map((spec) => spec.name), ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search", "history_list", "history_read", "history_windows"]);
  for (const spec of registered) {
    assert.equal(spec.isDeferred, false, `${spec.name} is available from the start without tool search`);
    assert.ok(spec.description.length > 20);
    assert.equal(spec.inputSchema.type, "object");
  }

  const call = (tool: string, params: Record<string, unknown>) => handlers.get("tool.call")!(host, { tool: `mcp__notesoup__${tool}`, tool_use_id: "hook-1", ...params }, async (event: unknown) => event) as Promise<{ result: unknown; isError?: unknown }>;

  const written = await call("notes_write", { address: "hook.md", content: "hook body" });
  assert.equal(written.result, "created hook.md", "the hook hands back the shared text unchanged");
  assert.equal("isError" in written, false, "a success carries no discriminator at all, not a false one");

  const refused = await call("notes_read", { address: "absent.md" });
  assert.equal(refused.isError, true, "a refusal carries the literal the public ToolCallResult declares");
  assert.match(String(refused.result), /^error: not_found: /, "the refusal reads as the shared error line");

  // A tool this plugin never registered is somebody else's answer, not a notesoup refusal.
  const foreign = await call("other_tool", {});
  assert.equal("result" in foreign, false, "an unregistered tool falls through to the engine's own handling");

  // A rejected host call is the only diagnosis there is, so its reason must reach the model.
  const ran = host.process.run;
  host.process.run = async () => { throw new Error("spawn timed out after 10000ms") };
  const crashed = await call("notes_write", { address: "hook.md", content: "again" });
  host.process.run = ran;
  assert.equal(crashed.isError, true);
  assert.match(String(crashed.result), /^notesoup: helper execution failed: Error: spawn timed out after 10000ms$/, "the host's own reason survives the catch");
});


test("Claude Mod resets at Claude's resolved point after the turn, retains one fresh boot and deduplicates measure", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-reset-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host, registered, notifications } = fakeEngine(home);
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const invoke = (name: string, event: Record<string, unknown> = {}) => handlers.get(name)!(host, event, async () => ({ sentinel: name }));
  // A 200K window resolves to Claude's 167 000 point, so notesoup resets 8 192 below it.
  let tokens: number | undefined = 140_000;
  let compactions = 0;
  let kept: Array<{ role: string; text: string }> = [];
  const measured = () => ({ context: { tokens, window: 200_000, percent: tokens === undefined ? undefined : (tokens / 200_000) * 100 } });
  host.session.usage = async () => measured();
  host.session.compact = async ({ instructions }) => {
    compactions++;
    const result = await invoke("session.compact", { trigger: "plugin", instructions: `${instructions} (rewritten upstream)`, messages: [{ role: "user", text: "OLD_SECRET" }] }) as { messages: typeof kept };
    kept = result.messages;
    tokens = undefined; // The real engine invalidates token usage after compact.
    return result;
  };
  await invoke("session.start", { cwd: home, isInteractive: true });
  assert.equal(registered.length, 8);
  const initial = await handlers.get("prompt.context")!(host, {}, async () => ({ blocks: [] })) as { blocks: Array<{ name: string; text: string }> };
  assert.equal(initial.blocks.length, 1, "below the warn point no warning joins the boot");
  assert.match(initial.blocks[0]!.text, /Current context window id: claude:hook-session:0/);
  await invoke("turn.start");
  await invoke("session.measure");
  await invoke("turn.complete");
  assert.equal(compactions, 0, "140000 is below every resolved point");
  host.session.usage = async () => { throw new Error("usage unavailable"); };
  await invoke("session.measure");
  await invoke("turn.complete");
  assert.equal(notifications.filter((text) => text.includes("Brain fullness unknown")).length, 1, "usage failure logs once per session");
  host.session.usage = async () => measured();
  await dispatch({ op: "tool", tool: "notes_write", identity: { ...identity, home, cwd: home, sessionId: "hook-session" }, params: { address: "@human/MAP.md", content: "FRESH_NOTES_AT_RESET" } });
  await invoke("turn.start");
  tokens = 158_807;
  await invoke("turn.complete");
  assert.equal(compactions, 0, "one token below the resolved reset point");
  await invoke("turn.start");
  tokens = 158_808;
  await invoke("session.measure");
  assert.equal(compactions, 0, "measure cannot compact under a running turn");
  assert.deepEqual(await invoke("turn.complete"), { sentinel: "turn.complete" });
  assert.equal(compactions, 1);
  assert.equal(kept.length, 2, "the reset is the notes boot followed by the one reset message");
  assert.equal(kept[0]!.role, "user");
  assert.match(kept[0]!.text, /Current context window id: claude:hook-session:1/);
  assert.match(kept[0]!.text, /Previous context window id: claude:hook-session:0/);
  assert.match(kept[0]!.text, /FRESH_NOTES_AT_RESET/);
  assert.doesNotMatch(kept[0]!.text, /OLD_SECRET/);
  assert.ok(FORCED_CONTINUATIONS.includes(kept[1]!.text), "the handoff comes from the shared forced pool");
  await invoke("session.measure");
  assert.equal(compactions, 1, "invalidated tokens cannot immediately reset twice");
  const upstream = { blocks: [{ name: "unrelated", text: "leave this alone" }], sentinel: "kept" };
  assert.deepEqual(await handlers.get("prompt.context")!(host, {}, async () => upstream), upstream, "the retained boot is not injected a second time");
});

test("Claude Mod headless detection skips compaction and logs once", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-headless-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host, notifications } = fakeEngine(home);
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const invoke = (name: string, e: Record<string, unknown> = {}) => handlers.get(name)!(host, e, async () => ({ sentinel: name }));
  let tokens: number | undefined;
  let attempts = 0;
  host.session.usage = async () => ({ context: { tokens, window: 200_000 } });
  host.session.compact = async () => { attempts++; throw new Error("not available in a headless (-p / SDK) session yet"); };
  await invoke("session.start", { cwd: home, isInteractive: false });
  await invoke("turn.start");
  await invoke("turn.complete");
  await invoke("session.measure");
  assert.equal(attempts, 0, "no measured tokens means no automatic reset");
  tokens = 190_000;
  await invoke("turn.start");
  assert.deepEqual(await invoke("turn.complete"), { sentinel: "turn.complete" }, "a rejection does not break the turn chain");
  await invoke("session.measure");
  await invoke("turn.complete");
  assert.equal(attempts, 0, "headless sessions skip the unsupported capability from startup");
  assert.deepEqual(notifications, ["🥣 No brain when headless"]);
  const manual = await invoke("command.run", { command: "empty" }) as { text: string };
  assert.match(manual.text, /No brain when headless/);
  assert.equal(notifications.length, 1);
  const boot = await handlers.get("prompt.context")!(host, {}, async () => ({ blocks: [] })) as { blocks: Array<{ text: string }> };
  assert.match(boot.blocks[0]!.text, /Current context window id: claude:hook-session:0/);
  const event = { text: "continue" };
  assert.equal(await handlers.get("prompt.submit")!(host, event, async (e) => e), event, "headless prompts never warn");
});

test("Claude Mod keeps its window numbering from a boot written before the tag rename", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-legacy-boot-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host } = fakeEngine(home);
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const invoke = (name: string, event: Record<string, unknown> = {}, next: () => Promise<unknown> = async () => ({ sentinel: name })) => handlers.get(name)!(host, event, next);
  const boot = (spelling: "notesoup:window_identity" | "context_window") => `<${spelling}>\nAgent name: claude (brain: claude)\n\nhook-session\n</${spelling}>\n\nCurrent context window id: claude:hook-session:3`;
  for (const spelling of ["context_window", "notesoup:window_identity"] as const) {
    const text = boot(spelling);
    host.session.messages = async () => [{ role: "user", text }];
    await invoke("session.start", { cwd: home, isInteractive: true });
    // A recognised retained boot is not injected a second time into prompt context.
    const context = await invoke("prompt.context", {}, async () => ({ blocks: [] })) as { blocks: Array<{ name: string }> };
    assert.deepEqual(context.blocks, [], `${spelling} is recognised as this session's retained boot`);
    const compacted = await invoke("session.compact", { trigger: "auto", instructions: "", messages: [] }) as { messages: Array<{ text: string }> };
    assert.match(compacted.messages[0]!.text, /Current context window id: claude:hook-session:4/, `${spelling} keeps its window ordinal`);
  }
});

test("Claude Mod refuses to wipe on boot failure and can retry without advancing the window", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-reset-failure-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host } = fakeEngine(home);
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const invoke = (name: string, e: Record<string, unknown> = {}) => handlers.get(name)!(host, e, async () => ({}));
  await invoke("session.start", { cwd: home, isInteractive: true });
  const run = host.process.run;
  let failBoot = true;
  host.process.run = async (argv, init) => {
    if (JSON.parse(init!.stdin!).op === "boot" && failBoot) return { exitCode: 1, stdout: "" };
    return run(argv, init);
  };
  host.session.usage = async () => ({ context: { tokens: 170_000, window: 200_000 } });
  let result: Awaited<ReturnType<HookEngine["session"]["compact"]>> = {};
  host.session.compact = async ({ instructions }) => result = await invoke("session.compact", { trigger: "plugin", instructions }) as typeof result;
  await invoke("turn.start");
  await invoke("turn.complete");
  assert.match(result.skip!, /notes didn't load/);
  assert.equal(result.messages, undefined, "a failed builder must veto rather than fall through to summary");
  failBoot = false;
  await invoke("turn.start");
  await invoke("turn.complete");
  assert.equal(result.skip, undefined);
  assert.equal(result.messages!.length, 2);
  assert.match(result.messages![0]!.text, /Current context window id: claude:hook-session:1/, "a failed reset never consumes a window ordinal");
  assert.ok(FORCED_CONTINUATIONS.includes(result.messages![1]!.text));
});

test("Claude Mod manual reset uses one hidden close-out turn, then recovers its boot on reload", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-manual-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host } = fakeEngine(home);
  const commands: string[] = [];
  host.command.register = async (spec) => { commands.push(spec.name); return { command: spec.name }; };
  let handlers = new Map<string, HookHandler>();
  const invoke = (name: string, e: Record<string, unknown> = {}) => handlers.get(name)!(host, e, async () => ({}));
  const timers: Array<() => void | Promise<void>> = [];
  const prompts: string[] = [];
  let kept: Array<{ role: string; text: string }> = [];
  let compactions = 0;
  host.clock.after = (_ms, callback) => { timers.push(callback); };
  host.session.compact = async ({ instructions }) => {
    compactions++;
    const result = await invoke("session.compact", { trigger: "plugin", instructions }) as { messages: typeof kept };
    kept = result.messages;
    return result;
  };
  host.prompt.submit = async ({ text }) => {
    prompts.push(text);
    await invoke("turn.start");
    await invoke("turn.complete");
  };
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  await invoke("session.start", { cwd: home, isInteractive: true });
  assert.deepEqual(commands.sort(), ["empty", "fresh-window"], "only the new short name and the retained alias are registered");
  assert.deepEqual(await invoke("command.run", { command: "empty-brain" }), {}, "the retired spelling passes through instead of resetting");
  assert.equal(timers.length, 0);
  const command = await invoke("command.run", { command: "empty" }) as { text: string };
  assert.match(command.text, /Brain being emptied/);
  await Promise.resolve();
  assert.equal(compactions, 0, "command.run must not call compact under its held turn");
  assert.equal(timers.length, 1);
  await timers.shift()!();
  assert.equal(prompts.length, 1, "exactly one hidden normal-model close-out turn, not a summary");
  assert.equal(prompts[0], CLAUDE_WARNING_PROMPT, "the close-out is the same warning text the automatic path shows");
  assert.equal(compactions, 1);
  assert.equal(kept.length, 2);
  assert.match(kept[0]!.text, /Current context window id: claude:hook-session:1/);
  assert.ok(FORCED_CONTINUATIONS.includes(kept[1]!.text));
  host.session.messages = async () => [{ role: "user", text: "OLD_SECRET" }, ...kept];
  handlers = new Map();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  await invoke("session.start", { cwd: home, isInteractive: true });
  assert.deepEqual(await handlers.get("prompt.context")!(host, {}, async () => ({ blocks: [] })), { blocks: [] }, "reload does not duplicate the already-retained boot");
  await invoke("turn.start");
  await invoke("command.run", { command: "empty" });
  await invoke("turn.complete");
  assert.equal(prompts.length, 1, "a busy manual request reuses the current turn instead of submitting another");
  assert.match(kept[0]!.text, /Current context window id: claude:hook-session:2/);
});


test("Claude Mod delivers one warning per window through main tools or prompt submission, never boot", async (t) => {
  const { host, invoke, context } = await retainedFixture(t);
  const texts = await dispatch({ op: "texts" }) as { warning: string };
  let tokens = CLAUDE_200K.warn - 1;
  host.session.usage = async () => ({ context: { tokens, window: 200_000 } });
  const foreign = { result: "upstream result", context: ["upstream context"], ref: 1 };
  const tool = (event: Record<string, unknown> = { tool: "Read" }, result: unknown = foreign) => invoke("tool.call", event, result) as Promise<{ result?: string; context?: string[] }>;
  const submit = () => invoke("prompt.submit", { text: "continue", context: ["earlier plugin"] }, {}, async (e) => e) as Promise<{ context: string[] }>;
  assert.equal(await tool(), foreign, "below the warn point the result passes through untouched");
  tokens++;
  assert.deepEqual((await context()).blocks, [], "prompt.context never delivers a warning, even above the runway");
  const denied = { deny: "upstream refusal" };
  assert.equal(await tool({ tool: "Read" }, denied), denied, "deny stays unchanged and does not consume the warning");
  assert.equal(await invoke("tool.call", { tool: "Read", agentId: "child" }, foreign), foreign, "subagent results do not warn");
  const own = await tool({ tool: "mcp__notesoup__notes_list" });
  assert.equal(typeof own.result, "string", "a self-registered result still carries its original text");
  assert.deepEqual(own.context, [texts.warning]);
  assert.equal(await tool(), foreign, "another tool cannot warn twice in the same window");
  assert.deepEqual((await submit()).context, ["earlier plugin"], "tool delivery also consumes the prompt route");

  const reset = () => invoke("session.compact", { trigger: "auto", messages: [] });
  await reset();
  assert.deepEqual(await tool(), { ...foreign, context: [...foreign.context, texts.warning] }, "a new window can warn through a next() tool result");
  assert.equal(await tool(), foreign);
  await reset();
  assert.deepEqual((await submit()).context, ["earlier plugin", texts.warning], "prompt submission preserves earlier context and warns once");
  assert.deepEqual((await submit()).context, ["earlier plugin"]);
  assert.equal(await tool(), foreign, "prompt delivery wins over the later tool route");
  assert.deepEqual((await context()).blocks, [], "no notesoup:warning block is ever added to prompt context");
});

test("Claude Mod consumes a warning only after an accepted delivery and ignores stale generations", async (t) => {
  const { host, invoke } = await retainedFixture(t);
  const texts = await dispatch({ op: "texts" }) as { warning: string };
  host.session.usage = async () => ({ context: { tokens: CLAUDE_200K.warn, window: 200_000 } });
  const event = { text: "continue", context: ["upstream"] };
  const drop = { drop: "another plugin refused" };
  assert.equal(await invoke("prompt.submit", event, drop), drop);
  await assert.rejects(invoke("prompt.submit", event, {}, async () => { throw new Error("submission failed"); }), /submission failed/);
  assert.deepEqual(await invoke("prompt.submit", event, event), event, "a downstream context rewrite does not count as delivery");
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const pending = invoke("prompt.submit", event, {}, async (e) => {
    assert.deepEqual((e as typeof event).context, [...event.context, texts.warning]);
    entered(); await held; return e;
  });
  await ready;
  const result = { result: "tool while prompt enters" };
  assert.equal(await invoke("tool.call", { tool: "Read" }, result), result, "an in-flight accepted route reserves this window against duplicate tool delivery");
  await invoke("session.end", { reason: "clear" });
  host.session.id = async () => "next-session";
  host.session.messages = async () => [];
  await invoke("prompt.context", {}, { blocks: [] });
  release(); await pending;
  const delivered = await invoke("prompt.submit", event, {}, async (e) => e) as typeof event;
  assert.deepEqual(delivered.context, [...event.context, texts.warning], "an old delivery cannot mark the new generation warned");
  assert.equal(await invoke("prompt.submit", event, event), event, "only an accepted delivery consumes the new window");
});

test("Claude Mod moves the reset point to the hard window when auto-compact is off", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-off-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host, notifications } = fakeEngine(home);
  host.settings = { read: async () => ({ autoCompactEnabled: false }) };
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const invoke = (name: string, e: Record<string, unknown> = {}) => handlers.get(name)!(host, e, async () => ({}));
  let tokens = 171_807;
  let compactions = 0;
  host.session.usage = async () => ({ context: { tokens, window: 200_000 } });
  host.session.compact = async ({ instructions }) => { compactions++; return await invoke("session.compact", { trigger: "plugin", instructions }) as { skip?: string; messages?: Array<{ role: string; text: string }> }; };
  await invoke("session.start", { cwd: home, isInteractive: true });
  await invoke("turn.start");
  await invoke("turn.complete");
  assert.equal(compactions, 0, "171807 is below the hard-window point");
  await invoke("turn.start");
  tokens = 171_808;
  await invoke("turn.complete");
  assert.equal(compactions, 1, "200000 - 20000 - 8192");
  assert.deepEqual(notifications.filter((text) => text.includes("unavailable") || text.includes("Couldn't")), [], "a resolvable configuration logs no failure");
});

test("Claude Mod stops the automatic reset and the manual command under DISABLE_COMPACT", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-disabled-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host, notifications } = fakeEngine(home);
  host.env = { get: async (name) => name === "NOTESOUP_HOME" ? home : name === "DISABLE_COMPACT" ? "1" : undefined };
  const timers: Array<() => void | Promise<void>> = [];
  host.clock.after = (_ms, callback) => { timers.push(callback); };
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const invoke = (name: string, e: Record<string, unknown> = {}) => handlers.get(name)!(host, e, async () => ({}));
  let compactions = 0;
  host.session.usage = async () => ({ context: { tokens: 190_000, window: 200_000 } });
  host.session.compact = async () => { compactions++; return {}; };
  await invoke("session.start", { cwd: home, isInteractive: true });
  assert.equal(notifications.length, 1, "one startup line");
  assert.match(notifications[0]!, /DISABLE_COMPACT/);
  const manual = await invoke("command.run", { command: "empty" }) as { text: string };
  assert.match(manual.text, /DISABLE_COMPACT/);
  assert.equal(timers.length, 0, "no close-out turn is queued");
  await invoke("turn.start");
  await invoke("session.measure");
  await invoke("turn.complete");
  await invoke("session.measure");
  assert.equal(compactions, 0, "the automatic reset is off and does not retry");
  assert.equal(notifications.length, 1, "detection logs once, not per turn");
  const upstream = { result: "upstream", context: ["other plugin"] };
  assert.equal(await handlers.get("tool.call")!(host, { tool: "Read" }, async () => upstream), upstream, "DISABLE_COMPACT also suppresses warnings");
});

test("Claude Mod skips the automatic reset when thresholds cannot be resolved", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-nolimits-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host, notifications } = fakeEngine(home);
  host.process.run = async () => ({ exitCode: 1, stdout: "" });
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const invoke = (name: string, e: Record<string, unknown> = {}) => handlers.get(name)!(host, e, async () => ({}));
  let compactions = 0;
  host.session.usage = async () => ({ context: { tokens: 190_000, window: 200_000 } });
  host.session.compact = async () => { compactions++; return {}; };
  await invoke("session.start", { cwd: home, isInteractive: true });
  await invoke("turn.start");
  await invoke("session.measure");
  await invoke("turn.complete");
  await invoke("session.measure");
  assert.equal(compactions, 0, "an unresolvable point never resets");
  assert.equal(notifications.filter((text) => text.includes("Brain size unknown")).length, 1, "one line, not one per turn");
});

test("Claude skill projections stay byte-identical to canonical shared files", () => {
  assert.deepEqual(
    readFileSync(join(process.cwd(), "plugins/claude/skills/memory/SKILL.md")),
    readFileSync(join(process.cwd(), "skills/memory/SKILL.md")),
  );
  assert.deepEqual(
    readFileSync(join(process.cwd(), "plugins/claude/skills/dream/SKILL.md")),
    readFileSync(join(process.cwd(), "skills/dream/SKILL.md")),
  );
  assert.deepEqual(
    readFileSync(join(process.cwd(), "plugins/claude/playbook.md")),
    readFileSync(join(process.cwd(), "playbook.md")),
  );
  const skill = readFileSync(join(process.cwd(), "plugins/claude/skills/dream/SKILL.md"), "utf8");
  assert.match(skill, /\.\.\/\.\.\/playbook\.md/);
  assert.doesNotMatch(skill, /Claude.*runner|dream runner/i);
});

test("Claude Mod keeps the turn latch through subagent turns", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "claude-subagent-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const { host } = fakeEngine(home);
	const handlers = new Map<string, HookHandler>();
	(await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
	const invoke = (name: string, e: Record<string, unknown> = {}) => handlers.get(name)!(host, e, async () => ({}));
	let compactions = 0;
	host.session.usage = async () => ({ context: { tokens: 190_000, window: 200_000 } });
	host.session.compact = async ({ instructions }) => { compactions++; return await invoke("session.compact", { trigger: "plugin", instructions }) as { skip?: string; messages?: Array<{ role: string; text: string }> }; };
	await invoke("session.start", { cwd: home, isInteractive: true });
	await invoke("turn.start");
	await invoke("turn.start", { agentId: "sub-1" });
	await invoke("turn.complete", { agentId: "sub-1" });
	await invoke("session.measure");
	assert.equal(compactions, 0, "a subagent turn cannot release the main turn's latch");
	await invoke("turn.complete");
	assert.equal(compactions, 1, "the main turn still resets at its own end");
});

test("Claude Mod treats DISABLE_COMPACT=off as not disabled", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "claude-flag-off-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const { host, notifications } = fakeEngine(home);
	host.env = { get: async (name) => name === "NOTESOUP_HOME" ? home : name === "DISABLE_COMPACT" ? "off" : undefined };
	const handlers = new Map<string, HookHandler>();
	(await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
	const invoke = (name: string, e: Record<string, unknown> = {}) => handlers.get(name)!(host, e, async () => ({}));
	let compactions = 0;
	host.session.usage = async () => ({ context: { tokens: 190_000, window: 200_000 } });
	host.session.compact = async ({ instructions }) => { compactions++; return await invoke("session.compact", { trigger: "plugin", instructions }) as { skip?: string; messages?: Array<{ role: string; text: string }> }; };
	await invoke("session.start", { cwd: home, isInteractive: true });
	assert.deepEqual(notifications.filter((text) => text.includes("DISABLE_COMPACT")), [], "an explicit off is not a disable");
	await invoke("turn.start");
	await invoke("turn.complete");
	assert.equal(compactions, 1, "the automatic reset still runs");
});

test("Claude Mod retries an unresolvable threshold inside the same window", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "claude-retry-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const { host } = fakeEngine(home);
	const helper = host.process.run;
	let limitsCalls = 0;
	host.process.run = async (argv, init) => {
		const request = JSON.parse(String(init?.stdin ?? "{}")) as { op?: string };
		if (request.op === "limits" && ++limitsCalls === 1) return { exitCode: 1, stdout: "" };
		return await helper(argv, init);
	};
	const handlers = new Map<string, HookHandler>();
	(await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
	const invoke = (name: string, e: Record<string, unknown> = {}) => handlers.get(name)!(host, e, async () => ({}));
	let compactions = 0;
	host.session.usage = async () => ({ context: { tokens: 190_000, window: 200_000 } });
	host.session.compact = async ({ instructions }) => { compactions++; return await invoke("session.compact", { trigger: "plugin", instructions }) as { skip?: string; messages?: Array<{ role: string; text: string }> }; };
	await invoke("session.start", { cwd: home, isInteractive: true });
	await invoke("turn.start");
	await invoke("turn.complete");
	assert.equal(limitsCalls, 1, "the first limits round trip failed");
	assert.equal(compactions, 0, "one failed resolution does not disable the window");
	await invoke("turn.start");
	await invoke("turn.complete");
	assert.equal(limitsCalls, 2, "the retry runs in the same window");
	assert.equal(compactions, 1, "the retried resolution resets at the turn's end");
});

/** Start from a real retained boot, as after notesoup reset or a plugin reload. */
async function retainedFixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "claude-lifecycle-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host } = fakeEngine(home);
  const boot = await dispatch({ op: "boot", identity: { ...identity, home, cwd: home, sessionId: "hook-session" }, window: 2, tools: {
    notes: "mcp__notesoup__notes_*", notesList: "mcp__notesoup__notes_list",
    history: "unavailable", remaining: "unavailable", wipe: "/fresh-window",
  } }) as string;
  host.session.messages = async () => [{ role: "user", text: `# notesoup:boot\n${boot}` }];
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const invoke = (name: string, e: Record<string, unknown> = {}, result: unknown = {}, next?: (e: unknown) => Promise<unknown>) =>
    handlers.get(name)!(host, e, next ?? (async () => result));
  const context = async () => await invoke("prompt.context", {}, { blocks: [] }) as { blocks: Array<{ name: string; text: string }> };
  await invoke("session.start", { cwd: home, isInteractive: true });
  assert.deepEqual((await context()).blocks, [], "the existing boot is retained, not injected twice");
  return { home, host, invoke, context, boot };
}

test("Claude asks for one handoff per compaction and reuses it when the same window retries", async (t) => {
  const { host, invoke } = await retainedFixture(t);
  const run = host.process.run;
  const draws: string[] = [];
  host.process.run = async (argv, init) => {
    const request = init?.stdin ? JSON.parse(init.stdin) as { op?: string } : {};
    if (request.op === "continuation") draws.push(init?.stdin!);
    return run(argv, init);
  };
  // Every read path stays pure: no boot, warning, context, or measure draws a handoff.
  await invoke("prompt.context", {}, { blocks: [] });
  await invoke("session.measure");
  await invoke("turn.start");
  await invoke("turn.complete");
  assert.equal(draws.length, 0, "only a reset draws, never a read");

  const timers: Array<() => void | Promise<void>> = [];
  const lines: string[] = [];
  host.clock.after = (_ms, callback) => { timers.push(callback); };
  host.prompt.submit = async () => { await invoke("turn.start"); };
  // The host retries one plugin compaction for the same window: one artifact, one draw.
  host.session.compact = async ({ instructions }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await invoke("session.compact", { trigger: "plugin", instructions: instructions ?? "" }) as { messages: Array<{ role: string; text: string }> };
      lines.push(result.messages[1]!.text);
    }
    return { skip: "test default" };
  };
  assert.match(((await invoke("command.run", { command: "fresh-window", args: "" })) as { text: string }).text, /Brain being emptied/);
  await Promise.resolve();
  await timers.shift()!();
  await invoke("turn.complete");
  assert.equal(draws.length, 1, "a retried compaction adds no second draw");
  assert.equal(lines.length, 2, "both attempts returned a handoff");
  assert.equal(lines[0], lines[1], "both attempts carry the same artifact's paragraph");
  assert.ok(FORCED_CONTINUATIONS.includes(lines[0]!), "Claude has no model reset tool, so its pool is always the forced one");
});

test("Claude session.end gives /clear, /resume and /branch a fresh boot and identity", async (t) => {
  for (const action of ["clear", "resume", "branch"]) {
    await t.test(action, async (t) => {
      const { host, invoke, context } = await retainedFixture(t);
      host.session.usage = async () => ({ context: { tokens: 142_424, window: 200_000 } });
      assert.deepEqual((await invoke("prompt.submit", { text: "continue" }, {}, async (e) => e) as { context: string[] }).context, [CLAUDE_WARNING_PROMPT], "the old window has already warned");
      await invoke("turn.start");
      await invoke("command.run", { command: "empty" });
      const ended = { sentinel: action };
      assert.equal(await invoke("session.end", { reason: action === "clear" ? "clear" : "resume", sessionId: "hook-session" }, ended), ended);
      host.session.id = async () => `after-${action}`;
      host.session.messages = async () => [];
      // Clear the old running-turn and queued-reset state, not just the retained boot.
      let compactions = 0;
      host.session.compact = async () => { compactions++; return {}; };
      await invoke("turn.complete");
      assert.equal(compactions, 0, "the old queued reset cannot spill into the new session");
      const fresh = await context();
      assert.deepEqual(fresh.blocks.map((block) => block.name), ["notesoup:boot"]);
      assert.deepEqual((await invoke("prompt.submit", { text: "continue" }, {}, async (e) => e) as { context: string[] }).context, [CLAUDE_WARNING_PROMPT], "the new session can warn again");
      assert.match(fresh.blocks[0]!.text, new RegExp(`Current context window id: claude:after-${action}:0`));
      assert.doesNotMatch(fresh.blocks[0]!.text, /claude:hook-session:/);
      const requests: Array<{ identity?: { sessionId: string }; params?: Record<string, unknown> }> = [];
      const run = host.process.run;
      host.process.run = async (argv, init) => { requests.push(JSON.parse(init!.stdin!)); return run(argv, init); };
      const written = await invoke("tool.call", { tool: "mcp__notesoup__notes_write", tool_use_id: "new-session", address: "session.md", content: action }) as { result: string };
      assert.equal(written.result, "created session.md");
      assert.equal(requests[0]!.identity?.sessionId, `after-${action}`, "tools also use the new session home");
    });
  }
});

test("Claude lazy identity detects a switched session without session.start or session.end", async (t) => {
  const { host, context } = await retainedFixture(t);
  host.session.id = async () => "lazy-session";
  host.session.messages = async () => [];
  const fresh = await context();
  assert.deepEqual(fresh.blocks.map((block) => block.name), ["notesoup:boot"]);
  assert.match(fresh.blocks[0]!.text, /Current context window id: claude:lazy-session:0/);
});

test("Claude native compaction becomes a notes-only reset, a veto, or a pass-through", async (t) => {
  await t.test("manual and precompute are vetoed before upstream", async (t) => {
    for (const [trigger, pattern] of [["manual", /No compacting brains here/], ["precompute", /No precomputing brains here/]] as const) {
      const { invoke, context } = await retainedFixture(t);
      let upstreamCalls = 0;
      const result = await invoke("session.compact", { trigger, messages: [{ role: "user", text: "OLD" }] }, {},
        async () => { upstreamCalls++; return { messages: [{ role: "user", text: "SUMMARY" }] }; }) as { skip?: string; messages?: unknown };
      assert.equal(upstreamCalls, 0, `${trigger} never runs the summarizer`);
      assert.match(result.skip!, pattern);
      assert.equal(result.messages, undefined);
      assert.deepEqual((await context()).blocks, [], "the retained boot is untouched");
    }
  });
  await t.test("auto becomes the next window's notes boot", async (t) => {
    const { invoke } = await retainedFixture(t);
    let upstreamCalls = 0;
    const result = await invoke("session.compact", { trigger: "auto", messages: [{ role: "user", text: "OLD" }] }, {},
      async () => { upstreamCalls++; return { messages: [{ role: "user", text: "SUMMARY" }] }; }) as { messages: Array<{ role: string; text: string }> };
    assert.equal(upstreamCalls, 0, "an automatic compaction never runs the summarizer");
    assert.equal(result.messages.length, 2);
    assert.match(result.messages[0]!.text, /Current context window id: claude:hook-session:3/);
    assert.doesNotMatch(result.messages[0]!.text, /OLD/);
    assert.ok(FORCED_CONTINUATIONS.includes(result.messages[1]!.text));
    const upstream = { blocks: [{ name: "claude:user-context", text: "upstream" }] };
    const context = await invoke("prompt.context", {}, upstream) as { blocks: typeof upstream.blocks };
    assert.deepEqual(context.blocks, upstream.blocks, "the hijacked boot is retained, not injected again");
  });
  await t.test("a failed auto build falls back to native compaction", async (t) => {
    const { host, invoke } = await retainedFixture(t);
    const run = host.process.run;
    host.process.run = async (argv, init) => JSON.parse(init!.stdin!).op === "boot" ? { exitCode: 1, stdout: "" } : run(argv, init);
    const upstream = { messages: [{ role: "user", text: "SUMMARY" }], sentinel: "native" };
    let upstreamCalls = 0;
    const result = await invoke("session.compact", { trigger: "auto", messages: [{ role: "user", text: "OLD" }] }, upstream,
      async () => { upstreamCalls++; return upstream; });
    assert.equal(upstreamCalls, 1, "an over-long prompt still compacts natively");
    assert.equal(result, upstream);
  });
  await t.test("foreign plugin, veto, subagent and kept boot still pass through", async (t) => {
    for (const mode of ["foreign plugin", "veto", "subagent", "kept boot"]) {
      await t.test(mode, async (t) => {
        const { host, invoke, context } = await retainedFixture(t);
        const event = { trigger: mode === "subagent" ? "manual" : "plugin", messages: [{ role: "user", text: "OLD" }], ...(mode === "subagent" ? { agentId: "child" } : {}) };
        const upstream = mode === "veto" ? { skip: "user veto" } : {
          messages: mode === "kept boot" ? await host.session.messages() : [{ role: "user", text: "SUMMARY" }], sentinel: mode,
        };
        let upstreamCalls = 0;
        const result = await invoke("session.compact", event, upstream, async () => { upstreamCalls++; return upstream; });
        assert.equal(upstreamCalls, 1, "the engine's compaction is passed through");
        assert.equal(result, upstream);
        const after = await context();
        if (mode === "foreign plugin") {
          assert.deepEqual(after.blocks.map((block) => block.name), ["notesoup:boot"]);
          assert.match(after.blocks[0]!.text, /Current context window id: claude:hook-session:2/);
        } else {
          assert.deepEqual(after.blocks, [], "veto, subagent and kept boot leave the main boot alone");
        }
      });
    }
  });
});

test("Claude serves every registered notes tool to subagents without leaking event fields into params", async (t) => {
  const { invoke } = await retainedFixture(t);
  const call = (tool: string, params: Record<string, unknown>) => invoke("tool.call", {
    tool: `mcp__notesoup__${tool}`, tool_use_id: "child-call", agentId: "child", ...params,
  }) as Promise<{ result: string; isError?: boolean }>;
  assert.equal((await call("notes_write", { address: "child.md", content: "child body" })).result, "created child.md");
  assert.match((await call("notes_read", { address: "child.md" })).result, /child body/);
  assert.equal((await call("notes_update", { address: "child.md", edits: [{ oldText: "child body", newText: "updated body" }] })).isError, undefined);
  assert.match((await call("notes_list", {})).result, /child\.md/);
  assert.match((await call("notes_search", { query: "updated body" })).result, /child\.md/);
  assert.equal((await call("notes_read", { address: "absent.md" })).isError, true, "refusals retain the error discriminator in subagents");
});

test("Claude identity uses the documented current model and cwd, with a safe model fallback", async (t) => {
  const { host, home, invoke } = await retainedFixture(t);
  let model = "Claude Opus 4.6";
  let cwd = home;
  host.session.model = async () => model;
  host.session.cwd = async () => cwd;
  const seen: Array<{ identity: { model: string; cwd: string }; params: unknown }> = [];
  const run = host.process.run;
  host.process.run = async (argv, init) => {
    const request = JSON.parse(init!.stdin!);
    if (request.op === "tool") seen.push(request);
    return run(argv, init);
  };
  const write = (address: string, content: string) => invoke("tool.call", { tool: "mcp__notesoup__notes_write", tool_use_id: "model-call", address, content }) as Promise<{ result: string }>;
  assert.equal((await write("@model/model.md", "opus")).result, "created @model/model.md");
  assert.equal(seen.at(-1)!.identity.model, "claude-opus-4-6");
  assert.ok(readFileSync(join(home, "models/claude-opus-4-6/model.md"), "utf8").includes("opus"));
  model = "Claude Sonnet 4.6";
  cwd = mkdtempSync(join(tmpdir(), "claude-cwd-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  await write("@model/model.md", "sonnet");
  assert.equal(seen.at(-1)!.identity.model, "claude-sonnet-4-6");
  assert.equal(seen.at(-1)!.identity.cwd, cwd, "a /cd or worktree move is not frozen at session.start");
  assert.ok(readFileSync(join(home, "models/claude-sonnet-4-6/model.md"), "utf8").includes("sonnet"));
  host.session.model = async () => { throw new Error("model unavailable"); };
  await write("@model/model.md", "fallback");
  assert.equal(seen.at(-1)!.identity.model, "claude");
});

test("Claude current-cwd project resolution shares Pi's remote home across checkout spellings", async (t) => {
  const { host, home, invoke } = await retainedFixture(t);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-project-home-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, "api");
  const second = join(root, "renamed");
  for (const [cwd, remote] of [[first, "git@HOST:team/backend.git"], [second, "https://host/team/backend.git"]]) {
    mkdirSync(join(cwd!, ".git"), { recursive: true });
    writeFileSync(join(cwd!, ".git/config"), `[remote "origin"]\nurl = ${remote}\n`);
  }
  let cwd = first;
  host.session.cwd = async () => cwd;
  const piIdentity = notesIdentityFromPi(context(manager(), undefined, undefined, true, first), home);
  assert.equal(piIdentity.projectKey, "api");
  await createNotesStore(piIdentity).write("@project/shared", "Pi body");
  const call = (tool: string, params: Record<string, unknown>) => invoke("tool.call", {
    tool: `mcp__notesoup__${tool}`, tool_use_id: "project-call", ...params,
  }) as Promise<{ result: string; isError?: boolean }>;
  assert.match((await call("notes_read", { address: "@project/shared" })).result, /Pi body/);
  cwd = second;
  const written = await call("notes_write", { address: "@project/shared", content: "Claude body" });
  assert.equal(written.isError, undefined);
  assert.equal(written.result, "overwrote @project/shared.md (project api)");
  assert.equal((await createNotesStore(piIdentity).read("@project/shared"))?.body, "Claude body");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "project/api/.project"), "utf8")), { id: "host/team/backend", path: second });
  assert.equal(resolveProjectHome(second, home).name, piIdentity.projectKey);
});

test("Claude session.end cannot be undone by an in-flight old reset", async (t) => {
  const { host, invoke, context } = await retainedFixture(t);
  let prepared!: () => void;
  const ready = new Promise<void>((resolve) => { prepared = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  host.session.usage = async () => ({ context: { tokens: 170_000, window: 200_000 } });
  host.session.compact = async ({ instructions }) => {
    const result = await invoke("session.compact", { trigger: "plugin", instructions }) as { messages: Array<{ role: string; text: string }> };
    prepared();
    await hold;
    return result;
  };
  const finishing = invoke("turn.complete");
  await ready;
  await invoke("session.end", { reason: "clear", sessionId: "hook-session" });
  host.session.id = async () => "after-flight";
  host.session.messages = async () => [];
  host.session.usage = async () => ({ context: {} });
  release();
  await finishing;
  const fresh = await context();
  assert.deepEqual(fresh.blocks.map((block) => block.name), ["notesoup:boot"]);
  assert.match(fresh.blocks[0]!.text, /Current context window id: claude:after-flight:0/);
});

test("Claude history keeps classic transcript_path across startup, confirms append heads, and refuses subagent leakage", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-history-hook-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host, registered } = fakeEngine(home);
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const invoke = (name: string, event: Record<string, unknown> = {}, result: unknown = {}) => handlers.get(name)!(host, event, async () => result);
  const transcriptPath = join(home, "transcript.jsonl");
  const root = { type: "user", uuid: "root", parentUuid: null, sessionId: "hook-session", message: { role: "user", content: "old request" } };
  const attachment = { type: "attachment", uuid: "startup", parentUuid: "root", sessionId: "hook-session", rendered: [{ content: [{ type: "text", text: "startup injection" }] }] };
  const sibling = { type: "assistant", uuid: "sibling", parentUuid: "root", sessionId: "hook-session", message: { role: "assistant", content: "another branch" } };
  writeFileSync(transcriptPath, [root, attachment, sibling].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const call = (tool: string, params = {}, agentId?: string) => invoke("tool.call", { tool: `mcp__notesoup__${tool}`, tool_use_id: "probe", ...params, ...(agentId ? { agentId } : {}) }) as Promise<{ result: string; isError?: boolean }>;
  await invoke("classic.SessionStart", { session_id: "hook-session", transcript_path: transcriptPath, source: "startup" });
  // Real order: classic -> startup attachment appends -> typed session.start.
  await invoke("session.append", { uuid: "startup" }, { uuid: "startup", message: {} });
  await invoke("session.start", { cwd: home, isInteractive: true });
  assert.equal(registered.length, 8);
  const listed = await call("history_list", { roles: ["user", "context"] });
  assert.equal(listed.isError, undefined, listed.result);
  assert.match(listed.result, /old request/);
  assert.match(listed.result, /startup injection/);
  assert.doesNotMatch(listed.result, /another branch/);
  const boot = await invoke("prompt.context", {}, { blocks: [] }) as { blocks: Array<{ text: string }> };
  assert.match(boot.blocks[0]!.text, /mcp__notesoup__history_\*/);
  const subagent = await call("history_list", {}, "worker");
  assert.equal(subagent.isError, true);
  assert.match(subagent.result, /unavailable for subagents/);
  // Subagent classic payloads/append results must not overwrite the main binding.
  await invoke("classic.SessionStart", { session_id: "hook-session", transcript_path: "/wrong/subagent.jsonl", source: "startup", agent_id: "worker" });
  await invoke("session.append", { uuid: "subagent", agentId: "worker" }, { uuid: "subagent" });
  assert.equal((await call("history_read", { seq: 1 })).isError, undefined);
  // A resumed head is not supplied by SessionStart or messages(); don't use the last file row.
  await invoke("classic.SessionStart", { session_id: "hook-session", transcript_path: transcriptPath, source: "resume" });
  const beforeAppend = await call("history_list");
  assert.equal(beforeAppend.isError, true);
  assert.match(beforeAppend.result, /no confirmed active head/);
  await invoke("session.append", { uuid: "sibling" }, { uuid: "sibling" });
  const switched = await call("history_list");
  assert.match(switched.result, /another branch/);
  assert.doesNotMatch(switched.result, /startup injection/);
});

test("Claude history without a documented path refuses honestly and keeps notes usable", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-no-history-path-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host } = fakeEngine(home);
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  await handlers.get("session.start")!(host, { cwd: home, isInteractive: true }, async () => ({}));
  const history = await handlers.get("tool.call")!(host, { tool: "mcp__notesoup__history_windows", tool_use_id: "history" }, async () => ({})) as { result: string; isError?: boolean };
  assert.equal(history.isError, true);
  assert.match(history.result, /transcript_path is unavailable/);
  const notes = await handlers.get("tool.call")!(host, { tool: "mcp__notesoup__notes_list", tool_use_id: "notes" }, async () => ({})) as { result: string; isError?: boolean };
  assert.equal(notes.isError, undefined);
  const boot = await handlers.get("prompt.context")!(host, {}, async () => ({ blocks: [] })) as { blocks: Array<{ text: string }> };
  assert.match(boot.blocks[0]!.text, /History isn't available.*no main transcript_path/);
});
