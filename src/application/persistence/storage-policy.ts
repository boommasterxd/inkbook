import { createSettingsRevision } from "../note-session";
import { closedRecord } from "../../domain/model/validation-support";
import {
  defaultSidecarStoragePolicyV1,
  isSidecarStoragePolicyV1,
  normalizeVaultRelativePath,
  validateSidecarStoragePolicyV1,
  type VaultPathValidationOptionsV1,
} from "./validation";
import type {
  LoadDataPortV1,
  PluginDataPortV1,
  SaveDataPortV1,
  SidecarStorageLayoutV1,
  SidecarStoragePolicyLoadResultV1,
  SidecarStoragePolicySnapshotV1,
  SidecarStoragePolicyStateV1,
  SidecarStoragePolicyV1,
  SidecarStoragePolicyWriteResultV1,
} from "./types";

const POLICY_VERSION = 1;
const MARKDOWN_SUFFIX = ".md";
const SIDECAR_SUFFIX = ".inkbook.json";

export interface SidecarStoragePolicyDocumentV1 {
  readonly version: 1;
  readonly revision: number;
  readonly policy: SidecarStoragePolicyV1;
}

export const DEFAULT_SIDECAR_STORAGE_POLICY_V1 = Object.freeze(
  defaultSidecarStoragePolicyV1(),
);

function readVersion(value: unknown): number | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "version");
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "number" ||
    !Number.isSafeInteger(descriptor.value)
  ) {
    return null;
  }
  return descriptor.value;
}

function defaultSnapshot(): SidecarStoragePolicySnapshotV1 {
  return Object.freeze({
    version: POLICY_VERSION,
    revision: createSettingsRevision(1),
    policy: DEFAULT_SIDECAR_STORAGE_POLICY_V1,
  });
}

function snapshot(
  policy: SidecarStoragePolicyV1,
  revision: number,
  pathOptions: VaultPathValidationOptionsV1,
): SidecarStoragePolicySnapshotV1 {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError("Storage policy revision must be a positive integer.");
  }
  return Object.freeze({
    version: POLICY_VERSION,
    revision: createSettingsRevision(revision),
    policy: validateSidecarStoragePolicyV1(policy, pathOptions),
  });
}

function invalidLoad(): SidecarStoragePolicyLoadResultV1 {
  return Object.freeze({
    snapshot: defaultSnapshot(),
    status: "defaulted-invalid",
  });
}

function futureLoad(): SidecarStoragePolicyLoadResultV1 {
  return Object.freeze({
    snapshot: defaultSnapshot(),
    status: "read-only-newer-version",
  });
}

function parseDocument(
  value: unknown,
  pathOptions: VaultPathValidationOptionsV1,
): SidecarStoragePolicyLoadResultV1 {
  if (value === null) return invalidLoad();

  const version = readVersion(value);
  if (version !== null && version > POLICY_VERSION) return futureLoad();

  if (isSidecarStoragePolicyV1(value, pathOptions)) {
    return Object.freeze({
      snapshot: snapshot(
        validateSidecarStoragePolicyV1(value, pathOptions),
        1,
        pathOptions,
      ),
      status: "loaded",
    });
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return invalidLoad();
  }

  const hasPolicy = Object.hasOwn(value, "policy");
  const hasSidecarStoragePolicy = Object.hasOwn(value, "sidecarStoragePolicy");
  if (!hasPolicy && !hasSidecarStoragePolicy) return invalidLoad();

  const field = hasPolicy ? "policy" : "sidecarStoragePolicy";
  const data = closedRecord(
    value,
    ["version", "revision", field],
    "Stored sidecar storage policy",
  );
  if (typeof data.version !== "number" || !Number.isSafeInteger(data.version)) {
    return invalidLoad();
  }
  if (data.version !== POLICY_VERSION) {
    return data.version > POLICY_VERSION ? futureLoad() : invalidLoad();
  }
  const nestedVersion = readVersion(data[field]);
  if (nestedVersion !== null && nestedVersion > POLICY_VERSION) {
    return futureLoad();
  }
  try {
    const policy = validateSidecarStoragePolicyV1(data[field], pathOptions);
    return Object.freeze({
      snapshot: snapshot(policy, data.revision as number, pathOptions),
      status: "loaded",
    });
  } catch {
    return invalidLoad();
  }
}

export function parseSidecarStoragePolicyV1(
  value: unknown,
  pathOptions: VaultPathValidationOptionsV1 = {},
): SidecarStoragePolicyLoadResultV1 {
  try {
    return parseDocument(value, pathOptions);
  } catch {
    return invalidLoad();
  }
}

async function loadSidecarStoragePolicyV1(
  port: LoadDataPortV1,
  pathOptions: VaultPathValidationOptionsV1 = {},
): Promise<SidecarStoragePolicyLoadResultV1> {
  try {
    return parseSidecarStoragePolicyV1(await port.loadData(), pathOptions);
  } catch {
    return invalidLoad();
  }
}

export function serializeSidecarStoragePolicyV1(
  value: SidecarStoragePolicySnapshotV1,
  pathOptions: VaultPathValidationOptionsV1 = {},
): SidecarStoragePolicyDocumentV1 {
  const validated = snapshot(value.policy, value.revision, pathOptions);
  return Object.freeze({
    version: POLICY_VERSION,
    revision: validated.revision,
    policy: validated.policy,
  });
}

export function sidecarStoragePolicyToLayout(
  policy: SidecarStoragePolicyV1,
  pathOptions: VaultPathValidationOptionsV1 = {},
): SidecarStorageLayoutV1 {
  const validated = validateSidecarStoragePolicyV1(policy, pathOptions);
  if (validated.mode === "adjacent") {
    return Object.freeze({ kind: "adjacent" });
  }
  return Object.freeze({
    kind: "vault-root",
    vaultRelativeRoot: validated.vaultRelativeRoot,
  });
}

export function resolveNewSidecarPathV1(
  policy: SidecarStoragePolicyV1,
  vaultRelativeMarkdownPath: unknown,
  pathOptions: VaultPathValidationOptionsV1 = {},
): string {
  const validatedPolicy = validateSidecarStoragePolicyV1(policy, pathOptions);
  const markdownPath = normalizeVaultRelativePath(vaultRelativeMarkdownPath, {
    ...pathOptions,
    name: "Markdown path",
    requiredSuffix: MARKDOWN_SUFFIX,
  });
  const sidecarName = `${markdownPath.slice(0, -MARKDOWN_SUFFIX.length)}${SIDECAR_SUFFIX}`;
  const candidate =
    validatedPolicy.mode === "adjacent"
      ? sidecarName
      : `${validatedPolicy.vaultRelativeRoot}/${sidecarName}`;
  return normalizeVaultRelativePath(candidate, {
    ...pathOptions,
    name: "Sidecar path",
    requiredSuffix: SIDECAR_SUFFIX,
  });
}

function policyEqual(
  left: SidecarStoragePolicyV1,
  right: SidecarStoragePolicyV1,
): boolean {
  return (
    left.mode === right.mode &&
    (left.mode === "adjacent" ||
      (right.mode !== "adjacent" &&
        left.vaultRelativeRoot === right.vaultRelativeRoot))
  );
}

function state(
  acknowledged: SidecarStoragePolicySnapshotV1,
  sessionOnly: SidecarStoragePolicySnapshotV1 | null,
  loadStatus: SidecarStoragePolicyStateV1["loadStatus"],
  writeStatus: SidecarStoragePolicyStateV1["writeStatus"],
): SidecarStoragePolicyStateV1 {
  return Object.freeze({
    acknowledged,
    sessionOnly,
    loadStatus,
    writeStatus,
    creationBlocked:
      writeStatus !== "ready" || loadStatus === "read-only-newer-version",
  });
}

export class SidecarStoragePolicyStoreV1 {
  #port: SaveDataPortV1;
  #pathOptions: VaultPathValidationOptionsV1;
  #state: SidecarStoragePolicyStateV1;
  #writeChain: Promise<void> = Promise.resolve();

  public constructor(
    port: SaveDataPortV1,
    loaded: SidecarStoragePolicyLoadResultV1 = Object.freeze({
      snapshot: defaultSnapshot(),
      status: "loaded",
    }),
    pathOptions: VaultPathValidationOptionsV1 = {},
  ) {
    this.#port = port;
    this.#pathOptions = pathOptions;
    this.#state = state(
      loaded.snapshot,
      null,
      loaded.status,
      loaded.status === "read-only-newer-version"
        ? "blocked-newer-version"
        : "ready",
    );
  }

  public static async load(
    port: PluginDataPortV1,
    pathOptions: VaultPathValidationOptionsV1 = {},
  ): Promise<SidecarStoragePolicyStoreV1> {
    const loaded = await loadSidecarStoragePolicyV1(port, pathOptions);
    return new SidecarStoragePolicyStoreV1(port, loaded, pathOptions);
  }

  public get state(): SidecarStoragePolicyStateV1 {
    return this.#state;
  }

  public get snapshot(): SidecarStoragePolicySnapshotV1 {
    return this.#state.acknowledged;
  }

  public get canCreateSidecar(): boolean {
    return !this.#state.creationBlocked;
  }

  public setPolicy(
    policy: unknown,
    expectedRevision: number = this.#state.acknowledged.revision,
  ): Promise<SidecarStoragePolicyWriteResultV1> {
    return this.#enqueue(() => this.#setPolicy(policy, expectedRevision));
  }

  public retry(): Promise<SidecarStoragePolicyWriteResultV1> {
    return this.#enqueue(() => this.#retry());
  }

  #enqueue(
    operation: () => Promise<SidecarStoragePolicyWriteResultV1>,
  ): Promise<SidecarStoragePolicyWriteResultV1> {
    const result = this.#writeChain.then(operation, operation);
    this.#writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #setPolicy(
    value: unknown,
    expectedRevision: number,
  ): Promise<SidecarStoragePolicyWriteResultV1> {
    if (this.#state.loadStatus === "read-only-newer-version") {
      return this.#result("blocked-newer-version");
    }
    if (this.#state.sessionOnly !== null) {
      return this.#result("retry-required");
    }
    if (expectedRevision !== this.#state.acknowledged.revision) {
      return this.#result("stale-revision");
    }
    if (this.#state.acknowledged.revision >= Number.MAX_SAFE_INTEGER) {
      return this.#result("revision-exhausted");
    }
    let policy: SidecarStoragePolicyV1;
    try {
      policy = validateSidecarStoragePolicyV1(value, this.#pathOptions);
    } catch {
      return this.#result("invalid-policy");
    }
    if (policyEqual(policy, this.#state.acknowledged.policy)) {
      return this.#result("acknowledged");
    }
    const replacement = snapshot(
      policy,
      this.#state.acknowledged.revision + 1,
      this.#pathOptions,
    );
    return this.#persist(replacement);
  }

  async #retry(): Promise<SidecarStoragePolicyWriteResultV1> {
    if (this.#state.loadStatus === "read-only-newer-version") {
      return this.#result("blocked-newer-version");
    }
    const replacement = this.#state.sessionOnly;
    if (replacement === null) return this.#result("acknowledged");
    return this.#persist(replacement);
  }

  async #persist(
    replacement: SidecarStoragePolicySnapshotV1,
  ): Promise<SidecarStoragePolicyWriteResultV1> {
    this.#state = state(
      this.#state.acknowledged,
      replacement,
      this.#state.loadStatus,
      "saving",
    );
    try {
      await this.#port.saveData(
        serializeSidecarStoragePolicyV1(replacement, this.#pathOptions),
      );
    } catch {
      this.#state = state(
        this.#state.acknowledged,
        replacement,
        this.#state.loadStatus,
        "retry-required",
      );
      return this.#result("retry-required");
    }
    this.#state = state(replacement, null, this.#state.loadStatus, "ready");
    return this.#result("acknowledged");
  }

  #result(
    status: SidecarStoragePolicyWriteResultV1["status"],
  ): SidecarStoragePolicyWriteResultV1 {
    return Object.freeze({ status, state: this.#state });
  }
}

export async function createSidecarStoragePolicyStore(
  port: PluginDataPortV1,
  pathOptions: VaultPathValidationOptionsV1 = {},
): Promise<SidecarStoragePolicyStoreV1> {
  return SidecarStoragePolicyStoreV1.load(port, pathOptions);
}
