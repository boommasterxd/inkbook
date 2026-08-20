import type {
  ImmutableSourceDocumentV1,
  SourceOffsetMapV1,
} from "../../application/source-coordination";
import {
  ANNOTATION_MARKER_KEY,
  SIDECAR_LOCATOR_KEY,
} from "./vault-sidecar/marker";

const MAX_FRONTMATTER_UTF16 = 1_048_576;
const COMPARISON_CHUNK_UTF16 = 65_536;
const YAML_QUOTE_LENGTH = 2;

interface FrontmatterEvidenceV1 {
  readonly bodyStart: number;
  readonly locator: string | null;
  readonly marker: boolean | null;
}

export function provesOwnedMarkerTransitionV1(input: {
  readonly expectedLocator: string;
  readonly offsetMap: SourceOffsetMapV1;
  readonly prior: ImmutableSourceDocumentV1;
  readonly replacement: ImmutableSourceDocumentV1;
}): boolean {
  const prior = readFrontmatter(input.prior);
  const replacement = readFrontmatter(input.replacement);
  if (
    replacement?.marker !== true ||
    replacement.locator !== input.expectedLocator ||
    (prior?.marker === true && prior.locator === input.expectedLocator)
  ) {
    return false;
  }
  const priorBodyStart = prior?.bodyStart ?? 0;
  if (
    !changesStayInsideFrontmatter(
      input.offsetMap,
      priorBodyStart,
      replacement.bodyStart,
    )
  ) {
    return false;
  }
  return equalDocumentSuffixes(
    input.prior,
    priorBodyStart,
    input.replacement,
    replacement.bodyStart,
  );
}

function readFrontmatter(
  document: ImmutableSourceDocumentV1,
): FrontmatterEvidenceV1 | null {
  const inspectedLength = Math.min(document.utf16Length, MAX_FRONTMATTER_UTF16);
  let prefix: string;
  try {
    prefix = document.sliceString(0, inspectedLength);
  } catch {
    return null;
  }
  const openingEnd = lineEnd(prefix, 0);
  if (openingEnd === null || prefix.slice(0, openingEnd.contentEnd) !== "---") {
    return null;
  }
  let cursor = openingEnd.next;
  let marker: boolean | null = null;
  let locator: string | null = null;
  let markerSeen = false;
  let locatorSeen = false;
  while (cursor < prefix.length) {
    const line = lineEnd(prefix, cursor);
    if (line === null) return null;
    const text = prefix.slice(cursor, line.contentEnd);
    if (text === "---" || text === "...") {
      return Object.freeze({
        bodyStart: line.next,
        locator,
        marker,
      });
    }
    const parsed = parseTopLevelValue(text);
    if (parsed?.key === ANNOTATION_MARKER_KEY) {
      if (markerSeen) return null;
      markerSeen = true;
      marker = parsed.value === "true" ? true : null;
    } else if (parsed?.key === SIDECAR_LOCATOR_KEY) {
      if (locatorSeen) return null;
      locatorSeen = true;
      locator = parseYamlString(parsed.value);
    }
    cursor = line.next;
  }
  return null;
}

function lineEnd(
  value: string,
  start: number,
): { readonly contentEnd: number; readonly next: number } | null {
  if (start > value.length) return null;
  const newline = value.indexOf("\n", start);
  if (newline < 0) {
    return Object.freeze({ contentEnd: value.length, next: value.length });
  }
  const contentEnd =
    newline > start && value[newline - 1] === "\r" ? newline - 1 : newline;
  return Object.freeze({ contentEnd, next: newline + 1 });
}

function parseTopLevelValue(
  line: string,
): { readonly key: string; readonly value: string } | null {
  if (line.length === 0 || /^\s/u.test(line)) return null;
  const separator = line.indexOf(":");
  if (separator <= 0) return null;
  return Object.freeze({
    key: line.slice(0, separator).trim(),
    value: line.slice(separator + 1).trim(),
  });
}

function parseYamlString(value: string): string | null {
  if (value.length === 0) return "";
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value
      .slice(1, value.length - (YAML_QUOTE_LENGTH - 1))
      .replaceAll("''", "'");
  }
  return /[#[\]{}&,*!|>@`]/u.test(value) ? null : value;
}

function changesStayInsideFrontmatter(
  offsetMap: SourceOffsetMapV1,
  priorBodyStart: number,
  replacementBodyStart: number,
): boolean {
  return offsetMap.spans.every(
    (span) =>
      span.oldFromUtf16 <= span.oldToUtf16 &&
      span.newFromUtf16 <= span.newToUtf16 &&
      span.oldToUtf16 <= priorBodyStart &&
      span.newToUtf16 <= replacementBodyStart,
  );
}

function equalDocumentSuffixes(
  prior: ImmutableSourceDocumentV1,
  priorStart: number,
  replacement: ImmutableSourceDocumentV1,
  replacementStart: number,
): boolean {
  const priorLength = prior.utf16Length - priorStart;
  if (priorLength !== replacement.utf16Length - replacementStart) return false;
  try {
    for (
      let offset = 0;
      offset < priorLength;
      offset += COMPARISON_CHUNK_UTF16
    ) {
      const length = Math.min(COMPARISON_CHUNK_UTF16, priorLength - offset);
      if (
        prior.sliceString(priorStart + offset, priorStart + offset + length) !==
        replacement.sliceString(
          replacementStart + offset,
          replacementStart + offset + length,
        )
      ) {
        return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}
