import { describe, expect, it } from "vitest";

import {
  ChunkedJsonCancelledError,
  ChunkedJsonParseError,
  parseChunkedJson,
} from "../../../../src/persistence/serialization/chunked-json-parser";
import type { ChunkedJsonLimits } from "../../../../src/persistence/serialization/chunked-json-limits";
import { BoundedJsonStringBuilder } from "../../../../src/persistence/serialization/bounded-json-string-builder";

const GENEROUS_LIMITS = {
  maximumContainerEntries: 10_000,
  maximumDepth: 64,
  maximumNodes: 10_000,
  maximumOutputCharacters: 100_000,
  maximumStringScratchCharacters: 256,
} as const;

function parse(input: string, overrides: Partial<ChunkedJsonLimits> = {}): Promise<unknown> {
  return parseChunkedJson(input, { limits: { ...GENEROUS_LIMITS, ...overrides } });
}

describe("chunked JSON semantics", () => {
  it.each([
    "null",
    "true",
    "false",
    "-0",
    "1.25e-3",
    '"plain"',
    '"escapes: \\" \\\\ / \\b \\f \\n \\r \\t"',
    '"unicode: \\u0041\\uD83D\\uDE00\\uD800"',
    "[]",
    "{}",
    '[null,true,false,-12.5E+2,"text",{"nested":[1,2,3]}]',
    '{"0":"numeric key","__proto__":{"safe":true},"constructor":null}',
    ' \t\r\n {"a": 1, "b": [2, 3]} \n',
  ])("matches JSON.parse for %s", async (input) => {
    expect(await parse(input)).toEqual(JSON.parse(input) as unknown);
  });

  it("preserves negative zero and JSON number overflow semantics", async () => {
    expect(Object.is(await parse("-0"), -0)).toBe(true);
    expect(await parse("1e9999")).toBe(Number.POSITIVE_INFINITY);
  });

  it("checkpoints at configured input batches", async () => {
    let checkpoints = 0;
    const input = JSON.stringify({ value: "x".repeat(25) });

    const result = await parseChunkedJson(input, {
      batchCharacters: 5,
      checkpoint: () => {
        checkpoints += 1;
        return Promise.resolve();
      },
      limits: GENEROUS_LIMITS,
    });

    expect(result).toEqual(JSON.parse(input) as unknown);
    expect(checkpoints).toBe(Math.floor(input.length / 5) * 2);
  });

  it("ignores escaped structural characters while preflighting container widths", async () => {
    const input = JSON.stringify({ decoy: '\\"}],{,,,,', values: [1, 2] });

    await expect(parse(input, { maximumContainerEntries: 2 })).resolves.toEqual(
      JSON.parse(input) as unknown,
    );
  });

  it("decodes escape-dense strings through bounded scratch blocks", async () => {
    const decodedCharacters = 32_768;
    const input = `"${"\\n".repeat(decodedCharacters)}"`;

    const result = await parse(input, {
      maximumOutputCharacters: decodedCharacters,
      maximumStringScratchCharacters: 64,
    });

    expect(result).toBe("\n".repeat(decodedCharacters));
  });
});

describe("chunked JSON rejection", () => {
  it.each([
    "",
    "undefined",
    "01",
    "1.",
    "1e",
    "[1,]",
    '{"a":1,}',
    '{"a" 1}',
    '"unterminated',
    '"bad\\xescape"',
    '"bad\\u12xz"',
    '"control\u0001character"',
    "true false",
  ])("rejects malformed JSON %s", async (input) => {
    await expect(parse(input)).rejects.toMatchObject({
      code: "invalid-json",
      name: "ChunkedJsonParseError",
    });
  });

  it("rejects duplicate decoded object keys", async () => {
    await expect(parse('{"a":1,"\\u0061":2}')).rejects.toMatchObject({
      code: "duplicate-key",
    });
  });

  it("enforces depth, node, and materialized output limits", async () => {
    await expect(parse('[[["value"]]]', { maximumDepth: 2 })).rejects.toMatchObject({
      code: "depth-limit-exceeded",
    });
    await expect(parse("[1,2,3]", { maximumNodes: 3 })).rejects.toMatchObject({
      code: "node-limit-exceeded",
    });
    await expect(parse('{"key":"value"}', { maximumOutputCharacters: 7 })).rejects.toMatchObject({
      code: "output-limit-exceeded",
    });
    await expect(
      parse(`"${"\\n".repeat(9)}"`, { maximumOutputCharacters: 8 }),
    ).rejects.toMatchObject({ code: "output-limit-exceeded" });
  });

  it.each([
    { input: "[0,1,2]", name: "array" },
    { input: '{"a":0,"b":1,"c":2}', name: "object" },
  ])("rejects a $name at the container limit plus one", async ({ input }) => {
    await expect(parse(input, { maximumContainerEntries: 2 })).rejects.toMatchObject({
      code: "container-limit-exceeded",
    });
  });

  it.each([
    { input: "[0,1]", name: "array" },
    { input: '{"a":0,"b":1}', name: "object" },
  ])("accepts a $name exactly at the container limit", async ({ input }) => {
    await expect(parse(input, { maximumContainerEntries: 2 })).resolves.toEqual(
      JSON.parse(input) as unknown,
    );
  });

  it("permits only empty containers when the container limit is zero", async () => {
    await expect(parse("[]", { maximumContainerEntries: 0 })).resolves.toEqual([]);
    await expect(parse("{}", { maximumContainerEntries: 0 })).resolves.toEqual({});
    await expect(parse("[0]", { maximumContainerEntries: 0 })).rejects.toMatchObject({
      code: "container-limit-exceeded",
    });
  });

  it("validates scheduling and resource limits", () => {
    expect(() => parseChunkedJson("null", { batchCharacters: 0, limits: GENEROUS_LIMITS })).toThrow(
      RangeError,
    );
    expect(() =>
      parseChunkedJson("null", {
        limits: { ...GENEROUS_LIMITS, maximumDepth: -1 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      parseChunkedJson("null", {
        limits: { ...GENEROUS_LIMITS, maximumStringScratchCharacters: 0 },
      }),
    ).toThrow(RangeError);
  });

  it("reports typed parse errors with an input offset", async () => {
    const failure = await parse("[1 nope]").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChunkedJsonParseError);
    expect(failure).toMatchObject({ code: "invalid-json", offset: 3 });
  });
});

describe("bounded JSON string scratch", () => {
  it("retains one output fragment per decoded scratch block", () => {
    const scratchCharacters = 64;
    const decodedCharacters = 32_768;
    const builder = new BoundedJsonStringBuilder(scratchCharacters);

    for (let index = 0; index < decodedCharacters; index += 1) {
      builder.appendCodeUnit(0x0a);
    }
    const result = builder.finish();

    expect(result.fragmentCount).toBe(decodedCharacters / scratchCharacters);
    expect(result.value).toBe("\n".repeat(decodedCharacters));
  });
});

describe("chunked JSON cancellation", () => {
  it("cancels before parsing without exposing the abort reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private caller detail"));

    await expect(
      parseChunkedJson('{"secret":"must not return"}', {
        limits: GENEROUS_LIMITS,
        signal: controller.signal,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "json-parse-cancelled",
        message: "Chunked JSON parsing was cancelled.",
      }),
    );
  });

  it("cancels after a checkpoint without returning a partial result", async () => {
    const controller = new AbortController();
    let checkpoints = 0;

    const operation = parseChunkedJson('["first","second","third"]', {
      batchCharacters: 4,
      checkpoint: () => {
        checkpoints += 1;
        controller.abort("must not escape");
        return Promise.resolve();
      },
      limits: GENEROUS_LIMITS,
      signal: controller.signal,
    });

    await expect(operation).rejects.toBeInstanceOf(ChunkedJsonCancelledError);
    expect(checkpoints).toBe(1);
  });

  it("does not misclassify checkpoint failures", async () => {
    const schedulerFailure = new Error("scheduler failed");
    await expect(
      parseChunkedJson('"long enough"', {
        batchCharacters: 2,
        checkpoint: () => Promise.reject(schedulerFailure),
        limits: GENEROUS_LIMITS,
      }),
    ).rejects.toBe(schedulerFailure);
  });
});
