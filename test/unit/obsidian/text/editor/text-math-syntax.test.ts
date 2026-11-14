import { describe, expect, it } from "vitest";
import { textMathSyntaxSteps } from "../../../../../src/obsidian/text/editor/text-math-syntax";

function tokens(source: string) {
  const steps = textMathSyntaxSteps(source, 1, source.length - 1);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

describe("native-style TeX syntax ranges", () => {
  it("classifies variables, scripts, commands, numbers and brackets without consuming plain operators", () => {
    const source = "$x^2+\\frac{1}{2}$";
    expect(tokens(source)).toEqual([
      { start: 1, end: 2, className: "cm-math cm-variable-2" },
      { start: 2, end: 3, className: "cm-math cm-tag" },
      { start: 3, end: 4, className: "cm-math cm-number" },
      { start: 5, end: 10, className: "cm-math cm-tag" },
      { start: 10, end: 11, className: "cm-bracket cm-math" },
      { start: 11, end: 12, className: "cm-math cm-number" },
      { start: 12, end: 13, className: "cm-bracket cm-math" },
      { start: 13, end: 14, className: "cm-bracket cm-math" },
      { start: 14, end: 15, className: "cm-math cm-number" },
      { start: 15, end: 16, className: "cm-bracket cm-math" },
    ]);
  });

  it("keeps escaped percent as a command and stops comments at the next source line", () => {
    const source = "$a\\%b % note 2\nx_1 & y$";
    const syntax = tokens(source).map((token) => [
      source.slice(token.start, token.end),
      token.className,
    ]);
    expect(syntax).toContainEqual(["\\%", "cm-math cm-tag"]);
    expect(syntax).toContainEqual(["% note 2", "cm-math cm-comment"]);
    expect(syntax).toContainEqual(["x", "cm-math cm-variable-2"]);
    expect(syntax).toContainEqual(["_", "cm-math cm-tag"]);
    expect(syntax).toContainEqual(["1", "cm-math cm-number"]);
    expect(syntax).toContainEqual(["&", "cm-math cm-tag"]);
  });
});
