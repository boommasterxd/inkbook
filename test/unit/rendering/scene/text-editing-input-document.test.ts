// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { TextEditingInputDocument } from "../../../../src/rendering/scene/text-editing-input-document";
import { SVG_NAMESPACE } from "../../../../src/rendering/scene/constants";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture() {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  const group = document.createElementNS(SVG_NAMESPACE, "g");
  group.setAttribute("transform", "rotate(30)");
  svg.append(group);
  document.body.append(svg);
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  const assets = { ready, prepare: vi.fn(async () => undefined), dispose: vi.fn() };
  const invalidated = vi.fn();
  const input = new TextEditingInputDocument({
    group,
    prepareDocument: () => assets,
    onInvalidated: invalidated,
  });
  const frame = group.querySelector<HTMLIFrameElement>("iframe.inkbook-text-input-frame")!;
  return { input, frame, group, assets, invalidated, resolve };
}

it("owns a single accessible unrotated input document until late readiness and disposal", async () => {
  const state = fixture();
  expect(state.frame.contentDocument).toBe(state.input.document);
  expect(state.input.container.ownerDocument).not.toBe(document);
  expect(state.frame.hasAttribute("aria-hidden")).toBe(false);
  expect(state.frame.hasAttribute("inert")).toBe(false);
  expect(state.frame.title).toBe("Text");
  expect(state.input.container.closest("foreignObject")).toBeNull();
  const ownerWindow = state.input.document.defaultView!;
  const html = ownerWindow.getComputedStyle(state.input.document.documentElement);
  const body = ownerWindow.getComputedStyle(state.input.document.body);
  expect(html.overflow).toBe("clip");
  expect(html.height).toBe("100%");
  expect(body.overflow).toBe("clip");
  expect(body.position).toBe("fixed");
  expect(body.height).toBe("100%");
  expect(Number.parseFloat(body.inset)).toBe(0);
  expect(ownerWindow.getComputedStyle(state.input.container).position).toBe("relative");
  expect(state.group.querySelectorAll("iframe")).toHaveLength(1);
  state.frame.dispatchEvent(new Event("load"));
  expect(state.invalidated).not.toHaveBeenCalled();
  await state.input.prepare();
  expect(state.assets.prepare).toHaveBeenCalledOnce();
  state.input.dispose();
  state.input.dispose();
  state.resolve();
  await state.input.ready;
  expect(state.assets.dispose).toHaveBeenCalledOnce();
  expect(state.input.valid).toBe(false);
  expect(state.group.children).toHaveLength(0);
});

it("fails closed on document replacement and releases its owned listener and assets", async () => {
  const state = fixture();
  state.resolve();
  await state.input.ready;
  vi.spyOn(state.frame, "contentDocument", "get").mockReturnValue(
    document.implementation.createHTMLDocument(),
  );
  state.input.node.setAttribute("visibility", "visible");
  state.frame.dispatchEvent(new Event("load"));
  state.frame.dispatchEvent(new Event("load"));
  expect(state.input.node.getAttribute("visibility")).toBe("hidden");
  expect(state.invalidated).toHaveBeenCalledOnce();
  expect(state.input.valid).toBe(false);
  state.input.dispose();
  state.frame.dispatchEvent(new Event("load"));
  expect(state.invalidated).toHaveBeenCalledOnce();
  expect(state.assets.dispose).toHaveBeenCalledOnce();
});

it("rejects readiness when its document was replaced before assets became ready", async () => {
  const state = fixture();
  vi.spyOn(state.frame, "contentDocument", "get").mockReturnValue(null);
  state.frame.dispatchEvent(new Event("load"));
  state.resolve();
  await expect(state.input.ready).rejects.toThrow("Text input document replaced");
  state.input.dispose();
  expect(state.assets.dispose).toHaveBeenCalledOnce();
});
