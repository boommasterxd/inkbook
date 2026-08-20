/* eslint-disable @typescript-eslint/no-magic-numbers -- Fixture counters represent persisted revisions and IDs. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteSessionSnapshotV1 } from "../../../src/application/note-session";
import {
  createSidecarRevision,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseSourceCheckpointId,
} from "../../../src/application/note-session";
import type { ActiveRemovalRecoveryV1 } from "../../../src/application/recovery";
import type { RuntimePersistenceOpenResultV1 } from "../../../src/adapters/obsidian/runtime-persistence-open";
import {
  openRuntimePersistenceSessionV1,
  type RuntimePersistenceLifecycleStateV1,
} from "../../../src/adapters/obsidian/runtime-persistence-lifecycle";

const persistenceMocks = vi.hoisted(() => ({
  open: vi.fn(),
  snapshot: vi.fn((snapshot: unknown) => snapshot),
}));

vi.mock("../../../src/adapters/obsidian/runtime-persistence-open", () => ({
  openRuntimePersistenceV1: persistenceMocks.open,
  runtimeOpenSnapshotV1: persistenceMocks.snapshot,
}));

const SNAPSHOT = {} as NoteSessionSnapshotV1;
const DIGEST = parseSha256Digest("a".repeat(64));
const BASE = {
  markdownPath: "Notes/page.md",
  rawTextSha256: DIGEST,
  revision: createSidecarRevision(1),
  vaultRelativePath: "Notes/page.inkbook.json",
} as const;
const ATTEMPT = parseRecoveryAttemptId("ra_0123456789abcdefghjkmnpqrs");
const CHECKPOINT = parseSourceCheckpointId("scp_0123456789abcdefghjkmnpqrs");

describe("openRuntimePersistenceSessionV1", () => {
  beforeEach(() => {
    persistenceMocks.open.mockReset();
    persistenceMocks.snapshot.mockClear();
    persistenceMocks.snapshot.mockImplementation(
      (snapshot: unknown) => snapshot,
    );
  });

  it.each([
    { kind: "conflict" as const },
    { kind: "drift" as const },
    { kind: "newer-version" as const },
  ])(
    "returns an unusable open result without mutating lifecycle state: $kind",
    async (opened) => {
      persistenceMocks.open.mockResolvedValue(opened);
      const state = lifecycleState();

      await expect(openSession(state)).resolves.toBe(SNAPSHOT);

      expect(persistenceMocks.snapshot).toHaveBeenCalledWith(SNAPSHOT, opened);
      expect(state.calls).toEqual([]);
    },
  );

  it.each([
    { kind: "unannotated" as const },
    { kind: "removal-pending" as const },
  ])(
    "creates a source for a usable non-existing result: $kind",
    async ({ kind }) => {
      const opened = kind === "unannotated" ? unannotated() : removalPending();
      persistenceMocks.open.mockResolvedValue(opened);
      const state = lifecycleState();

      await expect(openSession(state)).resolves.toBe(SNAPSHOT);

      expect(state.calls).toEqual([
        `pending:${kind === "removal-pending" ? "active" : "none"}`,
        "base",
        `source:${kind}`,
        "history:true",
        "has-source:true",
      ]);
    },
  );

  it("fails closed when history initialization is rejected before checking source availability", async () => {
    const state = lifecycleState({
      initializeHistory: false,
      hasSource: false,
    });
    persistenceMocks.open.mockResolvedValue(unannotated());

    await expect(openSession(state)).resolves.toBe(SNAPSHOT);

    expect(state.calls).toEqual([
      "pending:none",
      "base",
      "source:unannotated",
      "history:false",
    ]);
  });
});

describe("openRuntimePersistenceSessionV1 existing lifecycle", () => {
  beforeEach(() => {
    persistenceMocks.open.mockReset();
    persistenceMocks.snapshot.mockClear();
    persistenceMocks.snapshot.mockImplementation(
      (snapshot: unknown) => snapshot,
    );
  });

  it("fails closed when history initializes but no source was created", async () => {
    const state = lifecycleState({ hasSource: false });
    persistenceMocks.open.mockResolvedValue(removalPending());

    await expect(openSession(state)).resolves.toBe(SNAPSHOT);

    expect(state.calls).toContain("has-source:false");
    expect(persistenceMocks.snapshot).toHaveBeenCalledWith(SNAPSHOT, {
      kind: "conflict",
    });
  });

  it("installs an existing sidecar and remains clean without recovery records", async () => {
    const opened = existing();
    persistenceMocks.open.mockResolvedValue(opened);
    const state = lifecycleState();

    await expect(openSession(state)).resolves.toBe(SNAPSHOT);

    expect(state.calls).toEqual([
      "pending:none",
      "base",
      "source:existing",
      "history:true",
      "has-source:true",
      "file",
      "layout",
      "raw-text",
      "save-pipeline",
    ]);
  });

  it("replays attempts and checkpoints and marks the existing session dirty", async () => {
    const opened = existing({
      recoveredAttemptIds: [ATTEMPT],
      recoveredCheckpointIds: [CHECKPOINT],
    });
    persistenceMocks.open.mockResolvedValue(opened);
    const state = lifecycleState();

    await openSession(state);

    expect(state.calls).toContain("attempt:ra_0123456789abcdefghjkmnpqrs");
    expect(state.calls).toContain("checkpoint:scp_0123456789abcdefghjkmnpqrs");
    expect(state.calls).toContain("dirty");
  });

  it("does not mark recovery records dirty while an active removal is present", async () => {
    const opened = existing({
      activeRemoval: {} as ActiveRemovalRecoveryV1,
      recoveredAttemptIds: [ATTEMPT],
    });
    persistenceMocks.open.mockResolvedValue(opened);
    const state = lifecycleState();

    await openSession(state);

    expect(state.calls).toContain("attempt:ra_0123456789abcdefghjkmnpqrs");
    expect(state.calls).not.toContain("dirty");
  });
});

function openSession(
  state: RuntimePersistenceLifecycleStateV1 & { readonly calls: string[] },
): Promise<NoteSessionSnapshotV1> {
  return openRuntimePersistenceSessionV1({
    config: {} as never,
    marker: {} as never,
    repository: {} as never,
    snapshot: SNAPSHOT,
    state,
  });
}

function lifecycleState(
  overrides: {
    readonly hasSource?: boolean;
    readonly initializeHistory?: boolean;
  } = {},
): RuntimePersistenceLifecycleStateV1 & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    addAttempt: (attemptId): void => {
      calls.push(`attempt:${attemptId}`);
    },
    addCheckpoint: (checkpointId): void => {
      calls.push(`checkpoint:${checkpointId}`);
    },
    calls,
    createSavePipeline: (): void => {
      calls.push("save-pipeline");
    },
    createSource: async (opened): Promise<void> => {
      calls.push(`source:${opened.kind}`);
    },
    hasSource: (): boolean => {
      calls.push(`has-source:${String(overrides.hasSource ?? true)}`);
      return overrides.hasSource ?? true;
    },
    initializeHistory: (): boolean => {
      calls.push(`history:${String(overrides.initializeHistory ?? true)}`);
      return overrides.initializeHistory ?? true;
    },
    markDirty: (): void => {
      calls.push("dirty");
    },
    setBase: (): void => {
      calls.push("base");
    },
    setFile: (): void => {
      calls.push("file");
    },
    setLayout: (): void => {
      calls.push("layout");
    },
    setPendingRemoval: (removal): void => {
      calls.push(removal === null ? "pending:none" : "pending:active");
    },
    setRawText: (): void => {
      calls.push("raw-text");
    },
  };
}

function unannotated(): RuntimePersistenceOpenResultV1 {
  return {
    base: BASE,
    digest: DIGEST,
    generation: 1 as never,
    kind: "unannotated",
  };
}

function removalPending(): RuntimePersistenceOpenResultV1 {
  return {
    activeRemoval: {} as ActiveRemovalRecoveryV1,
    base: BASE,
    digest: DIGEST,
    generation: 1 as never,
    kind: "removal-pending",
  };
}

function existing(
  overrides: Partial<
    Extract<RuntimePersistenceOpenResultV1, { readonly kind: "existing" }>
  > = {},
): RuntimePersistenceOpenResultV1 {
  const opened = {
    base: BASE,
    digest: DIGEST,
    file: { path: BASE.vaultRelativePath } as never,
    generation: 1 as never,
    historySnapshot: {} as never,
    kind: "existing",
    layout: { kind: "adjacent" },
    rawText: "sidecar",
    recoveredAttemptIds: [],
    recoveredCheckpointIds: [],
    revision: BASE.revision,
    scene: { revision: 1 } as never,
    ...overrides,
  };
  return opened as RuntimePersistenceOpenResultV1;
}
