import { describe, expect, it } from "vitest";

import { createSceneRevision } from "../../../src/domain/model";
import {
  parseHistoryEntryId,
  parseOperationId,
} from "../../../src/domain/operations";
import { createRuntimeSceneStateV1 } from "../../../src/domain/scene";
import {
  admitCommand,
  createHistoryEpoch,
  createLayoutRevision,
  createSourceGeneration,
  createSidecarRevision,
  createSettingsRevision,
  deriveEffectiveViewAccess,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseViewId,
  revalidateCommandAdmission,
  type AnnotationCommandRequestV1,
  type CommandViewV1,
  type FirstSidecarPendingV1,
  type NoteSessionSnapshotV1,
} from "../../../src/application/note-session";

const ID_PAYLOAD = "00000000000000000000000000";
const DIGEST_HEX_LENGTH = 64;
const SECOND_REVISION = 2;
const DIGEST_A = parseSha256Digest("a".repeat(DIGEST_HEX_LENGTH));
const DIGEST_B = parseSha256Digest("b".repeat(DIGEST_HEX_LENGTH));
const VIEW = parseViewId("view-a");
const EPOCH = createHistoryEpoch(1);
const SOURCE_GENERATION = createSourceGeneration(1);
const LAYOUT_REVISION = createLayoutRevision(1);

function scene(revision = 0): NoteSessionSnapshotV1["scene"] {
  return createRuntimeSceneStateV1({
    elements: [],
    groups: [],
    noteAppearance: {
      background: "none",
      contrast: "medium",
      horizontalSpacing: "standard",
    },
    objectOrder: [],
    revision: createSceneRevision(revision),
  });
}

function snapshot(
  overrides: Partial<NoteSessionSnapshotV1> = {},
): NoteSessionSnapshotV1 {
  return {
    historyLease: { kind: "owned", ownerViewId: VIEW, epoch: EPOCH },
    lifecycle: "ready",
    persistence: { kind: "clean", sidecarRevision: createSidecarRevision(1) },
    scene: scene(),
    source: {
      digest: DIGEST_A,
      generation: SOURCE_GENERATION,
      kind: "durable",
    },
    ...overrides,
  };
}

function view(overrides: Partial<CommandViewV1> = {}): CommandViewV1 {
  return {
    historyAvailable: true,
    layoutRevision: LAYOUT_REVISION,
    mode: "editable",
    prospectiveHistoryEpoch: EPOCH,
    viewId: VIEW,
    ...overrides,
  };
}

function request(
  overrides: Partial<AnnotationCommandRequestV1> = {},
): AnnotationCommandRequestV1 {
  return {
    expectedLayoutRevision: LAYOUT_REVISION,
    expectedSceneRevision: createSceneRevision(0),
    expectedSourceDigest: DIGEST_A,
    expectedSourceGeneration: SOURCE_GENERATION,
    firstSidecarExpectation: null,
    historyEntryId: parseHistoryEntryId(`he_${ID_PAYLOAD}`),
    operationId: parseOperationId(`op_${ID_PAYLOAD}`),
    recoveryAttemptId: parseRecoveryAttemptId(`ra_${ID_PAYLOAD}`),
    recoveryAvailable: true,
    ...overrides,
  };
}

describe("note-session command admission", () => {
  it("returns an immutable revision-bound token for the owner", () => {
    const result = admitCommand(snapshot(), view(), request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      historyEpoch: EPOCH,
      sceneRevision: 0,
      sourceDigest: DIGEST_A,
      viewId: VIEW,
    });
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("derives read-only access for reading and secondary panes", () => {
    expect(
      deriveEffectiveViewAccess(snapshot(), view({ mode: "reading" })),
    ).toEqual({
      kind: "reading-read-only",
    });
    expect(
      deriveEffectiveViewAccess(
        snapshot(),
        view({ viewId: parseViewId("view-b") }),
      ),
    ).toEqual({ kind: "secondary-read-only", ownerViewId: VIEW });
  });

  it.each([
    ["disposed", snapshot({ lifecycle: "disposed" }), view(), request()],
    [
      "stale-scene",
      snapshot(),
      view(),
      request({ expectedSceneRevision: createSceneRevision(1) }),
    ],
    [
      "stale-source",
      snapshot(),
      view(),
      request({ expectedSourceDigest: DIGEST_B }),
    ],
    [
      "stale-layout",
      snapshot(),
      view({ layoutRevision: createLayoutRevision(SECOND_REVISION) }),
      request(),
    ],
    [
      "recovery-unavailable",
      snapshot(),
      view(),
      request({ recoveryAvailable: false }),
    ],
    [
      "sidecar-conflict",
      snapshot({ persistence: { kind: "conflict" } }),
      view(),
      request(),
    ],
    [
      "sidecar-drift",
      snapshot({ persistence: { kind: "drift" } }),
      view(),
      request(),
    ],
  ] as const)(
    "rejects %s without a token",
    (code, state, candidateView, candidate) => {
      expect(admitCommand(state, candidateView, candidate)).toEqual({
        ok: false,
        code,
      });
    },
  );
});

describe("note-session command revalidation", () => {
  it("revalidates every bound revision and lease epoch", () => {
    const admitted = admitCommand(snapshot(), view(), request());
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    expect(
      revalidateCommandAdmission(snapshot(), view(), admitted.value, {
        recoveryAvailable: true,
      }),
    ).toEqual({
      ok: true,
      value: admitted.value,
    });
    expect(
      revalidateCommandAdmission(
        snapshot({ scene: scene(1) }),
        view(),
        admitted.value,
        { recoveryAvailable: true },
      ),
    ).toEqual({ ok: false, code: "stale-scene" });
    expect(
      revalidateCommandAdmission(snapshot(), view(), admitted.value, {
        recoveryAvailable: false,
      }),
    ).toEqual({ ok: false, code: "recovery-unavailable" });
  });
});

describe("first-sidecar command admission", () => {
  it("admits only the exact identity-bound first-sidecar command", () => {
    const candidate = request({
      firstSidecarExpectation: {
        expectedSettingsRevision: createSettingsRevision(1),
        expectedVaultRelativePath: "notes/source.inkbook.json",
        noteIdentity: {
          vaultIdHint: "vault",
          vaultRelativeMarkdownPath: "notes/source.md",
        },
      },
    });
    const expectation = candidate.firstSidecarExpectation;
    if (expectation === null) throw new Error("Missing test expectation.");
    const pending: FirstSidecarPendingV1 = {
      expectedSettingsRevision: expectation.expectedSettingsRevision,
      expectedSourceDigest: candidate.expectedSourceDigest,
      expectedSourceGeneration: candidate.expectedSourceGeneration,
      expectedVaultRelativePath: expectation.expectedVaultRelativePath,
      historyEntryId: candidate.historyEntryId,
      noteIdentity: expectation.noteIdentity,
      operationId: candidate.operationId,
      recoveryAttemptId: candidate.recoveryAttemptId,
    };
    const state = snapshot({
      persistence: { kind: "first-sidecar-pending", pending },
    });

    expect(admitCommand(state, view(), candidate).ok).toBe(true);
    expect(
      admitCommand(state, view(), {
        ...candidate,
        firstSidecarExpectation: {
          ...expectation,
          expectedVaultRelativePath: "notes/other.inkbook.json",
        },
      }),
    ).toEqual({ ok: false, code: "invalid-command" });
  });

  it("requires a validated empty revision-zero scene before first admission", () => {
    const firstRequest = request({
      firstSidecarExpectation: {
        expectedSettingsRevision: createSettingsRevision(1),
        expectedVaultRelativePath: "notes/source.inkbook.json",
        noteIdentity: {
          vaultIdHint: "vault",
          vaultRelativeMarkdownPath: "notes/source.md",
        },
      },
    });
    const unannotated = snapshot({ persistence: { kind: "unannotated" } });

    expect(admitCommand(unannotated, view(), firstRequest).ok).toBe(true);
    expect(
      admitCommand({ ...unannotated, scene: scene(1) }, view(), {
        ...firstRequest,
        expectedSceneRevision: createSceneRevision(1),
      }),
    ).toEqual({ ok: false, code: "invalid-command" });
    const validScene = scene();
    const sceneWithUnknownAppearanceField = {
      ...validScene,
      noteAppearance: {
        ...validScene.noteAppearance,
        unexpected: true,
      },
    } as NoteSessionSnapshotV1["scene"];
    expect(
      admitCommand(
        { ...unannotated, scene: sceneWithUnknownAppearanceField },
        view(),
        firstRequest,
      ),
    ).toEqual({ ok: false, code: "invalid-command" });
  });

  it("rejects a first-sidecar expectation after a sidecar exists", () => {
    expect(
      admitCommand(snapshot(), view(), {
        ...request(),
        firstSidecarExpectation: {
          expectedSettingsRevision: createSettingsRevision(1),
          expectedVaultRelativePath: "notes/source.inkbook.json",
          noteIdentity: {
            vaultIdHint: "vault",
            vaultRelativeMarkdownPath: "notes/source.md",
          },
        },
      }),
    ).toEqual({ ok: false, code: "invalid-command" });
  });
});
