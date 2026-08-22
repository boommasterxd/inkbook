import { beforeEach, describe, expect, it, vi } from "vitest";

const languageMocks = vi.hoisted(() => ({
  syntaxTree: vi.fn(),
  syntaxTreeAvailable: vi.fn(),
}));

vi.mock("@codemirror/language", () => languageMocks);

import { isExecutableEmbedSyntax } from "../../../../src/obsidian/embeds/live-preview";

interface TestSyntaxNode {
  readonly from: number;
  readonly name: string;
  readonly to: number;
}

function viewWithSyntax(nodes: readonly TestSyntaxNode[]) {
  languageMocks.syntaxTree.mockReturnValue({
    iterate: ({ enter }: { readonly enter: (node: TestSyntaxNode) => void }) => {
      for (const node of nodes) enter(node);
    },
  });
  return { state: {} } as never;
}

describe("Live Preview syntax correlation", () => {
  beforeEach(() => {
    languageMocks.syntaxTree.mockReset();
    languageMocks.syntaxTreeAvailable.mockReset();
    languageMocks.syntaxTreeAvailable.mockReturnValue(true);
  });

  it.each([
    ["Markdown image", "Image"],
    ["Wiki embed", "hmd-embed"],
  ])("accepts an exact executable %s node", (_label, name) => {
    expect(isExecutableEmbedSyntax(viewWithSyntax([{ from: 4, name, to: 28 }]), 4, 28)).toBe(true);
  });

  it("rejects exact embed nodes inside code syntax", () => {
    expect(
      isExecutableEmbedSyntax(
        viewWithSyntax([
          { from: 0, name: "InlineCode", to: 30 },
          { from: 4, name: "hmd-embed", to: 28 },
        ]),
        4,
        28,
      ),
    ).toBe(false);
  });

  it("fails closed for unavailable, unknown, or inexact syntax", () => {
    languageMocks.syntaxTreeAvailable.mockReturnValue(false);
    expect(isExecutableEmbedSyntax(viewWithSyntax([]), 4, 28)).toBe(false);

    languageMocks.syntaxTreeAvailable.mockReturnValue(true);
    expect(
      isExecutableEmbedSyntax(viewWithSyntax([{ from: 4, name: "Text", to: 28 }]), 4, 28),
    ).toBe(false);
    expect(
      isExecutableEmbedSyntax(viewWithSyntax([{ from: 0, name: "Image", to: 30 }]), 4, 28),
    ).toBe(false);
    expect(
      isExecutableEmbedSyntax(viewWithSyntax([{ from: 4, name: "custom-embed", to: 28 }]), 4, 28),
    ).toBe(false);
  });
});
