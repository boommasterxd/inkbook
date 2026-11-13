import type { RenderBand } from "../../commands/render-bands";
import type { ElementRecord, MaterializedSnapshot, SnapshotMaterialization } from "../types";
import { mutableElement } from "./immutability";

export function materializeStoreSnapshot(
  bands: Readonly<Record<RenderBand, readonly string[]>>,
  records: ReadonlyMap<string, ElementRecord>,
  input: SnapshotMaterialization,
): MaterializedSnapshot {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new RangeError("Snapshot revision must be a non-negative safe integer.");
  }
  let version: 1 | 2 = input.version === 2 || input.fontResources !== undefined ? 2 : 1;
  const elements = ["highlight", "content"].flatMap((band) =>
    bands[band as RenderBand].map((id) => {
      const record = records.get(id);
      if (record === undefined) throw new Error(`Missing record for band element: ${id}`);
      if (record.element.kind === "text") version = 2;
      return mutableElement(record.element);
    }),
  );
  return {
    elements,
    format: "inkbook",
    page: { ...input.page, background: { ...input.page.background } },
    revision: input.revision,
    version,
    ...(input.fontResources === undefined
      ? {}
      : {
          fontResources: input.fontResources.map((resource) => ({
            ...resource,
            ...(resource.weightRange === undefined
              ? {}
              : { weightRange: [...resource.weightRange] as [number, number] }),
          })),
        }),
  };
}
