import { INTERACTION_REFRESH_PROFILE } from "../../performance/interaction-refresh-profile";
import { FakeScheduler } from "../../unit/rendering/scene/fakes";

/** Profile timestamps drive admission; actual observed work consumes its simulated slice. */
export class InteractionProfileScheduler extends FakeScheduler {
  public constructor() {
    super(INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs);
  }

  public override runNext(): void {
    this.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    super.runNext();
  }
}
