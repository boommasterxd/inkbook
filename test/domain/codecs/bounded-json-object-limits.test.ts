/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact object-width boundaries are the tested contract. */
import { describe, expect, it } from "vitest";

import {
  BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT,
  type BoundedJsonLimits,
  parseBoundedJson,
} from "../../../src/domain/codecs/bounded-json";

const GLOBAL_MEMBER_LIMIT = 1_000;
const LIMITS: BoundedJsonLimits = {
  maxUtf8Bytes: 100_000,
  maxNesting: 64,
  maxStringUtf16Units: 1_000,
  maxArrayItems: 1_000,
  maxObjectMembers: GLOBAL_MEMBER_LIMIT,
  maxObjectMembersPerObject: BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT,
  maxArrays: 1_000,
  maxObjects: 1_000,
};

describe("bounded JSON object width", () => {
  it.each([
    [BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT - 1, true],
    [BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT, true],
    [BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT + 1, false],
  ] as const)(
    "admits %i members according to the hard width limit",
    (count, ok) => {
      const result = parseBoundedJson(objectWithMembers(count), LIMITS);

      expect(result.ok).toBe(ok);
      if (!ok) {
        expect(result).toMatchObject({
          error: { code: "object-member-limit" },
        });
        expect("value" in result).toBe(false);
      }
    },
  );

  it("bounds every object independently across deep and sibling structures", () => {
    const atLimit = objectWithMembers(
      BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT,
    );
    const deep = `{"outer":{"inner":${atLimit}}}`;
    const siblings = `[${atLimit},${atLimit}]`;

    expect(parseBoundedJson(deep, LIMITS)).toMatchObject({ ok: true });
    expect(parseBoundedJson(siblings, LIMITS)).toMatchObject({
      ok: true,
      counters: {
        objectMembers: BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT * 2,
      },
    });
  });

  it("keeps the global member limit separate from per-object admission", () => {
    const limits = {
      ...LIMITS,
      maxObjectMembers: 3,
      maxObjectMembersPerObject: 2,
    };

    expect(parseBoundedJson('[{"a":0},{"b":1,"c":2}]', limits)).toMatchObject({
      ok: true,
      counters: { objectMembers: 3 },
    });
    expect(
      parseBoundedJson('[{"a":0,"b":1},{"c":2,"d":3}]', limits),
    ).toMatchObject({
      ok: false,
      error: { code: "object-member-limit" },
      counters: { objectMembers: 4 },
    });
  });

  it("rejects width before parsing or materializing an excess member value", () => {
    const admitted = objectMemberEntries(
      BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT,
    );
    const input = `{${admitted},"excess":[}`;

    expect(parseBoundedJson(input, LIMITS)).toMatchObject({
      ok: false,
      error: { code: "object-member-limit" },
      counters: {
        arrays: 0,
        objectMembers: BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT + 1,
      },
    });
  });

  it("still reports a decoded duplicate at the width boundary", () => {
    const unique = objectMemberEntries(
      BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT - 1,
    );

    expect(parseBoundedJson(`{${unique},"key-0":1}`, LIMITS)).toMatchObject({
      ok: false,
      error: { code: "duplicate-key" },
      counters: {
        objectMembers: BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT,
      },
    });
  });

  it("rejects caller limits wider than the parser hard ceiling", () => {
    expect(
      parseBoundedJson("{}", {
        ...LIMITS,
        maxObjectMembersPerObject:
          BOUNDED_JSON_MAX_OBJECT_MEMBERS_PER_OBJECT + 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-limits" } });
  });
});

function objectWithMembers(count: number): string {
  return `{${objectMemberEntries(count)}}`;
}

function objectMemberEntries(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `"key-${String(index)}":${String(index)}`,
  ).join(",");
}
