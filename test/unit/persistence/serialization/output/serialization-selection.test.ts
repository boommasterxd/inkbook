import { expect, it } from "vitest";
import {
  prepareSerializationRanks,
  serializationSelectionSteps,
} from "../../../../../src/persistence/serialization/output/serialization-selection";
import { completeSerializationSteps } from "../../../../../src/persistence/serialization/output/serialization-model-preparation";
import { highlighter, rectangle, IDS } from "../../../domain/store/fixtures";

it("orders selected records by stable bands and ranks while deduplicating IDs", () => {
  const highlight = highlighter();
  const first = rectangle();
  const second = rectangle(IDS.other);
  const elements = new Map([highlight, first, second].map((element) => [element.id, element]));
  const ranks = completeSerializationSteps(
    prepareSerializationRanks({ highlight: [highlight.id], content: [first.id, second.id] }, 1),
  );
  expect(
    completeSerializationSteps(
      serializationSelectionSteps(elements, ranks, [second.id, highlight.id, first.id, second.id]),
    ),
  ).toEqual([highlight, first, second]);
  expect(completeSerializationSteps(serializationSelectionSteps(elements, ranks, []))).toEqual([]);
  expect(
    completeSerializationSteps(serializationSelectionSteps(elements, ranks, ["unknown"])),
  ).toBeNull();
  ranks.content.delete(first.id);
  expect(
    completeSerializationSteps(serializationSelectionSteps(elements, ranks, [first.id])),
  ).toBeNull();
});
