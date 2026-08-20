import {
  commandFailure,
  commandSuccess,
  type CommandResultV1,
} from "../../application/note-session";
import {
  isValidNoteIdentity,
  isValidSidecarBase,
  RECOVERY_STORE_LIMITS_V1,
  type PrefixRelocationMemberV1,
  type PrefixRelocationRecordV1,
} from "../../application/recovery";
import { isValidVaultRelativePathV1 } from "../../application/vault-path";
import { parseBoundedJson } from "../../domain/codecs/bounded-json";
import { encodeCanonicalJson } from "../../domain/codecs/canonical-json";
import { createSceneRevision } from "../../domain/model";
import { bytesEqual } from "./record-storage";
import type { StoredPrefixRelocationMember } from "./schema";

const MAX_MEMBER_BYTES = RECOVERY_STORE_LIMITS_V1.maxNoteBytes;
const BEFORE = -1;
const MEMBER_KEYS = [
  "destinationSidecarPath",
  "expectedSceneRevision",
  "ordinal",
  "priorNoteIdentity",
  "replacementNoteIdentity",
  "sidecarBase",
  "sourceSidecarPath",
] as const;
const STORED_KEYS = [
  "byteSize",
  "encoded",
  "key",
  "noteKey",
  "ordinal",
  "relocationId",
  "sha256",
] as const;

export function admitPrefixMember(
  value: PrefixRelocationMemberV1,
): CommandResultV1<
  Readonly<{ member: PrefixRelocationMemberV1; encoded: Uint8Array }>
> {
  try {
    const encoded = encodeCanonicalJson(value);
    if (encoded.byteLength > MAX_MEMBER_BYTES) return limited();
    const member = decodePrefixMember(encoded);
    return member.ok
      ? commandSuccess(Object.freeze({ encoded, member: member.value }))
      : member;
  } catch {
    return invalid();
  }
}

export function decodePrefixMember(
  bytes: Uint8Array,
): CommandResultV1<PrefixRelocationMemberV1> {
  if (bytes.byteLength > MAX_MEMBER_BYTES) return limited();
  try {
    const parsed = parseBoundedJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      {
        maxArrayItems: 8,
        maxArrays: 1,
        maxNesting: 8,
        maxObjectMembers: 32,
        maxObjectMembersPerObject: 8,
        maxObjects: 8,
        maxStringUtf16Units: MAX_MEMBER_BYTES,
        maxUtf8Bytes: MAX_MEMBER_BYTES,
      },
    );
    if (!parsed.ok) return invalid();
    const member = materializeMember(parsed.value);
    return bytesEqual(bytes, encodeCanonicalJson(member))
      ? commandSuccess(member)
      : invalid();
  } catch {
    return invalid();
  }
}

export function validCanonicalPrefixPlan(
  members: readonly PrefixRelocationMemberV1[],
  record: PrefixRelocationRecordV1,
): boolean {
  const prior = new Set<string>();
  const replacement = new Set<string>();
  const sourceSidecars = new Set<string>();
  const destinationSidecars = new Set<string>();
  let previous: PrefixRelocationMemberV1 | undefined;
  for (const [index, member] of members.entries()) {
    const priorKey = noteIdentityKey(member.priorNoteIdentity);
    const replacementKey = noteIdentityKey(member.replacementNoteIdentity);
    if (
      member.ordinal !== index ||
      (previous !== undefined && compareMembers(previous, member) >= 0) ||
      prior.has(priorKey) ||
      replacement.has(replacementKey) ||
      !matchesPrefixTransition(member, record) ||
      hasSidecarCollision(member, sourceSidecars, destinationSidecars)
    ) {
      return false;
    }
    prior.add(priorKey);
    replacement.add(replacementKey);
    previous = member;
  }
  return true;
}

export function parseStoredPrefixMember(
  value: unknown,
): StoredPrefixRelocationMember | null {
  if (!isRecord(value) || !exactKeys(value, STORED_KEYS)) return null;
  if (!(value.encoded instanceof Uint8Array)) return null;
  const candidate = value as unknown as StoredPrefixRelocationMember;
  return typeof candidate.key === "string" &&
    typeof candidate.relocationId === "string" &&
    Number.isSafeInteger(candidate.ordinal) &&
    candidate.ordinal >= 0 &&
    typeof candidate.noteKey === "string" &&
    candidate.byteSize === candidate.encoded.byteLength &&
    typeof candidate.sha256 === "string"
    ? candidate
    : null;
}

export function exactStoredPrefixPlan(
  values: readonly unknown[],
  expected: readonly StoredPrefixRelocationMember[],
): boolean {
  if (values.length !== expected.length) return false;
  const actual = values.map(parseStoredPrefixMember);
  return actual.every((member, index) => {
    const expectedMember = expected[index];
    return (
      member !== null &&
      expectedMember !== undefined &&
      sameStoredMember(member, expectedMember)
    );
  });
}

export function validStoredPrefixOrdinals(
  members: readonly StoredPrefixRelocationMember[],
  record: PrefixRelocationRecordV1,
): boolean {
  const ordinals = new Set<number>();
  for (const member of members) {
    if (
      member.relocationId !== record.relocationId ||
      member.ordinal >= record.admittedRecordCount ||
      ordinals.has(member.ordinal)
    ) {
      return false;
    }
    ordinals.add(member.ordinal);
  }
  return true;
}

export function storedPrefixMemberMatches(
  stored: StoredPrefixRelocationMember,
  relocationId: string,
  member: PrefixRelocationMemberV1,
): boolean {
  return (
    stored.key === prefixMemberKey(relocationId, member.ordinal) &&
    stored.relocationId === relocationId &&
    stored.ordinal === member.ordinal &&
    stored.noteKey === member.priorNoteIdentity.vaultRelativeMarkdownPath &&
    stored.byteSize === stored.encoded.byteLength
  );
}

export function prefixMemberKey(relocationId: string, ordinal: number): string {
  return `${relocationId}:${String(ordinal)}`;
}

function materializeMember(value: unknown): PrefixRelocationMemberV1 {
  if (!isRecord(value) || !exactKeys(value, MEMBER_KEYS)) throw new TypeError();
  const prior = value.priorNoteIdentity;
  const replacement = value.replacementNoteIdentity;
  if (!isValidNoteIdentity(prior) || !isValidNoteIdentity(replacement)) {
    throw new TypeError();
  }
  const expectedSceneRevision =
    value.expectedSceneRevision === null
      ? null
      : createSceneRevision(asNonNegativeInteger(value.expectedSceneRevision));
  const base = value.sidecarBase;
  const source = value.sourceSidecarPath;
  const destination = value.destinationSidecarPath;
  const noSidecar = base === null && source === null && destination === null;
  const hasSidecar = validSidecarFields(base, source, destination, prior);
  if (
    (!noSidecar && !hasSidecar) ||
    noSidecar !== (expectedSceneRevision === null)
  ) {
    throw new TypeError();
  }
  const typedBase = hasSidecar ? base : null;
  const typedSource = hasSidecar ? (source as string) : null;
  const typedDestination = hasSidecar ? (destination as string) : null;
  return Object.freeze({
    destinationSidecarPath: typedDestination,
    expectedSceneRevision,
    ordinal: asNonNegativeInteger(value.ordinal),
    priorNoteIdentity: Object.freeze({ ...prior }),
    replacementNoteIdentity: Object.freeze({ ...replacement }),
    sidecarBase: typedBase === null ? null : Object.freeze({ ...typedBase }),
    sourceSidecarPath: typedSource,
  });
}

function matchesPrefixTransition(
  member: PrefixRelocationMemberV1,
  record: PrefixRelocationRecordV1,
): boolean {
  if (
    member.priorNoteIdentity.vaultIdHint !==
    member.replacementNoteIdentity.vaultIdHint
  ) {
    return false;
  }
  const expectedMarkdown = replacePrefix(
    member.priorNoteIdentity.vaultRelativeMarkdownPath,
    record.priorPrefix,
    record.replacementPrefix,
  );
  if (record.kind === "folder-prefix") {
    return (
      expectedMarkdown !== null &&
      member.replacementNoteIdentity.vaultRelativeMarkdownPath ===
        expectedMarkdown
    );
  }
  if (
    member.priorNoteIdentity.vaultRelativeMarkdownPath !==
    member.replacementNoteIdentity.vaultRelativeMarkdownPath
  ) {
    return false;
  }
  if (
    member.sourceSidecarPath === null ||
    member.destinationSidecarPath === null
  ) {
    return true;
  }
  return (
    replacePrefix(
      member.sourceSidecarPath,
      record.priorPrefix,
      record.replacementPrefix,
    ) === member.destinationSidecarPath
  );
}

function replacePrefix(
  path: string,
  priorPrefix: string,
  replacementPrefix: string,
): string | null {
  if (path === priorPrefix) return replacementPrefix;
  const prefix = `${priorPrefix}/`;
  return path.startsWith(prefix)
    ? `${replacementPrefix}/${path.slice(prefix.length)}`
    : null;
}

function hasSidecarCollision(
  member: PrefixRelocationMemberV1,
  sources: Set<string>,
  destinations: Set<string>,
): boolean {
  const source = member.sourceSidecarPath;
  const destination = member.destinationSidecarPath;
  if (source === null || destination === null) return false;
  const collision =
    sources.has(source) ||
    destinations.has(destination) ||
    sources.has(destination) ||
    destinations.has(source);
  sources.add(source);
  destinations.add(destination);
  return collision;
}

function validSidecarFields(
  base: unknown,
  source: unknown,
  destination: unknown,
  prior: PrefixRelocationMemberV1["priorNoteIdentity"],
): base is NonNullable<PrefixRelocationMemberV1["sidecarBase"]> {
  return (
    isValidSidecarBase(base) &&
    typeof source === "string" &&
    isValidVaultRelativePathV1(source) &&
    typeof destination === "string" &&
    isValidVaultRelativePathV1(destination) &&
    source !== destination &&
    base.markdownPath === prior.vaultRelativeMarkdownPath &&
    base.vaultRelativePath === source
  );
}

function compareMembers(
  left: PrefixRelocationMemberV1,
  right: PrefixRelocationMemberV1,
): number {
  const fields = [
    [left.priorNoteIdentity.vaultIdHint, right.priorNoteIdentity.vaultIdHint],
    [
      left.priorNoteIdentity.vaultRelativeMarkdownPath,
      right.priorNoteIdentity.vaultRelativeMarkdownPath,
    ],
    [
      left.replacementNoteIdentity.vaultRelativeMarkdownPath,
      right.replacementNoteIdentity.vaultRelativeMarkdownPath,
    ],
  ] as const;
  for (const [leftValue, rightValue] of fields) {
    const compared = compareCodePoints(leftValue, rightValue);
    if (compared !== 0) return compared;
  }
  if (left.sourceSidecarPath === null) {
    return right.sourceSidecarPath === null ? 0 : BEFORE;
  }
  if (right.sourceSidecarPath === null) return 1;
  return compareCodePoints(left.sourceSidecarPath, right.sourceSidecarPath);
}

function compareCodePoints(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  let leftPoint = leftIterator.next();
  let rightPoint = rightIterator.next();
  while (!leftPoint.done && !rightPoint.done) {
    const leftCodePoint = leftPoint.value.codePointAt(0);
    const rightCodePoint = rightPoint.value.codePointAt(0);
    if (leftCodePoint === undefined || rightCodePoint === undefined) {
      throw new TypeError();
    }
    const delta = leftCodePoint - rightCodePoint;
    if (delta !== 0) return delta;
    leftPoint = leftIterator.next();
    rightPoint = rightIterator.next();
  }
  if (leftPoint.done === rightPoint.done) return 0;
  return leftPoint.done ? BEFORE : 1;
}

function sameStoredMember(
  left: StoredPrefixRelocationMember,
  right: StoredPrefixRelocationMember,
): boolean {
  return (
    left.key === right.key &&
    left.relocationId === right.relocationId &&
    left.ordinal === right.ordinal &&
    left.noteKey === right.noteKey &&
    left.byteSize === right.byteSize &&
    left.sha256 === right.sha256 &&
    bytesEqual(left.encoded, right.encoded)
  );
}

function noteIdentityKey(
  identity: PrefixRelocationMemberV1["priorNoteIdentity"],
): string {
  return JSON.stringify([
    identity.vaultIdHint,
    identity.vaultRelativeMarkdownPath,
  ]);
}

function asNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function invalid(): CommandResultV1<never> {
  return commandFailure("invalid-command");
}

function limited(): CommandResultV1<never> {
  return commandFailure("recovery-limit");
}
