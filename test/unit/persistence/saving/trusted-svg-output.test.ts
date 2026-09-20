import { createHash } from "node:crypto";
import { InteractiveWorkPriority } from "../../../../src/editor/session/interactive-work-priority";
import { describe, expect, it, vi } from "vitest";

import {
  inspectTrustedSvgOutput,
  inspectTrustedSvgOutputSync,
} from "../../../../src/persistence/scheduling/trusted-svg-output";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";
import { createMaximumComplexitySvg } from "../../../fixtures/persistence/safe-svg";

describe("trusted SVG output validation slices", () => {
  it("rejects worker output with literal markup hidden inside metadata", async () => {
    const output = createMaximumComplexitySvg().replace(
      "</metadata>",
      "<script>bad()</script></metadata>",
    );

    expect(() => inspectTrustedSvgOutputSync(output)).toThrow("safe Inkbook SVG");
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
    const output = createMaximumComplexitySvg();
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

describe("trusted SVG background priority", () => {
  it("pauses before hashing and at existing checkpoints without replacing the checkpoint", async () => {
    const output = createMaximumComplexitySvg();
    const outputHash = createHash("sha256").update(output).digest("hex");
    const update = vi.spyOn(ChunkedSha256.prototype, "update");
    const checkpoint = vi.fn(async () => undefined);
    let resume: () => void = () => undefined;
    let entered: () => void = () => undefined;
    let pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waitForBackground = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
          entered();
        }),
    );
    const inspection = inspectTrustedSvgOutput(output, outputHash, {
      checkpoint,
      waitForBackground,
    });
    await pending;
    expect(update).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    resume();
    await pending;
    expect(update).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    waitForBackground.mockResolvedValue(undefined);
    resume();
    await expect(inspection).resolves.toMatchObject({
      content: output,
      lockedHeight: 148.6,
      outputHash,
      revision: 3,
      totalBytes: Buffer.byteLength(output),
    });
    expect(waitForBackground.mock.calls.length).toBe(checkpoint.mock.calls.length + 1);
    update.mockRestore();
  });

  it("pauses an already running hash when drawing starts and releases it on cancellation", async () => {
    const priority = new InteractiveWorkPriority();
    const controller = new AbortController();
    const update = vi.spyOn(ChunkedSha256.prototype, "update");
    let entered: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const inspection = inspectTrustedSvgOutput(new Uint8Array(6 * 64 * 1024), undefined, {
      signal: controller.signal,
      checkpoint: async () => {
        priority.setInputActive(true);
        entered();
      },
      waitForBackground: () => priority.waitForBackground(),
    });
    await paused;
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
    controller.abort();
    priority.setInputActive(false);
    await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
    expect(update).toHaveBeenCalledTimes(1);
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
