import { arrowDevelopmentExamples } from "./arrow-development";
import { arrowEvaluationExamples } from "./arrow-evaluation";
import { ellipseDevelopmentExamples } from "./ellipse-development";
import { ellipseEvaluationExamples } from "./ellipse-evaluation";
import { lineDevelopmentExamples } from "./line-development";
import { lineEvaluationExamples } from "./line-evaluation";
import { polygonDevelopmentExamples } from "./polygon-development";
import { polygonEvaluationExamples } from "./polygon-evaluation";
import type { CorpusSplit, RecognitionExample } from "./types";

export { ambiguousRecognitionExamples, nativeCurveOverlapExample } from "./ambiguous-traces";
export type { CorpusSplit, RecognitionExample } from "./types";

export function recognitionCorpus(split?: CorpusSplit): RecognitionExample[] {
  const development =
    split === "evaluation"
      ? []
      : [
          ...lineDevelopmentExamples(),
          ...arrowDevelopmentExamples(),
          ...polygonDevelopmentExamples(),
          ...ellipseDevelopmentExamples(),
        ];
  const evaluation =
    split === "development"
      ? []
      : [
          ...lineEvaluationExamples(),
          ...arrowEvaluationExamples(),
          ...polygonEvaluationExamples(),
          ...ellipseEvaluationExamples(),
        ];
  return [...development, ...evaluation];
}
