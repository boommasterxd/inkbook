import { parseOpeningTag } from "../../documents/svg-tag";
import { invalid, unsupported } from "./source-values";

export interface InkSvgMetadata {
  readonly engine: "ink-canvas" | "tldraw";
  readonly json: string;
  readonly lineHeight?: number;
  readonly transcript?: string;
}

interface XmlTag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

const GRAPHIC_TAGS = new Set([
  "svg",
  "g",
  "path",
  "defs",
  "pattern",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "style",
  "title",
  "desc",
  "clipPath",
  "mask",
  "use",
  "marker",
]);

/** Source graphics are never mounted. Only the authoritative editable metadata is imported. */
export function readInkSvgMetadataSteps(input: string): Generator<void, InkSvgMetadata> {
  return new InkMetadataReader(input).readSteps();
}

class InkMetadataReader {
  readonly #stack: string[] = [];
  readonly #payloads = new Map<string, string>();
  #inkAttributes: ReadonlyMap<string, string> | undefined;
  #metadataSeen = false;
  #rootSeen = false;
  #cursor = 0;
  #textStart = 0;

  public constructor(readonly input: string) {}

  public *readSteps(): Generator<void, InkSvgMetadata> {
    while (this.#cursor < this.input.length) {
      if (this.input[this.#cursor] === "<") {
        yield* this.#readMarkupSteps();
        this.#textStart = this.#cursor;
        continue;
      }
      if (this.#stack.length === 0 && !/\s/u.test(this.input[this.#cursor]!))
        invalid("Text outside SVG root.");
      this.#cursor += 1;
      if (this.#cursor % 16_384 === 0) yield;
    }
    return this.#finish();
  }

  *#readMarkupSteps(): Generator<void> {
    const parent = this.#stack[this.#stack.length - 1];
    if (parent === "ink-canvas" || parent === "tldraw" || parent === "transcript") {
      if (!this.input.startsWith(`</${parent}`, this.#cursor))
        invalid("Nested Ink metadata markup.");
      this.#payloads.set(
        parent,
        yield* decodeXmlTextSteps(this.input.slice(this.#textStart, this.#cursor)),
      );
    }
    if (this.input.startsWith("<!--", this.#cursor)) {
      this.#cursor = yield* scanTerminator(this.input, this.#cursor + 4, "-->");
      return;
    }
    if (this.input.startsWith("<?xml ", this.#cursor) && !this.#rootSeen) {
      this.#cursor = yield* scanTerminator(this.input, this.#cursor + 6, "?>");
      return;
    }
    if (this.input.startsWith("<!", this.#cursor) || this.input.startsWith("<?", this.#cursor)) {
      invalid("XML declarations, entities and processing instructions are unsupported.");
    }
    const end = yield* scanTagEnd(this.input, this.#cursor + 1);
    const tag = yield* readTagSteps(
      this.input.slice(this.#cursor, end),
      this.#stack.includes("metadata"),
    );
    this.#acceptTag(tag, parent);
    this.#cursor = end;
  }

  #acceptTag(tag: XmlTag, parent: string | undefined): void {
    if (tag.closing) {
      if (this.#stack.pop() !== tag.name) invalid("Unbalanced SVG tags.");
      return;
    }
    if (this.#stack.length === 0) {
      if (this.#rootSeen || tag.name !== "svg") invalid("Expected a single SVG root.");
      this.#rootSeen = true;
    }
    if (tag.name === "metadata") {
      if (this.#metadataSeen || this.#stack.length !== 1) invalid("Ambiguous SVG metadata.");
      this.#metadataSeen = true;
    } else if (parent === "metadata") this.#acceptMetadataChild(tag);
    else if (!GRAPHIC_TAGS.has(tag.name)) unsupported(`Unsupported SVG element: ${tag.name}.`);
    if (!tag.selfClosing) {
      this.#stack.push(tag.name);
      if (this.#stack.length > 32) invalid("SVG nesting exceeds the import limit.");
    }
  }

  #acceptMetadataChild(tag: XmlTag): void {
    if (!["ink", "ink-canvas", "tldraw", "transcript"].includes(tag.name))
      unsupported(`Unsupported Ink metadata element: ${tag.name}.`);
    if (tag.name === "ink") {
      if (this.#inkAttributes !== undefined) invalid("Duplicate Ink marker.");
      this.#inkAttributes = tag.attributes;
    } else if (this.#payloads.has(tag.name)) invalid("Duplicate Ink payload.");
    if (tag.name === "ink-canvas") {
      const version = tag.attributes.get("version");
      if (version !== undefined && !/^(?:0\.\d+\.\d+|1(?:\.\d+\.\d+)?)$/u.test(version)) {
        unsupported("Unsupported InkCanvas envelope version.");
      }
    }
  }

  #finish(): InkSvgMetadata {
    if (!this.#rootSeen || this.#stack.length !== 0) invalid("Incomplete SVG document.");
    if (this.#inkAttributes?.get("file-type") !== "inkWriting")
      unsupported("Only Ink handwriting files can be imported.");
    if (this.#payloads.has("ink-canvas") === this.#payloads.has("tldraw"))
      invalid("Ambiguous Ink payload.");
    const engine = this.#payloads.has("ink-canvas") ? "ink-canvas" : "tldraw";
    const lineHeightText = this.#inkAttributes.get("writing-line-height");
    const transcript = this.#payloads.get("transcript") ?? this.#inkAttributes.get("transcript");
    return {
      engine,
      json: this.#payloads.get(engine)!,
      ...(lineHeightText === undefined ? {} : { lineHeight: Number(lineHeightText) }),
      ...(transcript === undefined ? {} : { transcript }),
    };
  }
}

function* scanTerminator(input: string, start: number, token: string): Generator<void, number> {
  for (let cursor = start; cursor < input.length; cursor += 1) {
    if (input.startsWith(token, cursor)) return cursor + token.length;
    if (cursor % 16_384 === 0) yield;
  }
  return invalid("Unterminated XML declaration or comment.");
}

function* scanTagEnd(input: string, start: number): Generator<void, number> {
  let quote = "";
  for (let cursor = start; cursor < input.length; cursor += 1) {
    const character = input[cursor]!;
    if (quote !== "") {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return cursor + 1;
    else if (character === "<") invalid("Malformed SVG tag.");
    if (cursor % 16_384 === 0) yield;
  }
  return invalid("Unterminated SVG tag.");
}

function* readTagSteps(markup: string, metadata: boolean): Generator<void, XmlTag> {
  const closing = markup.startsWith("</");
  const match = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s|\/?>)/u.exec(markup);
  if (match === null) invalid("Invalid SVG tag name.");
  const name = match[1]!;
  if (closing) {
    if (!/^<\/[A-Za-z][A-Za-z0-9-]*\s*>$/u.test(markup)) invalid("Invalid closing tag.");
    return { name, closing, selfClosing: false, attributes: new Map() };
  }
  if (!metadata)
    return { name, closing, selfClosing: markup.endsWith("/>"), attributes: new Map() };
  if (markup.length > 65_536) invalid("Ink metadata tag exceeds the import limit.");
  const parsed = parseOpeningTag(markup, 0);
  if (parsed !== null)
    return { name, closing, selfClosing: parsed.selfClosing, attributes: parsed.attributes };
  const attributes = new Map<string, string>();
  let cursor = name.length + 1;
  const attribute = /\s+([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/uy;
  while (cursor < markup.length) {
    if (/^\s*\/?>$/u.test(markup.slice(cursor))) break;
    attribute.lastIndex = cursor;
    const found = attribute.exec(markup);
    if (found === null || attributes.has(found[1]!))
      invalid("Invalid or duplicate metadata attribute.");
    attributes.set(found[1]!, yield* decodeXmlTextSteps(found[2] ?? found[3]!));
    cursor = attribute.lastIndex;
  }
  return { name, closing, selfClosing: markup.endsWith("/>"), attributes };
}

export function* decodeXmlTextSteps(input: string): Generator<void, string> {
  const chunks: string[] = [];
  let parts: string[] = [];
  let literalStart = 0;
  let chunkStart = 0;
  for (let cursor = 0; cursor < input.length; cursor += 1) {
    if (input[cursor] === "<") invalid("Unexpected markup in Ink payload.");
    if (input[cursor] === "&") {
      parts.push(input.slice(literalStart, cursor));
      const end = input.indexOf(";", cursor + 1);
      if (end < 0 || end - cursor > 12) invalid("Invalid XML entity.");
      parts.push(decodeEntity(input.slice(cursor + 1, end)));
      cursor = end;
      literalStart = end + 1;
    }
    if (cursor - chunkStart >= 16_384) {
      parts.push(input.slice(literalStart, cursor + 1));
      chunks.push(parts.join(""));
      parts = [];
      literalStart = cursor + 1;
      chunkStart = cursor + 1;
      yield;
    }
  }
  parts.push(input.slice(literalStart));
  chunks.push(parts.join(""));
  return chunks.join("");
}

function decodeEntity(entity: string): string {
  const known: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  if (Object.prototype.hasOwnProperty.call(known, entity)) return known[entity]!;
  const numeric = /^#(?:([0-9]{1,7})|x([0-9a-fA-F]{1,6}))$/u.exec(entity);
  if (numeric === null) invalid("Named XML entities are unsupported.");
  const code = Number.parseInt(numeric[1] ?? numeric[2]!, numeric[1] === undefined ? 16 : 10);
  if (
    (code < 0x20 && code !== 9 && code !== 10 && code !== 13) ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff) ||
    code === 0xfffe ||
    code === 0xffff
  ) {
    invalid("Invalid XML character reference.");
  }
  return String.fromCodePoint(code);
}
