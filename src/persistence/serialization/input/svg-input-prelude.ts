import {
  validateEditableSafeSvgPreludeSteps,
  type SafeSvgPrelude,
} from "../../documents/safe-svg-validator";
import type { DocumentCodecResult } from "../types";
import { inputFailure } from "./chunked-input-utils";

const MAXIMUM_PREFIX_CHARACTERS = 64 * 1024 * 1024;
const ORDINARY_PREFIX_CHARACTERS = 64 * 1024;
const FONT_START = '<style id="inkbook-fonts">';
const IMAGE_START = '<defs id="inkbook-images">';
const METADATA_START = "<metadata ";
const RESOURCE_CARRY = Math.max(FONT_START.length, IMAGE_START.length) - 1;
const PREFIX_PARTS_PER_BLOCK = 64;
interface CompletePrelude {
  readonly prelude: SafeSvgPrelude;
  readonly remaining: string;
}

/** Keep embedded font and raster resources bounded and inspect a completed prefix exactly once. */
export class SvgInputPrelude {
  readonly #blocks: string[] = [];
  readonly #parts: string[] = [];
  #characters = 0;
  #openingPrefix = "";
  #resourceCarry = "";
  #fontStart = -1;
  #imageStart = -1;

  public clear(): void {
    this.#blocks.length = 0;
    this.#parts.length = 0;
    this.#characters = 0;
    this.#openingPrefix = "";
    this.#resourceCarry = "";
    this.#fontStart = -1;
    this.#imageStart = -1;
  }

  public *write(input: string): Generator<void, DocumentCodecResult<CompletePrelude | null>> {
    const capacity = MAXIMUM_PREFIX_CHARACTERS - this.#characters;
    const fragment = input.slice(0, capacity);
    const previousCharacters = this.#characters;
    this.#retain(fragment);
    this.#findResources(fragment, previousCharacters);
    let start = 0;
    let end = fragment.indexOf(">");
    while (end >= 0) {
      this.#readOpening(fragment.slice(start, end + 1));
      if (this.#openingPrefix === METADATA_START) {
        const candidate = this.#blocks
          .concat(this.#parts)
          .join("")
          .slice(0, previousCharacters + end + 1);
        const prelude = yield* validateEditableSafeSvgPreludeSteps(candidate);
        if (prelude !== null) {
          const remaining = fragment.slice(end + 1) + input.slice(capacity);
          this.clear();
          return { ok: true, value: { prelude, remaining } };
        }
      }
      start = end + 1;
      end = fragment.indexOf(">", start);
    }
    this.#readOpening(fragment.slice(start));
    const resourceStart = this.#fontStart < 0 ? this.#imageStart : this.#fontStart;
    if (
      this.#characters > ORDINARY_PREFIX_CHARACTERS &&
      (resourceStart < 0 || resourceStart > ORDINARY_PREFIX_CHARACTERS)
    )
      return prefixFailure();
    return input.length > capacity ? prefixFailure() : { ok: true, value: null };
  }

  #retain(fragment: string): void {
    this.#characters += fragment.length;
    if (fragment.length === 0) return;
    this.#parts.push(fragment);
    if (this.#parts.length === PREFIX_PARTS_PER_BLOCK) {
      this.#blocks.push(this.#parts.join(""));
      this.#parts.length = 0;
    }
  }

  #readOpening(fragment: string): void {
    const opening = fragment.lastIndexOf("<");
    if (opening >= 0)
      this.#openingPrefix = fragment.slice(opening, opening + METADATA_START.length);
    else if (this.#openingPrefix.length < METADATA_START.length)
      this.#openingPrefix += fragment.slice(0, METADATA_START.length - this.#openingPrefix.length);
  }

  #findResources(fragment: string, offset: number): void {
    const probe = this.#resourceCarry + fragment;
    const base = offset - this.#resourceCarry.length;
    if (this.#fontStart < 0) {
      const start = probe.indexOf(FONT_START);
      if (start >= 0) this.#fontStart = base + start;
    }
    if (this.#imageStart < 0) {
      const start = probe.indexOf(IMAGE_START);
      if (start >= 0) this.#imageStart = base + start;
    }
    this.#resourceCarry = probe.slice(-RESOURCE_CARRY);
  }
}

function prefixFailure(): DocumentCodecResult<never> {
  return inputFailure("invalid-svg", "Document SVG prefix exceeds its bounded envelope.");
}
