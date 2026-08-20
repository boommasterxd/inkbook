import type { Sha256Digest, SourceGeneration } from "../note-session";
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
