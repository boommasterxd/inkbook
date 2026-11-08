import { describe, expect, it, vi } from "vitest";
import { StreamingSvgMetadataParser } from "../../../../../src/persistence/serialization/input/streaming-svg-metadata";

describe("streaming SVG metadata literal accounting", () => {
  it("counts unchanged Unicode literals once for both byte limits", () => {
    const input = '{"value":"ä😀"}';
    const bytes = new TextEncoder().encode(input).byteLength;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      const parser = new StreamingSvgMetadataParser(bytes);
      expect(parser.consume(input + "</metadata>tail")).toEqual({
        kind: "complete",
        metadataText: input,
        metadataBytes: bytes,
        trailing: "tail",
      });
      expect(encode).toHaveBeenCalledExactlyOnceWith(input);
    } finally {
      encode.mockRestore();
    }
  });

  it("rejects raw bytes beyond the limit and literal XML markup", () => {
    const oversized = new StreamingSvgMetadataParser(2);
    expect(oversized.consume("ä")).toEqual({ kind: "collecting" });
    expect(oversized.consume("x")).toEqual({ kind: "invalid" });
    const markup = new StreamingSvgMetadataParser(100);
    expect(markup.consume('{"value":"<script>"}</metadata>')).toEqual({ kind: "invalid" });
  });

  it("retains entity decoding and exact accounting across chunk transitions", () => {
    const parts = ['{"value":"ä&', "amp;😀", '&lt;&gt;"}</meta'];
    const final = "data>tail";
    const raw = [...parts, final].join("").split("</metadata>")[0]!;
    const parser = new StreamingSvgMetadataParser(new TextEncoder().encode(raw).byteLength);
    for (const part of parts) {
      expect(parser.consume(part)).toEqual({ kind: "collecting" });
    }
    const decoded = '{"value":"ä&😀<>"}';
    expect(parser.consume(final)).toEqual({
      kind: "complete",
      metadataText: decoded,
      metadataBytes: new TextEncoder().encode(decoded).byteLength,
      trailing: "tail",
    });
    const unknownEntity = new StreamingSvgMetadataParser(100);
    expect(unknownEntity.consume('"&unknown;"</metadata>')).toEqual({ kind: "invalid" });
  });
});
