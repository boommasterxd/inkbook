import { afterEach, describe, expect, it, vi } from "vitest";
import { ElementStore } from "../../../../src/domain/store/public";
import { DocumentCapacity } from "../../../../src/domain/store/records/document-capacity";
import { textElementPayloadBytes } from "../../../../src/domain/schema/text-payload-size";
import type { InkElementV1, TextElementV2 } from "../../../../src/domain/schema/public";
import type { ImmutableInkElement } from "../../../../src/domain/store/types";
import { textElement } from "../schema/fixtures";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };
afterEach(() => vi.restoreAllMocks());

async function replace(store: ElementStore, elements: readonly ImmutableInkElement[]) {
  const prepared = await store.prepareElementReplacement(elements as InkElementV1[], scheduler);
  if (prepared.token === null) throw new Error("Expected prepared text replacement.");
  const result = store.commitPreparedElementReplacement(prepared.token);
  if (result.history === null) throw new Error("Expected replacement history.");
  return result.history;
}

function editedFields(source: TextElementV2): TextElementV2[] {
  const changedSource = { ...source, source: "Hello latest source" };
  const ranged = {
    ...changedSource,
    ranges: [{ start: 0, end: 5, style: { bold: true } }],
    paragraphs: [{ start: 0, alignment: "center" as const }],
  };
  const relaid = {
    ...ranged,
    layout: {
      version: 1 as const,
      lines: [
        {
          x: 0,
          y: 0,
          width: 100,
          height: 20,
          baseline: 15,
          runs: [{ text: ranged.source, start: 0, end: ranged.source.length, x: 0, width: 100 }],
        },
      ],
    },
  };
  return [
    changedSource,
    ranged,
    relaid,
    {
      ...relaid,
      style: { ...relaid.style, fontFamily: "custom-portable-font" },
    },
  ];
}

describe("prepared text replacement capacity", () => {
  it("tracks repeated source, range, paragraph, layout and font edits through undo and removal", async () => {
    const commits = vi.spyOn(DocumentCapacity.prototype, "commit");
    const initial = textElement();
    const store = new ElementStore([initial]);
    const assertCapacity = () => {
      const current = store.get(initial.id)?.element;
      const expected = current?.kind === "text" ? textElementPayloadBytes(current) : 0;
      expect(commits.mock.lastCall?.[0].totals.textPayloadBytes).toBe(expected);
    };
    const edits = [];
    for (const edited of editedFields(initial)) {
      edits.push(await replace(store, [edited]));
      assertCapacity();
    }
    for (const edit of [...edits].reverse()) {
      await replace(store, edit.previous);
      assertCapacity();
    }
    expect(store.get(initial.id)!.element).toEqual(initial);
    for (const edit of edits) {
      await replace(store, edit.replacements);
      assertCapacity();
    }
    const beforeRemoval = store.get(initial.id)!.element;
    const prepared = await store.prepareElementRemoval(new Set([initial.id]), scheduler);
    if (prepared.token === null) throw new Error("Expected prepared removal.");
    const removed = store.commitPreparedElementMutation(prepared.token).transition;
    if (removed === null) throw new Error("Expected removal history.");
    expect(store.size).toBe(0);
    assertCapacity();
    for (const direction of ["reverse", "forward"] as const) {
      const replay = await store.prepareHistoryReplay(removed[direction], scheduler, removed);
      if (replay.token === null) throw new Error("Expected prepared history replay.");
      store.commitPreparedElementMutation(replay.token);
      expect(store.get(initial.id)?.element).toEqual(
        direction === "reverse" ? beforeRemoval : undefined,
      );
      assertCapacity();
    }
    store.create(initial);
    assertCapacity();
  });
});
