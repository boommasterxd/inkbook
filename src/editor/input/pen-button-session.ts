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
    if (event.pointerType !== "pen") return "normal";
    this.expire(event.timeStamp);
    if (event.pointerId !== this.#activePointerId) this.reset();
    this.#activePointerId = event.pointerId;
    const rawRole = classifyPenRole({
      pointerType: "pen",
      button: phase === "up" ? -1 : event.button,
      buttons: event.buttons,
    });
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

  public reset(): void {
    this.#activeRole = "normal";
    this.#activePointerId = undefined;
    this.#releaseAt = undefined;
    this.#rawButtonHeld = false;
  }
}
