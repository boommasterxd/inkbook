import { expect } from "vitest";
import { assertAccessibleSemantics } from "../accessibility";

export async function assertImageDialogSemantics(expectedPasses: readonly string[]): Promise<void> {
  const body = document.querySelector<HTMLElement>(".inkbook-image-dialog")!;
  expect([...body.querySelectorAll("button")].every((button) => button.type === "button")).toBe(
    true,
  );
  await assertAccessibleSemantics(body.closest<HTMLElement>("[role=dialog]")!, expectedPasses);
}
