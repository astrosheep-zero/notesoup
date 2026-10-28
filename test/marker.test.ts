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

function beforeAgentStart(captured: ReturnType<typeof makeExtension>, ctx: ReturnType<typeof context>) {
	return runHandlers(captured, "before_agent_start", { type: "before_agent_start" }, ctx);
}

test("marker stamps its own seq at run start once the interval is reached, never mid-turn", async () => {
	const sessionManager = managerWithMessages(119);
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);

	// Mid-run tool turns never inject a standalone marker message.
	await runHandlers(captured, "turn_start", { type: "turn_start" }, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);

	await beforeAgentStart(captured, ctx);
	const sent = sentOf(captured, MARKER_TYPE);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.message.details, { seq: 120 });
	assert.equal(sent[0]!.message.display, false);
	assert.equal(sent[0]!.options?.triggerTurn, false);
	assert.equal(sent[0]!.message.content, '<notesoup:marker seq="120" />');
	assert.equal(nextHistorySeq(ctx), 121, "the marker occupies the seq it names");

	// An immediate second run is only one seq later: no new marker.
	await beforeAgentStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 1);

	// The next marker lands one interval after the last.
	appendText(sessionManager, "user", "x");
	for (let i = 0; i < 118; i++) appendText(sessionManager, "assistant", "y");
	await beforeAgentStart(captured, ctx);
	const all = sentOf(captured, MARKER_TYPE);
	assert.equal(all.length, 2);
	assert.deepEqual(all[1]!.message.details, { seq: 240 });
});

test("no marker before the interval", async () => {
	const sessionManager = managerWithMessages(118);
	const captured = makeExtension(sessionManager);
	await beforeAgentStart(captured, context(sessionManager));
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);
	assert.equal(MARKER_INTERVAL, 120);
});

test("a reset tail awaiting repair blocks markers, and boot anchors the new window's interval", async () => {
	const sessionManager = managerWithMessages(119);
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);

	// A marker with neither boot nor continuation still expects repair; stay out of its tail.
	sessionManager.appendCustomEntry(RESET_MARKER_TYPE, { windowId: "pcw:test:w1" });
	await beforeAgentStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);

	// Boot alone is still an open tail.
	sessionManager.appendCustomMessageEntry(BOOT_TYPE, "boot", false, { windowId: "pcw:test:w1" });
	await beforeAgentStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);

	// Once the reset tail is closed, boot (seq 120) already anchored the window's start seq.
	sessionManager.appendCustomMessageEntry(CONTINUATION_TYPE, "continued", false);
	await beforeAgentStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);

	for (let i = 0; i < 118; i++) appendText(sessionManager, "assistant", "y");
	await beforeAgentStart(captured, ctx);
	const sent = sentOf(captured, MARKER_TYPE);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.message.details, { seq: 240 });
});

test("notesoup off silences the odometer", async () => {
	const sessionManager = managerWithMessages(119);
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	await runCommand(captured, "notesoup", "off", ctx);
	await beforeAgentStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);
});

function managerWithMessages(count: number) {
	const sessionManager = SessionManager.inMemory("/private/tmp/notesoup-marker-test");
	for (let i = 0; i < count; i++) appendText(sessionManager, i % 2 === 0 ? "user" : "assistant", `m${i}`);
	return sessionManager;
}
