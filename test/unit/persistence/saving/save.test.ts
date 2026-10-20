import { describe, expect, it } from "vitest";

import { SaveError } from "../../../../src/persistence/saving/save-errors";
import type { MetadataGuardedFileRead } from "../../../../src/persistence/saving/save-ports";
import {
  saveExistingFile,
  saveExistingFileFromVerifiedPreflight,
} from "../../../../src/persistence/saving/save-existing";
import { saveNewFile } from "../../../../src/persistence/saving/save-new";
import { scanCanonicalRevisionPrefix } from "../../../../src/persistence/saving/revision-scan";
import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/constants";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { sha256Hex } from "../../../../src/persistence/serialization/sha256";
import { rectangle, snapshot } from "../worker/runtime/fixtures";

function serialized(revision: number, x: number) {
  const result = serializeInkbookDocument({
    ...snapshot(),
    elements: [rectangle(x)],
    revision,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const baseDocument = serialized(1, 100);
const outputDocument = serialized(2, 200);
const base = baseDocument.svg;
const output = outputDocument.svg;
const baseHash = baseDocument.hash;
const outputHash = outputDocument.hash;

function memoryVault(initial = base, reportedSizes: number[] = []) {
  let content = initial;
  let processCount = 0;
  let readCount = 0;
  return {
    create: async (_path: string, next: string) => {
      content = next;
    },
    createAndReadBack: async (path: string, next: string, maximumBytes: number) => {
      content = next;
      const size = new TextEncoder().encode(content).byteLength;
      if (size > maximumBytes) throw new RangeError("The vault file exceeds the input byte limit.");
      readCount += 1;
      return guardedRead(path, content, size);
    },
    process: async (_path: string, update: (current: string) => string) => {
      processCount += 1;
      content = update(content);
      return content;
    },
    processCount: () => processCount,
    readWithMetadataGuard: async (
      path: string,
      maximumBytes: number,
    ): Promise<MetadataGuardedFileRead> => {
      const size = reportedSizes.shift() ?? new TextEncoder().encode(content).byteLength;
      if (size > maximumBytes) throw new RangeError("The vault file exceeds the input byte limit.");
      readCount += 1;
      return guardedRead(path, content, size);
    },
    readCount: () => readCount,
    value: () => content,
  };
}

function guardedRead(path: string, content: string, size: number): MetadataGuardedFileRead {
  return {
    content,
    identity: { ctime: 1, mtime: 1, path, size },
    materialization: "host-full-read-not-bounded",
    stabilityEvidence: "object-identity-and-stat-unchanged",
  };
}

const verifier = {
  verify: async (content: string, revision: number, hash: string) =>
    content === output && revision === 2 && hash === outputHash,
};

function saveFromVerifiedPreflight(
  vault: ReturnType<typeof memoryVault>,
  verifiedOutputHash: string,
) {
  return saveExistingFileFromVerifiedPreflight(
    { path: "page.svg", output, outputHash, revision: 2 },
    { outputHash: baseHash, revision: 1, type: "confirmed" },
    {
      base: { outputHash: verifiedOutputHash, revision: 1, type: "confirmed" },
      content: base,
    },
    { currentRevision: () => 2 },
    vault,
    verifier,
  );
}

function saveExistingOutput(vault: ReturnType<typeof memoryVault>) {
  return saveExistingFile(
    { path: "page.svg", expectedBase: base, output, outputHash, revision: 2 },
    { currentRevision: () => 2 },
    vault,
    verifier,
  );
}

describe("canonical revision scan", () => {
  it("reads a bounded canonical safe-integer revision", () => {
    expect(scanCanonicalRevisionPrefix(output)).toBe(2);
    expect(scanCanonicalRevisionPrefix('<svg data-inkbook-revision="02"></svg>')).toBeNull();
    expect(
      scanCanonicalRevisionPrefix('<svg data-inkbook-revision="9007199254740992"></svg>'),
    ).toBeNull();
  });
});

describe("existing SVG save", () => {
  it("performs exact-base process and mandatory read-back verification", async () => {
    const vault = memoryVault();
    await expect(
      saveExistingFile(
        { path: "page.svg", expectedBase: base, output, outputHash, revision: 2 },
        { currentRevision: () => 2 },
        vault,
        verifier,
      ),
    ).resolves.toMatchObject({ revision: 2, outputHash });
    expect(vault.value()).toBe(output);
  });

  it("denies a preflight conflict without writing", async () => {
    const vault = memoryVault("external");
    await expect(
      saveExistingFile(
        { path: "page.svg", expectedBase: base, output, outputHash, revision: 2 },
        { currentRevision: () => 2 },
        vault,
        verifier,
      ),
    ).rejects.toMatchObject({ code: "external-conflict" } satisfies Partial<SaveError>);
    expect(vault.value()).toBe("external");
  });

  it("rejects a stale editor revision before starting the atomic process", async () => {
    const vault = memoryVault();
    await expect(
      saveExistingFile(
        { path: "page.svg", expectedBase: base, output, outputHash, revision: 2 },
        { currentRevision: () => 3 },
        vault,
        verifier,
      ),
    ).rejects.toMatchObject({ code: "stale-editor-revision" } satisfies Partial<SaveError>);
    expect(vault.processCount()).toBe(0);
    expect(vault.value()).toBe(base);
  });

  it("rejects a revision that changes after process starts but before its callback", async () => {
    const vault = memoryVault();
    let revision = 2;
    const originalProcess = vault.process;
    vault.process = async (path, update) => {
      revision = 3;
      return originalProcess(path, update);
    };
    await expect(
      saveExistingFile(
        { path: "page.svg", expectedBase: base, output, outputHash, revision: 2 },
        { currentRevision: () => revision },
        vault,
        verifier,
      ),
    ).rejects.toMatchObject({ code: "stale-editor-revision" } satisfies Partial<SaveError>);
    expect(vault.processCount()).toBe(1);
    expect(vault.value()).toBe(base);
  });

  it("checks the current revision at the callback return boundary", async () => {
    const vault = memoryVault();
    let revisionChecks = 0;

    await expect(
      saveExistingFile(
        { path: "page.svg", expectedBase: base, output, outputHash, revision: 2 },
        {
          currentRevision: () => {
            revisionChecks += 1;
            return revisionChecks === 1 ? 2 : 3;
          },
        },
        vault,
        verifier,
      ),
    ).rejects.toMatchObject({ code: "stale-editor-revision" } satisfies Partial<SaveError>);
    expect(revisionChecks).toBe(2);
    expect(vault.value()).toBe(base);
  });
});

describe("existing SVG save verification", () => {
  it("uses the shared save flow without rereading a verified preflight", async () => {
    const vault = memoryVault();
    await expect(saveFromVerifiedPreflight(vault, baseHash)).resolves.toMatchObject({
      revision: 2,
      outputHash,
    });
    expect(vault.processCount()).toBe(1);
    expect(vault.readCount()).toBe(1);
  });

  it("rejects failed read-back verification after writing the prepared output", async () => {
    const vault = memoryVault();
    let verificationCount = 0;
    await expect(
      saveExistingFile(
        { path: "page.svg", expectedBase: base, output, outputHash, revision: 2 },
        { currentRevision: () => 2 },
        vault,
        {
          verify: async (content, revision, hash) => {
            verificationCount += 1;
            expect({ content, revision, hash }).toEqual({
              content: output,
              revision: 2,
              hash: outputHash,
            });
            return false;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "read-back-mismatch" } satisfies Partial<SaveError>);
    expect(verificationCount).toBe(1);
    expect(vault.processCount()).toBe(1);
    expect(vault.readCount()).toBe(2);
    expect(vault.value()).toBe(output);
  });

  it("binds a preverified preflight to the confirmed revision and hash", async () => {
    const vault = memoryVault();
    await expect(saveFromVerifiedPreflight(vault, "different")).rejects.toMatchObject({
      code: "external-conflict",
    } satisfies Partial<SaveError>);
    expect(vault.value()).toBe(base);
  });

  it("reuses the exact-base race check after verified preflight", async () => {
    const vault = memoryVault();
    const originalProcess = vault.process;
    vault.process = async (path, update) => {
      await Promise.resolve();
      return originalProcess(path, () => update("external"));
    };
    await expect(saveFromVerifiedPreflight(vault, baseHash)).rejects.toMatchObject({
      code: "external-conflict",
    } satisfies Partial<SaveError>);
    expect(vault.value()).toBe(base);
  });
});

describe("existing SVG save read limits", () => {
  it("rejects an oversized exact-base preflight before reading or writing", async () => {
    const vault = memoryVault(base, [FILE_SCHEMA_LIMITS.totalInputBytes + 1]);

    await expect(saveExistingOutput(vault)).rejects.toBeInstanceOf(RangeError);
    expect(vault.readCount()).toBe(0);
    expect(vault.processCount()).toBe(0);
  });

  it("preflights the mandatory read-back size after the atomic write", async () => {
    const vault = memoryVault(base, [
      new TextEncoder().encode(base).byteLength,
      FILE_SCHEMA_LIMITS.totalInputBytes + 1,
    ]);

    await expect(saveExistingOutput(vault)).rejects.toBeInstanceOf(RangeError);
    expect(vault.value()).toBe(output);
    expect(vault.readCount()).toBe(1);
  });
});

describe("save output trust boundary", () => {
  it("rejects a malformed prepared output hash before reading or writing", async () => {
    const vault = memoryVault();
    await expect(
      saveExistingFile(
        { path: "page.svg", expectedBase: base, output, outputHash: "wrong", revision: 2 },
        { currentRevision: () => 2 },
        vault,
        verifier,
      ),
    ).rejects.toMatchObject({ code: "read-back-mismatch" } satisfies Partial<SaveError>);
    expect(vault.readCount()).toBe(0);
    expect(vault.processCount()).toBe(0);
    expect(vault.value()).toBe(base);
  });

  it("rejects unsafe SVG with its correct hash before any vault write", async () => {
    const vault = memoryVault();
    const unsafe = "<svg/>";

    await expect(
      saveExistingFile(
        {
          path: "page.svg",
          expectedBase: base,
          output: unsafe,
          outputHash: sha256Hex(unsafe),
          revision: 2,
        },
        { currentRevision: () => 2 },
        vault,
        verifier,
      ),
    ).rejects.toMatchObject({ code: "read-back-mismatch" } satisfies Partial<SaveError>);
    expect(vault.processCount()).toBe(0);
    expect(vault.value()).toBe(base);
  });
});

describe("new SVG save", () => {
  it("creates and confirms a complete file", async () => {
    const vault = memoryVault("");
    await expect(
      saveNewFile(
        { path: "new.svg", output, outputHash, revision: 2 },
        { currentRevision: () => 2 },
        vault,
        verifier,
      ),
    ).resolves.toMatchObject({ revision: 2 });
  });
});

describe("save background priority", () => {
  it.each(["existing", "new"] as const)(
    "rejects a revision changed during paused %s output validation",
    async (kind) => {
      const vault = memoryVault();
      let revision = 2;
      let resume: () => void = () => undefined;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const revisionSource = {
        currentRevision: () => revision,
        waitForBackground: () => paused,
      };
      const prepared = { path: "page.svg", expectedBase: base, output, outputHash, revision: 2 };
      const saving =
        kind === "existing"
          ? saveExistingFile(prepared, revisionSource, vault, verifier)
          : saveNewFile(prepared, revisionSource, vault, verifier);
      expect(vault.value()).toBe(base);
      expect(vault.processCount()).toBe(0);
      revision = 3;
      resume();
      await expect(saving).rejects.toMatchObject({ code: "stale-editor-revision" });
      expect(vault.value()).toBe(base);
      expect(vault.processCount()).toBe(0);
    },
  );
});
