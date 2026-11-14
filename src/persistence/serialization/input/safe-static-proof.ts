import { FILE_SCHEMA_LIMITS } from "../../../domain/schema/public";

/** Scalar evidence from an owned, completely validated safe SVG producer. */
export class SafeStaticProof {
  readonly #outputHash: string;
  readonly #totalBytes: number;
  readonly #unadjustedTextRuns: number | undefined;

  private constructor(outputHash: string, totalBytes: number, unadjustedTextRuns?: number) {
    this.#outputHash = outputHash;
    this.#totalBytes = totalBytes;
    this.#unadjustedTextRuns = unadjustedTextRuns;
    Object.freeze(this);
  }

  public static isAuthentic(value: unknown): value is SafeStaticProof {
    return value instanceof SafeStaticProof && #outputHash in value;
  }

  /** Internal producer boundary; never construct evidence from persisted metadata. */
  public static fromTrustedProducer(
    outputHash: string,
    totalBytes: number,
    unadjustedTextRuns?: number,
  ): SafeStaticProof {
    if (
      !/^[0-9a-f]{64}$/u.test(outputHash) ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 1 ||
      totalBytes > FILE_SCHEMA_LIMITS.totalInputBytes ||
      (unadjustedTextRuns !== undefined &&
        (!Number.isSafeInteger(unadjustedTextRuns) ||
          unadjustedTextRuns < 0 ||
          unadjustedTextRuns > FILE_SCHEMA_LIMITS.totalInputBytes))
    ) {
      throw new TypeError("Safe SVG proof must describe bounded complete input bytes.");
    }
    return new SafeStaticProof(outputHash, totalBytes, unadjustedTextRuns);
  }

  public get outputHash(): string {
    return this.#outputHash;
  }

  public get totalBytes(): number {
    return this.#totalBytes;
  }

  public get unadjustedTextRuns(): number | undefined {
    return this.#unadjustedTextRuns;
  }

  public matches(outputHash: string, totalBytes: number): boolean {
    return this.#outputHash === outputHash && this.#totalBytes === totalBytes;
  }
}
