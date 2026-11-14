/** Stable, portable CSS family names never include user-controlled display labels. */
export function fontCssFamily(family: string): string {
  if (!/^[a-z][a-z0-9-]{0,95}$/.test(family)) {
    throw new RangeError("Invalid font family identifier.");
  }
  return `inkbook-${family}`;
}

/** A laid-out run binds this alias to one immutable embedded binary. */
export function fontResourceCssFamily(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new RangeError("Invalid font resource identity.");
  return `inkbook-face-${id}`;
}
