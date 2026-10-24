// @vitest-environment happy-dom

import type { IFetchInterceptor, Window as HappyDomWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const environment = (window as unknown as HappyDomWindow).happyDOM;
const initialInterceptor = environment.settings.fetch.interceptor;
const svgNamespace = "http://www.w3.org/2000/svg";

afterEach(async () => {
  document.body.replaceChildren();
  document.body.removeAttribute("data-script-executed");
  await environment.waitUntilComplete();
  environment.settings.fetch.interceptor = initialInterceptor;
});

function createFrame(): HTMLIFrameElement {
  const frame = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "iframe",
  ) as HTMLIFrameElement;
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("inert", "");
  document.body.append(frame);
  return frame;
}

describe("scene test environment isolation", () => {
  it("provides a blank inert child document for retained SVG rendering", () => {
    const frame = createFrame();
    const child = frame.contentDocument!;
    const graphic = child.createElementNS(svgNamespace, "svg");
    const label = child.createElementNS(svgNamespace, "text");
    label.textContent = "Retained drawing";
    graphic.append(label);
    child.body.append(graphic);

    expect(child.URL).toBe("about:blank");
    expect(child.body.textContent).toBe("Retained drawing");
    expect(graphic.ownerDocument).toBe(child);
    expect(document.body.textContent).toBe("");
  });

  it("blocks external child navigation without fetching or losing the drawing document", async () => {
    // Return an inert response if isolation regresses so this check never reaches the network.
    const request = vi.fn<NonNullable<IFetchInterceptor["beforeAsyncRequest"]>>(
      async ({ window: owner }) => new owner.Response("", { status: 200 }),
    );
    environment.settings.fetch.interceptor = { beforeAsyncRequest: request };
    const frame = createFrame();
    const child = frame.contentDocument!;
    child.body.textContent = "Retained drawing";

    frame.contentWindow!.location.assign("https://unexpected.invalid/scene");
    await environment.waitUntilComplete();

    expect(request).not.toHaveBeenCalled();
    expect(frame.contentDocument).toBe(child);
    expect(child.URL).toBe("about:blank");
    expect(child.body.textContent).toBe("Retained drawing");
  });

  it("keeps inserted scripts inert in the host and child documents", async () => {
    const child = createFrame().contentDocument!;
    for (const owner of [document, child]) {
      const script = owner.createElementNS("http://www.w3.org/1999/xhtml", "script");
      script.append(
        owner.createTextNode('document.body.setAttribute("data-script-executed", "true")'),
      );
      owner.body.append(script);
    }
    await environment.waitUntilComplete();

    expect(document.body.hasAttribute("data-script-executed")).toBe(false);
    expect(child.body.hasAttribute("data-script-executed")).toBe(false);
  });
});
