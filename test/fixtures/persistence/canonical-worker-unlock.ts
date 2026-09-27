import type { InkSnapshotV1 } from "../../../src/domain/schema/public";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import type { ExecutorIdentity } from "../../../src/persistence/worker/protocol";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";

export async function unlockCanonicalSnapshot(
  runtime: DocumentWorkerRuntime,
  snapshot: InkSnapshotV1,
  identity: ExecutorIdentity,
): Promise<void> {
  const serialized = serializeInkbookDocument(snapshot);
  if (!serialized.ok) throw new Error(serialized.error.code);
  const result = await runtime.execute({
    identity: { ...identity, operationId: 1, purpose: "unlock" },
    input: serialized.value.svg,
    type: "unlock",
  });
  if (result.type !== "unlock-success") throw new Error("Canonical unlock failed.");
}
