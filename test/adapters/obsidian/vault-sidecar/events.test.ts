import { describe, expect, it } from "vitest";

import {
  classifyVaultSidecarEvent,
  OrphanSidecarReviewer,
} from "../../../../src/adapters/obsidian/vault-sidecar/events";
import {
  ControlledReviewScheduler,
  fakeFile,
  fakeFolder,
  FakeVault,
} from "./support";

const IDENTITY = Object.freeze({
  markdownPath: "Notes/A.md",
  sidecarPath: "Notes/A.inkbook.json",
});

describe("Vault sidecar event classification", () => {
  it("rejects unsafe open and event paths before classification", () => {
    expect(
      classifyVaultSidecarEvent(
        { ...IDENTITY, sidecarPath: "../outside.inkbook.json" },
        { kind: "modify", target: fakeFile(IDENTITY.sidecarPath) },
      ),
    ).toEqual({ kind: "invalid-path" });
    expect(
      classifyVaultSidecarEvent(IDENTITY, {
        kind: "rename",
        oldPath: "../outside.inkbook.json",
        target: fakeFile(IDENTITY.sidecarPath),
      }),
    ).toEqual({ kind: "invalid-path" });
  });

  it("classifies exact sidecar writes for runtime ownership validation", () => {
    for (const kind of ["create", "modify"] as const) {
      expect(
        classifyVaultSidecarEvent(IDENTITY, {
          kind,
          target: fakeFile(IDENTITY.sidecarPath),
        }),
      ).toEqual({ eventKind: kind, kind: "sidecar-write" });
    }
  });

  it("does not trust an event-level write ownership flag", () => {
    expect(
      classifyVaultSidecarEvent(IDENTITY, {
        kind: "modify",
        target: fakeFile(IDENTITY.sidecarPath),
      }),
    ).toEqual({ eventKind: "modify", kind: "sidecar-write" });
  });
});

describe("Vault sidecar rename and delete classification", () => {
  it("classifies external rename and delete as missing drift preserving recovery", () => {
    expect(
      classifyVaultSidecarEvent(IDENTITY, {
        kind: "rename",
        oldPath: IDENTITY.sidecarPath,
        target: fakeFile("Moved/A.inkbook.json"),
      }),
    ).toEqual({
      kind: "marker-present-sidecar-missing",
      movedPath: "Moved/A.inkbook.json",
      preserveAcknowledgedRecovery: true,
    });
    expect(
      classifyVaultSidecarEvent(IDENTITY, {
        kind: "delete",
        target: fakeFile(IDENTITY.sidecarPath),
      }),
    ).toEqual({
      kind: "marker-present-sidecar-missing",
      movedPath: null,
      preserveAcknowledgedRecovery: true,
    });
  });

  it("leaves relocation ownership to the exact runtime relocation token", () => {
    expect(
      classifyVaultSidecarEvent(IDENTITY, {
        kind: "rename",
        oldPath: IDENTITY.sidecarPath,
        target: fakeFile("Notes/B.inkbook.json"),
      }),
    ).toEqual({
      kind: "marker-present-sidecar-missing",
      movedPath: "Notes/B.inkbook.json",
      preserveAcknowledgedRecovery: true,
    });
  });

  it("distinguishes Markdown, folder, unrelated, and confused host events", () => {
    expect(
      classifyVaultSidecarEvent(IDENTITY, {
        kind: "rename",
        oldPath: IDENTITY.markdownPath,
        target: fakeFile("Notes/B.md"),
      }),
    ).toEqual({ kind: "markdown-file-relocation", newPath: "Notes/B.md" });
    expect(
      classifyVaultSidecarEvent(IDENTITY, {
        kind: "delete",
        target: fakeFile(IDENTITY.markdownPath),
      }),
    ).toEqual({ kind: "markdown-deleted-sidecar-orphaned" });
    expect(
      classifyVaultSidecarEvent(IDENTITY, {
        kind: "rename",
        oldPath: "Notes",
        target: fakeFolder("Archive"),
      }),
    ).toEqual({
      kind: "folder-path-change",
      markdownAffected: true,
      oldPath: "Notes",
      newPath: "Archive",
      sidecarAffected: true,
    });
    expect(
      classifyVaultSidecarEvent(IDENTITY, {
        kind: "modify",
        target: fakeFolder("Notes"),
      }),
    ).toEqual({ kind: "wrong-file-kind" });
    expect(
      classifyVaultSidecarEvent(IDENTITY, {
        kind: "delete",
        target: { ...fakeFile(IDENTITY.sidecarPath), children: [] },
      }),
    ).toEqual({ kind: "wrong-file-kind" });
  });
});

describe("explicit orphan review", () => {
  it("uses one getFiles pass, exact suffix filtering, hidden exclusion, and bounded yields", async () => {
    const vault = new FakeVault();
    vault.addFile("A.inkbook.json", "{}");
    vault.addFile("B.inkbook.json.bak", "{}");
    vault.addFile(".hidden/C.inkbook.json", "{}");
    const fillerCount = Number("513");
    for (let index = 0; index < fillerCount; index += 1) {
      vault.addFile(`Notes/${String(index)}.md`, "");
    }
    const scheduler = new ControlledReviewScheduler();
    const result = await new OrphanSidecarReviewer(vault, scheduler).review();
    expect(result).toMatchObject({
      kind: "complete",
      inspectedFiles: fillerCount + Number("3"),
      requiresContinuation: false,
      continuation: null,
    });
    if (result.kind !== "complete")
      throw new Error("Expected completed review.");
    expect(result.candidates.map((file) => file.path)).toEqual([
      "A.inkbook.json",
    ]);
    expect(scheduler.yields).toBeGreaterThanOrEqual(1);
    expect(vault.getFilesCalls).toBe(1);
  });

  it("caps candidates at ten thousand and reports continuation", async () => {
    const vault = new FakeVault();
    const overLimit = Number("10001");
    for (let index = 0; index < overLimit; index += 1) {
      vault.addFile(`Notes/${String(index)}.inkbook.json`, "{}");
    }
    const reviewer = new OrphanSidecarReviewer(
      vault,
      new ControlledReviewScheduler(),
    );
    const result = await reviewer.review();
    expect(result).toMatchObject({
      kind: "complete",
      inspectedFiles: Number("10000"),
      requiresContinuation: true,
    });
    if (result.kind !== "complete")
      throw new Error("Expected completed review.");
    expect(result.candidates).toHaveLength(Number("10000"));
    expect(result.continuation).not.toBeNull();
    if (result.continuation === null) throw new Error("Expected continuation.");
    const continued = await reviewer.continueReview(result.continuation);
    expect(continued).toMatchObject({
      kind: "complete",
      inspectedFiles: 1,
      requiresContinuation: false,
      continuation: null,
    });
    if (continued.kind !== "complete") {
      throw new Error("Expected continued review.");
    }
    expect(continued.candidates.map((file) => file.path)).toEqual([
      "Notes/10000.inkbook.json",
    ]);
  });

  it("rejects stale continuation after the Vault listing changes", async () => {
    const vault = new FakeVault();
    for (let index = 0; index < Number("10001"); index += 1) {
      vault.addFile(`Notes/${String(index)}.inkbook.json`, "{}");
    }
    const reviewer = new OrphanSidecarReviewer(
      vault,
      new ControlledReviewScheduler(),
    );
    const first = await reviewer.review();
    if (first.kind !== "complete" || first.continuation === null) {
      throw new Error("Expected continuation.");
    }
    vault.addFile("Notes/new.md", "");

    await expect(reviewer.continueReview(first.continuation)).resolves.toEqual({
      kind: "stale-continuation",
    });
  });

  it("cancels deterministically during a yield and disposes idempotently", async () => {
    const vault = new FakeVault();
    const fileCount = Number("513");
    for (let index = 0; index < fileCount; index += 1) {
      vault.addFile(`Notes/${String(index)}.md`, "");
    }
    const scheduler = new ControlledReviewScheduler();
    const reviewer = new OrphanSidecarReviewer(vault, scheduler);
    scheduler.onYield = (): void => {
      reviewer.dispose();
      reviewer.dispose();
    };
    await expect(reviewer.review()).resolves.toEqual({ kind: "cancelled" });
    await expect(reviewer.review()).resolves.toEqual({ kind: "cancelled" });
  });
});
