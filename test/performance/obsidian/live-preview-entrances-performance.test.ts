import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { expectTiming } from "../timing-assertions";
import { LivePreviewEntrances } from "../../../src/obsidian/embeds/live-preview-entrances";
import { MARKDOWN_EMBED_LIMITS } from "../../../src/obsidian/embeds/markdown-embed";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

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
  it("maps a leading text insertion and retains ready and pending occurrences within the frame budget", async ({
    annotate,
  }) => {
    const { entrances, tokens } = retainedEntrances();
    const changes = ChangeSet.of({ from: 0, insert: "x" }, documentLength);
    const durations: number[] = [];
    let mismatches = 0;
    for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
      const started = performance.now();
      const mapped = entrances.update(changes, sourcePath);
      for (let index = 0; index < capacity; index += 1) {
        const from = (index + 1) * spacing + 1;
        if (mapped.stateFor(from, from + tokenLength, documentId) !== tokens[index])
          mismatches += 1;
      }
      if (sample >= 0) durations.push(performance.now() - started);
    }
    expect(mismatches).toBe(0);
    const p99 = interactionP99(durations);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(
      `Leading insertion with ${String(capacity)} retained entrances p99=${p99.toFixed(3)} ms`,
      "performance",
    );
  });

  it("releases the full removed range within the frame budget and makes capacity reusable", async ({
    annotate,
  }) => {
    const { entrances, tokens } = retainedEntrances();
    const changes = ChangeSet.of({ from: 0, to: documentLength }, documentLength);
    const durations: number[] = [];
    let cleared = entrances;
    for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
      const started = performance.now();
      cleared = entrances.update(changes, sourcePath);
      if (sample >= 0) durations.push(performance.now() - started);
    }
    for (let index = 0; index < capacity; index += 1) {
      const from = (index + 1) * spacing;
      const fresh = cleared.stateFor(from, from + tokenLength, documentId);
      expect(fresh).not.toBe(tokens[index]);
      expect(fresh.presented).toBe(false);
      expect(cleared.stateFor(from, from + tokenLength, documentId)).toBe(fresh);
    }
    const p99 = interactionP99(durations);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(
      `Full removal of ${String(capacity)} retained entrances p99=${p99.toFixed(3)} ms`,
      "performance",
    );
  });
});
