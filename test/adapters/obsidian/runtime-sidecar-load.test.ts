import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../../src/domain/codecs";
import {
  createPersistenceCodecFallbackProcessorV1,
  PersistenceDecodedBytePoolV1,
  type PersistenceCodecPortV1,
  type PersistenceCodecSubmissionV1,
  type PersistenceCodecWorkV1,
} from "../../../src/application/persistence";
import { loadRuntimeSidecarV1 } from "../../../src/adapters/obsidian/runtime-sidecar-load";
import { VaultSidecarRepository } from "../../../src/adapters/obsidian/vault-sidecar/repository";
import { completeSidecar } from "../../application/persistence/support";
import { FakeVault, preparedSidecarWrite } from "./vault-sidecar/support";

const PATH = "Notes/A.inkbook.json";

class RecordingCodecPort implements PersistenceCodecPortV1 {
  readonly work: PersistenceCodecWorkV1[] = [];

  submit(work: PersistenceCodecWorkV1): PersistenceCodecSubmissionV1 {
    this.work.push(work);
    const processor = createPersistenceCodecFallbackProcessorV1(work);
    try {
      while (!processor.processNext()) {
        // The fake completes the production fallback processor deterministically.
      }
      return Object.freeze({
        result: Promise.resolve(processor.complete()),
        cancel: (): void => processor.dispose(),
      });
    } catch (error) {
      processor.dispose();
      return Object.freeze({
        result: Promise.reject(
          error instanceof Error
            ? error
            : new Error("Persistence fallback failed."),
        ),
        cancel: (): void => undefined,
      });
    }
  }
}

class DeferredCodecPort implements PersistenceCodecPortV1 {
  readonly submitted: Promise<void>;
  private rejectResult: ((error: Error) => void) | undefined;
  private resolveSubmitted: (() => void) | undefined;

  constructor() {
    this.submitted = new Promise<void>((resolve) => {
      this.resolveSubmitted = resolve;
    });
  }

  submit(): PersistenceCodecSubmissionV1 {
    const result = new Promise<never>((_resolve, reject) => {
      this.rejectResult = reject;
    });
    this.resolveSubmitted?.();
    return Object.freeze({
      result,
      cancel: (): void => {
        this.rejectResult?.(new Error("Persistence parse cancelled."));
      },
    });
  }
}

describe("loadRuntimeSidecarV1", () => {
  it("parses current and future sidecars through the codec port", async () => {
    const vault = new FakeVault();
    const current = preparedSidecarWrite(completeSidecar(), "desktop-tablet");
    vault.addFile(PATH, current.rawText);
    const codec = new RecordingCodecPort();
    const repository = new VaultSidecarRepository(vault);
    const decodedBytes = new PersistenceDecodedBytePoolV1();

    await expect(
      loadRuntimeSidecarV1(repository, PATH, codec, { decodedBytes }),
    ).resolves.toMatchObject({
      kind: "current",
      rawText: current.rawText,
      sidecar: completeSidecar(),
    });

    const future = structuredClone(completeSidecar()) as unknown as Record<
      string,
      unknown
    >;
    future.schemaVersion = { major: 1, minor: 1 };
    const futureRaw = `${canonicalizeJson(future)}\n`;
    vault.addFile(PATH, futureRaw);
    await expect(
      loadRuntimeSidecarV1(repository, PATH, codec, { decodedBytes }),
    ).resolves.toMatchObject({
      kind: "read-only-newer-version",
      rawText: futureRaw,
      schemaVersion: { major: 1, minor: 1 },
    });
    expect(codec.work.map((work) => work.kind)).toEqual([
      "parse-sidecar",
      "parse-sidecar",
    ]);
    expect(decodedBytes.ownedBytes).toBe(0);
  });

  it("fails closed for invalid input and decoded-memory exhaustion", async () => {
    const vault = new FakeVault();
    vault.addFile(PATH, "not-json");
    const repository = new VaultSidecarRepository(vault);
    const codec = new RecordingCodecPort();
    await expect(
      loadRuntimeSidecarV1(repository, PATH, codec),
    ).resolves.toMatchObject({ kind: "invalid" });

    const constrained = new PersistenceDecodedBytePoolV1(1);
    await expect(
      loadRuntimeSidecarV1(repository, PATH, codec, {
        decodedBytes: constrained,
      }),
    ).resolves.toEqual({ kind: "resource-limited" });
    expect(constrained.ownedBytes).toBe(0);
  });

  it("does not submit parsing after cancellation", async () => {
    const vault = new FakeVault();
    const prepared = preparedSidecarWrite(completeSidecar(), "desktop-tablet");
    vault.addFile(PATH, prepared.rawText);
    const codec = new RecordingCodecPort();
    const abort = new AbortController();
    abort.abort();
    await expect(
      loadRuntimeSidecarV1(new VaultSidecarRepository(vault), PATH, codec, {
        signal: abort.signal,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(codec.work).toHaveLength(0);
  });

  it("cancels submitted work and releases decoded-memory admission", async () => {
    const vault = new FakeVault();
    const prepared = preparedSidecarWrite(completeSidecar(), "desktop-tablet");
    vault.addFile(PATH, prepared.rawText);
    const codec = new DeferredCodecPort();
    const decodedBytes = new PersistenceDecodedBytePoolV1();
    const abort = new AbortController();
    const pending = loadRuntimeSidecarV1(
      new VaultSidecarRepository(vault),
      PATH,
      codec,
      { decodedBytes, signal: abort.signal },
    );
    await codec.submitted;
    expect(decodedBytes.ownedBytes).toBeGreaterThan(0);
    abort.abort();
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    expect(decodedBytes.ownedBytes).toBe(0);
  });
});
