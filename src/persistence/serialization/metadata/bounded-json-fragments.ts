const STRING_CHUNK = 16 * 1024;

/** Preserve canonical property order while bounding individual string encoding work. */
export function* boundedJsonFragments(value: unknown): Iterable<string> {
  if (typeof value === "string") {
    yield '"';
    for (let start = 0; start < value.length;) {
      let end = Math.min(value.length, start + STRING_CHUNK);
      const last = value.charCodeAt(end - 1);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index > 0) yield ",";
      yield* boundedJsonFragments(value[index]);
    }
    yield "]";
  } else if (typeof value === "object" && value !== null) {
    yield "{";
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!first) yield ",";
      first = false;
      yield `${JSON.stringify(key)}:`;
      yield* boundedJsonFragments(item);
    }
    yield "}";
  } else yield JSON.stringify(value);
}
