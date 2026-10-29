import { describe, expect, it } from "vitest";

import { layoutOnboardingNote } from "../../../../../src/obsidian/embeds/active-editor/onboarding-layout";

describe("onboarding note layout", () => {
  it.each([
    [
      { left: 200, top: 150, width: 900, height: 600 },
      { left: 0, top: 0, width: 1440, height: 900 },
    ],
    [
      { left: 80, top: 120, width: 640, height: 600 },
      { left: 0, top: 0, width: 800, height: 900 },
    ],
    [
      { left: 30, top: 100, width: 300, height: 600 },
      { left: 0, top: 0, width: 360, height: 800 },
    ],
  ])("keeps the note within the paper and viewport", (paper, viewport) => {
    const target = { left: paper.left + 40, top: paper.top, width: 24, height: 24 };
    const result = layoutOnboardingNote({ paper, target, viewport, noteHeight: 140 });
    expect(result.visible).toBe(true);
    expect(result.showArrow).toBe(true);
    expect(result.left).toBeGreaterThanOrEqual(paper.left + 16);
    expect(result.left + result.width).toBeLessThanOrEqual(paper.left + paper.width - 16);
    expect(result.top + 140).toBeLessThanOrEqual(viewport.top + viewport.height - 8);
    expect(result.width).toBe(Math.min(420, paper.width - 40, viewport.width - 32));
  });

  it.each([40, 780])("stays inside the paper directly below the toolbar icon at x=%s", (x) => {
    const target = { left: x, top: 50, width: 24, height: 24 };
    const result = layoutOnboardingNote({
      paper: { left: 20, top: 100, width: 800, height: 600 },
      viewport: { left: 0, top: 0, width: 900, height: 800 },
      target,
      noteHeight: 140,
    });
    const numbers = result.arrow.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    expect(result.showArrow).toBe(true);
    const titleLeft = result.left + result.width * 0.08;
    const titleWidth = result.width * 0.84;
    const pointsLeft = target.left + target.width / 2 < titleLeft + titleWidth / 2;
    expect(numbers[0]).toBeCloseTo(pointsLeft ? titleLeft - 6 : titleLeft + titleWidth + 6);
    expect(numbers[1]).toBe(result.top + 27);
    expect(numbers[6]).toBe(target.left + target.width / 2);
    expect(numbers[7]).toBeGreaterThanOrEqual(100 + 8);
    expect(numbers[4]).toBe(numbers[6]);
    expect(numbers[5]).toBeGreaterThan(numbers[7]!);
    for (let index = 0; index < numbers.length; index += 2) {
      expect(numbers[index]).toBeGreaterThanOrEqual(20);
      expect(numbers[index]).toBeLessThanOrEqual(820);
      expect(numbers[index + 1]).toBeGreaterThanOrEqual(100);
      expect(numbers[index + 1]).toBeLessThanOrEqual(700);
    }
    expect(result.arrowHead).toContain(`L ${numbers[6]} ${numbers[7]}`);
    expectAlignedArrowTip(numbers, result.arrowHead);
  });
});

describe("onboarding arrow placement", () => {
  it.each([
    { title: { left: 8.528, top: 11.644, width: 242.212, height: 31.173 }, targetX: 219 },
    { title: { left: 36.5125, top: 14.0013, width: 187.0128, height: 42.1915 }, targetX: 146 },
  ])(
    "routes the constrained phone curve outside the measured heading: %o",
    ({ title, targetX }) => {
      const paper = { left: 24, top: 271, width: 300, height: 306 };
      const result = layoutOnboardingNote({
        paper,
        title,
        viewport: { left: 0, top: 0, width: 360, height: 800 },
        target: { left: targetX, top: 213, width: 44, height: 44 },
        noteHeight: 194,
      });
      expect(result.showArrow).toBe(true);
      const curve = result.arrow.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const titleLeft = result.left + title.left;
      const pointsLeft = targetX + 22 < titleLeft + title.width / 2;
      expect(curve[0]).toBeCloseTo(pointsLeft ? titleLeft - 6 : titleLeft + title.width + 6);
      expect(curve[1]).toBeCloseTo(result.top + title.top + title.height / 2);
      expect(curve[6]).toBe(targetX + 22);
      expectAlignedArrowTip(curve, result.arrowHead);
      const left = result.left + title.left;
      const right = left + title.width;
      const top = result.top + title.top;
      const bottom = top + title.height;
      for (let index = 0; index <= 100; index += 1) {
        const t = index / 100;
        const point = (axis: number) =>
          (1 - t) ** 3 * curve[axis]! +
          3 * (1 - t) ** 2 * t * curve[axis + 2]! +
          3 * (1 - t) * t ** 2 * curve[axis + 4]! +
          t ** 3 * curve[axis + 6]!;
        const x = point(0);
        const y = point(1);
        expect(x >= left && x <= right && y >= top && y <= bottom).toBe(false);
        expect(x).toBeGreaterThanOrEqual(paper.left);
        expect(x).toBeLessThanOrEqual(paper.left + paper.width);
        expect(y).toBeGreaterThanOrEqual(paper.top);
        expect(y).toBeLessThanOrEqual(paper.top + paper.height);
      }
    },
  );
});

describe("onboarding navigation clearance", () => {
  it.each([274, 289])(
    "fits compact guidance above navigation in landscape ending at %s",
    (bottom) => {
      const paper = { left: 40, top: 167, width: 580, height: 600 };
      const viewport = { left: 0, top: 109, width: 667, height: bottom - 109 };
      const layout = layoutOnboardingNote({
        paper,
        viewport,
        compact: true,
        noteHeight: 44,
        navigationHeight: 48,
        target: { left: 200, top: 109, width: 44, height: 44 },
        title: { left: 20, top: 0, width: 180, height: 24 },
      });
      expect(layout.visible).toBe(true);
      expect(layout.navigationVisible).toBe(true);
      expect(layout.navigationLeft).toBe(paper.left + paper.width / 2);
      expect(layout.top).toBeGreaterThanOrEqual(paper.top);
      expect(layout.top + 44).toBeLessThanOrEqual(layout.navigationTop);
      expect(layout.navigationTop + 48).toBeLessThanOrEqual(bottom);
      expect(layout.showArrow).toBe(true);
      const points = layout.arrow.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      for (let index = 0; index < points.length; index += 2) {
        expect(points[index]).toBeGreaterThanOrEqual(paper.left);
        expect(points[index]).toBeLessThanOrEqual(paper.left + paper.width);
        expect(points[index + 1]).toBeGreaterThanOrEqual(paper.top);
        expect(points[index + 1]).toBeLessThanOrEqual(paper.top + paper.height);
      }
    },
  );

  it("keeps navigation available when the guide text cannot fit", () => {
    const layout = layoutOnboardingNote({
      paper: { left: 40, top: 167, width: 580, height: 600 },
      viewport: { left: 0, top: 109, width: 667, height: 165 },
      target: { left: 200, top: 109, width: 44, height: 44 },
      compact: true,
      noteHeight: 150,
      navigationHeight: 48,
    });
    expect(layout.visible).toBe(false);
    expect(layout.navigationVisible).toBe(true);
  });

  it("keeps navigation below the guide and centered at the visible paper bottom across targets", () => {
    const paper = { left: 24, top: 200, width: 300, height: 360 };
    const viewport = { left: 0, top: 0, width: 360, height: 800 };
    for (const left of [40, 160, 260]) {
      const layout = layoutOnboardingNote({
        paper,
        viewport,
        navigationHeight: 77,
        noteHeight: 134,
        target: { left, top: 150, width: 44, height: 44 },
      });
      expect(layout.visible).toBe(true);
      expect(layout.navigationLeft).toBe(174);
      expect(layout.navigationTop + 77).toBe(paper.top + paper.height - 16);
      expect(layout.top + 134).toBeLessThanOrEqual(layout.navigationTop - 24);
    }
    const clipped = layoutOnboardingNote({
      paper: { ...paper, height: 1000 },
      viewport,
      navigationHeight: 77,
      noteHeight: 134,
      target: { left: 40, top: 150, width: 44, height: 44 },
    });
    expect(clipped.visible).toBe(true);
    expect(clipped.navigationTop + 77).toBe(viewport.height - 16);
  });
});

describe("onboarding placement and visibility", () => {
  it("places a measured heading beside the target and starts at its nearest edge", () => {
    const title = { left: 20, top: 10, width: 180, height: 28 };
    const input = {
      paper: { left: 20, top: 100, width: 1000, height: 600 },
      viewport: { left: 0, top: 0, width: 1100, height: 800 },
      target: { left: 488, top: 50, width: 24, height: 24 },
      noteHeight: 140,
      title,
    };
    const result = layoutOnboardingNote(input);
    const curve = result.arrow.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(result.left + title.left + title.width).toBe(452);
    expect(curve[0]).toBe(458);
    expect(curve[1]).toBe(result.top + 24);
    expect(curve[2]).toBe(494);
    expectAlignedArrowTip(curve, result.arrowHead);
  });

  it("uses a clamped centered fallback on a narrow paper", () => {
    const result = layoutOnboardingNote({
      paper: { left: 30, top: 100, width: 300, height: 600 },
      viewport: { left: 0, top: 0, width: 360, height: 800 },
      target: { left: 168, top: 50, width: 24, height: 24 },
      noteHeight: 140,
    });
    expect(result.left).toBe(50);
    expect(result.showArrow).toBe(true);
  });

  it("hides the note when the visible paper cannot contain it", () => {
    const result = layoutOnboardingNote({
      paper: { left: 30, top: 350, width: 300, height: 260 },
      viewport: { left: 0, top: 0, width: 360, height: 500 },
      target: { left: 60, top: 350, width: 24, height: 24 },
      noteHeight: 180,
    });
    expect(result.visible).toBe(false);
    expect(result.showArrow).toBe(false);
  });

  it("hides on scroll away and restores the note inside a sufficiently visible paper", () => {
    const viewport = { left: 0, top: 0, width: 360, height: 500 };
    const paper = { left: 30, top: 100, width: 300, height: 600 };
    const target = { left: 60, top: 100, width: 24, height: 24 };
    const layout = (top: number) =>
      layoutOnboardingNote({ paper: { ...paper, top }, viewport, target, noteHeight: 140 });
    for (const top of [-700, 510, 400]) {
      const hidden = layout(top);
      expect(hidden.visible).toBe(false);
      expect(hidden.showArrow).toBe(false);
      expect(hidden.arrow).toBe("");
    }
    const partial = layout(300);
    expect(partial.visible).toBe(true);
    expect(partial.top).toBeGreaterThanOrEqual(308);
    expect(partial.top + 140).toBeLessThanOrEqual(492);
    expect(layout(100).visible).toBe(true);
  });

  it("suppresses arrows for clipped targets and invisible notes", () => {
    const input = {
      paper: { left: 20, top: 100, width: 300, height: 600 },
      viewport: { left: 0, top: 0, width: 360, height: 500 },
      target: { left: 40, top: 100, width: 24, height: 24 },
      noteHeight: 140,
    };
    expect(layoutOnboardingNote({ ...input, targetVisible: false }).showArrow).toBe(false);
    expect(
      layoutOnboardingNote({ ...input, target: { ...input.target, left: -10 } }).showArrow,
    ).toBe(false);
    expect(layoutOnboardingNote({ ...input, noteHeight: 500 }).visible).toBe(false);
  });
});

function expectAlignedArrowTip(curve: readonly number[], headPath: string): void {
  const head = headPath.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const tangentX = curve[6]! - curve[4]!;
  const tangentY = curve[7]! - curve[5]!;
  const headX = head[2]! - (head[0]! + head[4]!) / 2;
  const headY = head[3]! - (head[1]! + head[5]!) / 2;
  expect(tangentX * headY - tangentY * headX).toBeCloseTo(0, 8);
  expect(tangentX * headX + tangentY * headY).toBeGreaterThan(0);
  expect(tangentX).toBe(0);
  expect(tangentY).toBeLessThan(0);
}
