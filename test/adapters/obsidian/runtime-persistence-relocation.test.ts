/* eslint-disable @typescript-eslint/no-magic-numbers -- Fixture counters represent persisted revisions and ordinals. */
import { describe, expect, it, vi } from "vitest";

import {
  parseRelocationId,
  parseSha256Digest,
  type NoteIdentityV1,
} from "../../../src/application/note-session";
import { createSceneRevision } from "../../../src/domain/model";
import type { NoteSessionV1 } from "../../../src/application/note-session";
import type { SidecarStorageLayoutV1 } from "../../../src/application/persistence";
import type {
  FileRelocationRecordV1,
  SidecarBaseIdentityV1,
} from "../../../src/application/recovery";
import { RuntimePersistenceRelocationV1 } from "../../../src/adapters/obsidian/runtime-persistence-relocation";
import type { RuntimePersistenceSourceV1 } from "../../../src/adapters/obsidian/runtime-persistence-source";
import type { VaultFileCapability } from "../../../src/adapters/obsidian/vault-sidecar/paths";
import type { VaultSidecarRelocator } from "../../../src/adapters/obsidian/vault-sidecar/relocation";

const IDENTITY: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Notes/page.md",
});
const REPLACEMENT: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Archive/page.md",
});
const DIGEST = parseSha256Digest("a".repeat(64));
const BASE: SidecarBaseIdentityV1 = Object.freeze({
  markdownPath: IDENTITY.vaultRelativeMarkdownPath,
  rawTextSha256: DIGEST,
  revision: 1 as never,
  vaultRelativePath: "Notes/page.inkbook.json",
});
const NULL_REVISION_BASE: SidecarBaseIdentityV1 = Object.freeze({
  ...BASE,
  revision: null,
});
const FILE = file("Notes/page.inkbook.json");
const DESTINATION = file("Archive/page.inkbook.json");

describe("RuntimePersistenceRelocationV1", () => {
  it("requires both a durable base and an active session for a relocation member", () => {
    const harness = relocationHarness({ base: null });
    expect(harness.relocation.member(REPLACEMENT, 0)).toBeNull();

    harness.base = BASE;
    harness.session = null;
    expect(harness.relocation.member(REPLACEMENT, 0)).toBeNull();
  });

  it("builds members for the current layout or preserves the base path without layout evidence", () => {
    const harness = relocationHarness({ layout: null });
    expect(harness.relocation.member(REPLACEMENT, 1)).toMatchObject({
      destinationSidecarPath: BASE.vaultRelativePath,
      ordinal: 1,
    });

    harness.layout = { kind: "adjacent" };
    expect(harness.relocation.member(REPLACEMENT, 2)).toMatchObject({
      destinationSidecarPath: "Archive/page.inkbook.json",
      ordinal: 2,
    });
  });

  it("tracks active relocation records", () => {
    const harness = relocationHarness();
    const record = relocationRecord();

    harness.relocation.setActive(record);
    expect(harness.relocation.active).toBe(record);
    harness.relocation.setActive(null);
    expect(harness.relocation.active).toBeNull();
  });

  it("rekeys identity, base, source context, and save pipeline when all evidence is durable", () => {
    const harness = relocationHarness({ source: source(true) });
    const record = relocationRecord();

    harness.relocation.rekey(record);

    expect(harness.identity).toBe(record.noteIdentity);
    expect(harness.base).toBe(record.sidecarBase);
    expect(harness.context).toEqual({
      base: record.sidecarBase,
      digest: DIGEST,
      generation: 1,
    });
    expect(harness.pipelineCreations).toBe(1);
  });

  it("does not update optional evidence when the base, source, or revision is absent", () => {
    const harness = relocationHarness({ base: null, source: null });
    harness.relocation.rekey({
      ...relocationRecord(),
      sidecarBase: NULL_REVISION_BASE,
    });

    expect(harness.identity.vaultRelativeMarkdownPath).toBe(
      REPLACEMENT.vaultRelativeMarkdownPath,
    );
    expect(harness.context).toBeNull();
    expect(harness.pipelineCreations).toBe(0);
  });
});

describe("RuntimePersistenceRelocationV1 metadata", () => {
  it("returns success without flushing when no save pipeline is available", async () => {
    const harness = relocationHarness({ pipelineAvailable: false });

    await expect(harness.relocation.saveMetadata()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(harness.dirtyCalls).toBe(0);
    expect(harness.flushCalls).toBe(0);
  });

  it.each([
    ["flushed", { ok: true, value: undefined }],
    ["failed", { code: "relocation-pending", ok: false }],
  ] as const)(
    "marks metadata dirty and reports a %s flush",
    async (flush, expected) => {
      const harness = relocationHarness({ flushResult: flush });

      await expect(harness.relocation.saveMetadata()).resolves.toEqual(
        expected,
      );
      expect(harness.dirtyCalls).toBe(1);
      expect(harness.flushCalls).toBe(1);
    },
  );

  it.each([
    [null, { ok: true, value: undefined }],
    [undefined, { ok: true, value: undefined }],
    [true, { ok: true, value: undefined }],
    [false, { code: "recovery-unavailable", ok: false }],
  ] as const)(
    "awaitCheckpoint maps a source force result of %s",
    async (forced, expected) => {
      const harness = relocationHarness({
        source: forced === null ? null : source(forced),
      });

      await expect(harness.relocation.awaitCheckpoint()).resolves.toEqual(
        expected,
      );
    },
  );
});

describe("RuntimePersistenceRelocationV1 sidecar moves", () => {
  it("settles a sidecar move only after a successful flush", async () => {
    const harness = relocationHarness({ flushResult: "failed" });
    const relocator = relocatorResult({
      kind: "acknowledged",
      destinationFile: DESTINATION,
    });

    await expect(
      harness.relocation.settleAndMove(relocationRecord(), relocator),
    ).resolves.toEqual({ code: "relocation-pending", ok: false });
    expect(harness.file).toBe(FILE);
  });

  it.each([
    [
      "revisionless",
      { ...relocationRecord(), sidecarBase: NULL_REVISION_BASE },
      "success",
    ],
    ["missing file", relocationRecord(), "conflict"],
    ["already moved", relocationRecord(), "success"],
  ] as const)("settles a %s record", async (_case, record, result) => {
    const harness = relocationHarness({ file: settlementFile(_case) });
    const expected =
      result === "success"
        ? { ok: true, value: undefined }
        : { code: "sidecar-conflict", ok: false };

    await expect(
      harness.relocation.settleAndMove(
        record,
        relocatorResult({ kind: "acknowledged", destinationFile: DESTINATION }),
      ),
    ).resolves.toEqual(expected);
  });

  it.each([
    [{ kind: "resource-limit" as const }, "resource-limit"],
    [{ kind: "collision" as const }, "sidecar-conflict"],
  ] as const)("maps a relocation failure to %s", async (moved, code) => {
    const harness = relocationHarness();

    await expect(
      harness.relocation.settleAndMove(
        relocationRecord(),
        relocatorResult(moved),
      ),
    ).resolves.toEqual({ code, ok: false });
  });

  it("updates the current file after an acknowledged sidecar move", async () => {
    const harness = relocationHarness();

    await expect(
      harness.relocation.settleAndMove(
        relocationRecord(),
        relocatorResult({ kind: "acknowledged", destinationFile: DESTINATION }),
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(harness.file).toBe(DESTINATION);
  });
});

interface RelocationHarness {
  base: SidecarBaseIdentityV1 | null;
  context: {
    readonly base: SidecarBaseIdentityV1;
    readonly digest: string;
    readonly generation: number;
  } | null;
  dirtyCalls: number;
  file: VaultFileCapability | null;
  flushCalls: number;
  flushResult: "failed" | "flushed";
  identity: NoteIdentityV1;
  layout: SidecarStorageLayoutV1 | null;
  pipelineAvailable: boolean;
  pipelineCreations: number;
  relocation: RuntimePersistenceRelocationV1;
  session: NoteSessionV1 | null;
  source: RuntimePersistenceSourceV1 | null;
}

function relocationHarness(
  overrides: Partial<Omit<RelocationHarness, "relocation">> = {},
): RelocationHarness {
  const harness = {
    base: BASE,
    context: null,
    dirtyCalls: 0,
    file: FILE,
    flushCalls: 0,
    flushResult: "flushed" as const,
    identity: IDENTITY,
    layout: { kind: "adjacent" } as const,
    pipelineAvailable: true,
    pipelineCreations: 0,
    session: {
      snapshot: { scene: { revision: 1 } },
    } as unknown as NoteSessionV1,
    source: source(true),
    ...overrides,
  } as RelocationHarness;

  harness.relocation = new RuntimePersistenceRelocationV1({
    createSavePipeline: (): void => {
      harness.pipelineCreations += 1;
    },
    flush: async (): Promise<"failed" | "flushed"> => {
      harness.flushCalls += 1;
      return harness.flushResult;
    },
    history: {
      updatePersistenceContext: (base, generation, digest): void => {
        harness.context = { base, digest, generation };
      },
    },
    markDirty: (): void => {
      harness.dirtyCalls += 1;
    },
    normalizePath: (path): string => path,
    readBase: (): SidecarBaseIdentityV1 | null => harness.base,
    readFile: (): VaultFileCapability | null => harness.file,
    readIdentity: (): NoteIdentityV1 => harness.identity,
    readLayout: (): SidecarStorageLayoutV1 | null => harness.layout,
    readPipelineAvailable: (): boolean => harness.pipelineAvailable,
    readSession: (): NoteSessionV1 | null => harness.session,
    readSource: (): RuntimePersistenceSourceV1 | null => harness.source,
    setBase: (base): void => {
      harness.base = base;
    },
    setFile: (file): void => {
      harness.file = file;
    },
    setIdentity: (identity): void => {
      harness.identity = identity;
    },
  });
  return harness;
}

function source(forced: boolean | undefined): RuntimePersistenceSourceV1 {
  return {
    durableSource: { digest: DIGEST, generation: 1 },
    force: async () => forced,
  } as unknown as RuntimePersistenceSourceV1;
}

function file(path: string): VaultFileCapability {
  return { path, stat: { size: 1 } };
}

function settlementFile(
  caseName: "revisionless" | "missing file" | "already moved",
): VaultFileCapability | null {
  if (caseName === "missing file") return null;
  if (caseName === "already moved") return DESTINATION;
  return FILE;
}

function relocationRecord(): FileRelocationRecordV1 {
  return {
    destinationMarkdownPath: REPLACEMENT.vaultRelativeMarkdownPath,
    destinationSidecarPath: DESTINATION.path,
    expectedSceneRevision: createSceneRevision(1),
    expectedSettingsRevision: 1 as never,
    kind: "markdown-file",
    noteIdentity: REPLACEMENT,
    relocationId: parseRelocationId("rel_0123456789abcdefghjkmnpqrs"),
    sidecarBase: BASE,
    sourceMarkdownPath: IDENTITY.vaultRelativeMarkdownPath,
    sourceSidecarPath: FILE.path,
    step: "prepared",
  };
}

function relocatorResult(
  result:
    | {
        readonly kind: "acknowledged";
        readonly destinationFile: VaultFileCapability;
      }
    | { readonly kind: "collision" }
    | { readonly kind: "resource-limit" },
): VaultSidecarRelocator {
  return {
    relocate: vi.fn(async () => result),
  } as unknown as VaultSidecarRelocator;
}
