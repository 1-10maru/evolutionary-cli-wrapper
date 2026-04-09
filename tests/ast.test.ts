import { describe, expect, it } from "vitest";
import { diffSymbolSnapshots, extractSymbolSnapshots } from "../src/ast";

describe("AST symbol tracking", () => {
  it("extracts TypeScript functions and methods", () => {
    const content = `
export function greet(name: string) {
  return "hi " + name;
}

class Person {
  speak() {
    return greet("you");
  }
}
    `;

    const symbols = extractSymbolSnapshots("src/example.ts", content);
    expect(symbols.map((symbol) => symbol.qualifiedName)).toContain("greet");
    expect(symbols.map((symbol) => symbol.qualifiedName)).toContain("Person");
    expect(symbols.map((symbol) => symbol.qualifiedName)).toContain("Person.speak");
  });

  it("keeps a stable id for same-named function modifications", () => {
    const before = {
      relativePath: "src/example.ts",
      changeKind: "modified" as const,
      before: {
        path: "src/example.ts",
        relativePath: "src/example.ts",
        contentHash: "a",
        lineCount: 3,
        size: 10,
        isText: true,
        extension: ".ts",
        content: "export function greet(name: string) { return name; }",
      },
      after: {
        path: "src/example.ts",
        relativePath: "src/example.ts",
        contentHash: "b",
        lineCount: 3,
        size: 20,
        isText: true,
        extension: ".ts",
        content: "export function greet(name: string) { return name.toUpperCase(); }",
      },
      changedLines: 1,
    };

    const diff = diffSymbolSnapshots([before]);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].changeKind).toBe("modified");
    expect(diff.changes[0].stableSymbolId).toBe(
      diff.after.get("src/example.ts")?.find((symbol) => symbol.qualifiedName === "greet")?.stableSymbolId,
    );
  });

  it("treats removed python functions as deletes", () => {
    const before = {
      relativePath: "worker.py",
      changeKind: "modified" as const,
      before: {
        path: "worker.py",
        relativePath: "worker.py",
        contentHash: "a",
        lineCount: 4,
        size: 30,
        isText: true,
        extension: ".py",
        content: "def clean(x):\n    return x\n",
      },
      after: {
        path: "worker.py",
        relativePath: "worker.py",
        contentHash: "b",
        lineCount: 1,
        size: 1,
        isText: true,
        extension: ".py",
        content: "",
      },
      changedLines: 2,
    };

    const diff = diffSymbolSnapshots([before]);
    expect(diff.changes.some((change) => change.changeKind === "deleted")).toBe(true);
  });
});
