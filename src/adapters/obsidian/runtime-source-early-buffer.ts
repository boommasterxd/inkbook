import type {
  NoteSessionV1,
  Sha256Digest,
  ViewId,
} from "../../application/note-session";
import type { EditorSourceTransitionV1 } from "./editor-history/bridge";
import type { RuntimePersistenceSourceV1 } from "./runtime-persistence-source";

const MAX_TRANSITIONS = Number("64");
const MAX_RETAINED_BYTES = Number("2097152");
const UTF16_BYTES_PER_UNIT = Number("2");
const OFFSET_MAP_SPAN_BYTES = Number("32");

interface PendingTransitionV1 {
  readonly transition: EditorSourceTransitionV1;
  readonly viewId: ViewId;
}

export class RuntimeSourceEarlyBufferV1 {
  readonly #onOverflow: () => void;
  readonly #pending: PendingTransitionV1[] = [];
  #retainedBytes = 0;
  #overflowed = false;

  public constructor(onOverflow: () => void) {
    this.#onOverflow = onOverflow;
  }

  public accept(
    viewId: ViewId,
    transition: EditorSourceTransitionV1,
    source: RuntimePersistenceSourceV1 | null,
  ): void {
    if (source !== null) {
      source.accept(viewId, transition);
      return;
    }
    const retainedBytes = transitionBytes(transition);
    if (
      this.#pending.length >= MAX_TRANSITIONS ||
      this.#retainedBytes + retainedBytes > MAX_RETAINED_BYTES
    ) {
      if (!this.#overflowed) {
        this.#overflowed = true;
        this.#onOverflow();
      }
      return;
    }
    this.#pending.push({ transition, viewId });
    this.#retainedBytes += retainedBytes;
  }

  public drain(source: RuntimePersistenceSourceV1): void {
    const pending = this.#pending.splice(0);
    this.#retainedBytes = 0;
    for (const item of pending) source.accept(item.viewId, item.transition);
  }

  public dispose(): void {
    this.#pending.length = 0;
    this.#retainedBytes = 0;
    this.#overflowed = false;
  }
}

export function publishRuntimeSourceReattachmentV1(
  session: NoteSessionV1 | null,
  source: RuntimePersistenceSourceV1 | null,
): void {
  if (session === null) return;
  const sourceState = session.snapshot.source;
  const snapshotDigest = sourceStateDigest(sourceState);
  const targetDigest: Sha256Digest | null =
    source?.durableSource.digest ?? snapshotDigest;
  if (targetDigest === null) return;
  void session.enqueue({
    kind: "lifecycle",
    retainedBytes: 0,
    run: ({ publish, snapshot }) =>
      publish({
        ...snapshot,
        source: { kind: "reattaching", targetDigest },
      }),
  });
}

function sourceStateDigest(
  source: NoteSessionV1["snapshot"]["source"],
): Sha256Digest | null {
  if (source.kind === "durable") return source.digest;
  return source.kind === "reattaching" ? source.targetDigest : null;
}

function transitionBytes(transition: EditorSourceTransitionV1): number {
  return (
    (transition.priorDocument.utf16Length +
      transition.replacementDocument.utf16Length) *
      UTF16_BYTES_PER_UNIT +
    transition.offsetMap.spans.length * OFFSET_MAP_SPAN_BYTES
  );
}
