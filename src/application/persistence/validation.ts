import { createSourceGeneration, parseSha256Digest } from "../note-session";
import { validateSerializedSceneStateV1 } from "../../domain/codecs";
import { validateBoundedSerializedSceneStateV1 } from "../../domain/codecs/scene-validation";
import { closedRecord } from "../../domain/model/validation-support";
import { materializeSerializedSceneStateV1 } from "../../domain/scene";
import type {
  FutureSidecarVersionV1,
  InkbookSidecarV1,
  SidecarNoteIdentityV1,
  SidecarSchemaVersionV1,
  SidecarStorageLayoutV1,
} from "./types";

const FORMAT = "inkbook-obsidian-annotations";
const CURRENT_MAJOR = 1;
const CURRENT_MINOR = 0;
const MARKDOWN_SUFFIX = ".md";
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:\//iu;

function safeInteger(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RangeError(
      `${name} must be a safe integer of at least ${String(minimum)}.`,
    );
  }
  return value as number;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function validateVaultRelativePath(
  value: unknown,
  name: string,
  requiredSuffix: string | null,
): string {
  const path = stringValue(value, name);
  const segments = path.split("/");
  const invalidSegment = segments.some(
    (segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith("."),
  );
  if (
    path.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    invalidSegment ||
    (requiredSuffix !== null && !path.endsWith(requiredSuffix))
  ) {
    throw new TypeError(`${name} is not a normalized Vault-relative path.`);
  }
  return path;
}

export function validateSidecarVersionStructure(
  value: unknown,
): FutureSidecarVersionV1 {
  const data = closedRecord(value, ["major", "minor"], "Schema version");
  return Object.freeze({
    major: safeInteger(data.major, "Schema major", CURRENT_MAJOR),
    minor: safeInteger(data.minor, "Schema minor", CURRENT_MINOR),
  });
}

function validateCurrentVersion(value: unknown): SidecarSchemaVersionV1 {
  const version = validateSidecarVersionStructure(value);
  if (version.major !== CURRENT_MAJOR || version.minor !== CURRENT_MINOR) {
    throw new RangeError(
      "The sidecar schema is not the current writable V1 version.",
    );
  }
  return Object.freeze({ major: CURRENT_MAJOR, minor: CURRENT_MINOR });
}

function validateNoteIdentity(value: unknown): SidecarNoteIdentityV1 {
  const data = closedRecord(
    value,
    ["vaultRelativeMarkdownPath", "markdownContentDigest", "sourceGeneration"],
    "Sidecar note identity",
  );
  return Object.freeze({
    vaultRelativeMarkdownPath: validateVaultRelativePath(
      data.vaultRelativeMarkdownPath,
      "Markdown path",
      MARKDOWN_SUFFIX,
    ),
    markdownContentDigest: parseSha256Digest(
      stringValue(data.markdownContentDigest, "Markdown content digest"),
    ),
    sourceGeneration: createSourceGeneration(
      safeInteger(data.sourceGeneration, "Source generation", 1),
    ),
  });
}

function readStorageKind(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Storage layout must be a closed data object.");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    throw new TypeError("Storage layout must contain a data discriminator.");
  }
  return descriptor.value;
}

function validateStorageLayout(value: unknown): SidecarStorageLayoutV1 {
  const kind = readStorageKind(value);
  if (kind === "adjacent") {
    closedRecord(value, ["kind"], "Adjacent storage layout");
    return Object.freeze({ kind });
  }
  if (kind === "vault-root") {
    const data = closedRecord(
      value,
      ["kind", "vaultRelativeRoot"],
      "Vault-root storage layout",
    );
    return Object.freeze({
      kind,
      vaultRelativeRoot: validateVaultRelativePath(
        data.vaultRelativeRoot,
        "Storage root",
        null,
      ),
    });
  }
  throw new TypeError("Storage layout has an unsupported discriminator.");
}

function validateRevisions(
  revisionValue: unknown,
  baseRevisionValue: unknown,
): readonly [number, number | null] {
  const revision = safeInteger(revisionValue, "Sidecar revision", 1);
  if (baseRevisionValue === null) {
    if (revision !== 1) {
      throw new RangeError(
        "Only the first sidecar revision has a null base revision.",
      );
    }
    return Object.freeze([revision, null]);
  }
  const baseRevision = safeInteger(baseRevisionValue, "Base revision", 1);
  if (baseRevision !== revision - 1) {
    throw new RangeError("Base revision must be the direct predecessor.");
  }
  return Object.freeze([revision, baseRevision]);
}

function validateSidecar(
  value: unknown,
  measuredUtf8Bytes: number | undefined,
): InkbookSidecarV1 {
  const data = closedRecord(
    value,
    [
      "format",
      "schemaVersion",
      "noteIdentity",
      "storageLayout",
      "revision",
      "baseRevision",
      "savedAtEpochMs",
      "scene",
    ],
    "Inkbook sidecar",
  );
  if (data.format !== FORMAT)
    throw new TypeError("Sidecar format is unsupported.");
  const schemaVersion = validateCurrentVersion(data.schemaVersion);
  const noteIdentity = validateNoteIdentity(data.noteIdentity);
  const storageLayout = validateStorageLayout(data.storageLayout);
  const [revision, baseRevision] = validateRevisions(
    data.revision,
    data.baseRevision,
  );
  const savedAtEpochMs = safeInteger(data.savedAtEpochMs, "Saved timestamp", 0);
  const runtimeScene =
    measuredUtf8Bytes === undefined
      ? validateSerializedSceneStateV1(data.scene)
      : validateBoundedSerializedSceneStateV1(data.scene, measuredUtf8Bytes);
  return Object.freeze({
    format: FORMAT,
    schemaVersion,
    noteIdentity,
    storageLayout,
    revision,
    baseRevision,
    savedAtEpochMs,
    scene: materializeSerializedSceneStateV1(runtimeScene),
  });
}

export function validateInkbookSidecarV1(value: unknown): InkbookSidecarV1 {
  return validateSidecar(value, undefined);
}

export function validateBoundedInkbookSidecarV1(
  value: unknown,
  measuredUtf8Bytes: number,
): InkbookSidecarV1 {
  return validateSidecar(value, measuredUtf8Bytes);
}
