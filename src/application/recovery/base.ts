import type { Sha256Digest, SidecarRevision } from "../note-session/types";

export interface SidecarBaseIdentityV1 {
  readonly vaultRelativePath: string;
  readonly revision: SidecarRevision | null;
  readonly rawTextSha256: Sha256Digest | null;
  readonly markdownPath: string;
}
