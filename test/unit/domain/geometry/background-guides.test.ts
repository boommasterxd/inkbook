import { describe, expect, it } from "vitest";

import type { BackgroundGuideLayoutRequest } from "../../../../src/domain/geometry/public";
import {
  backgroundGuideLayout,
  centeredGuideAxis,
  topAnchoredGuideAxis,
} from "../../../../src/domain/geometry/public";

describe("centered background guides", () => {
  it("fits only complete intervals and splits the unused space equally", () => {
    expect(centeredGuideAxis(24.3, 2000, 60)).toEqual({
      end: 2014.3,
      intervalCount: 33,
      start: 34.3,
    });
  });

  it("collapses at the center when no complete interval fits", () => {
    expect(centeredGuideAxis(10, 30, 40)).toEqual({
      end: 25,
      intervalCount: 0,
      start: 25,
    });
  });

  it("keeps exact canonical intervals stable after floating-point subtraction", () => {
    const derivedLength = 1068.6 - 2 * 24.3;

    expect(centeredGuideAxis(24.3, derivedLength, 60)).toEqual({
      end: 1044.3,
      intervalCount: 17,
      start: 24.3,
    });
  });
});

describe("top-anchored background guides", () => {
  it("starts at the page frame and keeps its phase across height changes", () => {
    expect(topAnchoredGuideAxis(24.3, 300, 100)).toEqual({
      end: 324.3,
      intervalCount: 3,
      start: 24.3,
    });
    expect(topAnchoredGuideAxis(24.3, 350, 100)).toEqual({
      end: 324.3,
      intervalCount: 3,
      start: 24.3,
    });
  });

  it("retains the frame origin when no complete row fits", () => {
    expect(topAnchoredGuideAxis(10, 30, 40)).toEqual({
      end: 10,
      intervalCount: 0,
      start: 10,
    });
  });
});

describe("canonical background guide layout", () => {
  const base = { innerWidth: 2_000, margin: 24.3, pageHeight: 348.6 } as const;

  it("gives square grids all four frame boundaries", () => {
    const layout = backgroundGuideLayout({
      ...base,
      background: { spacing: 50, type: "squares" },
    });

    expect(layout).toMatchObject({
      bottom: 324.3,
      horizontalPointCount: 41,
      horizontalSpacing: 50,
      left: 24.3,
      right: 2_024.3,
      top: 24.3,
      verticalPointCount: 7,
      verticalSpacing: 50,
    });
  });

  it("uses the selected shared spacing directly for ruled lines", () => {
    const layout = backgroundGuideLayout({
      background: { spacing: 100, type: "lines" },
      innerWidth: 2_000,
      margin: 24.3,
      pageHeight: 448.6,
    });

    expect(layout).toMatchObject({
      bottom: 424.3,
      horizontalPointCount: 0,
      left: 24.3,
      right: 2_024.3,
      top: 24.3,
      verticalPointCount: 5,
      verticalSpacing: 100,
    });
  });

  it("places dots at the same intersections as the corresponding square grid", () => {
    const dotted = backgroundGuideLayout({
      ...base,
      background: { spacing: 50, type: "dots" },
    });
    const squared = backgroundGuideLayout({
      ...base,
      background: { spacing: 50, type: "squares" },
    });

    expect(dotted).toEqual(squared);
  });
});

describe("canonical background guide spacing matrix", () => {
  it.each([25, 33.333333333333336, 50, 100] as const)(
    "keeps every %d-unit square grid closed on all four sides",
    (spacing) => {
      const margin = 24.3;
      const layout = backgroundGuideLayout({
        background: { spacing, type: "squares" },
        innerWidth: 2_000,
        margin,
        pageHeight: 2 * margin + 5 * spacing,
      });

      expect(layout.top).toBe(margin);
      expect(layout.bottom).toBeCloseTo(margin + 5 * spacing, 3);
      expect(layout.verticalPointCount).toBe(6);
      expect(layout.left).toBe(margin);
      expect(layout.right).toBe(2_024.3);
    },
  );

  it.each([25, 33.333333333333336, 50, 100] as const)(
    "keeps every %d-unit dot matrix on the exact corresponding square intersections",
    (spacing) => {
      const dotted = fiveRowLayout({ spacing, type: "dots" }).layout;
      const squared = fiveRowLayout({ spacing, type: "squares" }).layout;

      expect(dotted).toEqual(squared);
    },
  );

  it.each([25, 33.333333333333336, 50, 100] as const)(
    "keeps every %d-unit ruled background on its corresponding square frame",
    (spacing) => {
      const { layout, margin } = fiveRowLayout({ spacing, type: "lines" });
      const squareFrame = fiveRowLayout({ spacing, type: "squares" }).layout;

      expect(layout.top).toBe(margin);
      expect(layout.bottom).toBeCloseTo(margin + 5 * spacing, 3);
      expect(layout.left).toBe(squareFrame.left);
      expect(layout.right).toBe(squareFrame.right);
      expect(layout.verticalPointCount).toBe(6);
    },
  );

  it("keeps the frame fixed when square spacing changes", () => {
    const layouts = ([25, 33.333333333333336, 50, 100] as const).map((spacing) =>
      backgroundGuideLayout({
        background: { spacing, type: "squares" },
        innerWidth: 2_000,
        margin: 24.3,
        pageHeight: 348.6,
      }),
    );

    expect(layouts.map(({ left, right, top, bottom }) => ({ bottom, left, right, top }))).toEqual(
      Array.from({ length: 4 }, () => ({ bottom: 324.3, left: 24.3, right: 2_024.3, top: 24.3 })),
    );
  });

  it("treats M as an exact three-way subdivision of every 100-unit layout row", () => {
    const layout = backgroundGuideLayout({
      background: { spacing: 33.333333333333336, type: "squares" },
      innerWidth: 2_000,
      margin: 24.3,
      pageHeight: 348.6,
    });

    expect(layout.horizontal.intervalCount).toBe(60);
    expect(layout.vertical.intervalCount).toBe(9);
    expect(layout.horizontal.end).toBe(2_024.3);
    expect(layout.vertical.end).toBe(324.3);
  });
});

function fiveRowLayout(background: BackgroundGuideLayoutRequest["background"]) {
  const margin = 24.3;
  return {
    layout: backgroundGuideLayout({
      background,
      innerWidth: 2_000,
      margin,
      pageHeight: 2 * margin + 5 * background.spacing,
    }),
    margin,
  };
}
