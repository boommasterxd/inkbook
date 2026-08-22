export interface BoundedStringBuildResult {
  readonly fragmentCount: number;
  readonly value: string;
}

/** Builds decoded strings with one fixed UTF-16 scratch block and bounded output fragments. */
export class BoundedJsonStringBuilder {
  readonly #scratch: Uint16Array;
  #fragments: string[] = [];
  #length = 0;

  public constructor(scratchCharacters: number) {
    this.#scratch = new Uint16Array(scratchCharacters);
  }

  public reset(): void {
    this.#fragments = [];
    this.#length = 0;
  }

  public appendCodeUnit(codeUnit: number): void {
    this.#scratch[this.#length] = codeUnit;
    this.#length += 1;
    if (this.#length === this.#scratch.length) this.#flush();
  }

  public appendInput(input: string, start: number, end: number): void {
    for (let position = start; position < end; position += 1) {
      this.appendCodeUnit(input.charCodeAt(position));
    }
  }

  public finish(): BoundedStringBuildResult {
    this.#flush();
    return { fragmentCount: this.#fragments.length, value: this.#fragments.join("") };
  }

  #flush(): void {
    if (this.#length === 0) return;
    this.#fragments.push(String.fromCharCode(...this.#scratch.subarray(0, this.#length)));
    this.#length = 0;
  }
}
