import type { InkElementV1 } from "../schema/public";

import type { DeepReadonly, ImmutableInkElement } from "./types";

export function immutableElement(element: InkElementV1): ImmutableInkElement {
  return freezeValue(cloneValue(element)) as ImmutableInkElement;
}

/** The caller must relinquish every mutable alias after transferring ownership. */
export function takeImmutableElementOwnership(element: InkElementV1): ImmutableInkElement {
  return freezeValue(element);
}

export function mutableElement(element: ImmutableInkElement): InkElementV1 {
  return cloneValue(element) as InkElementV1;
}

function cloneValue(value: unknown): unknown {
  if (value instanceof Float64Array) return new Float64Array(value);
  if (Array.isArray(value)) {
    const clone = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      clone[index] = item !== null && typeof item === "object" ? cloneValue(item) : item;
    }
    return clone;
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) clone[key] = cloneValue(child);
    return clone;
  }
  return value;
}

function freezeValue<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== "object") return value as DeepReadonly<T>;
  // Typed-array elements cannot be frozen in ECMAScript. Their immutability is
  // provided by exclusive ownership and readonly domain types instead.
  if (value instanceof Float64Array) return value as DeepReadonly<T>;
  if (Object.isFrozen(value)) return value as DeepReadonly<T>;
  if (Array.isArray(value)) {
    const arrayValue: unknown[] = value;
    for (const child of arrayValue) {
      if (child !== null && typeof child === "object") freezeValue(child);
    }
    Object.freeze(value);
    return value as DeepReadonly<T>;
  }
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") freezeValue(child);
  }
  Object.freeze(value);
  return value as DeepReadonly<T>;
}
