const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export class SampleBase64Writer {
  readonly #parts: string[] = [];
  #word = 0;
  #bytes = 0;
  #chunk = "";

  public append(value: number): void {
    this.#word = this.#word * 256 + value;
    this.#bytes += 1;
    if (this.#bytes !== 3) return;
    this.#chunk += this.#encodeWord(this.#word);
    if (this.#chunk.length >= 4096) {
      this.#parts.push(this.#chunk);
      this.#chunk = "";
    }
    this.#word = 0;
    this.#bytes = 0;
  }

  public finish(): string {
    if (this.#bytes === 1) {
      this.#chunk += this.#encodeWord(this.#word * 65536).slice(0, 2) + "==";
    } else if (this.#bytes === 2) {
      this.#chunk += this.#encodeWord(this.#word * 256).slice(0, 3) + "=";
    }
    this.#parts.push(this.#chunk);
    return this.#parts.join("");
  }

  #encodeWord(word: number): string {
    return (
      ALPHABET[(word >>> 18) & 63]! +
      ALPHABET[(word >>> 12) & 63]! +
      ALPHABET[(word >>> 6) & 63]! +
      ALPHABET[word & 63]!
    );
  }
}

/** Reads canonical Base64 without allocating a decoded byte buffer. */
export class SampleBase64Reader {
  readonly byteLength: number;
  #position = 0;
  #word = 0;
  #bytes = 0;
  #readBytes = 0;
  readonly #padding: number;

  public constructor(readonly input: string) {
    if (input.length === 0 || input.length % 4 !== 0) this.#invalid();
    const padding = input.endsWith("==") ? 2 : input.endsWith("=") ? 1 : 0;
    this.#padding = padding;
    const finalValue = this.#digit(input.length - padding - 1);
    if ((padding === 2 && (finalValue & 15) !== 0) || (padding === 1 && (finalValue & 3) !== 0)) {
      this.#invalid();
    }
    this.byteLength = (input.length / 4) * 3 - padding;
  }

  public read(): number {
    if (this.#readBytes >= this.byteLength) this.#invalid();
    if (this.#bytes === 0) this.#readWord();
    this.#bytes -= 1;
    this.#readBytes += 1;
    return (this.#word >>> (this.#bytes * 8)) & 255;
  }

  public get remainingBytes(): number {
    return this.byteLength - this.#readBytes;
  }

  #readWord(): void {
    this.#word = 0;
    for (let index = 0; index < 4; index += 1) {
      const position = this.#position++;
      const isPadding =
        this.input[position] === "=" && position >= this.input.length - this.#padding;
      this.#word = this.#word * 64 + (isPadding ? 0 : this.#digit(position));
    }
    this.#bytes = 3;
  }

  #digit(position: number): number {
    const character = this.input[position];
    const code = character?.charCodeAt(0) ?? -1;
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    if (character === "+") return 62;
    if (character === "/") return 63;
    return this.#invalid();
  }

  #invalid(): never {
    throw new RangeError("Invalid compact stroke Base64.");
  }
}
