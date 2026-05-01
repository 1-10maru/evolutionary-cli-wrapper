# Codex Friction Capture

This note documents the internal-friction layer added in v2.3.

## What Evo now tries to capture

- tool call start / success / failure
- approval requested / granted / denied
- retry requested / retry succeeded / retry failed
- edit attempt start / failure / recovery
- recovery start / recovery success

## Scope

- Codex: deep capture first. Evo tries to read approval, retry, and tool-failure hints from the live proxy stream.
- Claude: dedicated adapter now exists, but signal quality still depends on what Claude prints to the terminal.
- generic CLI: fallback only. Evo estimates friction from visible CLI output and result patterns.

## What the user sees

- normal turns still stay compact
- high-friction turns surface stop-and-reframe feedback first
- explain/recap now shows approvals, tool errors, retries, friction score, and the best stop turn

## Current limitation

This does not observe OS-wide clicks. The target is approval flow tied to AI tool execution inside the proxied session.

## Design boundary

Friction capture is separate from:

- issue intake
- future task dispatch
- future review loop

Keep this layer reusable so it can move into a cross-repo orchestration stack later.

## Parity goal

The goal is shared scoring and shared friction logic across Codex and Claude.

- adapters are CLI-specific
- normalized friction events are shared
- friction scoring and stop-and-reframe decisions are shared

So the capture layer can differ, while the actual coaching logic stays aligned.
