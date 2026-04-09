import { describe, expect, it } from "vitest";
import { explainIssueReadFailure, parseIssueSections } from "../src/issueIntake";

describe("issue intake", () => {
  it("extracts agent-task sections from an issue body", () => {
    const parsed = parseIssueSections(`
### 目的
GitHub CI の docs チェック warning を追加する

### 対象範囲
- .github/workflows/
- README.md

### 触らない範囲
src/proxyRuntime.ts には触らない

### 完了条件
- workflow が追加されている
- README に導線がある

### ドキュメント更新
必須

### 推奨レビュー担当
人間 + AI 両方
    `);

    expect(parsed.objective).toContain("docs チェック");
    expect(parsed.scope).toContain(".github/workflows/");
    expect(parsed.outOfScope).toContain("src/proxyRuntime.ts");
    expect(parsed.acceptance).toContain("workflow");
    expect(parsed.docsNeeded).toBe("必須");
    expect(parsed.reviewer).toBe("人間 + AI 両方");
  });

  it("returns helpful guidance for common gh failures", () => {
    expect(explainIssueReadFailure("authentication required")).toContain("gh auth login");
    expect(explainIssueReadFailure("not a git repository")).toContain("--repo owner/name");
    expect(explainIssueReadFailure("repository not found")).toContain("repo");
  });
});
