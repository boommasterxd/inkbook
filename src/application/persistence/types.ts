import type {
  SettingsRevision,
  Sha256Digest,
  SourceGeneration,
} from "../note-session";
import type { SceneElementV1 } from "../../domain/model";
import type { SerializedSceneStateV1 } from "../../domain/scene";

export interface SidecarSchemaVersionV1 {
  readonly major: 1;
  readonly minor: 0;
}

export interface SidecarNoteIdentityV1 {
  readonly vaultRelativeMarkdownPath: string;
  readonly markdownContentDigest: Sha256Digest;
  readonly sourceGeneration: SourceGeneration;
}

export type SidecarStorageLayoutV1 =
  | { readonly kind: "adjacent" }
  | {
      readonly kind: "vault-root";
      readonly vaultRelativeRoot: string;
    };

/**
 * The plugin-global default for sidecars created after policy acknowledgement.
 *
 * This policy is intentionally separate from `SidecarStorageLayoutV1`, which
 * records the layout already selected by an individual sidecar.
 */
export type SidecarStoragePolicyV1 =
  | { readonly version: 1; readonly mode: "adjacent" }
  | {
      readonly version: 1;
      readonly mode: "vault-root";
      readonly vaultRelativeRoot: string;
    };

export interface SidecarStoragePolicySnapshotV1 {
  readonly version: 1;
  readonly revision: SettingsRevision;
  readonly policy: SidecarStoragePolicyV1;
}

type SidecarStoragePolicyLoadStatusV1 =
  "loaded" | "defaulted-invalid" | "read-only-newer-version";

export interface SidecarStoragePolicyLoadResultV1 {
  readonly snapshot: SidecarStoragePolicySnapshotV1;
  readonly status: SidecarStoragePolicyLoadStatusV1;
}

type SidecarStoragePolicyWriteStatusV1 =
  | "acknowledged"
  | "retry-required"
  | "blocked-newer-version"
  | "stale-revision"
  | "revision-exhausted"
  | "invalid-policy";

export interface SidecarStoragePolicyStateV1 {
  readonly acknowledged: SidecarStoragePolicySnapshotV1;
  readonly sessionOnly: SidecarStoragePolicySnapshotV1 | null;
  readonly loadStatus: SidecarStoragePolicyLoadStatusV1;
  readonly writeStatus:
    "ready" | "saving" | "retry-required" | "blocked-newer-version";
  readonly creationBlocked: boolean;
}

export interface SidecarStoragePolicyWriteResultV1 {
  readonly status: SidecarStoragePolicyWriteStatusV1;
  readonly state: SidecarStoragePolicyStateV1;
}

/** The smallest host capability needed to make a policy durable. */
export interface SaveDataPortV1 {
  readonly saveData: (value: unknown) => Promise<void>;
}

/** The smallest host capability needed to load an untrusted policy value. */
export interface LoadDataPortV1 {
  readonly loadData: () => Promise<unknown>;
}

export interface PluginDataPortV1 extends SaveDataPortV1, LoadDataPortV1 {}

export type SidecarWritableTierV1 = "phone" | "desktop-tablet";

export interface InkbookSidecarV1 {
  readonly format: "inkbook-obsidian-annotations";
  readonly schemaVersion: SidecarSchemaVersionV1;
  readonly noteIdentity: SidecarNoteIdentityV1;
  readonly storageLayout: SidecarStorageLayoutV1;
  readonly revision: number;
  readonly baseRevision: number | null;
  readonly savedAtEpochMs: number;
  readonly scene: SerializedSceneStateV1;
}

export interface PreparedCanonicalSidecarV1 {
  readonly sidecarWithoutElements: InkbookSidecarV1;
  readonly elements: readonly SceneElementV1[];
}

export interface FutureSidecarVersionV1 {
  readonly major: number;
  readonly minor: number;
}

export type SidecarDecodeResultV1 =
  | {
      readonly kind: "current";
      readonly sidecar: InkbookSidecarV1;
    }
  | {
      readonly kind: "read-only-newer-version";
      readonly schemaVersion: FutureSidecarVersionV1;
    };
