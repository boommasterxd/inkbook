import {
  commandFailure,
  commandSuccess,
  type CommandResultV1,
  type NoteIdentityV1,
  type NoteSessionV1,
} from "../../application/note-session";
import type { SidecarStorageLayoutV1 } from "../../application/persistence";
import type {
  FileRelocationRecordV1,
  PrefixRelocationMemberV1,
  SidecarBaseIdentityV1,
} from "../../application/recovery";
import type { RuntimePersistenceSourceV1 } from "./runtime-persistence-source";
import type { RuntimeSessionHistoryV1 } from "./runtime-session";
import type { VaultFileCapability } from "./vault-sidecar/paths";
import {
  runtimeRelocationMemberV1,
  settleRuntimeSidecarMoveV1,
  type VaultSidecarRelocator,
} from "./vault-sidecar/relocation";

interface RuntimePersistenceRelocationOptionsV1 {
  readonly createSavePipeline: () => void;
  readonly flush: () => Promise<"failed" | "flushed">;
  readonly history: Pick<RuntimeSessionHistoryV1, "updatePersistenceContext">;
  readonly markDirty: () => void;
  readonly normalizePath: (path: string) => string;
  readonly readBase: () => SidecarBaseIdentityV1 | null;
  readonly readFile: () => VaultFileCapability | null;
  readonly readIdentity: () => NoteIdentityV1;
  readonly readLayout: () => SidecarStorageLayoutV1 | null;
  readonly readPipelineAvailable: () => boolean;
  readonly readSession: () => NoteSessionV1 | null;
  readonly readSource: () => RuntimePersistenceSourceV1 | null;
  readonly setBase: (base: SidecarBaseIdentityV1) => void;
  readonly setFile: (file: VaultFileCapability) => void;
  readonly setIdentity: (identity: NoteIdentityV1) => void;
}

export class RuntimePersistenceRelocationV1 {
  #active: FileRelocationRecordV1 | null = null;

  public constructor(
    private readonly options: RuntimePersistenceRelocationOptionsV1,
  ) {}

  public get active(): FileRelocationRecordV1 | null {
    return this.#active;
  }

  public member(
    replacement: NoteIdentityV1,
    ordinal: number,
    layout: SidecarStorageLayoutV1 | null = this.options.readLayout(),
  ): PrefixRelocationMemberV1 | null {
    const base = this.options.readBase();
    const session = this.options.readSession();
    if (base === null || session === null) return null;
    return runtimeRelocationMemberV1({
      base,
      identity: this.options.readIdentity(),
      layout,
      normalizePath: this.options.normalizePath,
      ordinal,
      replacement,
      sceneRevision: session.snapshot.scene.revision,
    });
  }

  public settleAndMove(
    record: FileRelocationRecordV1,
    relocator: VaultSidecarRelocator,
  ): Promise<CommandResultV1<void>> {
    return settleRuntimeSidecarMoveV1({
      file: this.options.readFile(),
      flush: this.options.flush,
      record,
      relocator,
      updateFile: this.options.setFile,
    });
  }

  public setActive(record: FileRelocationRecordV1 | null): void {
    this.#active = record;
  }

  public rekey(record: FileRelocationRecordV1): void {
    this.options.setIdentity(record.noteIdentity);
    if (this.options.readBase() !== null)
      this.options.setBase(record.sidecarBase);
    const source = this.options.readSource()?.durableSource;
    if (source !== undefined) {
      this.options.history.updatePersistenceContext(
        record.sidecarBase,
        source.generation,
        source.digest,
      );
    }
    if (record.sidecarBase.revision !== null) this.options.createSavePipeline();
  }

  public async saveMetadata(): Promise<CommandResultV1<void>> {
    if (!this.options.readPipelineAvailable()) return commandSuccess(undefined);
    this.options.markDirty();
    return (await this.options.flush()) === "flushed"
      ? commandSuccess(undefined)
      : commandFailure("relocation-pending");
  }

  public async awaitCheckpoint(): Promise<CommandResultV1<void>> {
    const forced = await this.options.readSource()?.force();
    return forced === undefined || forced
      ? commandSuccess(undefined)
      : commandFailure("recovery-unavailable");
  }
}
