import { describe, expect, it } from "vitest";

import {
  findInkCandidates,
  resolveInkReferences,
} from "../../../../src/obsidian/import/references";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

const writing =
  " ![Transcript](<Ink/file.svg>) [Edit Writing](https://local-fork.example/edit?type=inkWriting&aspectRatio=2)";
const legacy = '```handwritten-ink\n{"versionAtEmbed":"0.3.0","filepath":"Ink/old.writing"}\n```';

describe("Obsidian Ink writing reference recognition", () => {
  it("recognizes official legacy fences and fork writing markers without fetching marker URLs", async () => {
    const candidates = await findInkCandidates(`${legacy}\n\n${writing}`, immediateWorkScheduler());
    expect(candidates.map((candidate) => candidate.link)).toEqual([
      "Ink/old.writing",
      "Ink/file.svg",
    ]);
    expect(candidates[1]?.description).toBe("Transcript");
  });

  it.each([
    `---\nexample: |\n${writing}\n---`,
    `<!--\n${writing}\n-->`,
    `~~~~markdown\n${legacy}\n${writing}\n~~~~`,
    `> ${writing}`,
    `- ${writing}`,
    `    ${writing}`,
    writing.replace("inkWriting", "inkDrawing"),
    writing.replace("https:", "http:"),
    "![Ordinary SVG](<Ink/file.svg>)",
    legacy.replace("old.writing", "old.drawing"),
  ])("keeps non-writing or non-standalone markup unchanged", async (note) => {
    expect(await findInkCandidates(note, immediateWorkScheduler())).toEqual([]);
  });

  it("reports unresolved recognized source links", async () => {
    const warnings: string[] = [];
    const refs = await resolveInkReferences({
      note: writing,
      notePath: "note.md",
      resolve: () => undefined,
      scheduler: immediateWorkScheduler(),
      unresolved: (path) => warnings.push(path),
    });
    expect(refs).toEqual([]);
    expect(warnings).toEqual(["Ink/file.svg"]);
  });

  it("uses the central scheduler while streaming large note line sequences", async () => {
    let checkpoints = 0;
    const scheduler = {
      ...immediateWorkScheduler(),
      checkpoint: () => {
        checkpoints += 1;
        return undefined;
      },
    };
    const note = `${"ordinary line\n".repeat(20_000)}${writing}`;
    const candidates = await findInkCandidates(note, scheduler);
    expect(candidates).toHaveLength(1);
    expect(checkpoints).toBe(20_001);
  });

  it("stops cooperative note parsing when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      findInkCandidates(writing, immediateWorkScheduler(), controller.signal),
    ).rejects.toThrow();
  });
});
