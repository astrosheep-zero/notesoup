import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BOOT_TYPE, CONTINUATION_TYPE, MARKER_TYPE, RESET_MARKER_TYPE } from "../plugins/pi/entries.js";
import { nextHistorySeq } from "../plugins/pi/history.js";
import { MARKER_INTERVAL } from "../plugins/pi/marker.js";
import { appendText, context, installExtensionTestEnvironment, makeExtension, runCommand, runHandlers, sentOf } from "./helpers/extension.js";

const env = installExtensionTestEnvironment("notesoup-marker-test");
test.beforeEach(env.beforeEach);
test.afterEach(env.afterEach);
test.after(env.dispose);

function turnStart(captured: ReturnType<typeof makeExtension>, ctx: ReturnType<typeof context>) {
	return runHandlers(captured, "turn_start", { type: "turn_start" }, ctx);
}

test("marker stamps its own seq once the interval is reached, then holds", async () => {
	const sessionManager = managerWithMessages(49);
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);

	await turnStart(captured, ctx);
	const sent = sentOf(captured, MARKER_TYPE);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.message.details, { seq: 50 });
	assert.equal(sent[0]!.message.display, false);
	assert.equal(sent[0]!.options?.triggerTurn, false);
	assert.equal(sent[0]!.message.content, '<notesoup:marker seq="50" />');
	assert.equal(nextHistorySeq(ctx), 51, "the marker occupies the seq it names");

	// An immediate second turn is only one seq later: no new marker.
	await turnStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 1);

	// The next marker lands exactly one interval after the last.
	appendText(sessionManager, "user", "x".repeat(1));
	for (let i = 0; i < 48; i++) appendText(sessionManager, "assistant", "y");
	await turnStart(captured, ctx);
	const all = sentOf(captured, MARKER_TYPE);
	assert.equal(all.length, 2);
	assert.deepEqual(all[1]!.message.details, { seq: 100 });
});

test("no marker before the interval", async () => {
	const sessionManager = managerWithMessages(48);
	const captured = makeExtension(sessionManager);
	await turnStart(captured, context(sessionManager));
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);
	assert.equal(MARKER_INTERVAL, 50);
});

test("a reset tail awaiting repair closes the road to markers, then reopens it", async () => {
	const sessionManager = managerWithMessages(49);
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);

	// A marker with neither boot nor continuation still expects repair; stay out of its tail.
	sessionManager.appendCustomEntry(RESET_MARKER_TYPE, { windowId: "pcw:test:w1" });
	await turnStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);

	// Boot alone is still an open tail.
	sessionManager.appendCustomMessageEntry(BOOT_TYPE, "boot", false, { windowId: "pcw:test:w1" });
	await turnStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);

	// Once the shape is closed, the odometer continues across the reset: seq never restarted.
	sessionManager.appendCustomMessageEntry(CONTINUATION_TYPE, "continued", false);
	await turnStart(captured, ctx);
	const sent = sentOf(captured, MARKER_TYPE);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.message.details, { seq: 52 });
});

test("notesoup off silences the odometer", async () => {
	const sessionManager = managerWithMessages(49);
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	await runCommand(captured, "notesoup", "off", ctx);
	await turnStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);
});

function managerWithMessages(count: number) {
	const sessionManager = SessionManager.inMemory("/private/tmp/notesoup-marker-test");
	for (let i = 0; i < count; i++) appendText(sessionManager, i % 2 === 0 ? "user" : "assistant", `m${i}`);
	return sessionManager;
}
