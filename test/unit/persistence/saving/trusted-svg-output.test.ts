import { InteractiveWorkPriority } from "../../../../src/editor/session/interactive-work-priority";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  hashConfirmedSvgContent,
  inspectTrustedSvgOutput,
} from "../../../../src/persistence/scheduling/trusted-svg-output";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";
import { sha256Hex } from "../../../../src/persistence/serialization/sha256";
import { createMaximumComplexitySvg } from "../../../fixtures/persistence/safe-svg";

afterEach(() => vi.restoreAllMocks());

let maximumOutput: Readonly<{ content: string; outputHash: string; totalBytes: number }>;

beforeAll(async () => {
  // Share immutable reference data; every inspection still owns fresh hashing and validation.
  const content = createMaximumComplexitySvg();
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  maximumOutput = Object.freeze({
    content,
    outputHash: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    totalBytes: bytes.byteLength,
  });
});

describe("trusted SVG output validation slices", () => {
  it("rejects external output with literal markup hidden inside metadata", async () => {
    const output = maximumOutput.content.replace(
      "</metadata>",
      "<script>bad()</script></metadata>",
    );
    await expect(inspectTrustedSvgOutput(output)).rejects.toThrow("safe Inkbook SVG");
  });

  it("checks cancellation during hashing at the production 64 KiB chunk boundary", async () => {
    const hashChunkBytes = 64 * 1024;
    const output = new Uint8Array(hashChunkBytes * 6).fill(0x20);
    const controller = new AbortController();
    let checkpoints = 0;

    await expect(
      inspectTrustedSvgOutput(output, undefined, {
        checkpoint: async () => {
          checkpoints += 1;
          if (checkpoints === 4) controller.abort();
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(checkpoints).toBe(4);
  });

  it("honors cancellation while inspecting markup after string hashing completes", async () => {
    const output = maximumOutput.content;
    const chunkBytes = 64 * 1024;
    const firstInspectionCheckpoint = Math.ceil(output.length / chunkBytes) + 1;
    const controller = new AbortController();
    let checkpoints = 0;
    await expect(
      inspectTrustedSvgOutput(output, undefined, {
        chunkBytes,
        checkpoint: async () => {
          checkpoints += 1;
          if (checkpoints === firstInspectionCheckpoint) controller.abort();
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(checkpoints).toBe(firstInspectionCheckpoint);
  });
});

describe("confirmed-base digest", () => {
  it("hashes exact UTF-8 across one-code-unit surrogate boundaries", async () => {
    const source = "ä✒️\ud83d\udd8b";
    const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(hashConfirmedSvgContent(source, { chunkBytes: 1 })).resolves.toBe(
      sha256Hex(source),
    );
    expect(digest).toHaveBeenCalledOnce();
    expect(new Uint8Array(digest.mock.calls[0]![1] as ArrayBuffer)).toEqual(
      new TextEncoder().encode(source),
    );
  });

  it("checks cancellation while preparing native digest input", async () => {
    const controller = new AbortController();
    const digest = vi.spyOn(crypto.subtle, "digest");
    let checkpoints = 0;
    await expect(
      hashConfirmedSvgContent("abcdefgh", {
        chunkBytes: 2,
        signal: controller.signal,
        checkpoint: async () => {
          checkpoints += 1;
          if (checkpoints === 3) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(digest).not.toHaveBeenCalled();
  });

  it("retains sliced complete-byte hashing when native digest fails", async () => {
    const source = "confirmed base content";
    const expected = sha256Hex(source);
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("native digest unavailable"));
    const updates = vi.spyOn(ChunkedSha256.prototype, "update");
    const checkpoint = vi.fn(async () => undefined);
    await expect(hashConfirmedSvgContent(source, { checkpoint })).resolves.toBe(expected);
    expect(updates.mock.calls.reduce((bytes, [chunk]) => bytes + chunk.byteLength, 0)).toBe(
      new TextEncoder().encode(source).byteLength,
    );
    expect(checkpoint.mock.calls.length).toBeGreaterThan(2);
  });
});

describe("trusted SVG background priority", () => {
  it("pauses before hashing and at existing checkpoints without replacing the checkpoint", async () => {
    const { content: output, outputHash, totalBytes } = maximumOutput;
    const update = vi.spyOn(ChunkedSha256.prototype, "update");
    let checkpoints = 0;
    let backgroundWaits = 0;
    let backgroundReady = false;
    const checkpoint = () => {
      checkpoints += 1;
      return undefined;
    };
    let resume: () => void = () => undefined;
    let entered: () => void = () => undefined;
    let pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waitForBackground = () => {
      backgroundWaits += 1;
      if (backgroundReady) return undefined;
      return new Promise<void>((resolve) => {
        resume = resolve;
        entered();
      });
    };
    const inspection = inspectTrustedSvgOutput(output, outputHash, {
      checkpoint,
      waitForBackground,
    });
    await pending;
    expect(update).not.toHaveBeenCalled();
    expect(checkpoints).toBe(0);
    expect(backgroundWaits).toBe(1);
    pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    resume();
    await pending;
    expect(update).toHaveBeenCalledTimes(1);
    expect(checkpoints).toBe(1);
    expect(backgroundWaits).toBe(2);
    // Later checkpoints stay observable without retaining every chunk and resolved promise.
    update.mockRestore();
    backgroundReady = true;
    resume();
    await expect(inspection).resolves.toMatchObject({
      content: output,
      lockedHeight: 148.6,
      outputHash,
      revision: 3,
      totalBytes,
    });
    expect(backgroundWaits).toBe(checkpoints);
  });

  it("cancels while a shared checkpoint waits for drawing to finish", async () => {
    const priority = new InteractiveWorkPriority();
    const controller = new AbortController();
    const update = vi.spyOn(ChunkedSha256.prototype, "update");
    priority.setInputActive(true);
    let entered: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const inspection = inspectTrustedSvgOutput(new Uint8Array(6 * 64 * 1024), undefined, {
      signal: controller.signal,
      waitForBackground: () => {
        entered();
        return priority.waitForBackground();
      },
    });
    await paused;
    await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
    controller.abort();
    priority.setInputActive(false);
    await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
    priority.dispose();
  });

  it("checks abort again after a paused background operation resumes", async () => {
    const controller = new AbortController();
    const update = vi.spyOn(ChunkedSha256.prototype, "update");
    let resume: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const inspection = inspectTrustedSvgOutput("untrusted", undefined, {
      signal: controller.signal,
      waitForBackground: () => paused,
    });
    controller.abort();
    resume();
    await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });
});
