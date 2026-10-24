import { expect } from "vitest";

export function expectInertIsolatedFrame(frame: HTMLIFrameElement) {
  expect(frame.localName).toBe("iframe");
  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(frame.getAttribute("aria-hidden")).toBe("true");
  expect(frame.hasAttribute("inert")).toBe(true);
  expect(frame.tabIndex).toBe(-1);
  expect(frame.hasAttribute("src")).toBe(false);
  expect(frame.hasAttribute("srcdoc")).toBe(false);
}
