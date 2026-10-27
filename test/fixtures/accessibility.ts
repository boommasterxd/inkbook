import axe, { type Result } from "axe-core";

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// happy-dom has no layout engine. These rules require native Obsidian verification.
const nativeRules = new Set([
  "avoid-inline-spacing",
  "color-contrast",
  "css-orientation-lock",
  "label-content-name-mismatch",
  "link-in-text-block",
  "p-as-heading",
  "scrollable-region-focusable",
  "target-size",
]);
const semanticRules = [
  ...axe
    .getRules(wcagTags)
    .map((rule) => rule.ruleId)
    .filter((id) => !nativeRules.has(id)),
  "aria-dialog-name",
];

function findings(results: readonly Result[]): string {
  return JSON.stringify(
    results.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
    null,
    2,
  );
}

/** Blocks on semantic violations, unresolved checks and unexpectedly untested controls. */
export async function assertAccessibleSemantics(
  surface: HTMLElement,
  expectedPasses: readonly string[],
): Promise<void> {
  if (!surface.isConnected) throw new Error("Accessibility surface must be mounted.");
  const result = await axe.run(surface, {
    runOnly: { type: "rule", values: semanticRules },
  });
  if (result.violations.length || result.incomplete.length) {
    throw new Error(
      `axe-core ${axe.version} semantic accessibility failed:\n${findings([
        ...result.violations,
        ...result.incomplete,
      ])}`,
    );
  }
  for (const id of expectedPasses) {
    if (!result.passes.some((rule) => rule.id === id && rule.nodes.length > 0)) {
      throw new Error(`axe-core ${axe.version} did not evaluate expected rule ${id}.`);
    }
  }
}
