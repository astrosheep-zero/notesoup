import assert from "node:assert/strict";
import test from "node:test";
import { brainEmptyTransformer } from "../client/brain-empty-transformer.ts";
import { brainEmptySchema } from "../shared/brain-empty.ts";

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
  assert.deepEqual(brainEmptySchema.parse(result!.items[0]!.data), { status: "failed", error: "failed" });
});

test("other tools and non-tool items stay untouched", () => {
  assert.equal(brainEmptyTransformer.transform({ item: toolCall({ name: "notes_read" }) as never }), undefined);
  assert.equal(brainEmptyTransformer.transform({ item: { type: "user_message", text: "hi" } as never }), undefined);
});
