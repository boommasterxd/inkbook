import type { ChangeDesc } from "@codemirror/state";
import type { TextElementV2, TextStyleV2 } from "../../../domain/schema/public";
import type { TextSourceRange } from "../../../domain/text/text-types";

export interface TextFontBinding extends TextSourceRange {
  readonly id: string;
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
}

export function textBaseFontBinding(element: TextElementV2): TextFontBinding | undefined {
  const id = element.layout.baseFontResourceId;
  return id === undefined
    ? undefined
    : {
        id,
        start: 0,
        end: 0,
        family: element.style.fontFamily,
        bold: element.style.bold,
        italic: element.style.italic,
      };
}

export function* textFontBindingsSteps(element: TextElementV2): Generator<void, TextFontBinding[]> {
  const bindings: TextFontBinding[] = [];
  for (const line of element.layout.lines)
    for (const run of line.runs) {
      if (run.fontResourceId !== undefined && run.start < run.end) {
        const style = { ...element.style, ...run.style };
        bindings.push({
          start: run.start,
          end: run.end,
          id: run.fontResourceId,
          family: style.fontFamily,
          bold: style.bold,
          italic: style.italic,
        });
      }
      yield;
    }
  return bindings;
}

/** Native composed mapping keeps unchanged source bindings without copying all layout runs per input. */
export class TextFontBindings {
  #bindings: readonly TextFontBinding[] = [];
  #changes: ChangeDesc | undefined;
  #id: string | undefined;
  #snapshot: TextFontBindingLookup | undefined;
  #base: TextFontBinding | undefined;

  public get id(): string | undefined {
    return this.#id;
  }
  public get retained(): readonly TextFontBinding[] {
    return this.#bindings;
  }
  public get base(): TextFontBinding | undefined {
    return this.#base;
  }

  public adopt(id: string, bindings: readonly TextFontBinding[], base?: TextFontBinding): void {
    this.#id = id;
    this.#bindings = bindings;
    this.#changes = undefined;
    this.#snapshot = undefined;
    this.#base = base;
  }

  public map(changes: ChangeDesc): void {
    this.#changes = this.#changes?.composeDesc(changes) ?? changes;
    this.#snapshot = undefined;
  }

  public snapshot(): TextFontBindingLookup {
    return (this.#snapshot ??= new TextFontBindingLookup(
      this.#bindings,
      this.#changes,
      this.#base,
    ));
  }

  public clear(): void {
    this.#bindings = [];
    this.#changes = undefined;
    this.#id = undefined;
    this.#snapshot = undefined;
    this.#base = undefined;
  }
}

export class TextFontBindingLookup {
  public constructor(
    private readonly bindings: readonly TextFontBinding[],
    private readonly changes?: ChangeDesc,
    private readonly base?: TextFontBinding,
  ) {}

  public resolve(style: TextStyleV2, range?: TextSourceRange): string | undefined {
    if (range === undefined || (range.start === range.end && this.bindings.length === 0)) {
      return this.base !== undefined && sameFontStyle(this.base, style) ? this.base.id : undefined;
    }
    const index = this.#first(range.start);
    const binding = this.bindings[index];
    if (
      binding === undefined ||
      this.#start(binding) > range.start ||
      this.#end(binding) < range.end
    )
      return undefined;
    return sameFontStyle(binding, style) ? binding.id : undefined;
  }

  public boundaries(start: number, end: number): readonly number[] {
    const result: number[] = [];
    let previous = start;
    for (let index = this.#first(start); index < this.bindings.length; index += 1) {
      const binding = this.bindings[index]!;
      const from = this.#start(binding);
      if (from >= end) break;
      const to = this.#end(binding);
      for (const position of [from, to])
        if (position > previous && position < end) {
          result.push(position);
          previous = position;
        }
    }
    return result;
  }

  #first(position: number): number {
    let low = 0;
    let high = this.bindings.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#end(this.bindings[middle]!) <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  #start(binding: TextFontBinding): number {
    return this.changes?.mapPos(binding.start, 1) ?? binding.start;
  }
  #end(binding: TextFontBinding): number {
    return this.changes?.mapPos(binding.end, -1) ?? binding.end;
  }
}

function sameFontStyle(binding: TextFontBinding, style: TextStyleV2): boolean {
  return (
    binding.family === style.fontFamily &&
    binding.bold === style.bold &&
    binding.italic === style.italic
  );
}
