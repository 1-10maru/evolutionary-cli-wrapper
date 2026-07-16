import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Hosted Windows CI runners intermittently stall spawn/fs-heavy tests for
    // several seconds under load. With vitest's 5s default this produced a
    // ROTATING set of timeout failures across unrelated suites (observed on
    // windows-2022 for: spawnCommand ".ps1 path that is safe", shellIntegration
    // "normal project path (spaces allowed)", cli/logs --bundle, the install/*
    // bash suites, and the ps1-wedge integration test). Generous budgets cost
    // nothing when tests are green; a genuinely hung test still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Agent worktrees live under .worktrees/ inside the repo; without this,
    // vitest discovers their test copies and double-runs everything.
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
  },
});
