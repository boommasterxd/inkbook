import { decodeStrokeSamplesSteps } from "../../../src/persistence/serialization/metadata/stroke-sample-codec";
import { finishGeometrySteps } from "../domain/geometry-steps";

export function decodeStrokeSamples(input: string): Float64Array<ArrayBuffer> {
  return finishGeometrySteps(decodeStrokeSamplesSteps(input));
}
