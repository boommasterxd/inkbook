import { parseOperationId, type OperationId } from "../../domain/operations";
import { sha256Bytes } from "../../domain/codecs/sha256";
import type {
  RecoveryAttemptId,
  RelocationId,
  SourceCheckpointId,
} from "./types";
import {
  parseRecoveryAttemptId,
  parseRelocationId,
  parseSourceCheckpointId,
} from "./value-objects";

const CROCKFORD_BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const DOMAIN_ID_BYTES = 16;
const DOMAIN_ID_PAYLOAD_LENGTH = 26;
const BASE32_MASK = 31n;
const BASE32_SHIFT = 5n;
const BYTE_SHIFT = 8n;
const HEX_CHARACTERS_PER_BYTE = 2;
const HEX_RADIX = 16;

export interface CryptographicRandomValuesV1 {
  getRandomValues(bytes: Uint8Array): Uint8Array;
}

export function createRandomOperationIdV1(
  random: CryptographicRandomValuesV1 = requireCryptographicRandomValuesV1(),
): OperationId {
  return parseOperationId(`op_${randomDomainIdPayloadV1(random)}`);
}

export function createRandomRecoveryAttemptIdV1(
  random: CryptographicRandomValuesV1 = requireCryptographicRandomValuesV1(),
): RecoveryAttemptId {
  return parseRecoveryAttemptId(`ra_${randomDomainIdPayloadV1(random)}`);
}

export function createRandomSourceCheckpointIdV1(
  random: CryptographicRandomValuesV1 = requireCryptographicRandomValuesV1(),
): SourceCheckpointId {
  return parseSourceCheckpointId(`scp_${randomDomainIdPayloadV1(random)}`);
}

export function createRandomRelocationIdV1(
  random: CryptographicRandomValuesV1 = requireCryptographicRandomValuesV1(),
): RelocationId {
  return parseRelocationId(`rel_${randomDomainIdPayloadV1(random)}`);
}

export async function deriveRelocationIdV1(
  parentId: RelocationId,
  ordinal: number,
): Promise<RelocationId> {
  const digest = await sha256Bytes(
    new TextEncoder().encode(`${parentId}:${String(ordinal)}`),
  );
  return parseRelocationId(
    `rel_${encodeDomainIdPayloadV1(hexPrefixBytes(digest))}`,
  );
}

export function encodeDomainIdPayloadV1(bytes: Uint8Array): string {
  if (bytes.byteLength !== DOMAIN_ID_BYTES) {
    throw new RangeError("A domain ID requires exactly 128 bits.");
  }
  let value = 0n;
  for (const byte of bytes) value = (value << BYTE_SHIFT) | BigInt(byte);
  const encoded = Array.from({ length: DOMAIN_ID_PAYLOAD_LENGTH }, () => "0");
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] =
      CROCKFORD_BASE32_ALPHABET[Number(value & BASE32_MASK)] ?? "";
    value >>= BASE32_SHIFT;
  }
  return encoded.join("");
}

function randomDomainIdPayloadV1(random: CryptographicRandomValuesV1): string {
  const bytes = new Uint8Array(DOMAIN_ID_BYTES);
  random.getRandomValues(bytes);
  return encodeDomainIdPayloadV1(bytes);
}

function hexPrefixBytes(digest: string): Uint8Array {
  const bytes = new Uint8Array(DOMAIN_ID_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    const offset = index * HEX_CHARACTERS_PER_BYTE;
    bytes[index] = Number.parseInt(
      digest.slice(offset, offset + HEX_CHARACTERS_PER_BYTE),
      HEX_RADIX,
    );
  }
  return bytes;
}

function requireCryptographicRandomValuesV1(): CryptographicRandomValuesV1 {
  const candidate = Reflect.get(globalThis, "crypto") as unknown;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof Reflect.get(candidate, "getRandomValues") !== "function"
  ) {
    throw new Error("Cryptographic randomness is unavailable.");
  }
  return candidate as CryptographicRandomValuesV1;
}
