import type { Localization } from "../../../domain/localization";
/** Shared orientation for the scan, review and conversion stages. */
export function renderImportStep(
  container: HTMLElement,
  step: 1 | 2 | 3,
  localization: Localization,
): void {
  const labels = {
    1: localization.t("import.stepFind"),
    2: localization.t("import.stepReview"),
    3: localization.t("import.stepSwitch"),
  };
  container.createEl("p", {
    cls: "inkbook-import-step",
    text: localization.t("import.step", {
      step: localization.number(step),
      total: localization.number(3),
      label: labels[step],
    }),
  });
}

export function renderImportIntroduction(container: HTMLElement, localization: Localization): void {
  const steps = container.createEl("ol", { cls: "inkbook-import-journey" });
  for (const [title, description] of [
    [localization.t("import.journeyFind"), localization.t("import.journeyFindDescription")],
    [localization.t("import.stepReview"), localization.t("import.journeyReviewDescription")],
    [localization.t("import.stepSwitch"), localization.t("import.journeySwitchDescription")],
  ] as const) {
    const item = steps.createEl("li");
    item.createEl("strong", { text: title });
    item.createEl("p", { text: description });
  }
}
