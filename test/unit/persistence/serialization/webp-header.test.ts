import { expect, it } from "vitest";
import { inspectImageHeaderSteps } from "../../../../src/persistence/images/image-header";
import { IMAGE_LIMITS } from "../../../../src/domain/images/image-limits";
import { exhaustValidation } from "../../../fixtures/persistence/safe-svg";
import {
  extendedWebpHeader,
  webpBytes,
  webpChunk,
  webpContainer,
} from "../../../fixtures/persistence/webp-images";

function inspect(bytes: Uint8Array, source = false) {
  return exhaustValidation(inspectImageHeaderSteps(bytes, { source }));
}

function mutate(kind: "lossless" | "lossy" | "alpha", offset: number, value: number) {
  const bytes = webpBytes(kind);
  bytes[offset] = value;
  return bytes;
}

const lossless = webpBytes().slice(12);
const lossy = webpBytes("lossy").slice(12);
const alpha = webpBytes("alpha");
const zeroPartition = mutate("lossy", 20, 0x10);
zeroPartition[21] = 0;

it.each(["lossless", "lossy", "alpha"] as const)("inspects a real %s WebP", (kind) => {
  expect(inspect(webpBytes(kind)).result).toEqual({
    mimeType: "image/webp",
    width: 3,
    height: 2,
    lossless: kind === "lossless",
  });
});

it.each([
  ["RIFF length", mutate("lossless", 4, 0)],
  ["WEBP signature", mutate("lossless", 8, 0)],
  ["truncated RIFF", webpBytes().slice(0, -1)],
  ["trailing bytes", new Uint8Array([...webpBytes(), 0, 0])],
  ["chunk bounds", mutate("lossless", 16, 255)],
  ["nonzero padding", mutate("lossless", 35, 1)],
  ["missing bitstream", webpContainer(extendedWebpHeader(3, 2))],
  ["duplicate bitstream", webpContainer(lossless, lossless)],
  ["unknown leading chunk", webpContainer(webpChunk("TEST"), lossless)],
  ["incomplete chunk header", webpContainer(lossless, new Uint8Array(4))],
  ["lossless signature", mutate("lossless", 20, 0)],
  ["lossless version", mutate("lossless", 24, 0x20)],
  ["empty lossless body", webpContainer(webpChunk("VP8L", webpBytes().slice(20, 25)))],
  ["interframe", mutate("lossy", 20, 0xd1)],
  ["unsupported VP8 version", mutate("lossy", 20, 0xde)],
  ["hidden frame", mutate("lossy", 20, 0xc0)],
  ["invalid partition bounds", mutate("lossy", 22, 255)],
  ["zero partition", zeroPartition],
  ["VP8 start code", mutate("lossy", 23, 0)],
  ["zero VP8 width", mutate("lossy", 26, 0)],
  ["truncated VP8 header", webpContainer(webpChunk("VP8 ", webpBytes("lossy").slice(20, 29)))],
  ["VP8X canvas mismatch", webpContainer(extendedWebpHeader(4, 2), lossless)],
  ["VP8X reserved flags", mutate("alpha", 20, 0x90)],
  ["VP8X reserved bytes", mutate("alpha", 21, 1)],
  ["duplicate VP8X", webpContainer(extendedWebpHeader(3, 2), extendedWebpHeader(3, 2), lossless)],
  ["VP8X malformed size", webpContainer(webpChunk("VP8X", new Uint8Array(9)), lossless)],
  ["canvas product overflow", webpContainer(extendedWebpHeader(65536, 65536), lossless)],
  ["animation flag", webpContainer(extendedWebpHeader(3, 2, 2), lossless)],
  ["ANIM without flag", webpContainer(lossless, webpChunk("ANIM"))],
  ["ANMF without flag", webpContainer(lossless, webpChunk("ANMF"))],
  ["missing alpha flag", mutate("alpha", 20, 0)],
  ["missing alpha chunk", webpContainer(extendedWebpHeader(3, 2, 16), lossy)],
  ["alpha reserved bits", mutate("alpha", 38, 0xc0)],
  ["alpha compression", mutate("alpha", 38, 2)],
  ["alpha preprocessing", mutate("alpha", 38, 0x20)],
  [
    "truncated raw alpha",
    webpContainer(extendedWebpHeader(3, 2, 16), webpChunk("ALPH", new Uint8Array(2)), lossy),
  ],
  ["duplicate alpha", webpContainer(alpha.slice(12, 46), alpha.slice(30, 46), lossy)],
  ["alpha with lossless", webpContainer(alpha.slice(12, 46), lossless)],
  [
    "alpha after bitstream",
    webpContainer(extendedWebpHeader(3, 2, 16), lossy, alpha.slice(30, 46)),
  ],
  ["unflagged metadata", webpContainer(extendedWebpHeader(3, 2), lossless, webpChunk("EXIF"))],
  ["missing metadata", webpContainer(extendedWebpHeader(3, 2, 8), lossless)],
  [
    "duplicate metadata",
    webpContainer(extendedWebpHeader(3, 2, 8), lossless, webpChunk("EXIF"), webpChunk("EXIF")),
  ],
  ["late color profile", webpContainer(extendedWebpHeader(3, 2, 32), lossless, webpChunk("ICCP"))],
] as const)("rejects malformed or animated WebP: %s", (_label, bytes) => {
  expect(() => inspect(bytes)).toThrow(expect.objectContaining({ reason: "format" }));
});

it("admits ordered metadata and ignores bounded unknown chunks without changing pixels", () => {
  const bytes = webpContainer(
    extendedWebpHeader(3, 2, 44),
    webpChunk("ICCP", new Uint8Array([1])),
    lossless,
    webpChunk("EXIF"),
    webpChunk("XMP "),
    webpChunk("TEST"),
  );
  expect(inspect(bytes).result).toMatchObject({ width: 3, height: 2, lossless: true });
});

it("preserves resource/source byte, pixel and axis capacities for WebP", () => {
  const bytes = webpBytes();
  const view = new DataView(bytes.buffer);
  view.setUint32(21, 4000 | (3999 << 14), true);
  expect(() => inspect(bytes)).toThrow(expect.objectContaining({ reason: "dimensions" }));
  expect(inspect(bytes, true).result).toMatchObject({ width: 4001, height: 4000 });
  view.setUint32(21, 16383 | (0 << 14), true);
  expect(inspect(bytes, true).result.width).toBe(16384);
  view.setUint32(21, 8191 | (4095 << 14), true);
  expect(() => inspect(bytes, true)).toThrow(expect.objectContaining({ reason: "dimensions" }));
  for (const source of [false, true]) {
    const oversized = new Uint8Array(
      (source ? IMAGE_LIMITS.sourceBytes : IMAGE_LIMITS.resourceBytes) + 1,
    );
    expect(() => inspect(oversized, source)).toThrow(expect.objectContaining({ reason: "format" }));
  }
});
