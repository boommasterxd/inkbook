import {
  createSerializedSceneValidationProcessorV1,
  type SerializedSceneValidationProcessorV1,
} from "../../domain/codecs";
import type { PreparedCanonicalSidecarV1 } from "./types";
import {
  validateInkbookSidecarEnvelopeV1,
  type ValidatedSidecarEnvelopeV1,
} from "./validation";

export interface PreparedCanonicalSidecarProcessorV1 {
  readonly done: boolean;
  processNext(): boolean;
  complete(): PreparedCanonicalSidecarV1 | undefined;
  dispose(): void;
}

export function createPreparedCanonicalSidecarProcessorV1(
  value: unknown,
  measuredUtf8Bytes?: number,
): PreparedCanonicalSidecarProcessorV1 {
  const envelope = validateInkbookSidecarEnvelopeV1(value);
  return new PreparedSidecarProcessor(
    envelope,
    createSerializedSceneValidationProcessorV1(
      envelope.scene,
      measuredUtf8Bytes,
    ),
  );
}

class PreparedSidecarProcessor implements PreparedCanonicalSidecarProcessorV1 {
  #result: PreparedCanonicalSidecarV1 | undefined;
  #disposed = false;

  constructor(
    private readonly envelope: ValidatedSidecarEnvelopeV1,
    private readonly scene: SerializedSceneValidationProcessorV1,
  ) {}

  get done(): boolean {
    return this.#result !== undefined;
  }

  processNext(): boolean {
    this.assertUsable();
    if (!this.scene.done) {
      this.scene.processNext();
      return false;
    }
    const validatedScene = this.scene.complete();
    if (validatedScene === undefined) {
      throw new Error("Sidecar scene validation is incomplete.");
    }
    const sidecarWithoutElements = Object.freeze({
      ...this.envelope,
      scene: Object.freeze({
        ...validatedScene,
        elements: Object.freeze([]),
      }),
    });
    this.#result = Object.freeze({
      sidecarWithoutElements,
      elements: validatedScene.elements,
    });
    return true;
  }

  complete(): PreparedCanonicalSidecarV1 | undefined {
    this.assertUsable();
    return this.#result;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#result = undefined;
    this.scene.dispose();
  }

  private assertUsable(): void {
    if (this.#disposed) throw new Error("Sidecar validation is disposed.");
  }
}
