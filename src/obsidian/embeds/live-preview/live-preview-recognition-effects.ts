import { StateEffect } from "@codemirror/state";

export const documentRecognitionChanged = StateEffect.define<readonly string[]>();
export const documentRecognitionUnavailable = StateEffect.define<string>();
