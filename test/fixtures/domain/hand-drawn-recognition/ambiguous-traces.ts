import { samplesFromTrace, tracePolyline } from "./trace-primitives";
import type { AmbiguousRecognitionExample, RecognitionExample, TracePoint } from "./types";

const AMBIGUOUS_PATHS: readonly {
  id: string;
  variation: string;
  vertices: readonly TracePoint[];
}[] = [
  {
    id: "hook-tall",
    variation: "Long upright with broad terminal hook",
    vertices: [
      [0, -130],
      [2, -70],
      [1, 0],
      [-4, 45],
      [-20, 64],
      [-46, 62],
      [-59, 47],
    ],
  },
  {
    id: "hook-fishing",
    variation: "Diagonal fishing-hook flourish",
    vertices: [
      [-88, -74],
      [-39, -25],
      [8, 25],
      [34, 44],
      [54, 41],
      [64, 22],
      [59, 6],
      [43, 2],
    ],
  },
  {
    id: "partial-box-two-sides",
    variation: "Open L with unequal incomplete third side",
    vertices: [
      [-100, -70],
      [-103, 70],
      [100, 73],
      [102, 43],
    ],
  },
  {
    id: "partial-box-wide-gap",
    variation: "Box abandoned before most of last side",
    vertices: [
      [-100, -75],
      [99, -71],
      [104, 74],
      [-101, 78],
      [-100, 29],
    ],
  },
  {
    id: "scribble-zigzag",
    variation: "Crossing back-and-forth cancellation scribble",
    vertices: [
      [-110, -40],
      [98, 51],
      [-80, 57],
      [81, -54],
      [-98, -8],
      [113, 12],
      [-51, 39],
    ],
  },
  {
    id: "scribble-overlapping-loops",
    variation: "Two overlapping irregular loops in one stroke",
    vertices: [
      [-70, 0],
      [-100, -35],
      [-72, -67],
      [-15, -49],
      [5, 4],
      [-26, 49],
      [-72, 41],
      [-80, 2],
      [-11, -29],
      [53, -62],
      [106, -33],
      [99, 24],
      [51, 55],
      [8, 19],
      [32, -16],
    ],
  },
  {
    id: "letter-lowercase-h",
    variation: "Connected lowercase h with stem retrace",
    vertices: [
      [-66, 80],
      [-62, -97],
      [-66, 61],
      [-45, -5],
      [-12, -26],
      [20, -10],
      [31, 29],
      [30, 80],
    ],
  },
  {
    id: "letter-lowercase-m",
    variation: "Connected lowercase m with two rounded humps",
    vertices: [
      [-105, 56],
      [-102, -50],
      [-99, 23],
      [-78, -34],
      [-51, -52],
      [-25, -25],
      [-20, 54],
      [-19, 8],
      [5, -42],
      [35, -51],
      [65, -27],
      [72, 58],
    ],
  },
  {
    id: "letter-capital-e",
    variation: "Capital E with natural retracing",
    vertices: [
      [80, -88],
      [-75, -85],
      [-78, 1],
      [44, 3],
      [-76, 1],
      [-80, 88],
      [87, 87],
    ],
  },
  {
    id: "letter-lowercase-s",
    variation: "Connected S curve with opposing curvature",
    vertices: [
      [67, -74],
      [21, -98],
      [-36, -83],
      [-65, -45],
      [-41, -13],
      [28, 12],
      [65, 45],
      [49, 83],
      [-2, 102],
      [-59, 79],
    ],
  },
  {
    id: "spiral-inward",
    variation: "Loose inward coil with displaced center",
    vertices: [
      [-101, 5],
      [-68, -76],
      [28, -93],
      [102, -25],
      [86, 64],
      [-6, 101],
      [-77, 49],
      [-61, -25],
      [6, -50],
      [54, -13],
      [32, 35],
      [-7, 31],
      [-15, -1],
      [10, -4],
    ],
  },
  {
    id: "double-chevron",
    variation: "Connected double-chevron annotation",
    vertices: [
      [-107, -65],
      [-38, 0],
      [-109, 65],
      [-36, 0],
      [30, -65],
      [101, 0],
      [32, 65],
    ],
  },
];

export function ambiguousRecognitionExamples(): AmbiguousRecognitionExample[] {
  return AMBIGUOUS_PATHS.filter((trace) => trace.id !== "hook-tall").map(
    ({ id, variation, vertices }) => ({
      id: `ambiguous-${id}`,
      variation,
      samples: samplesFromTrace(tracePolyline(vertices, { wave: 3.2, uneven: true })),
      expected: null,
    }),
  );
}

/** A broad J shares the supported native quadratic family; letter intent is not encoded in ink. */
export function nativeCurveOverlapExample(): RecognitionExample {
  const trace = AMBIGUOUS_PATHS.find((path) => path.id === "hook-tall")!;
  return {
    id: "evaluation-line-native-hook-overlap",
    kind: "line",
    variation: trace.variation,
    split: "evaluation",
    samples: samplesFromTrace(tracePolyline(trace.vertices, { wave: 3.2, uneven: true })),
    expected: { kinds: ["line"], line: "curved" },
  };
}
