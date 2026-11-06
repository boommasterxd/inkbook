import type { ArrowNodeV1 } from "../../../../src/domain/schema/types";

export type RecognitionKind =
  | "line"
  | "arrow"
  | "rectangle"
  | "ellipse"
  | "triangle"
  | "star"
  | "octagon"
  | "parallelogram"
  | "diamond";

export type CorpusSplit = "development" | "evaluation";
export type TracePoint = readonly [number, number];

export interface RecognitionExample {
  id: string;
  kind: RecognitionKind;
  variation: string;
  split: CorpusSplit;
  samples: number[];
  expected: {
    kinds: readonly RecognitionKind[];
    line?: "straight" | "curved";
    startNode?: ArrowNodeV1;
    endNode?: ArrowNodeV1;
  };
}

export interface AmbiguousRecognitionExample {
  id: string;
  variation: string;
  samples: number[];
  expected: null;
}
