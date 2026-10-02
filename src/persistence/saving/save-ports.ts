export interface FileReadIdentity {
  readonly ctime: number;
  readonly mtime: number;
  readonly path: string;
  readonly size: number;
}

export interface MetadataGuardedFileRead {
  readonly content: string;
  readonly identity: FileReadIdentity;
  /** The public host API materializes the complete value before post-read checks can run. */
  readonly materialization: "host-full-read-not-bounded";
  /** This evidence detects ordinary races but cannot prove an atomic content snapshot. */
  readonly stabilityEvidence: "object-identity-and-stat-unchanged";
  /** A transient host proof invalidated by any later file modification or replacement. */
  readonly isCurrent?: () => boolean;
}

export interface ExistingFilePort {
  /** Defers exact UTF-8 measurement to the owned persisted-output verifier. */
  readForVerification?(path: string, maximumBytes: number): Promise<MetadataGuardedFileRead>;
  readWithMetadataGuard(path: string, maximumBytes: number): Promise<MetadataGuardedFileRead>;
  process(path: string, update: (current: string) => string): Promise<string>;
}

export interface NewFilePort {
  createAndReadBackForVerification?(
    path: string,
    content: string,
    maximumBytes: number,
  ): Promise<MetadataGuardedFileRead>;
  create(path: string, content: string): Promise<void>;
  createAndReadBack(
    path: string,
    content: string,
    maximumBytes: number,
  ): Promise<MetadataGuardedFileRead>;
}

export interface PersistedOutputVerifier {
  verify(content: string, expectedRevision: number, expectedHash: string): Promise<boolean>;
  /** Confirms complete content and its exact UTF-8 length against the stable host stat. */
  verifyRead?(
    read: MetadataGuardedFileRead,
    expectedRevision: number,
    expectedHash: string,
  ): Promise<boolean>;
}
