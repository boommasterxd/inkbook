import { describe, expect, it } from "vitest";
import {
  adoptOwnedSvgOutput,
  adoptOwnedSvgOutputSync,
} from "../../../../src/persistence/scheduling/owned-svg-output";
import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/constants";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { snapshot } from "../worker/runtime/fixtures";
import { UTF8_OUTPUT_PREFIX_CODE_UNITS } from "../../../../src/persistence/scheduling/utf8-adoption";

const serialized = serializeInkbookDocument(snapshot());
if (!serialized.ok) throw new Error(serialized.error.code);
const { svg, hash } = serialized.value;

describe("owned canonical SVG output", () => {
  it("derives root fields from the same decoded content across cooperative checkpoints", async () => {
    const bytes = new TextEncoder().encode(svg);
    const marker = 'data-inkbook-revision="';
    const revisionOffset = svg.indexOf(marker) + marker.length;
    let checkpoints = 0;
    const adopted = await adoptOwnedSvgOutput(bytes, hash, {
      chunkBytes: svg.indexOf(">") + 1,
      checkpoint: async () => {
        checkpoints += 1;
        if (checkpoints === 1) bytes[revisionOffset] = "1".charCodeAt(0);
        if (checkpoints === 2) bytes[revisionOffset] = "0".charCodeAt(0);
      },
    });

    expect(new TextDecoder().decode(bytes)).toBe(svg);
    expect(adopted.content).toBe(svg.replace(`${marker}0`, `${marker}1`));
    expect(adopted.revision).toBe(1);
  });

  it.each([UTF8_OUTPUT_PREFIX_CODE_UNITS, UTF8_OUTPUT_PREFIX_CODE_UNITS + 1])(
    "preserves the root prefix limit for a %i-code-unit opening tag",
    async (rootLength) => {
      const rootEnd = svg.indexOf(">") + 1;
      const content = `${svg.substring(0, rootEnd - 1)}${" ".repeat(rootLength - rootEnd)}${svg.substring(rootEnd - 1)}`;
      const pending = adoptOwnedSvgOutput(new TextEncoder().encode(content), hash, {
        chunkBytes: 31,
      });
      if (rootLength === UTF8_OUTPUT_PREFIX_CODE_UNITS) {
        await expect(pending).resolves.toMatchObject({ content, revision: 0 });
      } else await expect(pending).rejects.toThrow("canonical SVG root");
    },
  );

  it("adopts canonical bytes and strings and observes cancellation after waiting", async () => {
    const bytes = new TextEncoder().encode(svg);
    const expected = { content: svg, outputHash: hash, revision: 0 };
    expect(adoptOwnedSvgOutputSync(bytes, hash)).toMatchObject(expected);
    expect(adoptOwnedSvgOutputSync(svg, hash)).toMatchObject(expected);
    await expect(adoptOwnedSvgOutput(bytes, hash)).resolves.toMatchObject(expected);
    await expect(adoptOwnedSvgOutput(svg, hash)).resolves.toMatchObject(expected);
    const controller = new AbortController();
    await expect(
      adoptOwnedSvgOutput(svg, hash, {
        signal: controller.signal,
        waitForBackground: async () => controller.abort(),
      }),
    ).rejects.toThrow();
    await expect(adoptOwnedSvgOutput(svg, hash, { signal: controller.signal })).rejects.toThrow();
  });

  it.each([
    ["invalid hash", (): string => svg, "invalid"],
    ["missing root", (): string => "<svg/>", hash],
    ["invalid UTF-8", () => new Uint8Array([255]), hash],
    ["non-owned buffer", () => new Uint8Array(4).subarray(1), hash],
    ["shared buffer", () => new Uint8Array(new SharedArrayBuffer(4)), hash],
    ["oversized buffer", () => new Uint8Array(FILE_SCHEMA_LIMITS.totalInputBytes + 1), hash],
    ["oversized string", () => " ".repeat(FILE_SCHEMA_LIMITS.totalInputBytes + 1), hash],
  ] as const)(
    "rejects %s",
    async (_name: string, input: () => string | Uint8Array, digest: string) => {
      const value = input();
      expect(() => adoptOwnedSvgOutputSync(value, digest)).toThrow();
      await expect(adoptOwnedSvgOutput(value, digest)).rejects.toThrow();
    },
  );
});
