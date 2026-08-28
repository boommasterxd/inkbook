import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = readStylesheet();

describe("Inkbook feedback motion styles", () => {
  it("uses the toolbar scale motion in both presence directions", () => {
    expect(stylesheet).toContain(`.inkbook-root .inkbook-feedback {
  animation: inkbook-toolbar-context-control-enter var(--inkbook-motion-toolbar) ease-out both;`);
    expect(stylesheet)
      .toContain(`.inkbook-root .inkbook-feedback[data-inkbook-feedback-presence="exiting"] {
  animation: inkbook-toolbar-context-control-exit var(--inkbook-motion-toolbar) ease-in both;
  pointer-events: none;`);
  });
});

function readStylesheet(): string {
  const content = sys.readFile(sys.resolvePath("src/obsidian/styles/feedback.css"));
  if (content === undefined) throw new Error("Unable to read the feedback stylesheet.");
  return content;
}
