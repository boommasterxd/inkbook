import axe from "axe-core";
import { expect } from "vitest";
import { assertAccessibleSemantics } from "../accessibility";

export function imageSourceButton(name: RegExp): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(".inkbook-image-import-source")!;
  axe.setup(button.ownerDocument);
  try {
    expect(axe.commons.text.accessibleText(button)).toMatch(name);
    return button;
  } finally {
    axe.teardown();
  }
}

export async function assertImageDialogSemantics(expectedPasses: readonly string[]): Promise<void> {
  const body = document.querySelector<HTMLElement>(".inkbook-image-dialog")!;
  expect([...body.querySelectorAll("button")].every((button) => button.type === "button")).toBe(
    true,
  );
  await assertAccessibleSemantics(body.closest<HTMLElement>("[role=dialog]")!, expectedPasses);
}
