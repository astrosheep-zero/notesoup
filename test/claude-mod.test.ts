import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { dispatch, handleLine, type ClaudeToolResult } from "../src/claude/helper.js";

const identity = { home: mkdtempSync(join(tmpdir(), "claude-mod-")), sessionId: "session", cwd: process.cwd(), agent: "claude", model: "claude" };

type ToolOutcome = { ok: boolean; error?: { code: string; message: string } };

type HookToolSpec = { name: string; description: string; inputSchema: Record<string, unknown>; isDeferred?: boolean };

/** One engine handler: it receives the engine, the event, and the rest of the chain. */
type HookHandler = ($: HookEngine, e: Record<string, unknown>, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
/** The engine surface the hook actually touches; no live model or user configuration. */
type HookEngine = {
  env: { get: (name: string) => Promise<string | undefined> };
  session: { id: () => Promise<string>; messages: () => Promise<Array<{ role: string; text: string }>>; usage: () => Promise<{ context: { percent?: number } }>; compact: (options: { instructions: string }) => Promise<{ skip?: string; messages?: Array<{ role: string; text: string }> }> };
  command: { register: (spec: { name: string; description: string; immediate?: boolean }) => Promise<unknown> };
  clock: { after: (ms: number, callback: () => void | Promise<void>) => unknown };
  prompt: { submit: (input: { text: string }) => Promise<unknown> };
  tool: { register: (spec: HookToolSpec) => Promise<{ tool: string }> };
  ui?: { notify?: (text: string, options?: { title?: string }) => Promise<unknown>; log?: (text: string) => void };
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
  const hooksDir = join(process.cwd(), "mods/notesoup/hooks");
  const transpiled = await build({
    stdin: { contents: readFileSync(join(hooksDir, "register.ts"), "utf8"), loader: "ts", resolveDir: hooksDir, sourcefile: "register.ts" },
    bundle: false, format: "esm", platform: "node", target: "node22", write: false,
    banner: { js: `import.meta.dir = ${JSON.stringify(hooksDir)};` },
  });
  const loaded = mkdtempSync(join(tmpdir(), "claude-hook-module-"));
  t.after(() => rmSync(loaded, { recursive: true, force: true }));
  const module = join(loaded, "register.mjs");
  writeFileSync(module, transpiled.outputFiles[0]!.text);
  return await import(pathToFileURL(module).href) as { register: (on: (event: string, handler: HookHandler) => void) => void };
}

/** An engine that answers the hook by running the real helper against a throwaway notes home. */
function fakeEngine(home: string): { host: HookEngine; registered: HookToolSpec[]; notifications: string[] } {
  const registered: HookToolSpec[] = [];
  const notifications: string[] = [];
  return {
    registered,
    notifications,
    host: {
      env: { get: async (name) => name === "PI_NOTES_HOME" ? home : undefined },
      session: { id: async () => "hook-session", messages: async () => [], usage: async () => ({ context: {} }), compact: async () => ({ skip: "test default" }) },
      command: { register: async (spec) => ({ command: spec.name }) },
      clock: { after: () => { throw new Error("test has no pending manual timer") } },
      prompt: { submit: async () => undefined },
      tool: { register: async (spec) => { registered.push(structuredClone(spec)); return { tool: `mcp__notesoup__${spec.name}` }; } },
      ui: { notify: async (text) => { notifications.push(text); }, log: (text) => { notifications.push(text); } },
      process: { run: async (argv, init) => ({
        exitCode: 0,
        stdout: execFileSync(argv[0]!, argv.slice(1), { cwd: init?.cwd, input: init?.stdin, encoding: "utf8" }),
      }) },
    },
  };
}

test("Claude helper exposes the five shared note schemas", async () => {
  const schemas = await dispatch({ op: "schemas" }) as Array<{ name: string; description: string; inputSchema: { type: string } }>;
  assert.deepEqual(schemas.map((schema) => schema.name), ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"]);
  assert.ok(schemas.every((schema) => schema.description.length > 20 && schema.inputSchema.type === "object"));
});

test("Claude helper delivers the shared text and the shared outcome it came from", async () => {
  const write = await callTool("notes_write", { address: "checkpoint.md", content: "hello" });
  assert.equal((write.outcome as ToolOutcome).ok, true);
  assert.match(write.text, /checkpoint\.md/);
  assert.equal(write.text.includes("READ WINDOW"), false, "Claude reads the same presentation as Pi");
  const missing = await callTool("notes_read", { address: "absent.md" });
  assert.equal((missing.outcome as ToolOutcome).ok, false);
  assert.equal((missing.outcome as Required<ToolOutcome>).error?.code, "not_found");
  assert.match(missing.text, /^error: not_found: /, "the refusal renders as the shared error line");
});

test("Claude helper rejects malformed or unknown requests", async () => {
  const malformed = JSON.parse(await handleLine("not json")) as { ok: boolean; error: string };
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /Unexpected|malformed/);
  const unknown = JSON.parse(await handleLine(JSON.stringify({ op: "tool", tool: "history_read", identity, params: {} }))) as { ok: boolean; error: string };
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "unknown tool");
});

test("Claude helper refuses schema-invalid parameters before any operation runs", async () => {
  const address = "boundary.md";
  const written = await callTool("notes_write", { address, content: "boundary body" });
  assert.equal((written.outcome as ToolOutcome).ok, true, "the fixture note exists before anything is refused");

  const cases: Array<{ name: string; params: Record<string, unknown> }> = [
    { name: "a string offset", params: { address, offset_chars: "0" } },
    { name: "a fractional offset", params: { address, offset_chars: 0.5 } },
    { name: "a zero limit", params: { address, max_chars: 0 } },
    { name: "a limit past the maximum", params: { address, max_chars: 999_999_999 } },
  ];
  for (const { name, params } of cases) {
    const refused = JSON.parse(await handleLine(JSON.stringify({ op: "tool", tool: "notes_read", identity, params }))) as { ok: boolean; error?: string };
    assert.equal(refused.ok, false, `${name} is refused at the boundary`);
    assert.equal(refused.error, "invalid notes_read parameters", `${name} names the refused parameters`);
  }
  await assert.rejects(callTool("notes_read", { address, offset_chars: "0" }), /invalid notes_read parameters/);

  // Refusal happens before execute: a rejected mutation leaves nothing on disk.
  await assert.rejects(callTool("notes_write", { address: "rejected.md", content: 42 }), /invalid notes_write parameters/);
  const absent = await callTool("notes_read", { address: "rejected.md" });
  assert.equal((absent.outcome as ToolOutcome).ok, false);
  assert.equal((absent.outcome as Required<ToolOutcome>).error?.code, "not_found", "the refused write never reached the store");

  const valid = await callTool("notes_read", { address, offset_chars: 0, max_chars: 8 });
  assert.equal((valid.outcome as ToolOutcome).ok, true, "a schema-valid window still reads");
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
  assert.doesNotMatch(boot, /memory cleared|continuation/);
});


test("Claude Mod helper runs from a standalone copied plugin directory", () => {
  const fixture = mkdtempSync(join(tmpdir(), "claude-mod-install-"));
  try {
    const plugin = join(fixture, "notesoup");
    cpSync(join(process.cwd(), "mods/notesoup"), plugin, { recursive: true });
    const hook = readFileSync(join(plugin, "hooks/register.ts"), "utf8");
    assert.ok(hook.includes('${import.meta.dir}/../dist/claude/helper.js'));
    const helper = join(plugin, "dist/claude/helper.js");
    const run = (input: string) => JSON.parse(execFileSync(process.execPath, [helper], {
      cwd: fixture, input, encoding: "utf8",
    })) as { ok: boolean; result?: Array<{ name: string }>; error?: string };
    const schemas = run('{"op":"schemas"}');
    assert.equal(schemas.ok, true);
    assert.equal(schemas.result?.length, 5);
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
  assert.equal(first.sentinel, "kept", "unrelated result fields survive");
  assert.equal(bootRequests, 1, "the first prompt makes exactly one boot helper request");
  assert.equal(nextCalls, 1, "the upstream chain runs exactly once per prompt");

  const second = await promptContext(await registerSession(), structuredClone(first));
  assert.deepEqual(second, first, "the persisted result, boot block and sentinel included, is reused unchanged");
  assert.equal(bootRequests, 1, "a persisted boot block needs no second boot helper request");
  assert.equal(nextCalls, 2, "the upstream chain still runs exactly once per prompt");
  assert.deepEqual(notifications, [], "successful boot never notifies");
});

test("Claude Mod boot failure preserves fallback with available, absent, or failing notifications", async (t) => {
  for (const mode of ["available", "no ui", "no notify", "throws", "rejects"] as const) {
    await t.test(mode, async (t) => {
      const hooks = await loadHookModule(t);
      const home = mkdtempSync(join(tmpdir(), "claude-hook-home-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const { host, notifications } = fakeEngine(home);
      if (mode === "no ui") delete host.ui;
      else if (mode === "no notify") host.ui = {};
      else if (mode === "throws" || mode === "rejects") {
        host.ui = { notify: (text) => {
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
        blocks: [...upstream.blocks, { name: "notesoup:boot", text: "# notesoup\nhelper exited unsuccessfully" }],
      }, "boot failure keeps the original fallback and upstream fields even if notify is absent or fails");
      const expectedNotifications = mode === "no ui" || mode === "no notify" ? [] : ["notesoup: Notes boot failed."];
      assert.deepEqual(notifications, expectedNotifications, "one user-facing notification names notesoup and the notes boot failure");
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
  assert.deepEqual(registered.map((spec) => spec.name), ["notes_write", "notes_update", "notes_read", "notes_list", "notes_search"]);
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
});


test("Claude Mod resets at 85 after the turn, retains one fresh boot and deduplicates measure", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-reset-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host, registered, notifications } = fakeEngine(home);
  const handlers = new Map<string, HookHandler>();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  const invoke = (name: string, event: Record<string, unknown> = {}) => handlers.get(name)!(host, event, async () => ({ sentinel: name }));
  let percent: number | undefined = 84;
  let compactions = 0;
  let kept: Array<{ role: string; text: string }> = [];
  host.session.usage = async () => ({ context: { percent } });
  host.session.compact = async ({ instructions }) => {
    compactions++;
    const result = await invoke("session.compact", { trigger: "plugin", instructions: `${instructions} (rewritten upstream)`, messages: [{ role: "user", text: "OLD_SECRET" }] }) as { messages: typeof kept };
    kept = result.messages;
    percent = undefined; // The real engine invalidates token usage after compact.
    return result;
  };
  await invoke("session.start", { cwd: home, isInteractive: true });
  assert.equal(registered.length, 5);
  const initial = await handlers.get("prompt.context")!(host, {}, async () => ({ blocks: [] })) as { blocks: Array<{ text: string }> };
  assert.match(initial.blocks[0]!.text, /Current context window id: claude:hook-session:0/);
  await invoke("turn.start");
  await invoke("session.measure");
  await invoke("turn.complete");
  assert.equal(compactions, 0, "84 is below the fixed threshold");
  host.session.usage = async () => { throw new Error("usage unavailable"); };
  await invoke("session.measure");
  await invoke("turn.complete");
  assert.equal(notifications.filter((text) => text.includes("context usage unavailable")).length, 1, "usage failure logs once per session");
  host.session.usage = async () => ({ context: { percent } });
  await dispatch({ op: "tool", tool: "notes_write", identity: { ...identity, home, cwd: home, sessionId: "hook-session" }, params: { address: "@human/MAP.md", content: "FRESH_NOTES_AT_RESET" } });
  await invoke("turn.start");
  percent = 85;
  await invoke("session.measure");
  assert.equal(compactions, 0, "measure cannot compact under a running turn");
  assert.deepEqual(await invoke("turn.complete"), { sentinel: "turn.complete" });
  assert.equal(compactions, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.role, "user");
  assert.match(kept[0]!.text, /Current context window id: claude:hook-session:1/);
  assert.match(kept[0]!.text, /Previous context window id: claude:hook-session:0/);
  assert.match(kept[0]!.text, /FRESH_NOTES_AT_RESET/);
  assert.doesNotMatch(kept[0]!.text, /OLD_SECRET/);
  await invoke("session.measure");
  assert.equal(compactions, 1, "invalidated percent cannot immediately reset twice");
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
  let percent: number | undefined;
  let attempts = 0;
  host.session.usage = async () => ({ context: { percent } });
  host.session.compact = async () => { attempts++; throw new Error("not available in a headless (-p / SDK) session yet"); };
  await invoke("session.start", { cwd: home, isInteractive: false });
  await invoke("turn.start");
  await invoke("turn.complete");
  await invoke("session.measure");
  assert.equal(attempts, 0, "no counters means no automatic reset");
  percent = 85;
  await invoke("turn.start");
  assert.deepEqual(await invoke("turn.complete"), { sentinel: "turn.complete" }, "a rejection does not break the turn chain");
  await invoke("session.measure");
  await invoke("turn.complete");
  assert.equal(attempts, 0, "headless sessions skip the unsupported capability from startup");
  assert.deepEqual(notifications, ["notesoup: reset skipped in headless (-p / SDK) session."]);
  const manual = await invoke("command.run", { command: "clear-memory" }) as { text: string };
  assert.match(manual.text, /reset skipped in headless/);
  assert.equal(notifications.length, 1);
  const boot = await handlers.get("prompt.context")!(host, {}, async () => ({ blocks: [] })) as { blocks: Array<{ text: string }> };
  assert.match(boot.blocks[0]!.text, /Current context window id: claude:hook-session:0/);
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
  host.session.usage = async () => ({ context: { percent: 85 } });
  let result: Awaited<ReturnType<HookEngine["session"]["compact"]>> = {};
  host.session.compact = async ({ instructions }) => result = await invoke("session.compact", { trigger: "plugin", instructions }) as typeof result;
  await invoke("turn.start");
  await invoke("turn.complete");
  assert.match(result.skip!, /Notes boot failed/);
  assert.equal(result.messages, undefined, "a failed builder must veto rather than fall through to summary");
  failBoot = false;
  await invoke("turn.start");
  await invoke("turn.complete");
  assert.equal(result.skip, undefined);
  assert.match(result.messages![0]!.text, /Current context window id: claude:hook-session:1/, "a failed reset never consumes a window ordinal");
});

test("Claude Mod manual reset uses one hidden close-out turn, then recovers its boot on reload", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "claude-manual-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { host } = fakeEngine(home);
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
  const command = await invoke("command.run", { command: "clear-memory" }) as { text: string };
  assert.match(command.text, /closing out/);
  await Promise.resolve();
  assert.equal(compactions, 0, "command.run must not call compact under its held turn");
  assert.equal(timers.length, 1);
  await timers.shift()!();
  assert.equal(prompts.length, 1, "exactly one hidden normal-model close-out turn, not a summary");
  assert.equal(compactions, 1);
  assert.match(kept[0]!.text, /Current context window id: claude:hook-session:1/);
  host.session.messages = async () => [{ role: "user", text: "OLD_SECRET" }, ...kept];
  handlers = new Map();
  (await loadHookModule(t)).register((event, handler) => handlers.set(event, handler));
  await invoke("session.start", { cwd: home, isInteractive: true });
  assert.deepEqual(await handlers.get("prompt.context")!(host, {}, async () => ({ blocks: [] })), { blocks: [] }, "reload does not duplicate the already-retained boot");
  await invoke("turn.start");
  await invoke("command.run", { command: "clear-memory" });
  await invoke("turn.complete");
  assert.equal(prompts.length, 1, "a busy manual request reuses the current turn instead of submitting another");
  assert.match(kept[0]!.text, /Current context window id: claude:hook-session:2/);
});


test("Claude dream skill projection stays byte-identical to canonical shared files", () => {
  assert.deepEqual(
    readFileSync(join(process.cwd(), "mods/notesoup/skills/dream/SKILL.md")),
    readFileSync(join(process.cwd(), "skills/dream/SKILL.md")),
  );
  assert.deepEqual(
    readFileSync(join(process.cwd(), "mods/notesoup/playbook.md")),
    readFileSync(join(process.cwd(), "playbook.md")),
  );
  const skill = readFileSync(join(process.cwd(), "mods/notesoup/skills/dream/SKILL.md"), "utf8");
  assert.match(skill, /\.\.\/\.\.\/playbook\.md/);
  assert.doesNotMatch(skill, /Claude.*runner|dream runner/i);
});
