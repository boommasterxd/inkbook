import type {
  TextParagraphStyleV2,
  TextRangeStyleV2,
  TextStyleRangeV2,
  TextStyleV2,
} from "../schema/public";

export type TextMarkdownMark = "bold" | "italic" | "strikethrough" | "code";

export interface TextSourceRange {
  readonly start: number;
  readonly end: number;
}

export interface TextSourceChange extends TextSourceRange {
  readonly insert: string;
}

export interface TextSourceState {
  readonly source: string;
  readonly ranges: readonly TextStyleRangeV2[];
  readonly paragraphs: readonly TextParagraphStyleV2[];
}

export interface TextParseOptions {
  readonly style: TextStyleV2 & TextRangeStyleV2;
  readonly ranges?: readonly TextStyleRangeV2[];
  readonly paragraphs?: readonly TextParagraphStyleV2[];
}

export interface TextMarkdownRun extends TextSourceRange {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly kind: "text" | "math";
  readonly text: string;
  readonly latex?: string;
  readonly display?: boolean;
  readonly style: TextStyleV2 & TextRangeStyleV2;
  readonly code: boolean;
}

export interface TextListMarker {
  readonly ordered: boolean;
  readonly number: number;
  readonly depth: number;
  readonly marker: string;
}

export interface TextMarkdownTableCell extends TextSourceRange {
  readonly contentStart: number;
  readonly contentEnd: number;
}

export interface TextMarkdownTableRow extends TextSourceRange {
  readonly cells: readonly TextMarkdownTableCell[];
}

export interface TextMarkdownTable {
  readonly alignments: readonly ("left" | "center" | "right")[];
  readonly rows: readonly TextMarkdownTableRow[];
  readonly delimiter: TextSourceRange;
}

export interface TextMarkdownBlock extends TextSourceRange {
  readonly kind: "paragraph" | "heading" | "list-item" | "math" | "table";
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly headingLevel?: number;
  readonly list?: TextListMarker;
  readonly table?: TextMarkdownTable;
  readonly alignment: TextParagraphStyleV2["alignment"];
  readonly sourceAlignments?: readonly TextParagraphStyleV2[];
  readonly runs: readonly TextMarkdownRun[];
  readonly spans: readonly TextMarkSpan[];
}

export interface TextMarkdownDocument {
  readonly source: string;
  readonly blocks: readonly TextMarkdownBlock[];
  readonly spans: readonly TextMarkSpan[];
}

export interface TextMarkSpan extends TextSourceRange {
  readonly mark: TextMarkdownMark;
  readonly contentStart: number;
  readonly contentEnd: number;
}

export interface TextInlineToken extends TextSourceRange {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly text: string;
  readonly kind: "text" | "math";
  readonly display?: boolean;
  readonly marks: readonly TextMarkdownMark[];
}
