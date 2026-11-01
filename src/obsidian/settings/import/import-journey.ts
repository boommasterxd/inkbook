/** Shared orientation for the scan, review and conversion stages. */
export function renderImportStep(container: HTMLElement, step: 1 | 2 | 3): void {
  const labels = { 1: "Find handwriting", 2: "Review the results", 3: "Switch the embeds" };
  container.createEl("p", {
    cls: "inkbook-import-step",
    text: `Step ${step} of 3 · ${labels[step]}`,
  });
}

export function renderImportIntroduction(container: HTMLElement): void {
  const steps = container.createEl("ol", { cls: "inkbook-import-journey" });
  for (const [title, description] of [
    [
      "Find your handwriting",
      "We look for supported Obsidian Ink handwriting linked from your notes. Scanning changes no files.",
    ],
    ["Review the results", "Check the files we found and anything that may look different."],
    [
      "Switch the embeds",
      "When you confirm, we create editable Inkbook copies in the same folders and update your notes.",
    ],
  ] as const) {
    const item = steps.createEl("li");
    item.createEl("strong", { text: title });
    item.createEl("p", { text: description });
  }
}
