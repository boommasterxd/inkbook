import { vi } from "vitest";
import * as arrangement from "../../../src/domain/store/mutations/arrangement-mutation";
import type { RenderBand } from "../../../src/domain/commands/render-bands";
import { observeSchemaArray } from "./schema-array-work";

/** Observe authoritative order reads inside the real private arrangement producer. */
export function observeArrangementBandReads(onRead: (band: RenderBand) => void) {
  const prepare = arrangement.prepareArrangementMutation;
  return vi.spyOn(arrangement, "prepareArrangementMutation").mockImplementation((source, ...args) =>
    prepare(
      {
        ...source,
        bands: {
          content: observeSchemaArray(source.bands.content, () => onRead("content")).observed,
          highlight: observeSchemaArray(source.bands.highlight, () => onRead("highlight")).observed,
        },
      },
      ...args,
    ),
  );
}
