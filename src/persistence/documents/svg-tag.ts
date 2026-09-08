const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/u;

interface ParsedTag {
  readonly attributes: ReadonlyMap<string, string>;
  readonly name: string;
  readonly next: number;
  readonly selfClosing: boolean;
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

export function skipWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && isWhitespace(input[cursor]!)) {
    cursor += 1;
  }
  return cursor;
}

function parseQuotedValue(input: string, start: number): { next: number; value: string } | null {
  if (input[start] !== '"') {
    return null;
  }
  const end = input.indexOf('"', start + 1);
  if (end < 0) {
    return null;
  }
  const value = input.slice(start + 1, end);
  return value.includes("<") || value.includes("&") ? null : { next: end + 1, value };
}

export function parseOpeningTag(input: string, start: number): ParsedTag | null {
  if (input[start] !== "<" || input[start + 1] === "/") {
    return null;
  }
  let cursor = start + 1;
  const nameStart = cursor;
  while (cursor < input.length && /[A-Za-z0-9-]/u.test(input[cursor]!)) {
    cursor += 1;
  }
  const name = input.slice(nameStart, cursor);
  if (!ATTRIBUTE_NAME.test(name)) {
    return null;
  }
  const attributes = new Map<string, string>();
  while (cursor < input.length) {
    const beforeWhitespace = cursor;
    cursor = skipWhitespace(input, cursor);
    if (input.startsWith("/>", cursor)) {
      return { attributes, name, next: cursor + 2, selfClosing: true };
    }
    if (input[cursor] === ">") {
      return { attributes, name, next: cursor + 1, selfClosing: false };
    }
    if (cursor === beforeWhitespace) {
      return null;
    }
    const attributeStart = cursor;
    while (cursor < input.length && /[A-Za-z0-9-]/u.test(input[cursor]!)) {
      cursor += 1;
    }
    const attribute = input.slice(attributeStart, cursor);
    if (!ATTRIBUTE_NAME.test(attribute) || attributes.has(attribute)) {
      return null;
    }
    cursor = skipWhitespace(input, cursor);
    if (input[cursor] !== "=") {
      return null;
    }
    cursor = skipWhitespace(input, cursor + 1);
    const quoted = parseQuotedValue(input, cursor);
    if (quoted === null) {
      return null;
    }
    attributes.set(attribute, quoted.value);
    cursor = quoted.next;
  }
  return null;
}

export function hasExactAttributes(
  attributes: ReadonlyMap<string, string>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return (
    attributes.size === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => attributes.get(key) === value)
  );
}
