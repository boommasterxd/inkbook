import { describe, expect, it } from "vitest";

import {
  inspectTrustedSvgOutput,
  inspectTrustedSvgOutputSync,
} from "../../../../src/persistence/scheduling/trusted-svg-output";
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
});
