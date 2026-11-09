import { StateEffect } from "@codemirror/state";

export const documentRecognitionChanged = StateEffect.define<readonly string[]>();
