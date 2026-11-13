import { parseOpeningTag, skipWhitespace } from "../../documents/svg-tag";
import { FILE_SCHEMA_LIMITS } from "../../../domain/schema/public";
import {
  MAXIMUM_TEXT_MARKUP_CHARACTERS,
  validateTextElementSteps,
} from "../../documents/safe-svg-text";
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
  readonly #version: number;
  readonly #totals: SvgTotals = { commands: 0, groups: 0, pathBytes: 0, paths: 0 };
  #pending = "";
  #text = "";
  #textElements = 0;
  #maximumPendingCharacters = 0;
  #band = 0;
  #insideBand = false;
  #pressurePaths: number | null = null;
  #closed = false;
  #valid = true;

  public constructor(checkpoint: () => Promise<void> | undefined, version = 2) {
    this.#checkpoint = checkpoint;
    this.#version = version;
  }

  public async write(input: string): Promise<boolean> {
    if (!this.#valid) return false;
    let cursor = 0;
    while (cursor < input.length) {
      if (this.#pending.length === 0 && this.#text.length === 0)
        cursor = skipWhitespace(input, cursor);
      if (cursor === input.length) break;
      const end = input.indexOf(">", cursor);
      const next = end < 0 ? input.length : end + 1;
      this.#pending += input.slice(cursor, next);
      cursor = next;
      this.#maximumPendingCharacters = Math.max(
        this.#maximumPendingCharacters,
        this.#pending.length + this.#text.length,
      );
      if (this.#pending.length > MAXIMUM_TAG_CHARACTERS) return this.#reject();
      if (
        this.#text.length > 0 &&
        this.#pending.length + this.#text.length > MAXIMUM_TEXT_MARKUP_CHARACTERS
      )
        return this.#reject();
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

  public get unadjustedTextRuns(): number {
    return this.#totals.unadjustedTextRuns ?? 0;
  }

  public get hasUnadjustedText(): boolean {
    return this.unadjustedTextRuns > 0;
  }

  public finish(): boolean {
    return this.#valid && this.#closed && this.#pending.length === 0;
  }

  async #consume(token: string): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#text.length > 0) return this.#consumeText(token);
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
    if (tag.name === "text") {
      return this.#openText(tag, token);
    }
    if (tag.name === "g") {
      if (!validPressureGroup(tag, BANDS[this.#band]!, this.#pressurePaths, this.#totals))
        return false;
      this.#pressurePaths = 0;
      return true;
    }
    if (tag.name !== "path" || !tag.selfClosing) return false;
    const commands = await this.#runValidation(
      validatePathAttributesSteps(tag.attributes, undefined, undefined, this.#version),
    );
    if (commands === null) return false;
    if (this.#pressurePaths !== null && ++this.#pressurePaths > 1) return false;
    return accountPath(this.#totals, commands, tag.attributes.get("d")!);
  }

  #openText(tag: NonNullable<ReturnType<typeof parseOpeningTag>>, token: string): boolean {
    if (this.#version < 2 || this.#band !== 2 || this.#pressurePaths !== null || tag.selfClosing)
      return false;
    this.#text = token;
    return true;
  }

  async #consumeText(token: string): Promise<boolean> {
    this.#text += token;
    if (!token.endsWith("</text>")) return true;
    const next = await this.#runValidation(
      validateTextElementSteps(this.#text, 0, {
        open: () => undefined,
        close: () => undefined,
        unadjustedText: () => {
          this.#totals.unadjustedTextRuns = this.unadjustedTextRuns + 1;
        },
      }),
    );
    const valid = next === this.#text.length && ++this.#textElements <= FILE_SCHEMA_LIMITS.elements;
    this.#text = "";
    return valid;
  }

  async #runValidation(validation: Generator<void, number | null>): Promise<number | null> {
    let step = validation.next();
    while (!step.done) {
      const pending = this.#checkpoint();
      if (pending !== undefined) await pending;
      step = validation.next();
    }
    return step.value;
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
