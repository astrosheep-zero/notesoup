import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

// Exercise the actual renderer with RN host primitives, not a native layout emulator.
const require = createRequire(import.meta.url);
const opened: string[] = [];
const source = readFileSync(new URL("../client/markdown-core.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const compiled = { exports: {} as any };
new Function("require", "module", "exports", outputText)(
  (id: string) => id === "react-native"
    ? { Text: "Text", View: "View", ScrollView: "ScrollView", Linking: { openURL: (url: string) => { opened.push(url); return Promise.resolve(); } } }
    : require(id),
  compiled, compiled.exports,
);
const { renderBlocks, renderInlines } = compiled.exports;
const { lexer, Lexer } = require("marked");
const styles = new Proxy({}, { get: () => ({}) });
function elements(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  return [node, ...elements(node.props?.children)];
}
function text(node: any): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node == null) return "";
  return typeof node === "object" ? text(node.props?.children) : String(node);
}
const render = (markdown: string, openLinks?: boolean) => renderBlocks(lexer(markdown), styles, "test", undefined, openLinks);

test("inline nesting, entities, br and empty-alt images render cleanly", () => {
  const result = renderInlines(Lexer.lexInline("**bold *nested*** &mdash; &#65; `a < b & c`<br>![](https://example.com/a.png)"), styles, "inline");
  assert.equal(text(result), "bold nested — A a < b & c\n[image]");
});

test("ordered starts, tight and loose task markers survive without duplicate checkboxes", () => {
  assert.match(text(render("3. third\n4. fourth")), /3\.third4\.fourth/);
  const tight = text(render("- [x] done\n- [ ] pending\n  - child"));
  assert.match(tight, /☑done/);
  assert.match(tight, /☐pending/);
  assert.match(tight, /•child/);
  const loose = text(render("- [x] first\n\n- [ ] second"));
  assert.equal(loose, "☑first☐second");
});

test("safe links open only when enabled and block unsafe schemes", () => {
  opened.length = 0;
  const disabled = elements(render("[ok](https://example.com?a=1&amp;b=2)", false)).find(n => typeof n.props?.onPress === "function");
  assert.equal(disabled, undefined);
  const inlineDefault = elements(renderInlines(Lexer.lexInline("[peek](https://example.com)"), styles, "peek")).find(n => typeof n.props?.onPress === "function");
  assert.equal(inlineDefault, undefined);

  const active = elements(render("[ok](https://example.com?a=1&amp;b=2) [bad](javascript:alert(1)) [mail](mailto:hi@example.com)"));
  const handlers = active.filter(n => typeof n.props?.onPress === "function");
  assert.equal(handlers.length, 2);
  handlers.forEach(n => n.props.onPress());
  assert.deepEqual(opened, ["https://example.com?a=1&b=2", "mailto:hi@example.com"]);
});

test("tables size by visible CJK/link text and stay horizontally scrollable", () => {
  const md = "# Heading\n\n| [详情](https://very-long.example.com/path/to/doc) | 状态说明 |\n| :--- | ---: |\n| x<br>y | 值 |\n\n```\n&amp;\n```";
  const nodes = elements(render(md));
  assert.equal(nodes.filter(n => n.type === "ScrollView" && n.props.horizontal).length, 2);
  assert.ok(nodes.filter(n => n.type === "Text" && n.props.selectable !== undefined).every(n => n.props.selectable));
  const headerCells = nodes.filter(n => Array.isArray(n.props.style) && n.props.style.some((s: any) => typeof s?.width === "number")).slice(0, 2);
  const [linkColWidth, cjkColWidth] = headerCells.map(n => n.props.style.find((s: any) => typeof s?.width === "number").width);
  assert.ok(linkColWidth < 80, `expected visible link text width, got ${linkColWidth}`);
  assert.ok(cjkColWidth > 64, `expected CJK header width above ASCII floor, got ${cjkColWidth}`);
  assert.ok(nodes.some(n => n.type === "Text" && text(n) === "&amp;"));
});
