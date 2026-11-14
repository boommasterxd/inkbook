import { parseTextMarkdownSteps } from "../../../src/domain/text/markdown-parser";
import { applyTextEditsSteps } from "../../../src/domain/text/text-source-edits";
import {
  forceTextMarkdownMarkSteps,
  toggleTextMarkdownMarkSteps,
} from "../../../src/domain/text/markdown-formatting";
import type {
  TextParseOptions,
  TextSourceChange,
  TextSourceState,
} from "../../../src/domain/text/text-types";
import { finishGeometrySteps } from "./geometry-steps";

export function parseTextMarkdown(source: string, options: TextParseOptions) {
  return finishGeometrySteps(parseTextMarkdownSteps(source, options));
}

export function applyTextEdit(state: TextSourceState, change: TextSourceChange) {
  return finishGeometrySteps(applyTextEditsSteps(state, [change]));
}

export function toggleTextMarkdownMark(...args: Parameters<typeof toggleTextMarkdownMarkSteps>) {
  return finishGeometrySteps(toggleTextMarkdownMarkSteps(...args));
}

export function forceTextMarkdownMark(...args: Parameters<typeof forceTextMarkdownMarkSteps>) {
  return finishGeometrySteps(forceTextMarkdownMarkSteps(...args));
}
