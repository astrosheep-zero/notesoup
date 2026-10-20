import { builtinModules } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
type Adapter = "pi" | "claude" | "dsh" | "codex";
function packageAdapter(specifier: string): Adapter | undefined {
	if (/^@(?:earendil-works|mariozechner)\//.test(specifier)) return "pi";
	if (/^@deepseek-ai\//.test(specifier)) return "dsh";
	if (/^(?:claude-code|@anthropic-ai\/[^/]+)(?:\/|$)/.test(specifier)) return "claude";
	return undefined;
}

/** All AST edges enforce boundaries; emitted edges alone determine runtime cycles. */
export function moduleReferences(source: ts.SourceFile, runtimeOnly = false): string[] {
	if (runtimeOnly) {
		if (source.isDeclarationFile) return [];
		const emitted = ts.transpileModule(source.text, { fileName: source.fileName, compilerOptions: { module: ts.ModuleKind.Preserve, target: ts.ScriptTarget.ES2022 } }).outputText;
		source = ts.createSourceFile(source.fileName + ".js", emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	}
	const references = new Set<string>();
	const add = (node: ts.Node | undefined) => {
		if (node && ts.isStringLiteralLike(node)) references.add(node.text);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
		if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
		if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0]);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return [...references];
}

function packageName(specifier: string): string {
	return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
}

/** Resolve reachable edges, preserving each importing module's core/adapter ownership. */
export function dependencyViolations(root: string, entries: string[], options: ts.CompilerOptions, runtimeDependencies: Set<string>): string[] {
	root = realpathSync(root);
	const violations: string[] = [];
	const visited = new Set<string>();
	const runtime = new Map<string, string[]>();
	const cache = ts.createModuleResolutionCache(root, (path) => path, options);
	const sourceRoot = resolve(root, "src");
	const pluginRoot = resolve(root, "plugins");
	const notesRoot = resolve(sourceRoot, "notes");
	const notesEntry = resolve(sourceRoot, "notes/index.ts");
	const display = (path: string) => relative(root, path).split(sep).join("/");
	const local = (file: string) => file.startsWith(sourceRoot + sep) || file.startsWith(pluginRoot + sep);
	const adapter = (file: string): Adapter | undefined => {
		const path = display(file);
		return /^plugins\/(pi|claude|dsh|codex)\//.exec(path)?.[1] as Adapter | undefined
			?? packageAdapter(file.split(sep).join("/").split("/node_modules/").at(-1)!);
	};
	const walk = (file: string, chain: string[]): void => {
		file = realpathSync(file);
		if (visited.has(file)) return;
		visited.add(file);
		const here = [...chain, display(file)];
		const owner = adapter(file);
		const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
		const emitted = new Set(local(file) ? moduleReferences(source, true) : []);
		if (local(file)) runtime.set(file, []);
		for (const specifier of moduleReferences(source)) {
			if (specifier.startsWith("node:") || builtins.has(specifier)) continue;
			const sdk = packageAdapter(specifier);
			if (sdk) { if (owner !== sdk) violations.push([...here, specifier].join(" -> ")); continue; }
			const resolution = ts.resolveModuleName(specifier, file, options, ts.sys, cache).resolvedModule;
			if (!resolution) { violations.push([...here, `unresolved ${specifier}`].join(" -> ")); continue; }
			const target = realpathSync(resolution.resolvedFileName);
			const targetOwner = adapter(target);
			if ((targetOwner && targetOwner !== owner) ||
				(owner && target.startsWith(notesRoot + sep) && target !== notesEntry) ||
				(owner === "dsh" && target.startsWith(resolve(sourceRoot, "dream") + sep)) ||
				(!owner && target.startsWith(pluginRoot + sep))) {
				violations.push([...here, display(target)].join(" -> ")); continue;
			}
			// Core dependencies must be intentional, not accidentally supplied by a host.
			if (!owner && file.startsWith(sourceRoot + sep) && resolution.isExternalLibraryImport && !runtimeDependencies.has(packageName(specifier))) {
				violations.push([...here, `undeclared runtime dependency ${specifier}`].join(" -> "));
			}
			if (emitted.has(specifier) && local(target)) runtime.get(file)!.push(target);
			if (!targetOwner || local(target)) walk(target, here);
		}
	};
	for (const entry of entries) walk(resolve(root, entry), []);
	const checked = new Set<string>();
	const cycles = (file: string, path: string[]): void => {
		const start = path.indexOf(file);
		if (start >= 0) { violations.push(`runtime cycle: ${[...path.slice(start), file].map(display).join(" -> ")}`); return; }
		if (checked.has(file)) return;
		checked.add(file);
		for (const target of runtime.get(file) ?? []) cycles(target, [...path, file]);
	};
	for (const file of runtime.keys()) cycles(file, []);
	return violations;
}
