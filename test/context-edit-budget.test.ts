import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerBudget } from "../plugins/pi/budget.js";
import { BOOT_TYPE, RESET_MARKER_TYPE } from "../plugins/pi/entries.js";
import { currentReset, isCheckpointBackedReset, windowUsage } from "../plugins/pi/window.js";
import {
	appendText, call, commitTurnEndBoundary, context, makeExtension, manager,
	nativeUsageContext, resultJson, runHandlers,
} from "./helpers/extension.js";
import { installExtensionTestHooks } from "./helpers/extension-test-environment.js";

installExtensionTestHooks("notesoup-context-edit");

function appendUsage(sm: ReturnType<typeof manager>, tokens: number, timestamp = Date.now()): string {
	const message: AssistantMessage = {
		role: "assistant", content: [{ type: "text", text: "response" }],
		api: "openai-responses", provider: "openai", model: "usage-fixture",
		stopReason: "stop", timestamp,
		usage: {
			input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	return sm.appendMessage(message);
}

function appendWindow(sm: ReturnType<typeof manager>, checkpoint: boolean): void {
	if (checkpoint) sm.appendCompaction("", null, 0);
	sm.appendCustomEntry(RESET_MARKER_TYPE, { windowId: "pcw:edited" });
	sm.appendCustomMessageEntry(BOOT_TYPE, "boot", false, { windowId: "pcw:edited" });
}

for (const kind of ["root", "checkpoint", "legacy"] as const) {
	test(`${kind} budget rejects assistant usage invalidated by a real context edit`, async (t) => {
		const sm = manager();
		if (kind !== "root") appendWindow(sm, kind === "checkpoint");
		const target = appendText(sm, "user", "long context ".repeat(25_000));
		appendUsage(sm, 100_000);
		const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16_384 } });
		const native = await nativeUsageContext(sm, settings);
		t.after(native.dispose);
		const { ctx } = native;
		const captured = makeExtension(sm, settings);
		const budget = registerBudget({ on() {}, registerTool() {} } as unknown as Parameters<typeof registerBudget>[0], () => true, settings);
		assert.equal(budget.hardReserveDue(ctx), true, "the original provider usage really reaches hard reserve");

		sm.appendContextEdit(target, { content: "short" });
		const leaf = sm.getLeafId();
		const rawEntries = sm.getBranch();
		const nativeUsage = ctx.getContextUsage();
		const usage = windowUsage(ctx);
		assert.ok(nativeUsage && nativeUsage.tokens !== null && usage && usage.tokens !== null);
		if (kind === "legacy") {
			// Legacy uses the vendored chars/3.5 estimator; native Pi uses chars/4.
			assert.ok(usage.tokens >= nativeUsage.tokens);
			assert.ok(usage.tokens <= Math.ceil(nativeUsage.tokens * 4 / 3.5) + sm.buildSessionProjection().messages.length);
		} else {
			assert.deepEqual(usage, nativeUsage, "native projection remains the usage authority");
		}
		assert.equal(budget.hardReserveDue(ctx), false);
		const room = resultJson<{ remaining_tokens: number | null }>(await call(captured, "get_context_remaining", {}, ctx)).remaining_tokens;
		assert.equal(room, usage.contextWindow - usage.tokens - settings.getCompactionSettings().reserveTokens);
		assert.ok(room !== null && room > 0, "shrinking the transcript restores spendable budget");
		assert.equal(sm.getLeafId(), leaf, "accounting never repairs itself by resetting");
		assert.deepEqual(sm.getBranch(), rawEntries, "usage selection does not mutate persisted history");
		const boundary = await commitTurnEndBoundary(captured, sm, ctx);
		assert.deepEqual(boundary.entries, [], "the real registered turn-end hook does not trigger a hard wipe");
		assert.equal(sm.getLeafId(), leaf);
		assert.equal(isCheckpointBackedReset(ctx), kind === "checkpoint");
	});
}

test("legacy estimation excludes prior windows and trusts only usage appended after the edit", async (t) => {
	const sm = manager();
	appendText(sm, "user", "old window ".repeat(40_000));
	appendUsage(sm, 300_000);
	appendWindow(sm, false);
	const target = appendText(sm, "user", "long current window ".repeat(15_000));
	appendUsage(sm, 100_000);
	const settings = SettingsManager.inMemory();
	const native = await nativeUsageContext(sm, settings);
	t.after(native.dispose);
	const { ctx } = native;
	sm.appendContextEdit(target, { content: "short" });
	const usage = windowUsage(ctx);
	assert.ok(usage && usage.tokens !== null);
	assert.equal(usage.tokens, ["boot", "short", "response"].reduce((sum, text) => sum + Math.ceil(text.length / 3.5), 0));
	assert.ok(ctx.getContextUsage()!.tokens! > usage.tokens, "native legacy projection still contains the old window");

	const freshTokens = 42_000;
	appendUsage(sm, freshTokens, Date.now() + 1);
	assert.equal(windowUsage(ctx)?.tokens, freshTokens, "fresh usage is not discarded with the stale responses");
	sm.appendContextEdit(target, { content: "tiny" });
	assert.ok(windowUsage(ctx)!.tokens! < freshTokens, "a second edit invalidates that usage too");
});

test("checkpoint usage preserves native unknown/unavailable values; legacy retains context-window fallback", async (t) => {
	const sm = manager();
	appendUsage(sm, 100_000);
	appendWindow(sm, true);
	const native = await nativeUsageContext(sm, SettingsManager.inMemory());
	t.after(native.dispose);
	assert.equal(native.ctx.getContextUsage()?.tokens, null, "Pi has no post-compaction provider usage yet");
	assert.deepEqual(windowUsage(native.ctx), native.ctx.getContextUsage(), "unknown is not replaced with a made-up estimate");
	const captured = makeExtension(sm, SettingsManager.inMemory());
	assert.equal(resultJson<{ remaining_tokens: null }>(await call(captured, "get_context_remaining", {}, native.ctx)).remaining_tokens, null);
	native.ctx.getContextUsage = () => undefined;
	assert.equal(windowUsage(native.ctx), undefined, "even a known model window cannot invent native usage");

	const legacy = manager();
	appendWindow(legacy, false);
	const fallback = context(legacy, undefined, { tokens: null, percent: null, contextWindow: 100_000 });
	assert.equal(windowUsage(fallback)?.contextWindow, 100_000, "legacy can read the window size without a model");
	fallback.getContextUsage = () => undefined;
	assert.equal(windowUsage(fallback), undefined, "without either window size, legacy usage stays unavailable");
});

test("an incomplete legacy reset remains unknown until the existing startup repair supplies its boot", async () => {
	const sm = manager();
	appendUsage(sm, 100_000);
	sm.appendCustomEntry(RESET_MARKER_TYPE, { windowId: "pcw:partial" });
	const ctx = context(sm, undefined, { tokens: 100_000, percent: 100, contextWindow: 100_000 });
	const marker = currentReset(ctx)?.id;
	assert.equal(windowUsage(ctx), undefined);
	const captured = makeExtension(sm, SettingsManager.inMemory());
	await runHandlers(captured, "session_start", { reason: "startup" }, ctx);
	assert.equal(currentReset(ctx)?.id, marker, "repair does not create a replacement reset");
	const usage = windowUsage(ctx);
	assert.ok(usage && usage.tokens !== null && usage.tokens < usage.contextWindow);
});
