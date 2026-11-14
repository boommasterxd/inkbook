import {
  validateEditableSafeSvgPreludeSteps,
  type SafeSvgPrelude,
} from "../../documents/safe-svg-validator";
import type { DocumentCodecResult } from "../types";
import { inputFailure } from "./chunked-input-utils";

const MAXIMUM_PREFIX_CHARACTERS = 48 * 1024 * 1024 + 64 * 1024;
interface CompletePrelude {
  readonly prelude: SafeSvgPrelude;
  readonly remaining: string;
}

/** Keep large font CSS bounded and inspect a completed prefix exactly once. */
export class SvgInputPrelude {
  #prefix = "";
  #scanOffset = 0;

  public clear(): void {
    this.#prefix = "";
    this.#scanOffset = 0;
  }

  public *write(input: string): Generator<void, DocumentCodecResult<CompletePrelude | null>> {
    const capacity = MAXIMUM_PREFIX_CHARACTERS - this.#prefix.length;
    this.#prefix += input.slice(0, capacity);
    let end = this.#prefix.indexOf(">", this.#scanOffset);
    while (end >= 0) {
      this.#scanOffset = end + 1;
      const candidate = this.#prefix.slice(0, end + 1);
      const opening = candidate.lastIndexOf("<");
      if (candidate.startsWith("<metadata ", opening)) {
        const prelude = yield* validateEditableSafeSvgPreludeSteps(candidate);
        if (prelude !== null) {
          const remaining = this.#prefix.slice(end + 1) + input.slice(capacity);
          this.clear();
          return { ok: true, value: { prelude, remaining } };
        }
      }
      end = this.#prefix.indexOf(">", end + 1);
    }
    const fontStart = this.#prefix.indexOf('<style id="inkbook-fonts">');
    if (this.#prefix.length > 64 * 1024 && (fontStart < 0 || fontStart > 64 * 1024))
      return prefixFailure();
    return input.length > capacity ? prefixFailure() : { ok: true, value: null };
  }
}

function prefixFailure(): DocumentCodecResult<never> {
  return inputFailure("invalid-svg", "Document SVG prefix exceeds its bounded envelope.");
}
