import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_REMINDER_MARGIN_TOKENS, DEFAULT_RESERVE_TOKENS } from "../src/budget/constants.js";
import { GUIDANCE_TYPE, WARNING_TYPE } from "../plugins/pi/entries.js";
import { NOTESOUP_SETTINGS_KEY } from "../src/settings.js";
import {
	appendText,
	call,
	commitTurnEndBoundary,
	context,
	makeExtension,
	manager,
	noticesOf,
	resultJson,
	runContextHook,
	runHandlers,
	runCommand,
	sentOf,
	settingsFixture,
	writeJson,
} from "./helpers/extension.js";
import { installExtensionTestHooks } from "./helpers/extension-test-environment.js";

const testEnvironment = installExtensionTestHooks("notesoup-integration");

test("low-budget guidance and warning persist at turn_end, once per active window", async () => {
	const sessionManager = manager();
	const captured = makeExtension(sessionManager);
	const low = context(sessionManager, undefined, { tokens: 165_000, percent: 82.5, contextWindow: 200_000 });
	const guidance = await runContextHook(captured, low);
	assert.deepEqual(guidance?.messages.map((message) => (message as { customType?: string }).customType), [GUIDANCE_TYPE], "guidance reaches the crossing request");
	assert.match(String((guidance?.messages[0] as { content?: string }).content), /About 18616 tokens of room left in your brain\./, "the reminder reports room to the reserve, not to the warning");
	assert.equal(captured.sent.length, 0, "guidance does not trigger a detached turn");
	const guidanceBoundary = await commitTurnEndBoundary(captured, sessionManager, low);
	assert.equal(guidanceBoundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE).length, 1);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE).length, 1);
	assert.equal(await runContextHook(captured, low), undefined, "the same window does not repeat guidance");

	const warningContext = context(sessionManager, undefined, { tokens: 199_000, percent: 99.5, contextWindow: 200_000 });
	const warning = await runContextHook(captured, warningContext);
	assert.equal(warning?.messages.length, 1, "the warning is visible in the current provider request");
	assert.equal((warning?.messages[0] as { customType?: string }).customType, WARNING_TYPE);
	const warningBoundary = await commitTurnEndBoundary(captured, sessionManager, warningContext);
	assert.equal(warningBoundary.entries.filter((entry) => entry.type === "custom_message" && entry.customType === WARNING_TYPE).length, 1);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === WARNING_TYPE).length, 1);
});

test("early guidance stays silent and the final warning notifies immediately once", async () => {
	const sm = manager();
	const captured = makeExtension(sm);
	const early = context(sm, undefined, { tokens: 165_000, percent: 82.5, contextWindow: 200_000 });
	assert.equal((await runContextHook(captured, early))?.messages.length, 1, "early guidance reaches the crossing request");
	await commitTurnEndBoundary(captured, sm, early);
	await runHandlers(captured, "agent_settled", {}, early);
	assert.equal(noticesOf(early).filter((notice) => notice.message.includes("Context running low") || notice.message.includes("Context almost full")).length, 0, "early model guidance has no UI toast");
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE).length, 1, "early guidance remains durable for the model");

	const final = context(sm, undefined, { tokens: 181_000, percent: 90.5, contextWindow: 200_000 });
	const warning = await runContextHook(captured, final);
	assert.equal((warning?.messages[0] as { customType?: string } | undefined)?.customType, WARNING_TYPE);
	assert.equal(noticesOf(final).filter((notice) => notice.message === "🥣 Brain almost full · taking notes").length, 1, "notify at injection, before any turn_end");
	await runContextHook(captured, final);
	await commitTurnEndBoundary(captured, sm, final);
	await runHandlers(captured, "turn_start", {}, final);
	await runHandlers(captured, "agent_settled", {}, final);
	assert.equal(noticesOf(final).filter((notice) => notice.message === "🥣 Brain almost full · taking notes").length, 1, "repeated injection and commit do not notify again");
});

test("the reported room ends at the hard reserve, clamps at zero, and preserves unknown usage", async () => {
	const fixture = settingsFixture({
		reserveTokens: 16_384,
		project: { compaction: { reserveTokens: 32_768 } },
	});
	const sm = manager();
	const captured = makeExtension(sm);
	await runHandlers(captured, "session_tree", {}, context(sm, undefined, undefined, true, fixture.cwd, true));
	const readBudget = async (tokens: number | null, trusted = true) => {
		const ctx = context(sm, undefined, { tokens, contextWindow: 200_000, percent: tokens === null ? null : tokens / 2000 }, true, fixture.cwd, trusted);
		return resultJson<{ remaining_tokens: number | null }>(await call(captured, "get_context_remaining", {}, ctx)).remaining_tokens;
	};
	assert.equal(await readBudget(72_563), 94_669, "the reported room excludes only the project reserve (32768)");
	assert.equal(await readBudget(150_848), 16_384, "the warning line still has the entire runway left");
	assert.equal(await readBudget(167_232), 0, "the hard reserve reads zero");
	assert.equal(await readBudget(190_000), 0, "below the reserve, still zero");
	assert.equal(await readBudget(210_000), 0, "over the physical window");
	assert.equal(await readBudget(null), null, "unknown usage remains unknown");
	const absent = context(sm, undefined, undefined, true, fixture.cwd);
	assert.equal(resultJson<{ remaining_tokens: number | null }>(await call(captured, "get_context_remaining", {}, absent)).remaining_tokens, null);
	const untrusted = context(sm, undefined, { tokens: 72_563, contextWindow: 200_000, percent: 36.2815 }, true, fixture.cwd, false);
	await runHandlers(captured, "session_start", {}, untrusted);
	assert.equal(await readBudget(72_563, false), 111_053, "session start reloads the global reserve when the project is untrusted");
});

test("absent notesoup key or margins reproduce the default reminder threshold at Pi's default reserve", async () => {
	assert.equal(DEFAULT_RESERVE_TOKENS, 16_384);
	assert.equal(DEFAULT_RESERVE_TOKENS + DEFAULT_REMINDER_MARGIN_TOKENS, 40_960);

	for (const [label, options] of [
		["absent key", { global: {} }],
		["absent margins", { global: { [NOTESOUP_SETTINGS_KEY]: {} } }],
	] as const) {
		const fixture = settingsFixture(options);
		const sm = manager();
		const captured = makeExtension(sm);
		// Thresholds are resolved once per session and cached; branch navigation clears the
		// cache without emitting a boot block, so the next read uses this fixture.
		await runHandlers(captured, "session_tree", {}, context(sm, undefined, undefined, true, fixture.cwd));
		const window = 200_000;
		const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
		const first = at(40_961);
		assert.equal(await runContextHook(captured, first), undefined, `${label}: nothing injected above the default reminder`);
		assert.equal(sentOf(captured, GUIDANCE_TYPE).length, 0, `${label}: no guidance above the default reminder`);
		const crossing = at(40_960);
		assert.equal((await runContextHook(captured, crossing))?.messages.length, 1, `${label}: default reminder crossing reaches the request`);
		await commitTurnEndBoundary(captured, sm, crossing);
		assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE).length, 1, `${label}: default reminder fires`);
		assert.equal(noticesOf(first).length, 0, `${label}: valid defaults warn nobody`);
	}
});

test("project notesoup reminder margin and reserve override global per key", async () => {
	const fixture = settingsFixture({
		reserveTokens: 20_000,
		global: { [NOTESOUP_SETTINGS_KEY]: { reminderMarginTokens: 30_000 } },
		project: { compaction: { reserveTokens: 50_000 }, [NOTESOUP_SETTINGS_KEY]: { reminderMarginTokens: 40_000 } },
	});
	// Project reserve wins: reminder = 50000 + 40000 (project margin).
	const sm = manager();
	const captured = makeExtension(sm);
	await runHandlers(captured, "session_tree", {}, context(sm, undefined, undefined, true, fixture.cwd));
	const window = 300_000;
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
	assert.equal(await runContextHook(captured, at(90_001)), undefined, "nothing injected above the project-derived reminder");
	assert.equal(sentOf(captured, GUIDANCE_TYPE).length, 0);
	const crossing = at(90_000);
	assert.equal((await runContextHook(captured, crossing))?.messages.length, 1, "project-derived reminder crossing reaches the request");
	await commitTurnEndBoundary(captured, sm, crossing);
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE).length, 1, "project reminder margin wins");
});

test("an invalid reminder margin degrades to its default with one warning and never throws", async () => {
	const fixture = settingsFixture({ global: { [NOTESOUP_SETTINGS_KEY]: { reminderMarginTokens: 0 } } });
	const sm = manager();
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, undefined, true, fixture.cwd);
	await assert.doesNotReject(() => runHandlers(captured, "session_start", { reason: "startup" }, ctx));
	const notices = noticesOf(ctx).filter((notice) => notice.type === "warning");
	assert.equal(notices.length, 1, "one warning for the offending key");
	assert.equal(notices[0]?.type, "warning");
	assert.match(notices[0]?.message ?? "", /reminderMarginTokens/);
	assert.match(notices[0]?.message ?? "", /using the default/);
	assert.equal(/\d+\s*k?\s*(remaining|tokens)/i.test(notices[0]?.message ?? ""), false, "UI notices do not expose token counts");

	const window = 200_000;
	const at = (remaining: number) => context(sm, undefined, { tokens: window - remaining, percent: 0, contextWindow: window }, true, fixture.cwd);
	// The degraded reminder is Pi's default reserve + default margin = 40960.
	assert.equal(await runContextHook(captured, at(40_961)), undefined, "nothing injected above the degraded reminder");
	const crossing = at(40_960);
	assert.equal((await runContextHook(captured, crossing))?.messages.length, 1, "degraded reminder uses its default");
	await commitTurnEndBoundary(captured, sm, crossing);
	assert.equal(sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === GUIDANCE_TYPE).length, 1, "the degraded reminder is persisted once");
	assert.equal(noticesOf(ctx).filter((notice) => notice.type === "warning").length, 1, "warning stays one-time across handler calls");
});

test("the warning supersedes the early reminder when usage jumps across both thresholds", async () => {
	const sm = manager();
	appendText(sm, "user", "ongoing work");
	const captured = makeExtension(sm);
	const ctx = context(sm, undefined, { tokens: 199_000, percent: 99.5, contextWindow: 200_000 }, false);
	const warningResult = await runContextHook(captured, ctx);
	assert.deepEqual(warningResult?.messages.map((message) => (message as { customType?: string }).customType), [WARNING_TYPE]);
	await commitTurnEndBoundary(captured, sm, ctx);
	const reloaded = makeExtension(sm);
	await runHandlers(reloaded, "context", { messages: [] }, ctx);
	assert.equal(reloaded.sent.length, 0, "persisted warning also suppresses a late reminder after reload");
});
