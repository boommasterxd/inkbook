import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

export interface InkImportFile {
  readonly path: string;
  readonly size: number;
}

export interface InkImportPorts {
  readonly workScheduler: WorkScheduler;
  listFiles(): readonly InkImportFile[];
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  compareAndWrite(path: string, expected: string, content: string): Promise<boolean>;
  trash(path: string, expected: string): Promise<boolean>;
  resolveLink(link: string, notePath: string): string | undefined;
  generateEmbed(targetPath: string, notePath: string, description?: string): string;
  referenceState(
    path: string,
    signal?: AbortSignal,
  ): Promise<"referenced" | "unreferenced" | "unknown">;
  hash(content: string): Promise<string>;
  convert(
    content: string,
    options: {
      readonly signal?: AbortSignal;
      readonly legacyWriting: boolean;
    },
  ): Promise<{ readonly svg: string; readonly warnings: readonly string[] }>;
  createRunId(): string;
  now(): string;
}

export interface InkImportReference {
  readonly notePath: string;
  readonly start: number;
  readonly original: string;
  readonly sourcePath: string;
  readonly description?: string;
}

export interface InkImportSource {
  readonly path: string;
  readonly hash: string;
  readonly targetPath: string;
  readonly legacyWriting: boolean;
  readonly references: readonly InkImportReference[];
  readonly warnings: readonly string[];
}

export interface InkImportPreview {
  readonly id: string;
  readonly sources: readonly InkImportSource[];
  readonly notes: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
  readonly scanFindings?: readonly InkImportScanFinding[];
  readonly truncated: boolean;
}

export interface InkImportScanFinding {
  readonly original: string;
  readonly message: string;
  readonly sources: readonly string[];
  readonly notes: readonly string[];
}

export interface InkImportPatch {
  readonly sourcePath: string;
  readonly start: number;
  readonly before: string;
  readonly after: string;
  readonly prefix: string;
  readonly suffix: string;
  status: "pending" | "applied" | "undone" | "conflict";
}

export interface InkImportNoteRecord {
  readonly path: string;
  readonly backupPath: string;
  readonly originalHash: string;
  readonly importedHash: string;
  readonly patches: InkImportPatch[];
  status: "intent" | "applied" | "undone" | "conflict";
  undoIntent?: {
    readonly expectedHash: string;
    readonly resultHash: string;
    readonly patchIndexes: readonly number[];
  };
}

export interface InkImportSourceRecord {
  readonly path: string;
  readonly backupPath: string;
  readonly hash: string;
  readonly targetPath: string;
  readonly outputHash: string;
  readonly warnings: readonly string[];
  status: "intent" | "created" | "conflict" | "cleaned";
  cleanupIntent?: boolean;
}

export interface InkImportJournal {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  status: "running" | "complete" | "cancelled" | "undone" | "conflict";
  readonly sources: InkImportSourceRecord[];
  readonly notes: InkImportNoteRecord[];
  readonly issues: string[];
  readonly unreadable?: true;
}

export interface InkImportResult {
  readonly journal: InkImportJournal;
  readonly imported: number;
  readonly conflicts: number;
  readonly cancelled: boolean;
}

export const INK_IMPORT_FOLDER = "inkbook-imports";
