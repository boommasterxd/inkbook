import { describe, expect, it } from "vitest";

import { createSceneRevision } from "../../../src/domain/model";
import {
  createSettingsRevision,
  createSidecarRevision,
  parseRelocationId,
  parseRemovalId,
  parseSha256Digest,
  type NoteIdentityV1,
} from "../../../src/application/note-session";
import {
  isTerminalRemoval,
  validateRelocationStart,
  validateRelocationTransition,
  validateRemovalStart,
  validateRemovalTransition,
  type FileRelocationRecordV1,
  type PrefixRelocationRecordV1,
  type RemovalRecordV1,
} from "../../../src/application/recovery";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact saga steps and cursors are the transition fixtures under test. */

const ID_PAYLOAD = "00000000000000000000000000";
const NOTE: NoteIdentityV1 = {
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "notes/source.md",
};
const BASE = {
  markdownPath: "notes/source.md",
  rawTextSha256: parseSha256Digest("a".repeat(64)),
  revision: createSidecarRevision(1),
  vaultRelativePath: "notes/source.inkbook.json",
};
const FILE_STEPS = [
  "prepared",
  "sidecar-moved",
  "identities-rekeyed",
  "sidecar-metadata-saved",
  "marker-saved",
  "checkpoint-acknowledged",
  "complete",
] as const;

function fileRecord(
  step: FileRelocationRecordV1["step"],
): FileRelocationRecordV1 {
  return {
    destinationMarkdownPath: "notes/destination.md",
    destinationSidecarPath: "notes/destination.inkbook.json",
    expectedSceneRevision: createSceneRevision(1),
    expectedSettingsRevision: createSettingsRevision(1),
    kind: "markdown-file",
    noteIdentity: NOTE,
    relocationId: parseRelocationId(`rel_${ID_PAYLOAD}`),
    sidecarBase: BASE,
    sourceMarkdownPath: "notes/source.md",
    sourceSidecarPath: "notes/source.inkbook.json",
    step,
  };
}

function prefixRecord(
  step: PrefixRelocationRecordV1["step"],
  cursor: number,
  admittedRecordCount = 2,
): PrefixRelocationRecordV1 {
  return {
    admittedRecordCount,
    cursor,
    expectedSettingsRevision: createSettingsRevision(1),
    generation: 1,
    kind: "folder-prefix",
    priorPrefix: "notes/source",
    relocationId: parseRelocationId(`rel_${ID_PAYLOAD}`),
    replacementPrefix: "notes/destination",
    step,
  };
}

function removal(overrides: Partial<RemovalRecordV1> = {}): RemovalRecordV1 {
  return {
    deadlineEpochMs: 1,
    deleteEventAcknowledged: false,
    expectedSceneRevision: createSceneRevision(1),
    kind: "annotation-removal",
    markerState: "present",
    noteIdentity: NOTE,
    removalId: parseRemovalId(`rm_${ID_PAYLOAD}`),
    sidecarBase: BASE,
    trashAcknowledged: false,
    ...overrides,
  };
}

describe("relocation saga transitions", () => {
  it("accepts only the next file relocation step", () => {
    expect(validateRelocationStart(fileRecord("prepared")).ok).toBe(true);
    expect(
      validateRelocationTransition({
        expected: fileRecord("prepared"),
        replacement: fileRecord("sidecar-moved"),
      }).ok,
    ).toBe(true);
    expect(
      validateRelocationTransition({
        expected: fileRecord("prepared"),
        replacement: fileRecord("identities-rekeyed"),
      }),
    ).toEqual({ ok: false, code: "invalid-command" });
  });

  it("accepts the complete file relocation sequence and no other edge", () => {
    for (const [priorIndex, expectedStep] of FILE_STEPS.entries()) {
      for (const [replacementIndex, replacementStep] of FILE_STEPS.entries()) {
        const result = validateRelocationTransition({
          expected: fileRecord(expectedStep),
          replacement: fileRecord(replacementStep),
        });
        expect(result.ok).toBe(replacementIndex === priorIndex + 1);
      }
    }
  });

  it("rejects immutable file field changes", () => {
    const valid = fileRecord("sidecar-moved");
    const changes: readonly FileRelocationRecordV1[] = [
      { ...valid, destinationMarkdownPath: "notes/other.md" },
      { ...valid, destinationSidecarPath: "notes/other.inkbook.json" },
      { ...valid, sourceMarkdownPath: "notes/other-source.md" },
      { ...valid, sourceSidecarPath: "notes/other-source.inkbook.json" },
      { ...valid, expectedSceneRevision: createSceneRevision(2) },
      { ...valid, expectedSettingsRevision: createSettingsRevision(2) },
      {
        ...valid,
        noteIdentity: {
          ...valid.noteIdentity,
          vaultRelativeMarkdownPath: "notes/other.md",
        },
      },
      { ...valid, sidecarBase: { ...valid.sidecarBase, revision: null } },
    ];
    for (const replacement of changes) {
      expect(
        validateRelocationTransition({
          expected: fileRecord("prepared"),
          replacement,
        }).ok,
      ).toBe(false);
    }
  });

  it("requires discriminator-specific Markdown path transitions", () => {
    expect(
      validateRelocationStart({
        ...fileRecord("prepared"),
        destinationMarkdownPath: NOTE.vaultRelativeMarkdownPath,
      }).ok,
    ).toBe(false);
    expect(
      validateRelocationStart({
        ...fileRecord("prepared"),
        destinationMarkdownPath: NOTE.vaultRelativeMarkdownPath,
        kind: "sidecar-location",
      }).ok,
    ).toBe(true);
    expect(
      validateRelocationStart({
        ...fileRecord("prepared"),
        kind: "sidecar-location",
      }).ok,
    ).toBe(false);
  });
});

describe("prefix relocation saga transitions", () => {
  it("advances prefix cursors only through processing and completes at count", () => {
    expect(
      validateRelocationTransition({
        expected: prefixRecord("prepared", 0),
        replacement: prefixRecord("processing", 1),
      }).ok,
    ).toBe(true);
    expect(
      validateRelocationTransition({
        expected: prefixRecord("processing", 1),
        replacement: prefixRecord("processing", 2),
      }).ok,
    ).toBe(true);
    expect(
      validateRelocationTransition({
        expected: prefixRecord("processing", 2),
        replacement: prefixRecord("complete", 2),
      }).ok,
    ).toBe(true);
    expect(
      validateRelocationTransition({
        expected: prefixRecord("processing", 1),
        replacement: prefixRecord("complete", 1),
      }).ok,
    ).toBe(false);
    expect(
      validateRelocationTransition({
        expected: prefixRecord("prepared", 0, 0),
        replacement: prefixRecord("complete", 0, 0),
      }).ok,
    ).toBe(true);
    expect(
      validateRelocationTransition({
        expected: prefixRecord("processing", 1),
        replacement: prefixRecord("processing", 1),
      }).ok,
    ).toBe(false);
    expect(
      validateRelocationTransition({
        expected: prefixRecord("processing", 2),
        replacement: prefixRecord("processing", 1),
      }).ok,
    ).toBe(false);
  });
});

describe("removal saga transitions", () => {
  it("accepts signals in either order and requires marker completion", () => {
    expect(validateRemovalStart(removal()).ok).toBe(true);
    const eventFirst = removal({ deleteEventAcknowledged: true });
    expect(
      validateRemovalTransition({
        expected: removal(),
        replacement: eventFirst,
      }).ok,
    ).toBe(true);
    const bothSignals = removal({
      deleteEventAcknowledged: true,
      trashAcknowledged: true,
    });
    expect(
      validateRemovalTransition({
        expected: eventFirst,
        replacement: bothSignals,
      }).ok,
    ).toBe(true);
    const removing = { ...bothSignals, markerState: "removing" } as const;
    const removed = { ...bothSignals, markerState: "removed" } as const;
    expect(
      validateRemovalTransition({
        expected: bothSignals,
        replacement: removing,
      }).ok,
    ).toBe(true);
    expect(
      validateRemovalTransition({ expected: removing, replacement: removed })
        .ok,
    ).toBe(true);
    expect(isTerminalRemoval(removed)).toBe(true);
  });

  it("rejects acknowledgement regression, marker skips, and no-op transitions", () => {
    expect(
      validateRemovalTransition({
        expected: removal({ trashAcknowledged: true }),
        replacement: removal(),
      }).ok,
    ).toBe(false);
    expect(
      validateRemovalTransition({
        expected: removal(),
        replacement: removal({ markerState: "removed" }),
      }).ok,
    ).toBe(false);
    expect(
      validateRemovalTransition({ expected: removal(), replacement: removal() })
        .ok,
    ).toBe(false);
    expect(
      validateRemovalTransition({
        expected: removal(),
        replacement: removal({ markerState: "removing" }),
      }).ok,
    ).toBe(false);
  });

  it("rejects removal identity mutations and nonterminal completion", () => {
    const current = removal({ trashAcknowledged: true });
    expect(isTerminalRemoval(current)).toBe(false);
    expect(
      validateRemovalTransition({
        expected: current,
        replacement: {
          ...current,
          deleteEventAcknowledged: true,
          deadlineEpochMs: 2,
        },
      }).ok,
    ).toBe(false);
    expect(
      validateRemovalTransition({
        expected: current,
        replacement: {
          ...current,
          deleteEventAcknowledged: true,
          expectedSceneRevision: createSceneRevision(2),
        },
      }).ok,
    ).toBe(false);
  });
});
