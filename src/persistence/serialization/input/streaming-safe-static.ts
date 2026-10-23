import { parseOpeningTag, skipWhitespace } from "../../documents/svg-tag";
import {
  accountPath,
  isBandGroup,
  validPressureGroup,
  validatePathAttributesSteps,
  type SvgTotals,
} from "../../documents/safe-svg-validator";

const BANDS = ["inkbook-background", "inkbook-highlights", "inkbook-content"];
// One legal path can contain 16 MiB of data; attributes have a separate bounded allowance.
const MAXIMUM_TAG_CHARACTERS = 16 * 1024 * 1024 + 4096;

/** Validates supplied presentation syntax without reconstructing snapshot geometry. */
export class StreamingSafeStaticValidator {
  public readonly failure = "invalid-svg";
  readonly #checkpoint: () => Promise<void> | undefined;
  readonly #totals: SvgTotals = { commands: 0, groups: 0, pathBytes: 0, paths: 0 };
  #pending = "";
  #maximumPendingCharacters = 0;
  #band = 0;
  #insideBand = false;
  #pressurePaths: number | null = null;
  #closed = false;
  #valid = true;

  public constructor(checkpoint: () => Promise<void> | undefined) {
    this.#checkpoint = checkpoint;
  }

  public async write(input: string): Promise<boolean> {
    if (!this.#valid) return false;
    let cursor = 0;
    while (cursor < input.length) {
      if (this.#pending.length === 0) cursor = skipWhitespace(input, cursor);
      if (cursor === input.length) break;
      const end = input.indexOf(">", cursor);
      const next = end < 0 ? input.length : end + 1;
      this.#pending += input.slice(cursor, next);
      cursor = next;
      this.#maximumPendingCharacters = Math.max(
        this.#maximumPendingCharacters,
        this.#pending.length,
      );
      if (this.#pending.length > MAXIMUM_TAG_CHARACTERS) return this.#reject();
      if (end < 0) break;
      const token = this.#pending;
      this.#pending = "";
      if (!(await this.#consume(token))) return this.#reject();
    }
    return true;
  }

  public get maximumRetainedCharacters(): number {
    return this.#maximumPendingCharacters;
  }

  public finish(): boolean {
    return this.#valid && this.#closed && this.#pending.length === 0;
  }

  async #consume(token: string): Promise<boolean> {
    if (this.#closed) return false;
    if (!this.#insideBand) {
      if (this.#band === BANDS.length) {
        this.#closed = token === "</svg>";
        return this.#closed;
      }
      const tag = parseOpeningTag(token, 0);
      this.#insideBand = isBandGroup(tag, BANDS[this.#band]!) && tag?.next === token.length;
      return this.#insideBand;
    }
    if (token === "</g>") return this.#closeGroup();
    const tag = parseOpeningTag(token, 0);
    if (tag === null || tag.next !== token.length) return false;
    if (tag.name === "g") {
      if (!validPressureGroup(tag, BANDS[this.#band]!, this.#pressurePaths, this.#totals))
        return false;
      this.#pressurePaths = 0;
      return true;
    }
    if (tag.name !== "path" || !tag.selfClosing) return false;
    const validation = validatePathAttributesSteps(tag.attributes);
    let step = validation.next();
    while (!step.done) {
      const pending = this.#checkpoint();
      if (pending !== undefined) await pending;
      step = validation.next();
    }
    if (step.value === null) return false;
    if (this.#pressurePaths !== null && ++this.#pressurePaths > 1) return false;
    return accountPath(this.#totals, step.value, tag.attributes.get("d")!);
  }

  #closeGroup(): boolean {
    if (this.#pressurePaths !== null) {
      if (this.#pressurePaths === 0) return false;
      this.#pressurePaths = null;
    } else {
      this.#insideBand = false;
      this.#band += 1;
    }
    return true;
  }

  #reject(): false {
    this.#valid = false;
    return false;
  }
}
