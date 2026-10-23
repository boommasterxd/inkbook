import { hashConfirmedRuntimeInput, hashRuntimeInput } from "./runtime-input-hash";
import { parseRuntimeInput } from "./parse-runtime-input";
import type { RuntimeSliceContext } from "../types";
import { parseSafeSvgRoot } from "../../../documents/svg-envelope-root";
import { parseOpeningTag } from "../../../documents/svg-tag";

export interface OutputVerificationOptions {
  readonly confirmedBase?: OutputProof;
  readonly expectedBytes?: number;
  readonly versionPolicy?: "current" | "editable";
}

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
    options: OutputVerificationOptions = {},
  ): Promise<OutputProof | null> {
    const epoch = this.#epoch;
    const prefix =
      typeof input === "string"
        ? input.slice(0, 4096)
        : new TextDecoder().decode(input.subarray(0, 4096));
    const tag = parseOpeningTag(prefix, 0);
    const root = tag === null ? null : parseSafeSvgRoot(tag, options.versionPolicy ?? "editable");
    if (root === null) return null;
    if (
      this.#input !== null ||
      this.#export !== null ||
      options.confirmedBase !== undefined ||
      options.expectedBytes !== undefined
    ) {
      const hashInput =
        options.confirmedBase === undefined ? hashRuntimeInput : hashConfirmedRuntimeInput;
      const hash = await hashInput(input, context, options.expectedBytes);
      if (hash === null) return null;
      const proof = [this.#input, this.#export, options.confirmedBase].find(
        (entry) => entry != null && entry.outputHash === hash && entry.revision === root.revision,
      );
      context?.signal.throwIfAborted();
      if (epoch === this.#epoch && proof != null) {
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
