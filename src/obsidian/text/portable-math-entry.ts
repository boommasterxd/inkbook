import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { PortableMathRenderer } from "./portable-math-renderer";

export function createPortableMathRenderer(scheduler: WorkScheduler): PortableMathRenderer {
  return new PortableMathRenderer(scheduler);
}
