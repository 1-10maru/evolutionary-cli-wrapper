# Documentation

Index of everything under `docs/`. Start with the project [README](../README.md) ([日本語](../README.ja.md)) for install and usage; this folder holds the deeper policy, process, and design docs.

## For users

| Doc | What's inside |
|---|---|
| [PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md) | Supported operating systems, architectures, and Node versions (Node ≥ 20, 22 recommended), plus the CI matrix and what is explicitly unsupported. |
| [observability.md](./observability.md) | Where Evo writes log files, how they rotate and get pruned, and the environment toggles that control logging. |

## For contributors

| Doc | What's inside |
|---|---|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How humans and AI agents work in parallel: issues as the unit of work, first steps, and commit / PR conventions. |
| [ROADMAP.md](./ROADMAP.md) | What works today and what's planned next — the repo's overall map. |
| [VERSIONING.md](./VERSIONING.md) | Semantic-versioning policy: `vX.Y.Z` tags kept in sync with `package.json`, and how the changelog is maintained. |
| [RELEASE_PROCESS.md](./RELEASE_PROCESS.md) | The two-channel release flow — `next` (release candidate) and `latest` (stable) — with the exact tag and workflow steps. |

See also the top-level [CHANGELOG.md](../CHANGELOG.md) for release history.

## For AI agents

The `ai/` subtree is written for AI agents working in this repo.

| Doc | What's inside |
|---|---|
| [ai/README.md](./ai/README.md) | Entry point for the agent-facing documentation. |
| [ai/AGENT_WORKFLOW.md](./ai/AGENT_WORKFLOW.md) | How an agent picks up and executes a unit of work end to end. |
| [ai/PROJECT_MAP.md](./ai/PROJECT_MAP.md) | A map of the codebase for fast orientation. |
| [ai/DECISIONS.md](./ai/DECISIONS.md) | Running log of notable design decisions. |
| [ai/REVIEW_PLAYBOOK.md](./ai/REVIEW_PLAYBOOK.md) | Review conventions and the checklist reviewers apply. |
| [ai/issue-intake.md](./ai/issue-intake.md) | The issue-intake format agents read (`evo issue show`). |
| [ai/knowledge/](./ai/knowledge/) | Troubleshooting knowledge base — Windows shells and Zellij notes. |

## Runbooks

| Runbook | When to reach for it |
|---|---|
| [runbooks/evopet-not-appearing.md](./runbooks/evopet-not-appearing.md) | The statusline isn't showing up after install. |
| [runbooks/rollback-bad-release.md](./runbooks/rollback-bad-release.md) | A bad version reached npm and needs rolling back. |

## Design notes (future work)

| Doc | What's inside |
|---|---|
| [future/ai-orchestration.md](./future/ai-orchestration.md) | Design sketch for future AI-orchestration capabilities. |
| [future/friction-capture-architecture.md](./future/friction-capture-architecture.md) | Design sketch for the friction-capture architecture. |
