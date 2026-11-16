import { RENDER_BANDS } from "../../commands/render-bands";
import type { InkSnapshotV1 } from "../../schema/public";
import { hasMeasuredTextInkBounds } from "../../schema/snapshot-version";
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
  let version: InkSnapshotV1["version"] =
    input.version ?? (input.fontResources === undefined ? 1 : 2);
  if (input.fontResources !== undefined && version < 2) version = 2;
  if (input.imageResources !== undefined && version < 3) version = 3;
  if (input.imageResources !== undefined && input.imageResources.length > 0) version = 5;
  const elements = RENDER_BANDS.flatMap((band) =>
    bands[band].map((id) => {
      const record = records.get(id);
      if (record === undefined) throw new Error(`Missing record for band element: ${id}`);
      if (record.element.kind === "text" && version < 2) version = 2;
      if (record.element.kind === "image" || hasMeasuredTextInkBounds(record.element)) version = 5;
      if (record.element.locked === true && version < 4) version = 4;
      return mutableElement(record.element);
    }),
  );
  return {
    elements,
    format: "inkbook",
    page: { ...input.page, background: { ...input.page.background } },
    revision: input.revision,
    version,
    ...(input.imageResources === undefined
      ? {}
      : { imageResources: input.imageResources.map((resource) => ({ ...resource })) }),
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
