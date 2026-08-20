import type { RuntimeSceneStateV1 } from "../scene";
import { createRuntimeSceneStateV1 } from "../scene";
import {
  createSerializedSceneValidationProcessorV1,
  type SerializedSceneValidationProcessorV1,
} from "./scene-validation-processor";

export { SCENE_RESOURCE_LIMITS_V1 } from "../scene/resource-limits";
export {
  validateGroupRecordV1,
  validateNoteAppearanceV1,
} from "./scene-record-validation";
export {
  createSerializedSceneValidationProcessorV1,
  type SerializedSceneValidationProcessorV1,
} from "./scene-validation-processor";

export function validateSerializedSceneStateV1(
  value: unknown,
): RuntimeSceneStateV1 {
  return driveValidation(createSerializedSceneValidationProcessorV1(value));
}

export function validateBoundedSerializedSceneStateV1(
  value: unknown,
  measuredUtf8Bytes: number,
): RuntimeSceneStateV1 {
  return driveValidation(
    createSerializedSceneValidationProcessorV1(value, measuredUtf8Bytes),
  );
}

function driveValidation(
  processor: SerializedSceneValidationProcessorV1,
): RuntimeSceneStateV1 {
  while (!processor.processNext()) {
    // The synchronous API drives the same resumable semantic validator.
  }
  const scene = processor.complete();
  if (scene === undefined) throw new Error("Scene validation is incomplete.");
  return createRuntimeSceneStateV1(scene);
}
