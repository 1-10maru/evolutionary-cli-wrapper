# Friction Capture Architecture

v2.3 keeps friction capture modular on purpose.

## Current split

- `src/capture/frictionCore.ts`
  - shared event aggregation
  - friction score
  - stop-and-reframe decision
- `src/capture/codexCapture.ts`
  - Codex-first line/input capture
- `src/capture/genericCapture.ts`
  - fallback heuristics for Claude and generic CLIs
- `src/proxyRuntime.ts`
  - wires the capture layer into live turns

## Future extraction path

If this grows into multi-repo orchestration, keep these as separate modules:

1. `friction-core`
2. `codex-friction-adapter`
3. `claude-friction-adapter`
4. `friction-feedback-renderer`

That split keeps Evo scoring and mascot UX independent from agent routing and review-loop orchestration.
