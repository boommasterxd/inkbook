import { classifyPenRole, hasPenContact } from "./pointer-validation";

type PenRole = ReturnType<typeof classifyPenRole>;

interface PenButtonEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly button: number;
  readonly buttons: number;
  readonly pressure?: number;
  readonly timeStamp: number;
}

const RELEASE_GRACE_MS = 300;

/** One pen's temporary tool state, including short synthetic release gaps. */
export class PenButtonSession {
  #activeRole: PenRole = "normal";
  #activePointerId: number | undefined;
  #activePointerType: string | undefined;
  #mouseContactFallback = false;
  #releaseAt: number | undefined;
  #rawButtonHeld = false;

  public get role(): PenRole {
    return this.#activeRole;
  }

  public get pointerId(): number | undefined {
    return this.#activePointerId;
  }

  public get pendingReleaseAt(): number | undefined {
    return this.#releaseAt;
  }

  public update(event: PenButtonEvent, phase: "down" | "move" | "up"): PenRole {
    if (event.pointerType !== "pen" && event.pointerType !== "mouse") return "normal";
    const rawRole = this.#eventRole(event, phase);
    if (event.pointerType === "mouse" && rawRole !== "eraser") {
      if (this.#activePointerType === "mouse" && event.pointerId === this.#activePointerId) {
        this.reset();
      }
      return "normal";
    }
    this.expire(event.timeStamp);
    if (
      event.pointerId !== this.#activePointerId ||
      event.pointerType !== this.#activePointerType
    ) {
      this.reset();
    }
    this.#activePointerId = event.pointerId;
    this.#activePointerType = event.pointerType;
    if (phase === "down" || (event.buttons & 32) !== 0) {
      this.#mouseContactFallback = event.pointerType === "mouse" && (event.buttons & 32) === 0;
    }
    const wasRawHeld = this.#rawButtonHeld;
    this.#rawButtonHeld = rawRole !== "normal";
    if (rawRole !== "normal") {
      this.#activeRole = rawRole;
      this.#releaseAt = undefined;
    } else if (hasPenContact(event)) {
      this.#releaseAt = undefined;
      if (wasRawHeld) this.#activeRole = "normal";
    } else if (this.#activeRole !== "normal") {
      this.#releaseAt ??= event.timeStamp + RELEASE_GRACE_MS;
    }
    return this.#activeRole;
  }

  public expire(now: number): void {
    if (this.#releaseAt !== undefined && now >= this.#releaseAt) this.reset();
  }

  #eventRole(event: PenButtonEvent, phase: "down" | "move" | "up"): PenRole {
    const rawRole = classifyPenRole({
      pointerType: event.pointerType === "pen" ? "pen" : "mouse",
      button:
        phase === "down" || (event.pointerType === "pen" && phase === "move") ? event.button : -1,
      buttons: event.buttons,
    });
    if (event.pointerType !== "mouse" || phase !== "move") return rawRole;
    const retainedContact =
      this.#activePointerType === "mouse" &&
      event.pointerId === this.#activePointerId &&
      this.#mouseContactFallback &&
      event.button !== 5 &&
      hasPenContact(event);
    return retainedContact ? "eraser" : rawRole;
  }

  public reset(): void {
    this.#activeRole = "normal";
    this.#activePointerId = undefined;
    this.#activePointerType = undefined;
    this.#mouseContactFallback = false;
    this.#releaseAt = undefined;
    this.#rawButtonHeld = false;
  }
}
