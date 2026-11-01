import { describe, expect, it } from "vitest";
import { pointSegmentDistance } from "../../../../../src/domain/geometry/primitives";
import { pressureRadius } from "../../../../../src/domain/geometry/pressure/pressure-radius";
import { smoothStrokeCenters } from "../../../../../src/domain/geometry/stroke-path";
import { simplifyStrokeCenters } from "../../../../../src/domain/geometry/stroke-simplification";
import type {
  InkElementV1,
  PointV1,
  StrokeElementV1,
} from "../../../../../src/domain/schema/types";
import { convertObsidianInk } from "../../../../../src/persistence/import/obsidian-ink/convert";
import type { SourceStrokeCurve } from "../../../../../src/persistence/import/obsidian-ink/source-stroke-curve";
import { completeSteps } from "../../../../../src/persistence/import/obsidian-ink/source-values";
import { sampleSourceStrokeCurveSteps } from "../../../../../src/persistence/import/obsidian-ink/stroke-geometry";
import { roundTripInkbookSnapshotForTest } from "../../../../fixtures/persistence/parse-document";
import { canvasSnapshot, canvasStroke, inkSvg } from "./fixtures";

// Minimal numeric metadata from the Official 0.6.1 pen fixtures.
const officialStyle = {
  size: 4,
  thinning: 0.6,
  smoothing: 0.10546027011351397,
  streamline: 0.010920540227027924,
  simulatePressure: false,
  color: "currentColor",
};
const letter = [
  [232.5190032799683, 245.54807476638237, 0.2500000037252903],
  [232.5190032799683, 65.14540294672818, 0.5314582549035549],
  [340.76059726882926, 245.54807476638237, 0.7003332056105137],
  [340.76059726882926, 65.14540294672818, 0.5201999248564243],
];
const roundedBox = [
  [200.4474181901333, 150.3355522639355, 0.2500000037252903],
  [551.2303886442021, 150.3355522639355, 0.4798096977174282],
  [551.2303886442021, 350.7829704540688, 0.687885818630457],
  [200.4474181901333, 350.7829704540688, 0.7425411866605282],
  [200.4474181901333, 150.3355522639355, 0.5455247134864329],
];
const options = () => ({
  timestamp: 100,
  signal: new AbortController().signal,
  checkpoint: () => undefined,
});

function asStroke(value: InkElementV1 | undefined): StrokeElementV1 {
  if (value?.kind !== "stroke") throw new Error("Expected imported handwriting.");
  return value;
}

function renderedCenters(stroke: StrokeElementV1) {
  return simplifyStrokeCenters(
    smoothStrokeCenters(stroke.points),
    stroke.style.width,
    stroke.style.pressureEnabled,
  );
}

function distanceToCenters(point: PointV1, centers: readonly PointV1[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < centers.length; index += 1) {
    distance = Math.min(
      distance,
      pointSegmentDistance(point, centers[index - 1]!, centers[index]!),
    );
  }
  return distance;
}

function expectOfficialGeometry(strokes: StrokeElementV1[]): void {
  // These bounds compare the native result with the reconstructed source profile,
  // not with a measured centerline of the original asymmetric filled outline.
  const nCenters = renderedCenters(strokes[0]!);
  // Source streamlining shifts both N turns slightly away from the raw samples.
  for (const point of [
    { x: 232.5190032799683, y: 66.81998338619755 },
    { x: 339.7558490896452, y: 243.88903855150772 },
  ]) {
    expect(distanceToCenters(point, nCenters)).toBeLessThanOrEqual(0.25);
  }
  const boxCenters = renderedCenters(strokes[1]!);
  // The source profile's first and third turns are rounded; only its second turn is sharp.
  expect(
    distanceToCenters({ x: 551.2303886442021, y: 150.3355522639355 }, boxCenters),
  ).toBeGreaterThan(20);
  expect(
    distanceToCenters({ x: 200.4474181901333, y: 350.7829704540688 }, boxCenters),
  ).toBeGreaterThan(20);
  expect(
    distanceToCenters({ x: 551.2001637632635, y: 348.9223254743819 }, boxCenters),
  ).toBeLessThanOrEqual(0.25);
  // Reconstructed first quadratic at t=.5, after its averaged initial line endpoint.
  expect(
    distanceToCenters({ x: 483.2162151553762, y: 175.1588989152413 }, boxCenters),
  ).toBeLessThanOrEqual(0.25);
}

describe("Imported native stroke geometry", () => {
  it("preserves the reconstructed Official N and rounded box profiles through native save and reload", async () => {
    const imported = await convertObsidianInk(
      inkSvg(
        canvasSnapshot({
          strokes: [letter, roundedBox].map((points, index) => ({
            ...canvasStroke(`official-${index}`),
            points,
            style: officialStyle,
          })),
        }),
      ),
      options(),
    );
    const strokes = imported.snapshot.elements.map(asStroke);
    expectOfficialGeometry(strokes);
    expect(strokes[0]!.points.slice(0, 2)).toEqual([232.519, 245.548]);
    expect(strokes[0]!.points.slice(-3, -1)).toEqual([340.761, 65.145]);
    for (const [native, source] of [
      [strokes[0]!.points[2]!, letter[0]![2]!],
      [strokes[0]!.points[strokes[0]!.points.length - 1]!, letter[letter.length - 1]![2]!],
    ] as const) {
      const response = 0.5 + officialStyle.thinning * (source - 0.5);
      const sourceDiameter =
        2 * officialStyle.size * (0.65 * response + 0.35 * Math.sin((Math.PI * response) / 2));
      expect(
        Math.abs(2 * pressureRadius(native, strokes[0]!.style.width) - sourceDiameter),
      ).toBeLessThanOrEqual(0.002);
    }
    const loaded = await roundTripInkbookSnapshotForTest(imported.snapshot);
    expect(loaded).toEqual(imported.snapshot);
    expectOfficialGeometry(loaded.elements.map(asStroke));
  });

  it("preserves dots and short straight strokes with endpoint pressure", async () => {
    const samples = [
      [[1, 2, 0.25]],
      [
        [0, 0, 0.25],
        [20, 30, 0.75],
      ],
    ];
    const imported = await convertObsidianInk(
      inkSvg(
        canvasSnapshot({
          strokes: samples.map((points, index) => ({
            ...canvasStroke(`short-${index}`),
            points,
          })),
        }),
      ),
      options(),
    );
    for (const [index, value] of imported.snapshot.elements.entries()) {
      const stroke = asStroke(value);
      const centers = renderedCenters(stroke);
      const endpoints =
        samples[index]!.length === 1 ? [centers[0]!] : [centers[0]!, centers[centers.length - 1]!];
      for (const [pointIndex, center] of endpoints.entries()) {
        const [x, y, pressure] = samples[index]![pointIndex]!;
        expect({ x: center.x, y: center.y }).toEqual({ x, y });
        const response = 0.5 + 0.5 * (pressure! - 0.5);
        const sourceDiameter = 8 * (0.65 * response + 0.35 * Math.sin((Math.PI * response) / 2));
        expect(
          Math.abs(2 * pressureRadius(center.pressure, stroke.style.width) - sourceDiameter),
        ).toBeLessThanOrEqual(0.002);
      }
    }
  });
});

describe("Imported constant-width curve geometry", () => {
  it("preserves the Custom constant-width quadratic instead of joining its raw corners", async () => {
    const imported = await convertObsidianInk(
      inkSvg(
        canvasSnapshot({
          version: 2,
          strokes: [
            {
              ...canvasStroke(),
              points: [
                [0, 0, 0.25],
                [100, 160, 0.5],
                [200, 0, 0.75],
              ],
              style: { ...officialStyle, thinning: 0 },
            },
          ],
        }),
      ),
      options(),
    );
    const stroke = asStroke(imported.snapshot.elements[0]);
    const centers = renderedCenters(stroke);
    expect(stroke.style.pressureEnabled).toBe(false);
    expect(distanceToCenters({ x: 87.5, y: 100 }, centers)).toBeLessThanOrEqual(0.25);
    expect(distanceToCenters({ x: 100, y: 160 }, centers)).toBeGreaterThan(40);
    expect(centers[0]).toEqual({ x: 0, y: 0, pressure: 0.25 });
    expect(centers[centers.length - 1]).toEqual({ x: 200, y: 0, pressure: 0.75 });
  });
});

const quadratic: SourceStrokeCurve = {
  start: { x: 0, y: 0, pressure: 0.25 },
  segments: [
    {
      kind: "quadratic",
      control: { x: 100, y: 160, pressure: 0.5 },
      end: { x: 200, y: 0, pressure: 0.75 },
    },
  ],
  approximate: false,
};

describe("Native source-curve fitting", () => {
  it("keeps the simplified width-4 native centerline close to a constructed source quadratic", async () => {
    const points = await completeSteps(sampleSourceStrokeCurveSteps(quadratic), options());
    const centers = simplifyStrokeCenters(smoothStrokeCenters(points), 4, false);
    for (let index = 0; index <= 40; index += 1) {
      const t = index / 40;
      expect(distanceToCenters({ x: 200 * t, y: 320 * t * (1 - t) }, centers)).toBeLessThanOrEqual(
        0.25,
      );
    }
    expect(centers[0]).toEqual(quadratic.start);
    expect(centers[centers.length - 1]).toEqual(quadratic.segments[0]!.end);
    expect(Math.max(...centers.map((point) => point.y))).toBeLessThanOrEqual(80.25);
  });

  it("preserves a quadratic pressure peak on a geometrically straight source curve", async () => {
    const curve: SourceStrokeCurve = {
      start: { x: 0, y: 0, pressure: 0.1 },
      segments: [
        {
          kind: "quadratic",
          control: { x: 100, y: 0, pressure: 1 },
          end: { x: 200, y: 0, pressure: 0.1 },
        },
      ],
      approximate: false,
    };
    const points = await completeSteps(sampleSourceStrokeCurveSteps(curve), options());
    const centers = simplifyStrokeCenters(smoothStrokeCenters(points), 4, true);
    const midpoint = centers.reduce((closest, point) =>
      Math.abs(point.x - 100) < Math.abs(closest.x - 100) ? point : closest,
    );
    expect(Math.abs(midpoint.x - 100)).toBeLessThanOrEqual(0.25);
    expect(midpoint.pressure).toBeGreaterThan(0.54);
    expect(midpoint.pressure).toBeLessThanOrEqual(0.551);
    expect(centers[0]).toEqual(curve.start);
    expect(centers[centers.length - 1]).toEqual(curve.segments[0]!.end);
  });

  it("rejects an insufficient remaining document budget instead of flattening a curve", async () => {
    await expect(
      completeSteps(sampleSourceStrokeCurveSteps(quadratic, 2), options()),
    ).rejects.toMatchObject({
      code: "capacity-exceeded",
    });
  });
});
