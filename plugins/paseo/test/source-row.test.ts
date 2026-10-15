import assert from "node:assert/strict";
import test from "node:test";
import { sourceRowTransformer } from "../client/source-row.ts";
import { LAST_WORD_TYPE, lastWordSchema } from "../shared/last-word.ts";

test("renders the Pi adapter's replayed last word in place and leaves other rows intact", () => {
  const item = {
    type: "tool_call" as const, callId: "pi-custom-1", name: LAST_WORD_TYPE,
    status: "completed" as const, error: null,
    detail: { type: "plain_text" as const, text: "*You peel a sticky note off your forehead.*\nKeep the handoff." },
    metadata: { synthetic: true, customType: LAST_WORD_TYPE },
  };
  const result = sourceRowTransformer.transform({ item });
  assert.equal(result?.items.length, 1);
  assert.equal(lastWordSchema.parse(result!.items[0]!.data).text, item.detail.text);
  assert.deepEqual(sourceRowTransformer.transform({ item }), result, "replay deterministically replaces one source row");
  assert.equal(sourceRowTransformer.transform({ item: { ...item, metadata: { synthetic: true, customType: "other" } } }), undefined);
  assert.equal(sourceRowTransformer.transform({ item: { ...item, detail: { type: "plain_text" } } }), undefined);
});
