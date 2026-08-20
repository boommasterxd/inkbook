import { createSourceGeneration, parseSha256Digest } from "../note-session";
import { validateSerializedSceneStateV1 } from "../../domain/codecs";
import { validateBoundedSerializedSceneStateV1 } from "../../domain/codecs/scene-validation";
import { closedRecord } from "../../domain/model/validation-support";
import { materializeSerializedSceneStateV1 } from "../../domain/scene";
import {
  normalizeVaultRelativePathV1,
  type VaultPathNormalizerV1,
  type VaultPathValidationOptionsV1,
} from "../vault-path";
import type {
  FutureSidecarVersionV1,
  InkbookSidecarV1,
  SidecarNoteIdentityV1,
  SidecarSchemaVersionV1,
  SidecarStorageLayoutV1,
  SidecarStoragePolicyV1,
} from "./types";

const FORMAT = "inkbook-obsidian-annotations";
const CURRENT_MAJOR = 1;
const CURRENT_MINOR = 0;
const MARKDOWN_SUFFIX = ".md";

const SIDECAR_PATH_SUFFIX_V1 = ".inkbook.json";

export type { VaultPathNormalizerV1, VaultPathValidationOptionsV1 };

export interface ValidatedSidecarEnvelopeV1 {
  readonly format: "inkbook-obsidian-annotations";
  readonly schemaVersion: SidecarSchemaVersionV1;
  readonly noteIdentity: SidecarNoteIdentityV1;
  readonly storageLayout: SidecarStorageLayoutV1;
  readonly revision: number;
  readonly baseRevision: number | null;
  readonly savedAtEpochMs: number;
  readonly scene: unknown;
}

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

export function normalizeVaultRelativePath(
  value: unknown,
  optionsOrNormalizer?: VaultPathValidationOptionsV1 | VaultPathNormalizerV1,
): string {
  const options: VaultPathValidationOptionsV1 =
    typeof optionsOrNormalizer === "function"
      ? { normalizePath: optionsOrNormalizer }
      : (optionsOrNormalizer ?? {});
  return normalizeVaultRelativePathV1(value, options);
}

export function validateSidecarPathV1(
  value: unknown,
  options: Omit<VaultPathValidationOptionsV1, "requiredSuffix"> = {},
): string {
  return normalizeVaultRelativePath(value, {
    ...options,
    requiredSuffix: SIDECAR_PATH_SUFFIX_V1,
    name: options.name ?? "Sidecar path",
  });
}

function policyDiscriminator(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Storage policy must be a closed data object.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "mode");
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    throw new TypeError("Storage policy must contain a data discriminator.");
  }
  return descriptor.value;
}

export function validateSidecarStoragePolicyV1(
  value: unknown,
  options: Omit<VaultPathValidationOptionsV1, "requiredSuffix"> = {},
): SidecarStoragePolicyV1 {
  const mode = policyDiscriminator(value);
  if (mode === "adjacent") {
    const data = closedRecord(
      value,
      ["version", "mode"],
      "Adjacent storage policy",
    );
    if (data.version !== 1) {
      throw new RangeError("Storage policy version is not writable V1.");
    }
    return Object.freeze({ version: 1, mode: "adjacent" });
  }
  if (mode === "vault-root") {
    const data = closedRecord(
      value,
      ["version", "mode", "vaultRelativeRoot"],
      "Vault-root storage policy",
    );
    if (data.version !== 1) {
      throw new RangeError("Storage policy version is not writable V1.");
    }
    return Object.freeze({
      version: 1,
      mode: "vault-root",
      vaultRelativeRoot: normalizeVaultRelativePath(data.vaultRelativeRoot, {
        ...options,
        name: options.name ?? "Storage root",
      }),
    });
  }
  throw new TypeError("Storage policy has an unsupported mode.");
}

export function isSidecarStoragePolicyV1(
  value: unknown,
  options: Omit<VaultPathValidationOptionsV1, "requiredSuffix"> = {},
): value is SidecarStoragePolicyV1 {
  try {
    validateSidecarStoragePolicyV1(value, options);
    return true;
  } catch {
    return false;
  }
}

export function defaultSidecarStoragePolicyV1(): SidecarStoragePolicyV1 {
  return Object.freeze({ version: 1, mode: "adjacent" });
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

function validateNoteIdentity(
  value: unknown,
  pathOptions: VaultPathValidationOptionsV1,
): SidecarNoteIdentityV1 {
  const data = closedRecord(
    value,
    ["vaultRelativeMarkdownPath", "markdownContentDigest", "sourceGeneration"],
    "Sidecar note identity",
  );
  return Object.freeze({
    vaultRelativeMarkdownPath: normalizeVaultRelativePath(
      data.vaultRelativeMarkdownPath,
      {
        ...pathOptions,
        name: "Markdown path",
        requiredSuffix: MARKDOWN_SUFFIX,
      },
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

function validateStorageLayout(
  value: unknown,
  pathOptions: VaultPathValidationOptionsV1,
): SidecarStorageLayoutV1 {
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
      vaultRelativeRoot: normalizeVaultRelativePath(data.vaultRelativeRoot, {
        ...pathOptions,
        name: "Storage root",
      }),
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
  pathOptions: VaultPathValidationOptionsV1,
): InkbookSidecarV1 {
  const envelope = validateInkbookSidecarEnvelopeV1(value, pathOptions);
  const runtimeScene =
    measuredUtf8Bytes === undefined
      ? validateSerializedSceneStateV1(envelope.scene)
      : validateBoundedSerializedSceneStateV1(
          envelope.scene,
          measuredUtf8Bytes,
        );
  return Object.freeze({
    ...envelope,
    scene: materializeSerializedSceneStateV1(runtimeScene),
  });
}

export function validateInkbookSidecarEnvelopeV1(
  value: unknown,
  pathOptions: VaultPathValidationOptionsV1 = {},
): ValidatedSidecarEnvelopeV1 {
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
  const noteIdentity = validateNoteIdentity(data.noteIdentity, pathOptions);
  const storageLayout = validateStorageLayout(data.storageLayout, pathOptions);
  const [revision, baseRevision] = validateRevisions(
    data.revision,
    data.baseRevision,
  );
  const savedAtEpochMs = safeInteger(data.savedAtEpochMs, "Saved timestamp", 0);
  return Object.freeze({
    format: FORMAT,
    schemaVersion,
    noteIdentity,
    storageLayout,
    revision,
    baseRevision,
    savedAtEpochMs,
    scene: data.scene,
  });
}

export function validateInkbookSidecarV1(
  value: unknown,
  pathOptions: VaultPathValidationOptionsV1 = {},
): InkbookSidecarV1 {
  return validateSidecar(value, undefined, pathOptions);
}

export function validateBoundedInkbookSidecarV1(
  value: unknown,
  measuredUtf8Bytes: number,
  pathOptions: VaultPathValidationOptionsV1 = {},
): InkbookSidecarV1 {
  return validateSidecar(value, measuredUtf8Bytes, pathOptions);
}
