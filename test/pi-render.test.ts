import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { emptyBrainRenderers, notesReadRenderers, notesUpdateRenderers, notesWriteRenderers } from "../plugins/pi/render.js";
import { success, wireResult, type Outcome } from "../src/tools/result.js";

/** Flat theme for content assertions; strikethrough marks its text so crumple stays visible. */
const flatTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => `~~${text}~~`,
} as unknown as Theme;

function toolResult<T>(outcome: Outcome<T>): AgentToolResult<undefined> {
	return { content: [{ type: "text", text: "receipt" }], structuredContent: wireResult(outcome) as never, isError: !outcome.ok, details: undefined };
}

function jsonResult(value: unknown, isError = false): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: JSON.stringify(value) }], isError, details: undefined };
}

function lines(component: { render: (width: number) => string[] }, width = 80): string {
	return component.render(width).map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
}

test("notes_write collapsed: outcome, address and content size", () => {
	const result = toolResult(success({ address: "@self/grudge.md", outcome: "created" }));
	const component = notesWriteRenderers.renderResult(result, { expanded: false }, flatTheme, { args: { address: "@self/grudge.md", content: "hello" } });
	assert.equal(lines(component), "wrote @self/grudge.md · 5 chars");
});

test("notes_write expanded: the written content follows the header", () => {
	const result = toolResult(success({ address: "plan.md", outcome: "overwrote" }));
	const component = notesWriteRenderers.renderResult(result, { expanded: true }, flatTheme, { args: { address: "plan.md", content: "one\ntwo" } });
	assert.equal(lines(component), "wrote plan.md · overwrote · 7 chars\n\none\ntwo");
});

test("notes_update edited: collapsed peeks at the first added line", () => {
	const result = toolResult(success({ address: "a.md", change_kind: "body", diff: " 1 old\n-2 gone\n+2 here" }));
	const component = notesUpdateRenderers.renderResult(result, { expanded: false }, flatTheme, { args: { address: "a.md" } });
	assert.equal(lines(component), "edited a.md · + here");
});

test("notes_update crumple: the address is struck through", () => {
	const result = toolResult(success({ address: "@self/stale.md", change_kind: "metadata", diff: "" }));
	const component = notesUpdateRenderers.renderResult(result, { expanded: false }, flatTheme, { args: { address: "@self/stale.md", crumpled: true } });
	assert.equal(lines(component), "✂ crumpled ~~@self/stale.md~~");
});

test("notes_update moved: both addresses stay on the line", () => {
	const result = toolResult(success({ address: "@self/new.md", change_kind: "moved", diff: "rename a.md -> @self/new.md", rename_from: "a.md" }));
	const component = notesUpdateRenderers.renderResult(result, { expanded: false }, flatTheme, { args: { address: "a.md", rename_to: "@self/new.md" } });
	assert.equal(lines(component), "renamed a.md → @self/new.md");
});

test("notes_update unchanged keeps quiet", () => {
	const result = toolResult(success({ address: "a.md", change_kind: "none", diff: "" }));
	const component = notesUpdateRenderers.renderResult(result, { expanded: false }, flatTheme, { args: { address: "a.md" } });
	assert.equal(lines(component), "unchanged a.md");
});

test("notes_read collapsed: size and a peek at the first line", () => {
	const result = toolResult(success({ address: "@project/MAP.md", metadata: { origin: "self", created_at: "x", updated_at: "y", extra: {} }, text: "# MAP\n\nbody", total_chars: 11, next_offset_chars: null }));
	const component = notesReadRenderers.renderResult(result, { expanded: false }, flatTheme);
	assert.equal(lines(component), "read @project/MAP.md · 11 chars — # MAP");
});

test("notes_read expanded: truncation points at the next offset", () => {
	const result = toolResult(success({ address: "a.md", metadata: { origin: "self", created_at: "x", updated_at: "y", extra: {} }, text: "part", total_chars: 10, next_offset_chars: 4 }));
	const component = notesReadRenderers.renderResult(result, { expanded: true }, flatTheme);
	assert.equal(lines(component), "read a.md · 10 chars · truncated — part\n\npart\n… continue at offset_chars=4");
});

test("refusals render as one error line with the code", () => {
	const result = toolResult({ ok: false, error: { code: "not_found", message: "No note at x.md." } });
	const component = notesReadRenderers.renderResult(result, { expanded: false }, flatTheme);
	assert.equal(lines(component), "not_found: No note at x.md.");
});

test("results without a structured payload fall back to the receipt line", () => {
	const result: AgentToolResult<undefined> = { content: [{ type: "text", text: "created a.md" }], isError: false, details: undefined };
	const component = notesWriteRenderers.renderResult(result, { expanded: false }, flatTheme, { args: { address: "a.md", content: "x" } });
	assert.equal(lines(component), "created a.md");
});

test("empty_brain: divider with the last word, refusals in one line", () => {
	initTheme();
	const ok = emptyBrainRenderers.renderResult(jsonResult({ status: "rollover_requested" }), { expanded: false }, flatTheme, { args: { last_word: "cake was worth it" } });
	const rendered = lines(ok, 40).split("\n");
	assert.match(rendered[0] ?? "", /^── ✂ brain emptied ─+$/);
	assert.equal(rendered[1], "“cake was worth it”");
	const refused = emptyBrainRenderers.renderResult(jsonResult({ error: "notesoup is off" }, true), { expanded: false }, flatTheme, { args: {} });
	assert.equal(lines(refused), "✂ brain refused to empty — notesoup is off");
	const pending = emptyBrainRenderers.renderResult(jsonResult({ status: "rollover_already_pending" }), { expanded: false }, flatTheme, { args: {} });
	assert.equal(lines(pending), "✂ brain already being emptied");
});

test("notes_update expanded diff goes through the host's diff renderer", () => {
	initTheme();
	const result = toolResult(success({ address: "a.md", change_kind: "body", diff: " 1 old\n-2 gone\n+2 here" }));
	const component = notesUpdateRenderers.renderResult(result, { expanded: true }, flatTheme, { args: { address: "a.md" } });
	assert.equal(lines(component), "edited a.md · + here\n\n 1 old\n-2 gone\n+2 here");
});
