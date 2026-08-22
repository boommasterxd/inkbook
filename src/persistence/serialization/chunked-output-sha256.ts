const WORD_MODULUS = 0x1_0000_0000;

const INITIAL_STATE = fractionalPrimeWords(8, "square");
const ROUND_CONSTANTS = fractionalPrimeWords(64, "cube");

export class ChunkedSha256 {
  readonly #block = new Uint8Array(64);
  readonly #schedule = new Uint32Array(64);
  readonly #state = new Uint32Array(INITIAL_STATE);
  readonly #working = new Uint32Array(8);
  #blockLength = 0;
  #digest: string | null = null;
  #totalBytes = 0;

  public get totalBytes(): number {
    return this.#totalBytes;
  }

  public update(input: Uint8Array): void {
    if (this.#digest !== null) throw new Error("Cannot update a finalized SHA-256 digest.");
    if (input.byteLength === 0) return;
    if (!Number.isSafeInteger(this.#totalBytes + input.byteLength)) {
      throw new RangeError("SHA-256 input exceeds the supported byte length.");
    }
    this.#totalBytes += input.byteLength;
    let offset = 0;
    if (this.#blockLength > 0) offset = this.#completeBufferedBlock(input);
    while (offset + 64 <= input.byteLength) {
      compress(this.#state, this.#schedule, this.#working, input, offset);
      offset += 64;
    }
    if (offset < input.byteLength) {
      this.#block.set(input.subarray(offset), 0);
      this.#blockLength = input.byteLength - offset;
    }
  }

  public digestHex(): string {
    if (this.#digest !== null) return this.#digest;
    this.#block[this.#blockLength] = 0x80;
    this.#blockLength += 1;
    if (this.#blockLength > 56) {
      this.#block.fill(0, this.#blockLength);
      compress(this.#state, this.#schedule, this.#working, this.#block, 0);
      this.#blockLength = 0;
    }
    this.#block.fill(0, this.#blockLength, 56);
    writeBitLength(this.#block, this.#totalBytes);
    compress(this.#state, this.#schedule, this.#working, this.#block, 0);
    this.#digest = [...this.#state].map((word) => word.toString(16).padStart(8, "0")).join("");
    return this.#digest;
  }

  #completeBufferedBlock(input: Uint8Array): number {
    const copied = Math.min(64 - this.#blockLength, input.byteLength);
    this.#block.set(input.subarray(0, copied), this.#blockLength);
    this.#blockLength += copied;
    if (this.#blockLength === 64) {
      compress(this.#state, this.#schedule, this.#working, this.#block, 0);
      this.#blockLength = 0;
    }
    return copied;
  }
}

function fractionalPrimeWords(count: number, root: "cube" | "square"): Uint32Array {
  const output = new Uint32Array(count);
  let candidate = 2;
  let index = 0;
  while (index < count) {
    if (isPrime(candidate)) {
      const value = root === "square" ? Math.sqrt(candidate) : Math.cbrt(candidate);
      output[index] = Math.floor((value - Math.floor(value)) * WORD_MODULUS) >>> 0;
      index += 1;
    }
    candidate += 1;
  }
  return output;
}

function isPrime(candidate: number): boolean {
  for (let divisor = 2; divisor * divisor <= candidate; divisor += 1) {
    if (candidate % divisor === 0) return false;
  }
  return true;
}

function writeBitLength(block: Uint8Array, totalBytes: number): void {
  const bitLength = BigInt(totalBytes) * 8n;
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  view.setUint32(56, Number((bitLength >> 32n) & 0xffff_ffffn));
  view.setUint32(60, Number(bitLength & 0xffff_ffffn));
}

function compress(
  state: Uint32Array,
  words: Uint32Array,
  working: Uint32Array,
  input: Uint8Array,
  offset: number,
): void {
  const view = new DataView(input.buffer, input.byteOffset + offset, 64);
  for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4);
  for (let index = 16; index < words.length; index += 1) {
    const old = words[index - 15]!;
    const recent = words[index - 2]!;
    const oldMix = rotate(old, 7) ^ rotate(old, 18) ^ (old >>> 3);
    const recentMix = rotate(recent, 17) ^ rotate(recent, 19) ^ (recent >>> 10);
    words[index] = (words[index - 16]! + oldMix + words[index - 7]! + recentMix) >>> 0;
  }

  working.set(state);
  for (let index = 0; index < words.length; index += 1) {
    const a = working[0]!;
    const b = working[1]!;
    const c = working[2]!;
    const e = working[4]!;
    const f = working[5]!;
    const g = working[6]!;
    const h = working[7]!;
    const eMix = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
    const choose = (e & f) ^ (~e & g);
    const first = (h + eMix + choose + ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
    const aMix = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    working[7] = working[6]!;
    working[6] = working[5]!;
    working[5] = working[4]!;
    working[4] = working[3]!;
    working[3] = working[2]!;
    working[2] = working[1]!;
    working[1] = working[0]!;
    working[0] = (first + aMix + majority) >>> 0;
    working[4] = (working[4] + first) >>> 0;
  }
  for (let index = 0; index < state.length; index += 1) {
    state[index] = (state[index]! + working[index]!) >>> 0;
  }
}

function rotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
