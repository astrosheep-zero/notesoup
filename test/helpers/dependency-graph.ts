import { builtinModules } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const hostPackage = /^(?:(?:@earendil-works|@mariozechner)\/pi-(?:ai|agent-core|coding-agent)|@deepseek-ai\/(?:dsh(?:-[^/]+)?|cordis(?:-[^/]+)?))(?:\/|$)/;

/** AST edges include erased types and re-exports, not merely emitted runtime imports. */
export function moduleReferences(source: ts.SourceFile): string[] {
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

/** Resolve every reachable edge with TypeScript, including local aliases and external declarations. */
export function dependencyViolations(root: string, entries: string[], options: ts.CompilerOptions, runtimeDependencies: Set<string>): string[] {
	root = realpathSync(root);
	const violations: string[] = [];
	const visited = new Set<string>();
	const cache = ts.createModuleResolutionCache(root, (path) => path, options);
	const sourceRoot = resolve(root, "src");
	const display = (path: string) => relative(root, path).split(sep).join("/");
	const native = (path: string) => path === resolve(sourceRoot, "index.ts") || ["pi", "claude", "dsh"].some((adapter) => path.startsWith(resolve(sourceRoot, adapter) + sep)) || /node_modules\/(?:(?:@earendil-works|@mariozechner)\/pi-(?:ai|agent-core|coding-agent)|@deepseek-ai\/(?:dsh(?:-[^/]+)?|cordis(?:-[^/]+)?))(?:\/|$)/.test(path.split(sep).join("/"));
	const walk = (file: string, chain: string[]): void => {
		file = realpathSync(file);
		if (native(file)) { violations.push([...chain, display(file)].join(" -> ")); return; }
		if (visited.has(file)) return;
		visited.add(file);
		const here = [...chain, display(file)];
		const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
		for (const specifier of moduleReferences(source)) {
			if (specifier.startsWith("node:") || builtins.has(specifier)) continue;
			if (hostPackage.test(specifier)) { violations.push([...here, specifier].join(" -> ")); continue; }
			const resolution = ts.resolveModuleName(specifier, file, options, ts.sys, cache).resolvedModule;
			if (!resolution) { violations.push([...here, `unresolved ${specifier}`].join(" -> ")); continue; }
			// A shared dependency must be intentional, not accidentally supplied by a Pi peer/dev dependency.
			if (file.startsWith(sourceRoot + sep) && resolution.isExternalLibraryImport && !runtimeDependencies.has(packageName(specifier))) {
				violations.push([...here, `undeclared runtime dependency ${specifier}`].join(" -> "));
			}
			walk(resolution.resolvedFileName, here);
		}
	};
	for (const entry of entries) walk(resolve(root, entry), []);
	return violations;
}
