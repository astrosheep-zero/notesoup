import assert from "node:assert/strict";
import test from "node:test";
import { brainEmptyTransformer } from "../client/brain-empty-transformer.ts";
import { brainEmptySchema } from "../shared/brain-empty.ts";
import { claudeEmptyCompleted, claudeEmptyFailed } from "./fixtures/claude-tool-calls.ts";

function toolCall(overrides: Record<string, unknown>) {
  return {
    type: "tool_call" as const,
    callId: "call-1",
    name: "empty_brain",
    status: "completed" as const,
    error: null,
    detail: { type: "unknown" as const, input: {}, output: {} },
    ...overrides,
  };
}

const transform = (overrides: Record<string, unknown>) => brainEmptyTransformer.transform({ item: toolCall(overrides) as never });
const jsonOut = (value: unknown) => ({ type: "unknown", input: {}, output: { content: [{ type: "text", text: JSON.stringify(value) }] } });

test("a successful call is a completed divider with the rollover outcome", () => {
  const result = transform({ detail: jsonOut({ status: "rollover_requested" }) });
  assert.deepEqual(brainEmptySchema.parse(result!.items[0]!.data), { status: "completed", outcome: "rollover_requested" });
});

test("a successful call carries its last word for the divider modal", () => {
  const detail = jsonOut({ status: "rollover_requested" });
  const result = transform({ detail: { ...detail, input: { last_word: "  remember the shoe  " } } });
  assert.deepEqual(brainEmptySchema.parse(result!.items[0]!.data), {
    status: "completed", outcome: "rollover_requested", lastWord: "remember the shoe",
  });
});

test("an in-flight call shows as running from the call alone", () => {
  const result = transform({ status: "running", detail: { type: "unknown", input: { last_word: "bye" }, output: null } });
  assert.deepEqual(brainEmptySchema.parse(result!.items[0]!.data), { status: "running" });
});

test("a refused call surfaces the refusal text", () => {
  const result = transform({ detail: jsonOut({ error: "last_word is 263 characters; the sticky note holds 250." }) });
  const data = brainEmptySchema.parse(result!.items[0]!.data);
  assert.equal(data.error, "last_word is 263 characters; the sticky note holds 250.");
  assert.equal(data.outcome, undefined);
});

test("already-pending is an outcome, not an error", () => {
  const result = transform({ detail: jsonOut({ status: "rollover_already_pending" }) });
  assert.deepEqual(brainEmptySchema.parse(result!.items[0]!.data), { status: "completed", outcome: "rollover_already_pending" });
});

test("a failed transport call without a payload still fails", () => {
  const result = transform({ status: "failed", error: { message: "boom" }, detail: { type: "unknown", input: {}, output: null } });
  assert.deepEqual(brainEmptySchema.parse(result!.items[0]!.data), { status: "failed", error: "boom" });
});

test("Claude's plain acknowledgement completes the call without inventing a Pi rollover outcome", () => {
  const result = transform(claudeEmptyCompleted);
  assert.deepEqual(brainEmptySchema.parse(result!.items[0]!.data), { status: "completed" });
});

test("Claude empty_brain running and failed calls use the adapter's null output and raw error", () => {
  const running = transform({ ...claudeEmptyCompleted, status: "running", detail: { ...claudeEmptyCompleted.detail, output: null } });
  assert.deepEqual(brainEmptySchema.parse(running!.items[0]!.data), { status: "running" });
  assert.deepEqual(brainEmptySchema.parse(transform(claudeEmptyFailed)!.items[0]!.data), {
    status: "failed", error: "notesoup: only the main agent can empty this brain",
  });
  const blocks = transform({ ...claudeEmptyFailed, error: { ...claudeEmptyFailed.error, content: [{ type: "text", text: "notesoup: last_word must be a string" }] } });
  assert.deepEqual(brainEmptySchema.parse(blocks!.items[0]!.data), { status: "failed", error: "notesoup: last_word must be a string" });
});

test("Pi failed calls still surface text-block errors when no JSON receipt exists", () => {
  const result = transform({ status: "failed", detail: { type: "unknown", input: {}, output: { content: [{ type: "text", text: "io failed" }] } } });
  assert.deepEqual(brainEmptySchema.parse(result!.items[0]!.data), { status: "failed", error: "io failed" });
});

test("other tools and non-tool items stay untouched", () => {
  for (const name of ["notes_read", "mcp__other__empty_brain", "mcp__notesoup_extra__empty_brain", "mcp__notesoup__empty_brain_extra", "mcp__notesoup__mcp__notesoup__empty_brain"]) {
    assert.equal(transform({ name }), undefined, name);
  }
  assert.equal(brainEmptyTransformer.transform({ item: { type: "user_message", text: "hi" } as never }), undefined);
});
