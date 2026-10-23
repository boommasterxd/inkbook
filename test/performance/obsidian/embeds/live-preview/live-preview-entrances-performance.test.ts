import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { LivePreviewEntrances } from "../../../../../src/obsidian/embeds/live-preview/live-preview-entrances";
import { MARKDOWN_EMBED_LIMITS } from "../../../../../src/obsidian/embeds/markdown-embed";

const capacity = MARKDOWN_EMBED_LIMITS.matches;
const spacing = 40;
const tokenLength = 30;
const documentLength = (capacity + 1) * spacing;
const sourcePath = "note.md";
const documentId = "handwriting.svg";

function retainedEntrances() {
  const entrances = new LivePreviewEntrances(sourcePath);
  const tokens = Array.from({ length: capacity }, (_, index) => {
    const from = (index + 1) * spacing;
    const token = entrances.stateFor(from, from + tokenLength, documentId);
    token.presented = index % 2 === 0;
    if (!token.presented) token.initialHeight = 48;
    return token;
  });
  return { entrances, tokens };
}

describe("Live Preview retained entrance performance", () => {
  it("maps a leading text insertion and retains ready and pending occurrences with bounded work", () => {
    const { entrances, tokens } = retainedEntrances();
    const changes = ChangeSet.of({ from: 0, insert: "x" }, documentLength);

    let mismatches = 0;
    for (let sample = 0; sample < 2; sample += 1) {
      const mapped = entrances.update(changes, sourcePath);
      for (let index = 0; index < capacity; index += 1) {
        const from = (index + 1) * spacing + 1;
        if (mapped.stateFor(from, from + tokenLength, documentId) !== tokens[index])
          mismatches += 1;
      }
    }
    expect(mismatches).toBe(0);
  });

  it("releases the full removed range with bounded work and makes capacity reusable", () => {
    const { entrances, tokens } = retainedEntrances();
    const changes = ChangeSet.of({ from: 0, to: documentLength }, documentLength);

    let cleared = entrances;
    for (let sample = 0; sample < 2; sample += 1) {
      cleared = entrances.update(changes, sourcePath);
    }
    for (let index = 0; index < capacity; index += 1) {
      const from = (index + 1) * spacing;
      const fresh = cleared.stateFor(from, from + tokenLength, documentId);
      expect(fresh).not.toBe(tokens[index]);
      expect(fresh.presented).toBe(false);
      expect(cleared.stateFor(from, from + tokenLength, documentId)).toBe(fresh);
    }
  });
});
