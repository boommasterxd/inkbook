import {
  parseBoundedJson,
  type BoundedJsonLimits,
} from "../../domain/codecs/bounded-json";
import { encodeCanonicalJson } from "../../domain/codecs/canonical-json";
import { createSceneRevision } from "../../domain/model";
import {
  createHistoryEpoch,
  isHistoryEntryId,
  isOperationId,
  validateAnnotationHistoryEntryV1,
  type AnnotationHistoryEntryV1,
} from "../../domain/operations";
import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1 } from "../note-session/types";
import {
  createSessionOrder,
  createSettingsRevision,
  createSourceGeneration,
  parseRecoveryAttemptId,
  parseRelocationId,
  parseRemovalId,
  parseSha256Digest,
  parseSourceCheckpointId,
} from "../note-session/value-objects";
import { validateSourceOffsetMap } from "../source-coordination/offset-map";
import type { SourceCheckpointOperationV1 } from "../source-coordination/types";
import type {
  FileRelocationRecordV1,
  PrefixRelocationRecordV1,
  RecoveryAttemptCommonV1,
  RecoveryAttemptV1,
  RecoveryPersistenceRecordV1,
  RelocationRecordV1,
  RemovalRecordV1,
} from "./types";
import {
  acknowledgementValue,
  arrayValue,
  asRecord,
  booleanValue,
  dataPropertyValue,
  type DataRecord,
  equalBytes,
  exactKeys,
  fileStep,
  jsonErrorCode,
  markerState,
  noteIdentityValue,
  nonNegativeInteger,
  numberValue,
  positiveInteger,
  prefixStep,
  patchValue,
  sidecarBaseValue,
  sourceOffsetSpanValue,
  stringValue,
} from "./codec-values";
import { validateRelocationRecord, validateRemovalRecord } from "./transitions";

const CODEC_KIBIBYTE = 1024;
const CODEC_MEBIBYTE = CODEC_KIBIBYTE * CODEC_KIBIBYTE;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const MAX_RECORD_BYTES = 8 * CODEC_MEBIBYTE;
const MAX_JSON_COLLECTION_ITEMS = 1_048_576;
const RECOVERY_JSON_LIMITS: BoundedJsonLimits = Object.freeze({
  maxArrayItems: MAX_JSON_COLLECTION_ITEMS,
  maxArrays: MAX_JSON_COLLECTION_ITEMS,
  maxNesting: 64,
  maxObjectMembers: MAX_JSON_COLLECTION_ITEMS,
  maxObjectMembersPerObject: 64,
  maxObjects: MAX_JSON_COLLECTION_ITEMS,
  maxStringUtf16Units: MAX_RECORD_BYTES,
  maxUtf8Bytes: MAX_RECORD_BYTES,
});
const SCHEMA_VERSION = 1 as const;
const ENVELOPE_KEYS = ["record", "recordType", "schemaVersion"] as const;

type RecordType = "attempt" | "source-checkpoint" | "relocation" | "removal";

interface RecoveryRecordEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly recordType: RecordType;
  readonly record: RecoveryPersistenceRecordV1;
}

export function encodeRecoveryRecordV1(
  record: RecoveryPersistenceRecordV1,
): CommandResultV1<Uint8Array> {
  const materialized = materializeRecord(recordType(record), record);
  if (!materialized.ok) return materialized;
  try {
    const bytes = encodeCanonicalJson({
      record: materialized.value,
      recordType: recordType(materialized.value),
      schemaVersion: SCHEMA_VERSION,
    } satisfies RecoveryRecordEnvelopeV1);
    return bytes.byteLength <= MAX_RECORD_BYTES
      ? commandSuccess(bytes)
      : commandFailure("recovery-limit");
  } catch {
    return commandFailure("invalid-command");
  }
}

export function decodeRecoveryRecordV1(
  bytes: Uint8Array,
): CommandResultV1<RecoveryPersistenceRecordV1> {
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    return commandFailure("recovery-limit");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = parseBoundedJson(text, RECOVERY_JSON_LIMITS);
    if (!parsed.ok) return commandFailure(jsonErrorCode(parsed.error.code));
    const envelope = asRecord(parsed.value);
    exactKeys(envelope, ENVELOPE_KEYS);
    if (
      envelope.schemaVersion !== SCHEMA_VERSION ||
      !isRecordType(envelope.recordType)
    ) {
      return commandFailure("invalid-command");
    }
    const materialized = materializeRecord(
      envelope.recordType,
      envelope.record,
    );
    if (!materialized.ok) return materialized;
    const encoded = encodeRecoveryRecordV1(materialized.value);
    if (!encoded.ok) return encoded;
    return equalBytes(bytes, encoded.value)
      ? commandSuccess(materialized.value)
      : commandFailure("invalid-command");
  } catch {
    return commandFailure("invalid-command");
  }
}

function materializeRecord(
  type: RecordType,
  value: unknown,
): CommandResultV1<RecoveryPersistenceRecordV1> {
  try {
    switch (type) {
      case "attempt":
        return commandSuccess(materializeAttempt(value));
      case "source-checkpoint":
        return commandSuccess(materializeCheckpoint(value));
      case "relocation":
        return commandSuccess(materializeRelocation(value));
      case "removal":
        return commandSuccess(materializeRemoval(value));
    }
  } catch (error) {
    return commandFailure(
      error instanceof RangeError ? "recovery-limit" : "invalid-command",
    );
  }
}

function materializeAttempt(value: unknown): RecoveryAttemptV1 {
  const data = asRecord(value);
  const kind = dataPropertyValue(data, "kind");
  if (kind === "prepared-forward") {
    exactKeys(data, [...attemptCommonKeys(), "forward", "inverse", "kind"]);
    const common = materializeAttemptCommon(data);
    const historyEntry = materializeHistoryEntry(data, common);
    return Object.freeze({
      ...common,
      forward: historyEntry.forward,
      inverse: historyEntry.inverse,
      kind: "prepared-forward",
    });
  }
  if (kind === "host-recorded-forward") {
    exactKeys(data, [
      "acknowledgement",
      ...attemptCommonKeys(),
      "forward",
      "inverse",
      "kind",
    ]);
    const common = materializeAttemptCommon(data);
    const historyEntry = materializeHistoryEntry(data, common);
    return Object.freeze({
      ...common,
      acknowledgement: acknowledgementValue(data.acknowledgement, "forward"),
      forward: historyEntry.forward,
      inverse: historyEntry.inverse,
      kind: "host-recorded-forward",
    });
  }
  if (kind === "host-recorded-undo" || kind === "host-recorded-redo") {
    exactKeys(data, [
      "acknowledgement",
      ...attemptCommonKeys(),
      "directionPatch",
      "kind",
    ]);
    const common = materializeAttemptCommon(data);
    const expectedDirection =
      kind === "host-recorded-undo" ? "inverse" : "forward";
    return Object.freeze({
      ...common,
      acknowledgement: acknowledgementValue(
        data.acknowledgement,
        expectedDirection,
      ),
      directionPatch: patchValue(data.directionPatch),
      kind,
    });
  }
  throw new TypeError("Unknown recovery attempt kind.");
}

function materializeHistoryEntry(
  data: DataRecord,
  common: RecoveryAttemptCommonV1,
): AnnotationHistoryEntryV1 {
  const result = validateAnnotationHistoryEntryV1({
    forward: data.forward,
    historyEntryId: common.historyEntryId,
    historyEpoch: common.historyEpoch,
    inverse: data.inverse,
  });
  if (!result.ok) throw new TypeError("Invalid recovery patch pair.");
  return result.value;
}

function materializeAttemptCommon(data: DataRecord): RecoveryAttemptCommonV1 {
  if (
    !isOperationId(data.operationId) ||
    !isHistoryEntryId(data.historyEntryId)
  ) {
    throw new TypeError("Invalid operation identity.");
  }
  return {
    attemptId: parseRecoveryAttemptId(stringValue(data.attemptId)),
    base: sidecarBaseValue(data.base),
    expectedSceneRevision: createSceneRevision(
      numberValue(data.expectedSceneRevision),
    ),
    expectedSourceDigest: parseSha256Digest(
      stringValue(data.expectedSourceDigest),
    ),
    expectedSourceGeneration: createSourceGeneration(
      numberValue(data.expectedSourceGeneration),
    ),
    historyEntryId: data.historyEntryId,
    historyEpoch: createHistoryEpoch(numberValue(data.historyEpoch)),
    operationId: data.operationId,
    sessionOrder: createSessionOrder(numberValue(data.sessionOrder)),
  };
}

function materializeCheckpoint(value: unknown): SourceCheckpointOperationV1 {
  const data = asRecord(value);
  exactKeys(data, [
    "base",
    "checkpointId",
    "offsetMap",
    "priorDigest",
    "priorGeneration",
    "priorUtf16Length",
    "replacementDigest",
    "replacementGeneration",
    "replacementUtf16Length",
    "sessionOrder",
  ]);
  const priorLength = nonNegativeInteger(data.priorUtf16Length);
  const replacementLength = nonNegativeInteger(data.replacementUtf16Length);
  const mapData = asRecord(data.offsetMap);
  exactKeys(mapData, ["spans"]);
  const map = validateSourceOffsetMap(
    { spans: arrayValue(mapData.spans).map(sourceOffsetSpanValue) },
    priorLength,
    replacementLength,
  );
  if (!map.ok) throw new TypeError("Invalid source offset map.");
  const priorGeneration = createSourceGeneration(
    numberValue(data.priorGeneration),
  );
  const replacementGeneration = createSourceGeneration(
    numberValue(data.replacementGeneration),
  );
  if (replacementGeneration !== priorGeneration + 1) {
    throw new TypeError("Source generations are not contiguous.");
  }
  return Object.freeze({
    base: sidecarBaseValue(data.base),
    checkpointId: parseSourceCheckpointId(stringValue(data.checkpointId)),
    offsetMap: map.value,
    priorDigest: parseSha256Digest(stringValue(data.priorDigest)),
    priorGeneration,
    priorUtf16Length: priorLength,
    replacementDigest: parseSha256Digest(stringValue(data.replacementDigest)),
    replacementGeneration,
    replacementUtf16Length: replacementLength,
    sessionOrder: createSessionOrder(numberValue(data.sessionOrder)),
  });
}

function materializeRelocation(value: unknown): RelocationRecordV1 {
  const data = asRecord(value);
  if (data.kind === "markdown-file" || data.kind === "sidecar-location") {
    return materializeFileRelocation(data);
  }
  if (data.kind === "folder-prefix" || data.kind === "storage-root") {
    return materializePrefixRelocation(data);
  }
  throw new TypeError("Unknown relocation kind.");
}

function materializeFileRelocation(data: DataRecord): FileRelocationRecordV1 {
  exactKeys(data, [
    "destinationMarkdownPath",
    "destinationSidecarPath",
    "expectedSceneRevision",
    "expectedSettingsRevision",
    "kind",
    "noteIdentity",
    "relocationId",
    "sidecarBase",
    "sourceMarkdownPath",
    "sourceSidecarPath",
    "step",
  ]);
  const record = Object.freeze({
    destinationMarkdownPath: stringValue(data.destinationMarkdownPath),
    destinationSidecarPath: stringValue(data.destinationSidecarPath),
    expectedSceneRevision: createSceneRevision(
      numberValue(data.expectedSceneRevision),
    ),
    expectedSettingsRevision: createSettingsRevision(
      numberValue(data.expectedSettingsRevision),
    ),
    kind: data.kind as FileRelocationRecordV1["kind"],
    noteIdentity: noteIdentityValue(data.noteIdentity),
    relocationId: parseRelocationId(stringValue(data.relocationId)),
    sidecarBase: sidecarBaseValue(data.sidecarBase),
    sourceMarkdownPath: stringValue(data.sourceMarkdownPath),
    sourceSidecarPath: stringValue(data.sourceSidecarPath),
    step: fileStep(data.step),
  });
  if (!validateRelocationRecord(record).ok) {
    throw new TypeError("Invalid relocation record.");
  }
  return record;
}

function materializePrefixRelocation(
  data: DataRecord,
): PrefixRelocationRecordV1 {
  exactKeys(data, [
    "admittedRecordCount",
    "cursor",
    "expectedSettingsRevision",
    "generation",
    "kind",
    "priorPrefix",
    "relocationId",
    "replacementPrefix",
    "step",
  ]);
  const record = Object.freeze({
    admittedRecordCount: nonNegativeInteger(data.admittedRecordCount),
    cursor: nonNegativeInteger(data.cursor),
    expectedSettingsRevision: createSettingsRevision(
      numberValue(data.expectedSettingsRevision),
    ),
    generation: positiveInteger(data.generation),
    kind: data.kind as PrefixRelocationRecordV1["kind"],
    priorPrefix: stringValue(data.priorPrefix),
    relocationId: parseRelocationId(stringValue(data.relocationId)),
    replacementPrefix: stringValue(data.replacementPrefix),
    step: prefixStep(data.step),
  });
  if (!validateRelocationRecord(record).ok) {
    throw new TypeError("Invalid relocation record.");
  }
  return record;
}

function materializeRemoval(value: unknown): RemovalRecordV1 {
  const data = asRecord(value);
  exactKeys(data, [
    "deadlineEpochMs",
    "deleteEventAcknowledged",
    "expectedSceneRevision",
    "kind",
    "markerState",
    "noteIdentity",
    "removalId",
    "sidecarBase",
    "trashAcknowledged",
  ]);
  if (data.kind !== "annotation-removal")
    throw new TypeError("Invalid removal kind.");
  const record = Object.freeze({
    deadlineEpochMs: positiveInteger(data.deadlineEpochMs),
    deleteEventAcknowledged: booleanValue(data.deleteEventAcknowledged),
    expectedSceneRevision: createSceneRevision(
      numberValue(data.expectedSceneRevision),
    ),
    kind: "annotation-removal",
    markerState: markerState(data.markerState),
    noteIdentity: noteIdentityValue(data.noteIdentity),
    removalId: parseRemovalId(stringValue(data.removalId)),
    sidecarBase: sidecarBaseValue(data.sidecarBase),
    trashAcknowledged: booleanValue(data.trashAcknowledged),
  });
  if (!validateRemovalRecord(record).ok) {
    throw new TypeError("Invalid removal record.");
  }
  return record;
}

function recordType(record: RecoveryPersistenceRecordV1): RecordType {
  if ("attemptId" in record) return "attempt";
  if ("checkpointId" in record) return "source-checkpoint";
  if (record.kind === "annotation-removal") return "removal";
  return "relocation";
}

function attemptCommonKeys(): readonly string[] {
  return [
    "attemptId",
    "base",
    "expectedSceneRevision",
    "expectedSourceDigest",
    "expectedSourceGeneration",
    "historyEntryId",
    "historyEpoch",
    "operationId",
    "sessionOrder",
  ];
}

function isRecordType(value: unknown): value is RecordType {
  return (
    value === "attempt" ||
    value === "source-checkpoint" ||
    value === "relocation" ||
    value === "removal"
  );
}
