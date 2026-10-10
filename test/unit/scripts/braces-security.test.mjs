import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const braces = createRequire(require.resolve("micromatch"))("braces");
const micromatch = require("micromatch");

function nestedPattern(depth, open = "{", close = "}") {
  return open.repeat(depth) + "a,b" + close.repeat(depth);
}

function nestedAst(depth) {
  let node = { type: "text", value: "a" };
  for (let index = 0; index < depth; index++) node = { type: "paren", nodes: [node] };
  return { type: "root", nodes: [node] };
}

describe("installed micromatch braces security boundary", () => {
  it("preserves compiled, expanded, escaped, and range patterns", () => {
    expect(braces.compile("src/{domain,editor}/*.ts")).toBe("src/(domain|editor)/*.ts");
    expect(braces.expand("file-{01..03}.{ts,js}")).toEqual([
      "file-01.ts",
      "file-01.js",
      "file-02.ts",
      "file-02.js",
      "file-03.ts",
      "file-03.js",
    ]);
    expect(braces.stringify(braces.parse("src/{domain,editor}/*.ts"))).toBe(
      "src/{domain,editor}/*.ts",
    );
    expect(micromatch.braces("a/\\{b,c\\}")).toEqual(["a/{b,c}"]);
    expect(micromatch.braceExpand("src/{domain,editor}/*.{ts,tsx}")).toEqual([
      "src/domain/*.ts",
      "src/domain/*.tsx",
      "src/editor/*.ts",
      "src/editor/*.tsx",
    ]);
    expect(() => braces.expand("{1..1001}")).toThrow(/range limit/);
  });

  it.each(["parse", "compile", "expand", "stringify"])(
    "%s accepts the nesting boundary and rejects over-depth string input",
    (method) => {
      expect(() => braces[method](nestedPattern(100))).not.toThrow();
      for (const depth of [101, 4998]) {
        expect(() => braces[method](nestedPattern(depth))).toThrow(/exceeds max depth/);
        expect(() => braces[method](nestedPattern(depth, "(", ")"))).toThrow(/exceeds max depth/);
      }
    },
  );

  it.each(["compile", "expand", "stringify"])(
    "%s guards direct AST traversal independently of parsing",
    (method) => {
      expect(() => braces[method](nestedAst(100))).not.toThrow();
      expect(() => braces[method](nestedAst(5000))).toThrow(/exceeds max depth/);
      const cyclic = { type: "root", nodes: [] };
      cyclic.nodes.push(cyclic);
      expect(() => braces[method](cyclic)).toThrow(/exceeds max depth/);
    },
  );

  it.each([1000, Infinity, NaN, "1000", null])(
    "does not let maxDepth=%j disable the hard bound",
    (maxDepth) => {
      expect(() => braces.compile(nestedPattern(101), { maxDepth })).toThrow(/exceeds max depth/);
    },
  );

  it("enforces tighter fractional limits and rejects invalid length limits", () => {
    expect(() => braces.parse(nestedPattern(1), { maxDepth: 1.5 })).not.toThrow();
    expect(() => braces.parse(nestedPattern(2), { maxDepth: 1.5 })).toThrow(/exceeds max depth/);
    expect(() => braces.parse("plain", { maxDepth: -1 })).toThrow(/non-negative/);
    expect(() => braces.parse("x".repeat(10001), { maxLength: NaN })).toThrow(/non-negative/);
    expect(() => micromatch.braces(nestedPattern(4998))).toThrow(/exceeds max depth/);
  });
});
