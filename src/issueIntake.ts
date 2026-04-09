import { spawnSync } from "node:child_process";
import { IssueIntakeSummary } from "./types";

interface GitHubIssueView {
  number: number;
  title: string;
  url: string;
  body: string;
  labels?: Array<{ name?: string | null }>;
}

const HEADING_MAP: Record<string, keyof IssueIntakeSummary | null> = {
  "目的": "objective",
  "対象範囲": "scope",
  "触らない範囲": "outOfScope",
  "完了条件": "acceptance",
  "ドキュメント更新": "docsNeeded",
  "推奨レビュー担当": "reviewer",
};

export function parseIssueSections(body: string): IssueIntakeSummary {
  const base: IssueIntakeSummary = {
    number: 0,
    title: "",
    url: "",
    labels: [],
    objective: null,
    scope: null,
    outOfScope: null,
    acceptance: null,
    docsNeeded: null,
    reviewer: null,
    rawBody: body,
  };

  const lines = body.split(/\r?\n/);
  let currentKey: keyof IssueIntakeSummary | null = null;
  const buckets = new Map<keyof IssueIntakeSummary, string[]>();

  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      currentKey = HEADING_MAP[heading[1].trim()] ?? null;
      continue;
    }
    if (!currentKey) continue;
    if (!buckets.has(currentKey)) buckets.set(currentKey, []);
    buckets.get(currentKey)?.push(line);
  }

  for (const [key, value] of buckets.entries()) {
    const normalized = value.join("\n").trim();
    if (!normalized) continue;
    switch (key) {
      case "objective":
      case "scope":
      case "outOfScope":
      case "acceptance":
      case "docsNeeded":
      case "reviewer":
        base[key] = normalized;
        break;
      default:
        break;
    }
  }

  return base;
}

export function explainIssueReadFailure(errorText: string): string {
  const text = errorText.toLowerCase();
  if (text.includes("not logged into any hosts") || text.includes("authentication required")) {
    return "GitHub CLI に未ログインです。`gh auth login` を済ませると issue を読めます。";
  }
  if (text.includes("could not resolve host") || text.includes("network")) {
    return "GitHub へ接続できませんでした。ネットワーク状態を確認してください。";
  }
  if (text.includes("not a git repository")) {
    return "このフォルダでは repo を自動判定できません。`--repo owner/name` を付けてください。";
  }
  if (text.includes("could not find repository") || text.includes("repository not found")) {
    return "対象 repo が見つかりません。`--repo owner/name` の指定を確認してください。";
  }
  if (text.includes("could not resolve to an issue") || text.includes("not found")) {
    return "その issue は見つかりませんでした。issue 番号を確認してください。";
  }
  return `Issue を読めませんでした: ${errorText.trim() || "unknown error"}`;
}

export function readIssueIntake(input: {
  cwd: string;
  issueNumber: number;
  repo?: string;
}): { ok: true; summary: IssueIntakeSummary } | { ok: false; message: string } {
  const version = spawnSync("gh", ["--version"], {
    cwd: input.cwd,
    shell: true,
    encoding: "utf8",
  });
  if (version.status !== 0) {
    return {
      ok: false,
      message: "GitHub CLI (`gh`) が見つかりません。issue reader は `gh` 前提です。",
    };
  }

  const args = [
    "issue",
    "view",
    String(input.issueNumber),
    "--json",
    "number,title,url,body,labels",
  ];
  if (input.repo) {
    args.push("--repo", input.repo);
  }

  const result = spawnSync("gh", args, {
    cwd: input.cwd,
    shell: true,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return {
      ok: false,
      message: explainIssueReadFailure(String(result.stderr ?? result.stdout ?? "")),
    };
  }

  const parsed = JSON.parse(String(result.stdout)) as GitHubIssueView;
  const sections = parseIssueSections(parsed.body ?? "");

  return {
    ok: true,
    summary: {
      ...sections,
      number: parsed.number,
      title: parsed.title,
      url: parsed.url,
      labels: (parsed.labels ?? []).map((label) => label.name ?? "").filter(Boolean),
      rawBody: parsed.body ?? "",
    },
  };
}
