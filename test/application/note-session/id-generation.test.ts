import { describe, expect, it } from "vitest";

import {
  createRandomOperationIdV1,
  createRandomRecoveryAttemptIdV1,
  createRandomRelocationIdV1,
  createRandomSourceCheckpointIdV1,
  deriveRelocationIdV1,
  encodeDomainIdPayloadV1,
  parseRelocationId,
  type CryptographicRandomValuesV1,
} from "../../../src/application/note-session";

const ZERO_PAYLOAD = "00000000000000000000000000";
const PAYLOAD_SUFFIX_LENGTH = 25;
const DOMAIN_ID_BYTES = 16;
const SHORT_DOMAIN_ID_BYTES = 15;
const MAX_BYTE = 255;
const MAX_PAYLOAD = `7${"z".repeat(PAYLOAD_SUFFIX_LENGTH)}`;

describe("canonical domain ID generation", () => {
  it("encodes exactly 128 big-endian bits as lowercase Crockford Base32", () => {
    expect(encodeDomainIdPayloadV1(new Uint8Array(DOMAIN_ID_BYTES))).toBe(
      ZERO_PAYLOAD,
    );
    expect(
      encodeDomainIdPayloadV1(new Uint8Array(DOMAIN_ID_BYTES).fill(MAX_BYTE)),
    ).toBe(MAX_PAYLOAD);
    expect(() =>
      encodeDomainIdPayloadV1(new Uint8Array(SHORT_DOMAIN_ID_BYTES)),
    ).toThrow("exactly 128 bits");
  });

  it("uses all sixteen cryptographic bytes for every runtime ID kind", () => {
    const random = fixedRandom(MAX_BYTE);

    expect(createRandomOperationIdV1(random)).toBe(`op_${MAX_PAYLOAD}`);
    expect(createRandomRecoveryAttemptIdV1(random)).toBe(`ra_${MAX_PAYLOAD}`);
    expect(createRandomSourceCheckpointIdV1(random)).toBe(`scp_${MAX_PAYLOAD}`);
    expect(createRandomRelocationIdV1(random)).toBe(`rel_${MAX_PAYLOAD}`);
  });

  it("fails closed when the randomness provider fails", () => {
    const random: CryptographicRandomValuesV1 = {
      getRandomValues: (): never => {
        throw new Error("randomness unavailable");
      },
    };

    expect(() => createRandomRelocationIdV1(random)).toThrow(
      "randomness unavailable",
    );
  });

  it("derives stable canonical member IDs without truncating hexadecimal text", async () => {
    const parent = parseRelocationId(`rel_${ZERO_PAYLOAD}`);
    const first = await deriveRelocationIdV1(parent, 0);
    const retry = await deriveRelocationIdV1(parent, 0);
    const second = await deriveRelocationIdV1(parent, 1);

    expect(first).toMatch(/^rel_[0-7][0-9a-hjkmnp-tv-z]{25}$/u);
    expect(retry).toBe(first);
    expect(second).not.toBe(first);
  });
});

function fixedRandom(value: number): CryptographicRandomValuesV1 {
  return {
    getRandomValues: (bytes): Uint8Array => {
      bytes.fill(value);
      return bytes;
    },
  };
}
