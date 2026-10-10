import { vi } from "vitest";

import { SvgSceneRenderer } from "../../../src/rendering/scene";
import { FakeSceneStore, FakeScheduler } from "../../unit/rendering/scene/fakes";
import { page } from "../../integration/obsidian/embeds/active-editor-layout-fixture";

/** Real style writes and host reads with independently delivered observer boundaries. */
export function sceneSurfaceZoomFixture(observeTheme = true) {
  const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  const container = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  root.append(container);
  document.body.append(root);
  const observers = installObservers(observeTheme);
  const read = bridgeThemeRead(root, container);
  const scheduler = new FakeScheduler();
  const renderer = new SvgSceneRenderer({
    container,
    surfaceThemeRoot: root,
    layout: { readViewport: () => ({ height: 100, width: 100, top: 0, left: 0 }) },
    page: page(),
    store: new FakeSceneStore(),
    workScheduler: scheduler.workScheduler,
  });
  const notifyResize = (height: number) =>
    observers.resize([
      {
        target: container.firstElementChild!,
        contentRect: { width: 100, height },
      } as ResizeObserverEntry,
    ]);
  notifyResize(100);
  scheduler.runAll();
  const writes = vi.spyOn(container.style, "setProperty");
  const drawingWrites = vi.spyOn(renderer.svg.ownerDocument.body.style, "setProperty");
  const records: MutationRecord[] = [];
  const emptyNodes = document.createElementNS("http://www.w3.org/1999/xhtml", "div").childNodes;
  const change = (target: HTMLElement, attribute: string, write: () => void): void => {
    const oldValue = target.getAttribute(attribute);
    write();
    if (target.getAttribute(attribute) !== oldValue)
      records.push({
        type: "attributes",
        target,
        attributeName: attribute,
        oldValue,
        addedNodes: emptyNodes,
        removedNodes: emptyNodes,
        attributeNamespace: null,
        nextSibling: null,
        previousSibling: null,
      });
  };
  read.mockClear();
  renderer.resetInstrumentation();
  return {
    container,
    root,
    renderer,
    scheduler,
    read,
    writes,
    drawingWrites,
    observed: observers.observed,
    disconnectTheme: observers.disconnectTheme,
    disconnectResize: observers.disconnectResize,
    zoom: (height: number) => change(container, "style", () => renderer.setZoomBlockSize(height)),
    foreignStyle: (target: HTMLElement, property: string, value: string) =>
      change(target, "style", () => target.style.setProperty(property, value)),
    foreignClass: (target: HTMLElement) =>
      change(target, "class", () => target.classList.toggle("foreign")),
    deliver: () => observers.mutation(records.splice(0)),
    unknown: () => observers.mutation([]),
    resize: notifyResize,
    release: () => {
      renderer.destroy();
      root.remove();
    },
  };
}

function installObservers(observeTheme: boolean) {
  let mutation: MutationCallback = () => undefined;
  let resize: ResizeObserverCallback = () => undefined;
  const observed = new Map<Node, MutationObserverInit>();
  const disconnectTheme = vi.fn();
  const disconnectResize = vi.fn();
  if (!observeTheme) vi.stubGlobal("MutationObserver", undefined);
  else
    vi.spyOn(window, "MutationObserver").mockImplementation(
      class {
        public constructor(callback: MutationCallback) {
          mutation = callback;
        }
        public observe(target: Node, options: MutationObserverInit): void {
          observed.set(target, options);
        }
        public disconnect = disconnectTheme;
      } as unknown as typeof MutationObserver,
    );
  vi.spyOn(window, "ResizeObserver").mockImplementation(
    class {
      public constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      public observe(): void {}
      public disconnect = disconnectResize;
    } as unknown as typeof ResizeObserver,
  );
  return {
    observed,
    disconnectTheme,
    disconnectResize,
    mutation: (records: MutationRecord[]) => mutation(records, {} as MutationObserver),
    resize: (entries: ResizeObserverEntry[]) => resize(entries, {} as ResizeObserver),
  };
}

function bridgeThemeRead(root: HTMLElement, container: HTMLElement) {
  const computedStyle = window.getComputedStyle.bind(window);
  return vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = computedStyle(element);
    return new Proxy(style, {
      get: (target, property) =>
        property === "getPropertyValue"
          ? (name: string) =>
              target.getPropertyValue(name) ||
              container.style.getPropertyValue(name) ||
              root.style.getPropertyValue(name)
          : (Reflect.get(target, property) as unknown),
    });
  });
}
