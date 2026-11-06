import { arrowExample } from "./arrow-traces";
import { ellipseExample } from "./ellipse-traces";
import { lineExample } from "./line-traces";
import {
  roundClosedCorners,
  samplesFromTrace,
  startClosedTrace,
  tracePolyline,
} from "./trace-primitives";
import type { AmbiguousRecognitionExample, RecognitionExample, TracePoint } from "./types";

type VerificationPolygonKind =
  "rectangle" | "triangle" | "diamond" | "parallelogram" | "octagon" | "star";

// Independent verification inputs. No recognizer output was consulted to construct these paths.
const POLYGON_VERTICES: Record<VerificationPolygonKind, readonly TracePoint[]> = {
  rectangle: [
    [-130, -58],
    [130, -58],
    [130, 58],
    [-130, 58],
  ],
  triangle: [
    [0, -117],
    [108, 73],
    [-108, 73],
  ],
  diamond: [
    [0, -59],
    [110, 0],
    [0, 59],
    [-110, 0],
  ],
  parallelogram: [
    [-78, -52],
    [130, -52],
    [78, 52],
    [-130, 52],
  ],
  octagon: [
    [-77.26, -90],
    [77.26, -90],
    [130, -37.26],
    [130, 37.26],
    [77.26, 90],
    [-77.26, 90],
    [-130, 37.26],
    [-130, -37.26],
  ],
  star: Array.from({ length: 10 }, (_, index): TracePoint => {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const radius = index % 2 === 0 ? 128 : 57.6;
    return [Math.cos(angle) * radius * 0.96, Math.sin(angle) * radius * 1.1];
  }),
};

const OFFSET_A: readonly TracePoint[] = [
  [-2, 1],
  [2, -4],
  [4, 1],
  [-3, 3],
  [1, -2],
  [-2, -3],
];
const OFFSET_B: readonly TracePoint[] = [
  [-4, -1],
  [3, 2],
  [-1, 4],
  [-2, -3],
  [3, -2],
  [1, 2],
];

function polygonVerification(kind: VerificationPolygonKind, second: boolean): RecognitionExample {
  const offsets = second ? OFFSET_B : OFFSET_A;
  const corners = POLYGON_VERTICES[kind].map(([x, y], index): TracePoint => {
    const offset = offsets[index % offsets.length]!;
    return [x + offset[0], y + offset[1]];
  });
  const contour = second ? roundClosedCorners(corners, 0.052) : corners;
  let points = tracePolyline([...contour, contour[0]!], {
    wave: second ? 8.1 : 7.2,
    uneven: true,
    phase: second ? 3 : 6,
  });
  points = startClosedTrace(points, second ? 0.467 : 0.219);
  if (second) {
    points = points.reverse();
    points.push(...points.slice(1, 6));
  } else {
    points = points.slice(0, -2);
  }
  const variation = second
    ? "soft-turns-reverse-overlap-new-proportions"
    : "uneven-mid-edge-gap-new-proportions";
  return {
    id: `verification-${kind}-${variation}`,
    kind,
    variation,
    split: "evaluation",
    samples: samplesFromTrace(points, second ? -0.47 : 0.36),
    expected: { kinds: [kind] },
  };
}

function verificationId(example: RecognitionExample): RecognitionExample {
  return { ...example, id: example.id.replace(/^evaluation-/, "verification-") };
}

function verificationLines(): RecognitionExample[] {
  return [
    lineExample(
      {
        name: "hesitant-long-oblique-new-waypoints",
        line: "straight",
        waypoints: [
          [0, 0],
          [12, 2],
          [46, -3.5],
          [103, 5],
          [174, -4],
          [238, 2],
          [287, -1],
          [298, 1],
        ],
        wave: 4.2,
        reverse: true,
        uneven: true,
        angle: -0.66,
      },
      "evaluation",
    ),
    lineExample(
      {
        name: "deep-offset-quadratic-slow-entry",
        line: "curved",
        control: [81, 158],
        endpoint: 7.4,
        wave: 4.2,
        uneven: true,
        angle: 0.91,
      },
      "evaluation",
    ),
  ];
}

function verificationEllipses(): RecognitionExample[] {
  return [
    ellipseExample(
      {
        name: "upper-right-drifting-egglike-return",
        phase: -0.61,
        reverse: true,
        egg: 7.8,
        flat: 0.035,
        drift: 3.8,
        gap: 0.007,
        uneven: true,
        wave: 5.8,
        angle: -0.73,
      },
      "evaluation",
    ),
    ellipseExample(
      {
        name: "low-left-loose-overlap-lopsided",
        phase: 2.08,
        egg: -8.2,
        overrun: 0.022,
        flat: 0.058,
        uneven: true,
        wave: 6.1,
        angle: 0.57,
      },
      "evaluation",
    ),
  ];
}

function verificationArrows(): RecognitionExample[] {
  return [
    arrowExample(
      {
        name: "triangle-to-diamond-unequal-oblique-new-combination",
        start: "triangle",
        end: "diamond",
        attachment: "rear",
        unequal: 0.93,
        headScale: 1.08,
        wave: 6.4,
        headWave: 1.6,
        uneven: true,
        reverse: true,
        angle: -0.87,
      },
      "evaluation",
    ),
    arrowExample(
      {
        name: "circle-to-open-curved-loose-tip-new-combination",
        start: "circle",
        end: "arrow",
        attachment: "edge",
        bend: 132,
        unequal: 1.16,
        returnOffset: 4.8,
        headScale: 1.06,
        headWave: 1.9,
        wave: 5.7,
        uneven: true,
        angle: 0.63,
      },
      "evaluation",
    ),
  ];
}

export function verificationRecognitionExamples(): RecognitionExample[] {
  const polygons = (Object.keys(POLYGON_VERTICES) as VerificationPolygonKind[]).flatMap((kind) => [
    polygonVerification(kind, false),
    polygonVerification(kind, true),
  ]);
  return [
    ...polygons,
    ...verificationLines(),
    ...verificationEllipses(),
    ...verificationArrows(),
  ].map(verificationId);
}

const NEGATIVE_VERTICES: readonly {
  name: string;
  variation: string;
  points: readonly TracePoint[];
}[] = [
  {
    name: "lowercase-k-retraced-stem",
    variation: "Stem retraced into the two opposing arms of a handwritten k",
    points: [
      [-65, 84],
      [-62, -106],
      [-64, 21],
      [-6, -39],
      [31, -68],
      [-57, 10],
      [7, 44],
      [50, 87],
    ],
  },
  {
    name: "open-staircase-annotation",
    variation: "Three open steps with long horizontal and vertical runs",
    points: [
      [-118, 90],
      [-116, 27],
      [-44, 29],
      [-45, -28],
      [38, -25],
      [35, -91],
      [118, -88],
    ],
  },
  {
    name: "asymmetric-crossed-double-loop",
    variation: "Two unequal loops meet at a crossing and continue into a tail",
    points: [
      [0, 8],
      [-51, -48],
      [-93, -41],
      [-110, 2],
      [-81, 43],
      [-37, 38],
      [20, -26],
      [68, -86],
      [113, -67],
      [124, -13],
      [99, 27],
      [49, 32],
      [3, 0],
      [-19, 54],
    ],
  },
  {
    name: "handwritten-five-open-bowl",
    variation: "Open handwritten five with a flat cap and oppositely curved bowl",
    points: [
      [76, -99],
      [-47, -95],
      [-59, -27],
      [-20, -34],
      [26, -26],
      [65, 4],
      [76, 46],
      [50, 81],
      [3, 95],
      [-42, 78],
      [-61, 56],
    ],
  },
];

export function verificationNegativeExamples(): AmbiguousRecognitionExample[] {
  return NEGATIVE_VERTICES.map(({ name, variation, points }, index) => ({
    id: `verification-negative-${name}`,
    variation,
    samples: samplesFromTrace(
      tracePolyline(points, { wave: 4.1, uneven: true, phase: index + 1 }),
      0.14,
    ),
    expected: null,
  }));
}
