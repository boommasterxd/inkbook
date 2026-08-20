import { isValidNoteIdentity } from "../recovery/validation";
import type { NoteIdentityV1 } from "./types";
import {
  freezeNoteIdentity,
  resolveRekeyedNoteIdentity,
} from "./value-objects";

export class HostHistoryIdentityAuthorityV1 {
  #current: NoteIdentityV1;

  public constructor(identity: NoteIdentityV1) {
    if (!isValidNoteIdentity(identity)) {
      throw new TypeError("The host history note identity is invalid.");
    }
    this.#current = freezeNoteIdentity(identity);
  }

  public get current(): NoteIdentityV1 {
    return this.#current;
  }

  public rekey(
    prior: NoteIdentityV1,
    replacement: NoteIdentityV1,
    unavailable: boolean,
  ): boolean {
    const identity = resolveRekeyedNoteIdentity(
      this.#current,
      prior,
      replacement,
    );
    if (unavailable || identity === null) return false;
    this.#current = identity;
    return true;
  }
}
