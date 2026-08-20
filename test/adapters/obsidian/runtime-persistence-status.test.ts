/* eslint-disable @typescript-eslint/no-magic-numbers -- Retry counts are contract examples. */
import { describe, expect, it } from "vitest";

import { runtimePersistenceIssueStatusV1 } from "../../../src/adapters/obsidian/runtime-persistence-status";
import type { RuntimePersistenceIssueStatusV1 } from "../../../src/adapters/obsidian/runtime-persistence-external";

describe("runtimePersistenceIssueStatusV1", () => {
  it("returns null when no retry is pending and no external issue exists", () => {
    expect(runtimePersistenceIssueStatusV1(undefined, 0)).toBeNull();
  });

  it("preserves the external issue while retrying is not required", () => {
    const external: RuntimePersistenceIssueStatusV1 = {
      conflict: { kind: "sidecar-changed" },
      drift: { kind: "source-changed" },
      retry: { action: "reload", attemptCount: 2, kind: "available" },
    };

    expect(runtimePersistenceIssueStatusV1(external, 0)).toBe(external);
  });

  it("adds an available save retry and supplies clear issue defaults", () => {
    const status = runtimePersistenceIssueStatusV1(undefined, 1);

    expect(status).toEqual({
      conflict: { kind: "none" },
      drift: { kind: "none" },
      retry: { action: "save", attemptCount: 1, kind: "available" },
    });
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status?.conflict)).toBe(true);
    expect(Object.isFrozen(status?.drift)).toBe(true);
    expect(Object.isFrozen(status?.retry)).toBe(true);
  });

  it("keeps existing conflict and drift details when creating a retry status", () => {
    const external: RuntimePersistenceIssueStatusV1 = {
      conflict: { kind: "recovery-conflict" },
      drift: { kind: "marker-invalid" },
      retry: { action: "recovery", attemptCount: 1, kind: "available" },
    };

    expect(runtimePersistenceIssueStatusV1(external, 3)).toEqual({
      conflict: external.conflict,
      drift: external.drift,
      retry: { action: "save", attemptCount: 3, kind: "available" },
    });
  });
});
