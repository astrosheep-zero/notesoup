import assert from "node:assert/strict";
import test from "node:test";
import { notesOpTransformer } from "../client/notes-op-transformer.ts";
import { OUTPUT_DISPLAY_MAX_CHARS, notesOpSchema } from "../shared/notes-op.ts";
import { claudeReadCompleted, claudeReadFailed, claudeUpdateCompleted, claudeWriteCompleted } from "./fixtures/claude-tool-calls.ts";

function toolCall(overrides: Record<string, unknown>) {
  return {
    type: "tool_call" as const,
    callId: "call-1",
    name: "notes_read",
    status: "completed" as const,
    error: null,
    detail: { type: "unknown" as const, input: { address: "@self/foo.md" }, output: {} },
    ...overrides,
  };
}

const transform = (overrides: Record<string, unknown>) => notesOpTransformer.transform({ item: toolCall(overrides) as never });

test("live and replay project the same complete delivered read, including continuation", () => {
  const body = "笔记🦈\n".repeat(3000) + "\n[truncated; continue at offset_chars=15000]";
  const content = [{ type: "text", text: `big.md\norigin self | created today | updated today\n\n${body}` }];
  const replay = transform({ detail: { type: "unknown", input: { address: "big.md" }, output: { content } } });
  const live = transform({ detail: { type: "unknown", input: { address: "big.md" }, output: {
    content, structuredContent: { text: body, next_offset_chars: 15000 },
  } } });
  assert.equal(notesOpSchema.parse(replay!.items[0]!.data).text, body);
  assert.deepEqual(live, replay);
});

test("write and moved update project the entire input and delivered diff", () => {
  const body = "long note\n".repeat(2000);
  const write = transform({ name: "notes_write", detail: { type: "unknown",
    input: { address: "a.md", content: body }, output: { content: [{ type: "text", text: "created a.md" }] },
  } });
  assert.equal(notesOpSchema.parse(write!.items[0]!.data).preview, body);
  const diff = "+ 1 + new\n".repeat(2000) + "[diff truncated; update applied]";
  const update = transform({ name: "notes_update", detail: { type: "unknown",
    input: { address: "a.md", rename_to: "b.md" },
    output: { content: [{ type: "text", text: `moved a.md -> b.md\ndiff:\n${diff}` }] },
  } });
  assert.deepEqual(notesOpSchema.parse(update!.items[0]!.data), {
    op: "update", address: "b.md", renamedFrom: "a.md", status: "completed", diff,
  });
});

test("oversized read, write and diff displays retain head and tail without changing history", () => {
  const body = "START\n" + "🦈".repeat(500_000) + "\nEND";
  for (const [name, field, receipt] of [
    ["notes_read", "text", `a.md\nmetadata\n\n${body}`],
    ["notes_write", "preview", "created a.md"],
    ["notes_update", "diff", `updated a.md\ndiff:\n${body}`],
  ] as const) {
    const source = { name, detail: { type: "unknown", input: { address: "a.md", content: body },
      output: { content: [{ type: "text", text: receipt }] } } };
    const before = JSON.stringify(source);
    const data = notesOpSchema.parse(transform(source)!.items[0]!.data);
    const preview = data[field]!;
    assert.ok(preview.length <= OUTPUT_DISPLAY_MAX_CHARS);
    assert.ok(preview.startsWith("START\n") && preview.endsWith("\nEND"));
    assert.match(preview, /middle is hidden/);
    assert.equal(Buffer.from(preview).toString("utf8"), preview);
    assert.equal(JSON.stringify(source), before);
  }
});

test("failed calls surface the refusal text; running calls need only input", () => {
  const failed = transform({ status: "failed", error: { message: "boom" },
    detail: { type: "unknown", input: { address: "a.md" }, output: { content: [{ type: "text", text: "io failed" }] } },
  });
  assert.equal(notesOpSchema.parse(failed!.items[0]!.data).error, "io failed");
  const running = transform({ status: "running", detail: { type: "unknown", input: { address: "a.md" }, output: null } });
  assert.deepEqual(notesOpSchema.parse(running!.items[0]!.data), { op: "read", address: "a.md", status: "running" });
});

test("history replay has no structured payload: the rendered text is parsed instead", () => {
  const read = transform({
    detail: { type: "unknown", input: { address: "@self/foo.md" }, output: { content: [{ type: "text", text: "@self/foo.md\norigin self | created 2026-10-15 | updated 2026-10-15\n\nbody line one\nbody line two" }] } },
  });
  assert.equal(notesOpSchema.parse(read!.items[0]!.data).text, "body line one\nbody line two");

  const write = transform({
    name: "notes_write",
    detail: { type: "unknown", input: { address: "a.md", content: "the new body" }, output: { content: [{ type: "text", text: "overwrote a.md (project pi-context)" }] } },
  });
  const writeData = notesOpSchema.parse(write!.items[0]!.data);
  assert.equal(writeData.preview, "the new body", "replay carries the call arguments, so the content preview comes from input on every path");

  const update = transform({
    name: "notes_update",
    detail: { type: "unknown", input: { address: "a.md" }, output: { content: [{ type: "text", text: "updated a.md\ndiff:\n- 1 - old\n+ 1 + new" }] } },
  });
  const updateData = notesOpSchema.parse(update!.items[0]!.data);
  assert.equal(updateData.diff, "- 1 - old\n+ 1 + new");

  const moved = transform({
    name: "notes_update",
    detail: { type: "unknown", input: { address: "a.md", rename_to: "b.md" }, output: { content: [{ type: "text", text: "moved a.md -> b.md" }] } },
  });
  assert.equal(notesOpSchema.parse(moved!.items[0]!.data).address, "b.md");
});

test("non-notes tools, unknown shapes and missing addresses stay untouched", () => {
  for (const name of ["bash", "mcp__other__notes_read", "mcp__notesoup_extra__notes_write", "mcp__notesoup__notes_list", "mcp__notesoup__mcp__notesoup__notes_read"]) {
    assert.equal(transform({ name }), undefined, name);
  }
  assert.equal(notesOpTransformer.transform({ item: toolCall({ detail: { type: "plain_text", text: "hi" } }) as never }), undefined);
  assert.equal(notesOpTransformer.transform({ item: toolCall({ detail: { type: "unknown", input: {}, output: {} } }) as never }), undefined);
  assert.equal(notesOpTransformer.transform({ item: { type: "user_message", text: "hi" } as never }), undefined);
});

test("Claude completed calls use the adapter's output text for read, write preview and update diff", () => {
  const read = notesOpSchema.parse(transform(claudeReadCompleted)!.items[0]!.data);
  assert.deepEqual(read, { op: "read", address: "@self/foo.md", status: "completed", text: "body line one\nbody line two" });
  assert.deepEqual(notesOpSchema.parse(transform(claudeWriteCompleted)!.items[0]!.data), {
    op: "write", address: "a.md", status: "completed", preview: "the new body",
  });
  assert.deepEqual(notesOpSchema.parse(transform(claudeUpdateCompleted)!.items[0]!.data), {
    op: "update", address: "a.md", status: "completed", diff: "- 1 - old\n+ 1 + new",
  });
});

test("Claude running calls render from input with null output", () => {
  for (const [op, call] of [["read", claudeReadCompleted], ["write", claudeWriteCompleted], ["update", claudeUpdateCompleted]] as const) {
    const running = transform({ ...call, status: "running", detail: { ...call.detail, output: null } });
    assert.deepEqual(notesOpSchema.parse(running!.items[0]!.data), { op, address: call.detail.input.address, status: "running" });
  }
});

test("Claude failures keep raw error content and transport messages instead of parsing them as notes", () => {
  assert.deepEqual(notesOpSchema.parse(transform(claudeReadFailed)!.items[0]!.data), {
    op: "read", address: "@self/foo.md", status: "failed", error: "No note at @self/foo.md.",
  });
  const write = transform({
    ...claudeWriteCompleted, status: "failed",
    detail: { ...claudeWriteCompleted.detail, output: null },
    error: { type: "tool_result", tool_use_id: claudeWriteCompleted.callId, is_error: true, content: "Disk full" },
  });
  assert.deepEqual(notesOpSchema.parse(write!.items[0]!.data), { op: "write", address: "a.md", status: "failed", error: "Disk full" });
  const update = transform({
    ...claudeUpdateCompleted, status: "failed", error: { message: "MCP connection closed" },
    detail: { ...claudeUpdateCompleted.detail, output: null },
  });
  assert.deepEqual(notesOpSchema.parse(update!.items[0]!.data), { op: "update", address: "a.md", status: "failed", error: "MCP connection closed" });
});

test("a crumple call is marked from the input alone", () => {
  const result = transform({
    name: "notes_update",
    detail: {
      type: "unknown",
      input: { address: "@self/stale.md", crumpled: true },
      output: { content: [{ type: "text", text: "updated @self/stale.md" }] },
    },
  });
  const data = notesOpSchema.parse(result!.items[0]!.data);
  assert.equal(data.crumpled, true);
  assert.equal(transform({ name: "notes_update", detail: { type: "unknown", input: { address: "@self/a.md", crumpled: false }, output: { content: [{ type: "text", text: "updated @self/a.md" }] } } })!
    .items[0]!.data.crumpled, undefined);
});
