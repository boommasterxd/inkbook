import type {
  NoteSessionV1,
  Sha256Digest,
  SourceGeneration,
} from "../../application/note-session";
import type { SidecarBaseIdentityV1 } from "../../application/recovery";
import type { SourceCheckpointOperationV1 } from "../../application/source-coordination";
import {
  RuntimePersistenceSourceV1,
  type RuntimePersistenceSourceOptionsV1,
} from "./runtime-persistence-source";
import type { RuntimePersistenceConfigV1 } from "./runtime-session";

function createRuntimePersistenceSourceV1(input: {
  readonly config: RuntimePersistenceConfigV1;
  readonly digest: Sha256Digest;
  readonly generation: SourceGeneration;
  readonly onDurable: (checkpoint: SourceCheckpointOperationV1) => void;
  readonly readBase: () => SidecarBaseIdentityV1;
  readonly session: NoteSessionV1;
}): Promise<RuntimePersistenceSourceV1 | null> {
  const options: RuntimePersistenceSourceOptionsV1 = {
    digest: input.digest,
    generation: input.generation,
    initialMarkdown: input.config.initialMarkdown,
    nextSessionOrder: input.config.nextSessionOrder,
    onDurable: input.onDurable,
    readBase: input.readBase,
    recovery: input.config.recovery,
    session: input.session,
    sourceDigestWorkPort: input.config.sourceDigestWorkPort,
    sourceMapWorkPort: input.config.sourceMapWorkPort,
  };
  return RuntimePersistenceSourceV1.create(options);
}

export async function bindRuntimePersistenceSourceV1(input: {
  readonly config: RuntimePersistenceConfigV1;
  readonly digest: Sha256Digest;
  readonly drainEarly: (source: RuntimePersistenceSourceV1) => void;
  readonly generation: SourceGeneration;
  readonly onDurable: (checkpoint: SourceCheckpointOperationV1) => void;
  readonly readBase: () => SidecarBaseIdentityV1;
  readonly session: NoteSessionV1;
  readonly bindViews: (source: RuntimePersistenceSourceV1) => void;
}): Promise<RuntimePersistenceSourceV1 | null> {
  const source = await createRuntimePersistenceSourceV1(input);
  if (source === null) return null;
  input.config.history.bindSourceMaterialization?.(
    () => source.currentSourceNode,
  );
  input.bindViews(source);
  input.drainEarly(source);
  return source;
}
