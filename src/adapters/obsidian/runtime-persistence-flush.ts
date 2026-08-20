import type {
  NoteSessionTurnResultV1,
  NoteSessionV1,
} from "../../application/note-session";
import type { SavePipelineResultV1 } from "../../application/persistence";

export async function flushRuntimePersistenceV1(options: {
  readonly forceSave: () => void;
  readonly forceSource: () => Promise<boolean>;
  readonly readSave: () => Promise<SavePipelineResultV1> | null;
  readonly session: NoteSessionV1 | null;
  readonly setFlushing: (flushing: boolean) => void;
}): Promise<"failed" | "flushed"> {
  if (!(await options.forceSource())) return "failed";
  options.setFlushing(true);
  try {
    const queued: NoteSessionTurnResultV1 | undefined =
      await options.session?.enqueue({
        kind: "persistence",
        retainedBytes: 0,
        run: (): void => undefined,
      });
    if (queued?.kind === "failed" || queued?.kind === "rejected") {
      return "failed";
    }
    options.forceSave();
    const result = await options.readSave();
    return result === null || result.kind === "acknowledged"
      ? "flushed"
      : "failed";
  } finally {
    options.setFlushing(false);
  }
}
