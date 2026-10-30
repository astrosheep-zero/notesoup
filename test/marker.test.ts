import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { BOOT_TYPE, CONTINUATION_TYPE, MARKER_TYPE, RESET_MARKER_TYPE } from "../plugins/pi/entries.js";
import { nextHistorySeq } from "../plugins/pi/history.js";
import { buildMarkerDraft, MARKER_INTERVAL } from "../plugins/pi/marker.js";
import { appendText, call, commitTurnEndBoundary, context, installExtensionTestEnvironment, makeExtension, runCommand, runHandlers, sentOf } from "./helpers/extension.js";

const env = installExtensionTestEnvironment("notesoup-marker-test");
test.beforeEach(env.beforeEach);
test.afterEach(env.afterEach);
test.after(env.dispose);

function beforeAgentStart(captured: ReturnType<typeof makeExtension>, ctx: ReturnType<typeof context>) {
	return runHandlers(captured, "before_agent_start", { type: "before_agent_start" }, ctx);
}

test("marker stamps its own seq at run start once the interval is reached, never mid-turn", async () => {
	const sessionManager = managerWithMessages(99);
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);

	// Mid-run tool turns never inject a standalone marker message.
	await runHandlers(captured, "turn_start", { type: "turn_start" }, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);

	await beforeAgentStart(captured, ctx);
	const sent = sentOf(captured, MARKER_TYPE);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.message.details, { seq: 100 });
	assert.equal(sent[0]!.message.display, false);
	assert.equal(sent[0]!.options?.triggerTurn, false);
	assert.equal(sent[0]!.message.content, '<notesoup:marker seq="100" />');
	assert.equal(nextHistorySeq(ctx), 101, "the marker occupies the seq it names");

	// An immediate second run is only one seq later: no new marker.
	await beforeAgentStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 1);

	// The next marker lands one interval after the last.
	appendText(sessionManager, "user", "x");
	for (let i = 0; i < 98; i++) appendText(sessionManager, "assistant", "y");
	await beforeAgentStart(captured, ctx);
	const all = sentOf(captured, MARKER_TYPE);
	assert.equal(all.length, 2);
	assert.deepEqual(all[1]!.message.details, { seq: 200 });
});

test("turn-end appends a due marker without requesting continuation or duplicating it at run start", async () => {
	const sessionManager = managerWithMessages(99);
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	const boundary = await commitTurnEndBoundary(captured, sessionManager, ctx);
	assert.equal(boundary.continue, false);
	assert.deepEqual(boundary.entries, [{ type: "custom_message", customType: MARKER_TYPE, content: '<notesoup:marker seq="100" />', display: false, details: { seq: 100 } }]);
	assert.equal(nextHistorySeq(ctx), 101);
	await beforeAgentStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0, "the committed turn-end marker already anchored this interval");
});

test("marker seq includes incoming boundary drafts, and a drafted reset or boot suppresses another marker", () => {
	const ctx = context(managerWithMessages(98));
	const incoming: SessionBoundaryDraft[] = [{ type: "custom_message", customType: "other/context", content: "context", display: false }];
	assert.deepEqual(buildMarkerDraft(ctx, incoming)?.details, { seq: 100 });
	assert.equal(buildMarkerDraft(ctx, [{ type: "custom", customType: RESET_MARKER_TYPE, data: { windowId: "pcw:new" } }]), undefined);
	assert.equal(buildMarkerDraft(ctx, [{ type: "custom_message", customType: BOOT_TYPE, content: "boot", display: false }]), undefined);
});

test("a due tool reset uses its boot instead of inserting a marker in the reset boundary", async () => {
	const sessionManager = managerWithMessages(99);
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	await call(captured, "empty_brain", {}, ctx);
	const boundary = await commitTurnEndBoundary(captured, sessionManager, ctx);
	assert.ok(boundary.entries.some((entry) => entry.type === "custom_message" && entry.customType === BOOT_TYPE));
	assert.equal(boundary.entries.some((entry) => entry.type === "custom_message" && entry.customType === MARKER_TYPE), false);
	await beforeAgentStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);
});

test("no marker before the interval", async () => {
	const sessionManager = managerWithMessages(98);
	const captured = makeExtension(sessionManager);
	await beforeAgentStart(captured, context(sessionManager));
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);
	assert.equal(MARKER_INTERVAL, 100);
});

test("a reset tail awaiting repair blocks markers, and boot anchors the new window's interval", async () => {
	const sessionManager = managerWithMessages(99);
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

	// Once the reset tail is closed, boot (seq 100) already anchored the window's start seq.
	sessionManager.appendCustomMessageEntry(CONTINUATION_TYPE, "continued", false);
	await beforeAgentStart(captured, ctx);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);

	for (let i = 0; i < 98; i++) appendText(sessionManager, "assistant", "y");
	await beforeAgentStart(captured, ctx);
	const sent = sentOf(captured, MARKER_TYPE);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.message.details, { seq: 200 });
});

test("notesoup off silences the odometer", async () => {
	const sessionManager = managerWithMessages(99);
	const captured = makeExtension(sessionManager);
	const ctx = context(sessionManager);
	await runCommand(captured, "notesoup", "off", ctx);
	await beforeAgentStart(captured, ctx);
	const boundary = await commitTurnEndBoundary(captured, sessionManager, ctx);
	assert.equal(boundary.entries.length, 0);
	assert.equal(sentOf(captured, MARKER_TYPE).length, 0);
});

function managerWithMessages(count: number) {
	const sessionManager = SessionManager.inMemory("/private/tmp/notesoup-marker-test");
	for (let i = 0; i < count; i++) appendText(sessionManager, i % 2 === 0 ? "user" : "assistant", `m${i}`);
	return sessionManager;
}
