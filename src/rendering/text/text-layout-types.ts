import type {
  TextLayoutV2,
  TextLayoutLineV2,
  TextMathLayoutV2,
  TextStyleV2,
  TextTableLayoutV2,
} from "../../domain/schema/public";
import type { FrameCancellation, WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { TextMarkdownBlock, TextMarkdownDocument } from "../../domain/text/text-types";

export interface PreparedTextTable {
  readonly table: TextTableLayoutV2;
  readonly lines: TextLayoutLineV2[];
  readonly math: TextMathLayoutV2[];
  readonly rows: {
    readonly top: number;
    readonly lineStart: number;
    readonly lineEnd: number;
    readonly mathStart: number;
    readonly mathEnd: number;
    readonly runStart: number;
    readonly runEnd: number;
  }[];
}

export interface MathSvgTree<Node> {
  kind(node: Node): string;
  attribute(node: Node, name: string): string | null;
  children(node: Node): readonly Node[];
}

export interface MeasuredText {
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
  readonly fontResourceId?: string;
  readonly lineHeight?: number;
}

export interface TextMeasurer {
  measure(text: string, style: TextStyleV2, fontResourceId?: string): MeasuredText;
  resolveFontResourceId?(
    style: TextStyleV2,
    range?: { readonly start: number; readonly end: number },
  ): string | undefined;
  fontResourceBoundaries?(start: number, end: number): readonly number[];
}

export type TextFontResourceResolver = NonNullable<TextMeasurer["resolveFontResourceId"]>;
export type TextFontResourceBoundaries = NonNullable<TextMeasurer["fontResourceBoundaries"]>;

export interface ResolvedTextMath extends MeasuredText {
  readonly height: number;
  readonly paths: TextMathLayoutV2["paths"];
}

export interface TextMathStyle {
  readonly bold?: boolean;
}

export interface TextMathResolver {
  resolve(
    latex: string,
    display: boolean,
    fontSize: number,
    signal?: FrameCancellation,
    availableWidth?: number,
    style?: TextMathStyle,
  ): Promise<ResolvedTextMath>;
}

export interface TextLayoutRequest {
  readonly document: TextMarkdownDocument;
  readonly width: number;
  readonly style: TextStyleV2;
  readonly padding?: number;
  readonly baseFontResourceId?: string;
}

export interface TextLineStrut {
  readonly style: TextStyleV2;
  readonly fontResourceId?: string;
}

export interface TextLayoutPorts {
  readonly measure: TextMeasurer;
  readonly scheduler: WorkScheduler;
  readonly math?: TextMathResolver;
  readonly signal?: FrameCancellation;
  readonly onTablePrepared?: (block: TextMarkdownBlock, layout: PreparedTextTable) => void;
}

export interface TextLayoutResult {
  readonly layout: TextLayoutV2;
  readonly height: number;
}

export function assertTextLayoutActive(signal?: FrameCancellation): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Text layout cancelled.");
}

export async function admitTextLayout(
  ports: Pick<TextLayoutPorts, "scheduler" | "signal">,
): Promise<void> {
  assertTextLayoutActive(ports.signal);
  const handoff = ports.scheduler.checkpoint(ports.signal, "frame");
  if (handoff) await handoff;
  assertTextLayoutActive(ports.signal);
}
