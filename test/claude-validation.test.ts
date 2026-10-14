import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const plugin = join(process.cwd(), "plugins/claude");

/** Only an absent executable may skip the real loader gate; other failures fail the suite. */
function validate(t: test.TestContext, dir: string) {
  const result = spawnSync("claude", ["plugin", "validate", dir, "--strict", "--json"], {
    encoding: "utf8", timeout: 30_000,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    t.skip("Claude mod validation skipped: claude is not installed (not found on PATH)");
    return undefined;
  }
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  const report = JSON.parse(result.stdout) as {
    success: boolean;
    contents: Array<{ errors: Array<{ path: string; code: string | null }> }>;
  };
  return { ...result, report };
}

test("Claude mod passes the installed engine's strict loader validation", (t) => {
  const result = validate(t, plugin);
  if (!result) return;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.success, true, result.stdout);
  t.diagnostic("claude plugin validate plugins/claude --strict: passed");
});

test("Claude mod typechecks against the vendored engine contract without Node globals", () => {
  const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "plugins/claude/tsconfig.json"], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// Test each original ScanRefusal independently against the real scanner. A regression must
// fail the gate rather than silently transpile in our fake engine's lifecycle tests.
for (const mutation of [
  {
    name: "variable environment names",
    from: 'return await $.env.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE")',
    to: 'const name = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"; return await $.env.get(name)',
  },
  {
    name: "bound session usage ops",
    from: "const context = (await $.session.usage()).context",
    to: "const read = $.session.usage; const context = (await read()).context",
  },
  {
    name: "bound settings nouns",
    from: "return await $.settings.read()",
    to: "const settings = $.settings; return await settings.read()",
  },
]) {
  test(`Claude loader gate rejects ${mutation.name}`, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "claude-scanner-gate-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const dir = join(fixture, "notesoup");
    cpSync(plugin, dir, { recursive: true });
    const source = join(dir, "hooks/register.ts");
    const text = readFileSync(source, "utf8");
    assert.equal(text.split(mutation.from).length, 2, "one scanner-safe call site is mutated");
    writeFileSync(source, text.replace(mutation.from, mutation.to));
    const result = validate(t, dir);
    if (!result) return;
    assert.notEqual(result.status, 0, "the strict gate must fail a loader refusal");
    assert.equal(result.report.success, false);
    // This build emits a null error code for ScanRefusal, so use the module error path.
    assert.ok(result.report.contents.some((entry) => entry.errors.some((error) => error.path === "modules../register.ts")), result.stdout);
  });
}
