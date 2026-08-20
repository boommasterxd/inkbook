/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact wire boundaries are the tested contract. */
import { describe, expect, it } from "vitest";

import {
  normalizePersistenceCodecWorkResultV1,
  normalizePersistenceCodecWorkV1,
  PERSISTENCE_CODEC_WIRE_VERSION_V1,
  SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1,
} from "../../../src/application/persistence";
import { SCENE_RESOURCE_LIMITS_V1 } from "../../../src/domain/codecs";
import { completeSidecar } from "./support";

const VALID_PARSE_WORK = Object.freeze({
  wireVersion: PERSISTENCE_CODEC_WIRE_VERSION_V1,
  kind: "parse-sidecar",
  rawText: "{}",
  admittedUtf8Bytes: 2,
  admittedDecodedBytes: 4,
  textChunks: Object.freeze([{ offset: 0, length: 2 }]),
});

const VALID_ENCODE_WORK = Object.freeze({
  wireVersion: PERSISTENCE_CODEC_WIRE_VERSION_V1,
  kind: "encode-sidecar",
  sidecar: completeSidecar(),
  writableTier: "phone",
  admittedInputBytes: 1,
  admittedDecodedBytes: 1,
  affectedElementIds: Object.freeze([]),
});

const VALID_ENCODED_RESULT = Object.freeze({
  wireVersion: PERSISTENCE_CODEC_WIRE_VERSION_V1,
  kind: "encoded-sidecar",
  bytes: new Uint8Array([1, 2]),
  byteChunks: Object.freeze([{ offset: 0, length: 2 }]),
  elementCount: 1,
  encodedElementCount: 1,
  reusedElementCount: 0,
});

describe("persistence codec work wire normalization", () => {
  it.each([
    null,
    [],
    { ...VALID_PARSE_WORK, wireVersion: 2 },
    { ...VALID_PARSE_WORK, kind: "unknown" },
    { ...VALID_PARSE_WORK, rawText: 1 },
    { ...VALID_PARSE_WORK, admittedUtf8Bytes: "2" },
    { ...VALID_PARSE_WORK, admittedDecodedBytes: 0 },
    { ...VALID_ENCODE_WORK, admittedDecodedBytes: "1" },
    { ...VALID_ENCODE_WORK, admittedDecodedBytes: 0 },
    { ...VALID_ENCODE_WORK, writableTier: "desktop" },
    { ...VALID_ENCODE_WORK, affectedElementIds: "element" },
    { ...VALID_ENCODE_WORK, affectedElementIds: [1] },
    { ...VALID_ENCODE_WORK, affectedElementIds: ["invalid"] },
    { ...VALID_ENCODE_WORK, admittedInputBytes: "1" },
    { ...VALID_ENCODE_WORK, admittedInputBytes: 0 },
  ])("rejects malformed or unbounded worker input: %#", (value) => {
    expect(() => normalizePersistenceCodecWorkV1(value)).toThrow();
  });

  it("rebuilds trusted chunk plans instead of retaining supplied arrays", () => {
    const supplied = [{ offset: 99, length: 99 }];
    const normalized = normalizePersistenceCodecWorkV1({
      ...VALID_PARSE_WORK,
      textChunks: supplied,
    });

    expect(normalized).toMatchObject({
      kind: "parse-sidecar",
      textChunks: [{ offset: 0, length: 2 }],
    });
    if (normalized.kind !== "parse-sidecar") {
      throw new Error("Expected normalized parse work.");
    }
    expect(normalized).not.toBe(VALID_PARSE_WORK);
    expect(normalized.textChunks).not.toBe(supplied);
  });
});

describe("persistence codec result wire normalization", () => {
  it.each([
    null,
    [],
    { ...VALID_ENCODED_RESULT, wireVersion: 2 },
    { ...VALID_ENCODED_RESULT, kind: "unknown" },
    { ...VALID_ENCODED_RESULT, bytes: [1, 2] },
    { ...VALID_ENCODED_RESULT, bytes: new Uint8Array([1, 2]).subarray(1) },
    { ...VALID_ENCODED_RESULT, byteChunks: null },
    { ...VALID_ENCODED_RESULT, byteChunks: [] },
    {
      ...VALID_ENCODED_RESULT,
      byteChunks: [{ offset: 1, length: 1 }],
    },
    { ...VALID_ENCODED_RESULT, elementCount: -1 },
    { ...VALID_ENCODED_RESULT, elementCount: 1.5 },
    {
      ...VALID_ENCODED_RESULT,
      elementCount: SCENE_RESOURCE_LIMITS_V1.maxRecords + 1,
    },
    { ...VALID_ENCODED_RESULT, encodedElementCount: -1 },
    { ...VALID_ENCODED_RESULT, reusedElementCount: "0" },
    { ...VALID_ENCODED_RESULT, reusedElementCount: 1 },
  ])("rejects malformed or inconsistent worker output: %#", (value) => {
    expect(() => normalizePersistenceCodecWorkResultV1(value)).toThrow();
  });

  it("rejects output bytes above the desktop and tablet ceiling", () => {
    const bytes = new Uint8Array(
      SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1["desktop-tablet"] + 1,
    );

    expect(() =>
      normalizePersistenceCodecWorkResultV1({
        ...VALID_ENCODED_RESULT,
        bytes,
      }),
    ).toThrow(RangeError);
  });

  it("normalizes current and future parsed results without parsing JSON again", () => {
    const current = normalizePersistenceCodecWorkResultV1({
      wireVersion: 1,
      kind: "parsed-sidecar",
      value: { kind: "current", sidecar: completeSidecar() },
    });
    const future = normalizePersistenceCodecWorkResultV1({
      wireVersion: 1,
      kind: "parsed-sidecar",
      value: {
        kind: "read-only-newer-version",
        schemaVersion: { major: 2, minor: 0 },
      },
    });

    expect(current).toMatchObject({
      kind: "parsed-sidecar",
      value: { kind: "current" },
    });
    expect(future).toEqual({
      wireVersion: 1,
      kind: "parsed-sidecar",
      value: {
        kind: "read-only-newer-version",
        schemaVersion: { major: 2, minor: 0 },
      },
    });
  });

  it.each([
    { kind: "unknown" },
    { kind: "current", sidecar: null },
    { kind: "read-only-newer-version", schemaVersion: null },
  ])("rejects an invalid parsed result graph: %#", (value) => {
    expect(() =>
      normalizePersistenceCodecWorkResultV1({
        wireVersion: 1,
        kind: "parsed-sidecar",
        value,
      }),
    ).toThrow();
  });
});
