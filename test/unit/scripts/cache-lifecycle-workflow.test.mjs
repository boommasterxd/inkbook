import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { workflowCondition } from "./workflow-condition-fixture.mjs";

const warm = readFileSync(
  new URL("../../../.github/workflows/dependency-cache.yml", import.meta.url),
  "utf8",
);
const metadata = readFileSync(
  new URL("../../../.github/workflows/cache-lifecycle.yml", import.meta.url),
  "utf8",
);
const cleanup = warm.split("\n  cleanup:\n")[1];

describe("cache lifecycle integration", () => {
  it("admits dependency pruning only after successful trusted main production", () => {
    const condition = cleanup.match(/if: >-\n((?: {6}.+\n)+)/)?.[1].trim();
    expect(condition).toBeTruthy();
    const context = {
      needs: { warm: { result: "success" } },
      github: { ref: "refs/heads/main", event: { repository: { default_branch: "main" } } },
    };
    expect(workflowCondition(condition, context)).toBe(true);
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(workflowCondition(condition, { ...context, needs: { warm: { result } } })).toBe(false);
    }
    context.github.ref = "refs/pull/42/merge";
    expect(workflowCondition(condition, context)).toBe(false);
    context.github.ref = "refs/heads/main";
    context.github.event.repository.default_branch = "other";
    expect(workflowCondition(condition, context)).toBe(false);
  });

  it("keeps privileged cleanup on trusted code without installation or cache writes", () => {
    for (const workflow of [cleanup, metadata]) {
      expect(workflow).toContain("ref: refs/heads/main");
      expect(workflow).toContain("persist-credentials: false");
      expect(workflow).toContain('node-version: "26.x"\n          check-latest: true');
      expect(workflow).toContain("package-manager-cache: false");
      expect(workflow).toContain("group: cache-lifecycle\n      cancel-in-progress: false");
      expect(workflow).toContain("contents: read\n      actions: write");
      expect(workflow).toContain("      actions: write\n      pull-requests: read");
      expect(workflow).toContain(
        "run: node scripts/cache-lifecycle/run.cjs scripts/cache-lifecycle/policy.json",
      );
      expect(workflow).not.toMatch(/npm ci|actions\/cache|head_sha|pull_request.head/);
    }
    expect(warm.split("\njobs:\n")[0]).not.toContain("actions: write");
    expect(metadata.split("\njobs:\n")[0]).not.toContain("actions: write");
    expect(metadata).toContain("pull_request_target:\n    types: [closed]");
    expect(metadata).toContain("types: [completed]");
    expect(metadata).not.toContain("schedule:");
  });
});
