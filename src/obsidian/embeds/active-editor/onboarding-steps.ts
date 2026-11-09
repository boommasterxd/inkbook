import { type Translator, type MessageKey } from "../../../domain/localization";
import type { CoachStep } from "./onboarding-coach";

export function createOnboardingSteps(t: Translator): readonly CoachStep[] {
  return [
    step(t, "step-1", "finger-drawing", { optional: true }),
    step(t, "step-2", "undo", {}),
    step(t, "step-3", "select", {}),
    step(t, "step-4", "eraser", {}),
    step(t, "step-5", "draw", {}),
    step(t, "step-6", "highlighter", {}),
    step(t, "step-7", "straight-highlighter", {}),
    step(t, "step-8", "shape", {}),
    step(t, "step-9", "shape-picker", {}),
    step(t, "step-10", "style", {}),
    step(t, "step-11", "lock", {}),
    step(t, "step-12", "overflow", {}),
    step(t, "step-13", "paste", { previewContext: true }),
    step(t, "step-14", "copy", { previewContext: true }),
    step(t, "step-15", "cut", { previewContext: true }),
    step(t, "step-16", "delete", { previewContext: true }),
    step(t, "step-17", "overflow", {}),
  ];
}

function step(
  t: Translator,
  id: string,
  action: CoachStep["action"],
  flags: Pick<CoachStep, "optional" | "previewContext">,
): CoachStep {
  const text = (part: string) => t(`editor.tour.${id}.${part}` as MessageKey);
  return {
    action,
    ...flags,
    title: text("title"),
    lines: [text("line-1"), text("line-2")],
    description: text("description"),
  };
}
