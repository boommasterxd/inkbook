import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { LivePreviewEntrances } from "../../../../src/obsidian/embeds/live-preview-entrances";
import { MARKDOWN_EMBED_LIMITS } from "../../../../src/obsidian/embeds/markdown-embed";

describe("Live Preview occurrence entrance state", () => {
  it("retains presentation state across edits before, after, and at occurrence boundaries", () => {
    let entrances = new LivePreviewEntrances("note.md");
    const token = entrances.stateFor(10, 20, "drawing.svg");
    token.presented = true;
    entrances = entrances.update(
      ChangeSet.of(
        [
          { from: 10, insert: "abc" },
          { from: 20, insert: "z" },
        ],
        30,
      ),
      "note.md",
    );
    expect(entrances.stateFor(13, 23, "drawing.svg")).toBe(token);
    entrances = entrances.update(ChangeSet.of({ from: 0, to: 3 }, 34), "note.md");
    expect(entrances.stateFor(10, 20, "drawing.svg").presented).toBe(true);
  });

  it("keeps duplicate file references independent and replacement occurrences fresh", () => {
    const entrances = new LivePreviewEntrances("note.md");
    const first = entrances.stateFor(0, 10, "drawing.svg");
    const second = entrances.stateFor(20, 30, "drawing.svg");
    first.presented = true;
    expect(second).not.toBe(first);
    expect(second.presented).toBe(false);
    const changed = entrances.update(
      ChangeSet.of({ from: 0, to: 10, insert: "replacement" }, 30),
      "note.md",
    );
    expect(changed.stateFor(0, 11, "drawing.svg")).not.toBe(first);
    expect(changed.stateFor(21, 31, "drawing.svg")).toBe(second);
  });

  it("retains unchanged remounts but resets changed source notes and edited embed markup", () => {
    const entrances = new LivePreviewEntrances("note.md");
    const token = entrances.stateFor(0, 10, "drawing.svg");
    token.presented = true;
    expect(entrances.update(ChangeSet.empty(10), "note.md").stateFor(0, 10, "drawing.svg")).toBe(
      token,
    );
    expect(
      entrances.update(ChangeSet.empty(10), "other.md").stateFor(0, 10, "drawing.svg").presented,
    ).toBe(false);
    expect(
      entrances
        .update(ChangeSet.of({ from: 5, insert: "x" }, 10), "note.md")
        .stateFor(0, 11, "drawing.svg").presented,
    ).toBe(false);
    expect(entrances.stateFor(0, 10, "other.svg")).not.toBe(token);
  });

  it("bounds retained tokens and frees deleted occurrence capacity", () => {
    let entrances = new LivePreviewEntrances("note.md");
    const limit = MARKDOWN_EMBED_LIMITS.matches;
    for (let index = 0; index < limit; index += 1)
      entrances.stateFor(index * 2, index * 2 + 1, "drawing.svg");
    const beyondCapacity = entrances.stateFor(limit * 2, limit * 2 + 1, "drawing.svg");
    expect(beyondCapacity.presented).toBe(true);
    expect(entrances.stateFor(limit * 2, limit * 2 + 1, "drawing.svg")).not.toBe(beyondCapacity);
    entrances = entrances.update(ChangeSet.of({ from: 0, to: 1 }, limit * 2 + 1), "note.md");
    const replacement = entrances.stateFor(limit * 2 - 1, limit * 2, "drawing.svg");
    expect(entrances.stateFor(limit * 2 - 1, limit * 2, "drawing.svg")).toBe(replacement);
  });
});
