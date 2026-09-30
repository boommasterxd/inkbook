import { TFile, type Vault } from "obsidian";
import { ObsidianInkbookDocumentRecognition } from "../../../src/obsidian/embeds/document-recognition";
import { WorkspaceRuntimeLifecycle } from "../../../src/obsidian/embeds/workspace-runtime-lifecycle";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as safeSvg from "../../../src/persistence/documents/safe-svg-validator";
import { inspectIntegrityBoundExport } from "../../../src/persistence/saving/autosave/export-integrity";
import { persistPreparedOutput } from "../../../src/persistence/saving/autosave/save-operation";
import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";
import {
  deriveDocumentIntegrityManifest,
  serializeInkbookDocument,
} from "../../../src/persistence/serialization/public";
import {
  decodeRuntimeResultChunked,
  encodeRuntimeResult,
} from "../../../src/persistence/worker/runtime/wire-codec";
import { assertResultMatchesRequest } from "../../../src/persistence/worker/runtime/request-result-validation";
import { createStandardPersistenceFixture } from "./fixtures";
import { immediateWorkScheduler } from "../../fixtures/obsidian/immediate-work-scheduler";

afterEach(() => vi.restoreAllMocks());

describe("owned canonical export adoption work", () => {
  it("adopts and saves 10k strokes without any receiver SVG scan or hash, retaining exact readback", async () => {
    const snapshot = createStandardPersistenceFixture(2);
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error(serialized.error.code);
    const identity = { sessionId: "owned", workerEpoch: 1, exportGeneration: 1, modelRevision: 2 };
    const transfer = encodeRuntimeResult({
      ...identity,
      type: "export-success",
      output: serialized.value.svg,
      outputHash: serialized.value.hash,
      integrityManifest: deriveDocumentIntegrityManifest(snapshot),
    });
    const scan = vi.spyOn(safeSvg, "validateSafeSvgSteps");
    const syncScan = vi.spyOn(safeSvg, "validateSafeSvg");
    const hash = vi.spyOn(ChunkedSha256.prototype, "update");
    const nativeHash = vi.spyOn(crypto.subtle, "digest");
    const hashedBytes = () =>
      hash.mock.calls.reduce((bytes, [chunk]) => bytes + chunk.byteLength, 0) +
      nativeHash.mock.calls.reduce((bytes, [, input]) => bytes + input.byteLength, 0);
    const options = { checkpoint: async () => {}, signal: new AbortController().signal };
    const decoded = await decodeRuntimeResultChunked(transfer.value, options);
    if (decoded.type !== "export-success") throw new Error("Expected canonical export");
    await expect(
      assertResultMatchesRequest(
        {
          ...identity,
          sessionId: "different",
          type: "export-full",
          baseModelRevision: null,
          snapshot,
        },
        decoded,
        options,
      ),
    ).rejects.toThrow("identity");
    const adopted = await inspectIntegrityBoundExport(decoded);
    const fallback = vi.fn(async () => false);
    let readback = adopted.content;
    const read = async () => ({
      content: readback,
      identity: { ctime: 1, mtime: 1, path: "owned.svg", size: readback.length },
      materialization: "host-full-read-not-bounded" as const,
      stabilityEvidence: "object-identity-and-stat-unchanged" as const,
    });
    const save = () =>
      persistPreparedOutput({
        beforeExistingWrite: undefined,
        expectedBase: { base: { type: "missing" }, type: "missing" },
        prepared: {
          output: adopted.content,
          outputHash: adopted.outputHash,
          revision: 2,
          path: "owned.svg",
        },
        revisionSource: { currentRevision: () => 2 },
        vault: {
          create: async () => {},
          createAndReadBack: read,
          process: async () => readback,
          readWithMetadataGuard: read,
        },
        verifier: { verify: fallback },
      });
    await expect(save()).resolves.toMatchObject({ revision: 2, outputHash: adopted.outputHash });
    expect(fallback).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(syncScan).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(nativeHash).not.toHaveBeenCalled();
    await confirmHostWrite(adopted.content, adopted.outputHash);
    expect(scan).not.toHaveBeenCalled();
    expect(syncScan).not.toHaveBeenCalled();
    expect(hashedBytes()).toBe(
      new TextEncoder().encode(adopted.content).byteLength * 2 + "<script/>".length,
    );
    hash.mockClear();
    nativeHash.mockClear();
    await verifyBoundRequest(adopted.content, adopted.outputHash);
    expect(scan).not.toHaveBeenCalled();
    expect(hashedBytes()).toBe(new TextEncoder().encode(adopted.content).byteLength);
    readback = adopted.content.replace("</svg>", "<script>alert(1)</script></svg>");
    await expect(save()).rejects.toMatchObject({ code: "read-back-mismatch" });
    expect(fallback).toHaveBeenCalledExactlyOnceWith(readback, 2, adopted.outputHash);
  });
});

async function confirmHostWrite(content: string, outputHash: string): Promise<void> {
  const path = "owned.svg";
  const file = new (TFile as unknown as new (path: string, size: number) => TFile)(
    path,
    content.length,
  );
  const notify = vi.fn(async () => "ignored" as const);
  const lookup = vi.fn(() => file);
  const cachedRead = vi.fn(async () => content);
  const read = vi.fn(async () => content);
  const frames: FrameRequestCallback[] = [];
  const scheduler = {
    ...immediateWorkScheduler(),
    requestFrame: (callback: FrameRequestCallback) => frames.push(callback),
  };
  let settle!: () => void;
  const settlement = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const vault = {
    getFileByPath: lookup,
    cachedRead,
    read,
    getResourcePath: () => path,
  } as unknown as Vault;
  const recognition = new ObsidianInkbookDocumentRecognition(vault, {
    workScheduler: immediateWorkScheduler(),
  });
  recognition.acceptConfirmedOutput(
    path,
    content,
    outputHash,
    `${file.stat.ctime}:${file.stat.mtime}:${file.stat.size}`,
  );
  const resolve = (output?: {
    readonly content: string;
    readonly outputHash: string;
    readonly signature: string;
  }) => {
    if (output === undefined) recognition.invalidate(path);
    else
      recognition.acceptConfirmedOutput(path, output.content, output.outputHash, output.signature);
  };
  lookup.mockClear();
  const lifecycle = new WorkspaceRuntimeLifecycle({
    activate: () => {},
    fallbackWindow: () => undefined,
    isDisposed: () => false,
    currentSaveSettlement: () => settlement,
    presentations: () => [],
    reloadPresentation: () => {},
    notifyExternalChange: notify,
    workScheduler: () => scheduler,
    vault,
  });
  recognition.deferRefresh(path);
  lifecycle.handleVaultModification(path, resolve);
  frames.shift()?.(0);
  expect(read).not.toHaveBeenCalled();
  lifecycle.handlePersisted({ documentId: path, outputHash, revision: 2, lockedAspectRatio: 1 });
  settle();
  await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(5));
  expect(await recognition.recognize(path)).toMatchObject({ contentIdentity: { outputHash } });
  expect(cachedRead).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  content += "<script/>";
  lookup.mockClear();
  recognition.deferRefresh(path);
  lifecycle.handleVaultModification(path, resolve);
  lifecycle.handlePersisted({ documentId: path, outputHash, revision: 2, lockedAspectRatio: 1 });
  frames.shift()?.(0);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledExactlyOnceWith(path));
  expect(recognition.cached(path)).toBeUndefined();
  const staleSignature = `${file.stat.ctime}:${file.stat.mtime}:${file.stat.size}`;
  file.stat.mtime += 1;
  recognition.acceptConfirmedOutput(path, content, outputHash, staleSignature);
  expect(recognition.cached(path)).toBeUndefined();
  recognition.dispose();
  lifecycle.dispose();
}

async function verifyBoundRequest(input: string, outputHash: string): Promise<void> {
  const identity = {
    sessionId: "owned",
    workerEpoch: 1,
    operationId: 1,
    purpose: "verification" as const,
  };
  await assertResultMatchesRequest(
    { type: "verify-output", identity, input },
    {
      type: "verify-output-success",
      identity,
      persisted: { type: "confirmed", revision: 2, outputHash },
    },
    { checkpoint: async () => {}, signal: new AbortController().signal },
  );
}
