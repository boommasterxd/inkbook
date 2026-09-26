import { hashRuntimeInput } from "./runtime-input-hash";
import { parseRuntimeInput } from "./parse-runtime-input";
import type { RuntimeSliceContext } from "./types";

interface OutputProof {
  readonly outputHash: string;
  readonly revision: number;
}

/** Scalar proofs come only from this runtime's complete validation or serialization. */
export class VerifiedOutputProofs {
  #input: OutputProof | null = null;
  #export: OutputProof | null = null;
  #epoch = 0;

  public get epoch(): number {
    return this.#epoch;
  }

  public clear(): void {
    this.#epoch += 1;
    this.#input = null;
    this.#export = null;
  }

  public acceptInput(outputHash: string, revision: number, epoch: number): void {
    if (epoch === this.#epoch) this.#input = { outputHash, revision };
  }

  public acceptExport(outputHash: string, revision: number, epoch: number): void {
    if (epoch === this.#epoch) this.#export = { outputHash, revision };
  }

  public async verify(
    input: string | Uint8Array,
    context?: RuntimeSliceContext,
  ): Promise<OutputProof | null> {
    const epoch = this.#epoch;
    if (this.#input !== null || this.#export !== null) {
      const hash = await hashRuntimeInput(input, context);
      const proof = [this.#input, this.#export].find(
        (entry) => entry !== null && entry.outputHash === hash,
      );
      context?.signal.throwIfAborted();
      if (epoch === this.#epoch && proof != null) {
        this.#input = proof;
        return { ...proof };
      }
    }
    const parsed = await parseRuntimeInput(input, context);
    context?.signal.throwIfAborted();
    if (!parsed.ok) return null;
    const proof = { outputHash: parsed.value.hash, revision: parsed.value.snapshot.revision };
    this.acceptInput(proof.outputHash, proof.revision, epoch);
    return proof;
  }
}
