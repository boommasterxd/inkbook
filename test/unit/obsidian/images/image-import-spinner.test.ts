// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { MotionPreference } from "../../../../src/rendering/motion/transitions";
import { animateOwnedElement } from "../../../../src/obsidian/runtime/element-motion";
import { ImageImportSpinner } from "../../../../src/obsidian/images/image-import-spinner";

vi.mock("../../../../src/obsidian/runtime/element-motion", () => ({
  animateOwnedElement: vi.fn(),
}));

it("owns at most one animation and pauses for reduced motion, hidden documents and completion", () => {
  const icon = document.createElement("span");
  Object.defineProperty(icon, "animate", { value: () => undefined });
  document.body.append(icon);
  const cancel = vi.fn();
  vi.mocked(animateOwnedElement).mockReturnValue({
    cancel,
    finished: Promise.resolve(),
  } as unknown as ReturnType<typeof animateOwnedElement>);
  let hidden = false;
  const visibility = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  let preference: MotionPreference = "full";
  let notify = (): void => undefined;
  const unsubscribe = vi.fn();
  const spinner = new ImageImportSpinner(icon, {
    readMotion: () => preference,
    observeMotion: (callback) => {
      notify = callback;
      return unsubscribe;
    },
  });
  spinner.setActive(true);
  spinner.setActive(true);
  expect(animateOwnedElement).toHaveBeenCalledOnce();
  preference = "reduced";
  notify();
  expect(cancel).toHaveBeenCalledTimes(1);
  preference = "full";
  notify();
  expect(animateOwnedElement).toHaveBeenCalledTimes(2);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(cancel).toHaveBeenCalledTimes(2);
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(animateOwnedElement).toHaveBeenCalledTimes(3);
  spinner.setActive(false);
  expect(cancel).toHaveBeenCalledTimes(3);
  spinner.setActive(true);
  expect(animateOwnedElement).toHaveBeenCalledTimes(4);
  spinner.dispose();
  spinner.dispose();
  spinner.setActive(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(cancel).toHaveBeenCalledTimes(4);
  expect(animateOwnedElement).toHaveBeenCalledTimes(4);
  expect(unsubscribe).toHaveBeenCalledOnce();
  visibility.mockRestore();
  icon.remove();
});
