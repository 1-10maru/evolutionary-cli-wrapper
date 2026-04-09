import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import TypeScript from "tree-sitter-typescript";
import { ChangedFile, SymbolChangeEvent, SymbolKind, SymbolSnapshot } from "./types";
import { hashText, shortHash } from "./utils/hash";

type TreeNode = Parser.SyntaxNode;

interface ExtractedSymbol {
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  parentQualifiedName: string | null;
  startLine: number;
  endLine: number;
  signatureText: string;
  bodyText: string;
  fingerprintSource: string;
}

const parser = new Parser();

function languageForExtension(extension: string): { name: string; grammar: unknown } | null {
  switch (extension) {
    case ".ts":
      return { name: "typescript", grammar: TypeScript.typescript };
    case ".tsx":
      return { name: "tsx", grammar: TypeScript.tsx };
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return { name: "javascript", grammar: JavaScript };
    case ".py":
      return { name: "python", grammar: Python };
    default:
      return null;
  }
}

function getNodeText(content: string, node: TreeNode | null | undefined): string {
  if (!node) return "";
  return content.slice(node.startIndex, node.endIndex);
}

function normalizeBody(text: string): string {
  return text
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '"str"')
    .replace(/\b\d+(?:\.\d+)?\b/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprintNode(node: TreeNode): string {
  const types: string[] = [];
  const visit = (current: TreeNode, depth: number): void => {
    if (depth > 4) return;
    types.push(current.type);
    for (const child of current.namedChildren) visit(child, depth + 1);
  };
  visit(node, 0);
  return hashText(types.join("|"));
}

function extractJavaScriptLikeSymbols(content: string, tree: Parser.Tree): ExtractedSymbol[] {
  const results: ExtractedSymbol[] = [];
  const visit = (node: TreeNode, scope: string[]): void => {
    if (node.type === "function_declaration") {
      const nameNode = node.childForFieldName("name");
      const name = getNodeText(content, nameNode);
      const qualifiedName = [...scope, name].join(".");
      results.push({
        kind: "function",
        name,
        qualifiedName,
        parentQualifiedName: scope.length > 0 ? scope.join(".") : null,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signatureText: getNodeText(content, nameNode) + getNodeText(content, node.childForFieldName("parameters")),
        bodyText: getNodeText(content, node.childForFieldName("body")),
        fingerprintSource: fingerprintNode(node),
      });
      for (const child of node.namedChildren) visit(child, [...scope, name]);
      return;
    }

    if (node.type === "class_declaration") {
      const nameNode = node.childForFieldName("name");
      const name = getNodeText(content, nameNode);
      const qualifiedName = [...scope, name].join(".");
      results.push({
        kind: "class",
        name,
        qualifiedName,
        parentQualifiedName: scope.length > 0 ? scope.join(".") : null,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signatureText: getNodeText(content, nameNode),
        bodyText: getNodeText(content, node.childForFieldName("body")),
        fingerprintSource: fingerprintNode(node),
      });
      for (const child of node.namedChildren) visit(child, [...scope, name]);
      return;
    }

    if (node.type === "method_definition") {
      const nameNode = node.childForFieldName("name");
      const name = getNodeText(content, nameNode);
      const qualifiedName = [...scope, name].join(".");
      results.push({
        kind: "method",
        name,
        qualifiedName,
        parentQualifiedName: scope.length > 0 ? scope.join(".") : null,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signatureText: getNodeText(content, nameNode) + getNodeText(content, node.childForFieldName("parameters")),
        bodyText: getNodeText(content, node.childForFieldName("body")),
        fingerprintSource: fingerprintNode(node),
      });
      return;
    }

    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const child of node.namedChildren) {
        if (child.type !== "variable_declarator") continue;
        const nameNode = child.childForFieldName("name");
        const valueNode = child.childForFieldName("value");
        if (!valueNode || !["arrow_function", "function"].includes(valueNode.type)) continue;
        const name = getNodeText(content, nameNode);
        const qualifiedName = [...scope, name].join(".");
        results.push({
          kind: "function",
          name,
          qualifiedName,
          parentQualifiedName: scope.length > 0 ? scope.join(".") : null,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          signatureText: `${name}${getNodeText(content, valueNode.childForFieldName("parameters"))}`,
          bodyText: getNodeText(content, valueNode.childForFieldName("body")),
          fingerprintSource: fingerprintNode(valueNode),
        });
      }
    }

    for (const child of node.namedChildren) visit(child, scope);
  };

  visit(tree.rootNode, []);
  return results;
}

function extractPythonSymbols(content: string, tree: Parser.Tree): ExtractedSymbol[] {
  const results: ExtractedSymbol[] = [];
  const visit = (node: TreeNode, scope: string[]): void => {
    if (node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      const name = getNodeText(content, nameNode);
      const qualifiedName = [...scope, name].join(".");
      results.push({
        kind: "function",
        name,
        qualifiedName,
        parentQualifiedName: scope.length > 0 ? scope.join(".") : null,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signatureText: `${name}${getNodeText(content, node.childForFieldName("parameters"))}`,
        bodyText: getNodeText(content, node.childForFieldName("body")),
        fingerprintSource: fingerprintNode(node),
      });
      for (const child of node.namedChildren) visit(child, [...scope, name]);
      return;
    }

    if (node.type === "class_definition") {
      const nameNode = node.childForFieldName("name");
      const name = getNodeText(content, nameNode);
      const qualifiedName = [...scope, name].join(".");
      results.push({
        kind: "class",
        name,
        qualifiedName,
        parentQualifiedName: scope.length > 0 ? scope.join(".") : null,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signatureText: name,
        bodyText: getNodeText(content, node.childForFieldName("body")),
        fingerprintSource: fingerprintNode(node),
      });
      for (const child of node.namedChildren) visit(child, [...scope, name]);
      return;
    }

    for (const child of node.namedChildren) visit(child, scope);
  };

  visit(tree.rootNode, []);
  return results;
}

export function extractSymbolSnapshots(relativePath: string, content?: string): SymbolSnapshot[] {
  if (!content) return [];
  const extension = relativePath.includes(".") ? relativePath.slice(relativePath.lastIndexOf(".")) : "";
  const language = languageForExtension(extension);
  if (!language) return [];

  parser.setLanguage(language.grammar as never);
  const tree = parser.parse(content);
  const extracted =
    language.name === "python"
      ? extractPythonSymbols(content, tree)
      : extractJavaScriptLikeSymbols(content, tree);

  return extracted.map((symbol) => ({
    stableSymbolId: shortHash(`${relativePath}:${symbol.kind}:${symbol.qualifiedName}`),
    language: language.name,
    kind: symbol.kind,
    qualifiedName: symbol.qualifiedName,
    parentQualifiedName: symbol.parentQualifiedName,
    signatureHash: hashText(symbol.signatureText),
    bodyHash: hashText(normalizeBody(symbol.bodyText)),
    astFingerprint: symbol.fingerprintSource,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  }));
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  let matches = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] === right[index]) matches += 1;
  }
  return length === 0 ? 1 : matches / length;
}

export function diffSymbolSnapshots(
  changedFiles: ChangedFile[],
): {
  before: Map<string, SymbolSnapshot[]>;
  after: Map<string, SymbolSnapshot[]>;
  changes: SymbolChangeEvent[];
} {
  const before = new Map<string, SymbolSnapshot[]>();
  const after = new Map<string, SymbolSnapshot[]>();
  const changes: SymbolChangeEvent[] = [];

  for (const file of changedFiles) {
    const beforeSymbols = extractSymbolSnapshots(file.relativePath, file.before?.content);
    const afterSymbols = extractSymbolSnapshots(file.relativePath, file.after?.content);
    before.set(file.relativePath, beforeSymbols);
    after.set(file.relativePath, afterSymbols);

    const unmatchedBefore = [...beforeSymbols];
    const matchedBeforeIds = new Set<string>();

    for (const afterSymbol of afterSymbols) {
      let match = unmatchedBefore.find(
        (candidate) =>
          candidate.kind === afterSymbol.kind &&
          candidate.qualifiedName === afterSymbol.qualifiedName,
      );

      if (!match) {
        match = unmatchedBefore.find(
          (candidate) =>
            candidate.kind === afterSymbol.kind &&
            candidate.signatureHash === afterSymbol.signatureHash,
        );
      }

      if (!match) {
        match = unmatchedBefore.find(
          (candidate) =>
            candidate.kind === afterSymbol.kind &&
            similarity(candidate.astFingerprint, afterSymbol.astFingerprint) >= 0.85,
        );
      }

      if (!match) {
        changes.push({
          stableSymbolId: afterSymbol.stableSymbolId,
          path: file.relativePath,
          qualifiedName: afterSymbol.qualifiedName,
          kind: afterSymbol.kind,
          language: afterSymbol.language,
          changeKind: "added",
          beforeBodyHash: null,
          afterBodyHash: afterSymbol.bodyHash,
          changedLines: afterSymbol.endLine - afterSymbol.startLine + 1,
        });
        continue;
      }

      matchedBeforeIds.add(match.stableSymbolId);
      const stableSymbolId = match.stableSymbolId;
      afterSymbol.stableSymbolId = stableSymbolId;
      if (match.bodyHash !== afterSymbol.bodyHash || match.qualifiedName !== afterSymbol.qualifiedName) {
        let changeKind: SymbolChangeEvent["changeKind"] = "modified";
        if (match.qualifiedName !== afterSymbol.qualifiedName) changeKind = "renamed";
        else if (
          match.startLine !== afterSymbol.startLine ||
          match.endLine !== afterSymbol.endLine
        ) {
          changeKind = "moved";
        }
        changes.push({
          stableSymbolId,
          path: file.relativePath,
          qualifiedName: afterSymbol.qualifiedName,
          kind: afterSymbol.kind,
          language: afterSymbol.language,
          changeKind,
          beforeBodyHash: match.bodyHash,
          afterBodyHash: afterSymbol.bodyHash,
          changedLines: Math.max(file.changedLines, 1),
        });
      }
    }

    for (const beforeSymbol of beforeSymbols) {
      if (matchedBeforeIds.has(beforeSymbol.stableSymbolId)) continue;
      changes.push({
        stableSymbolId: beforeSymbol.stableSymbolId,
        path: file.relativePath,
        qualifiedName: beforeSymbol.qualifiedName,
        kind: beforeSymbol.kind,
        language: beforeSymbol.language,
        changeKind: "deleted",
        beforeBodyHash: beforeSymbol.bodyHash,
        afterBodyHash: null,
        changedLines: beforeSymbol.endLine - beforeSymbol.startLine + 1,
      });
    }
  }

  return { before, after, changes };
}
