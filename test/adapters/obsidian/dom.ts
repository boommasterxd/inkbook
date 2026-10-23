const animationSubtreeAdapters = new WeakSet<object>();

export function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
): HTMLElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
}

export function installObsidianDomHelpers(): void {
  installAnimationSubtreeAdapter();
  const elementPrototype = window.HTMLElement.prototype as HTMLElement & {
    setCssProps(properties: Record<string, string>): void;
  };
  elementPrototype.setCssProps = function (properties): void {
    for (const [name, value] of Object.entries(properties)) this.style.setProperty(name, value);
  };
  const nodePrototype = window.Node.prototype as Node & {
    createDiv: (options?: { readonly cls?: string }) => HTMLDivElement;
    createEl: <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      options?: { readonly cls?: string; readonly text?: string },
    ) => HTMLElementTagNameMap[K];
    createSpan: (options?: { readonly cls?: string; readonly text?: string }) => HTMLSpanElement;
    readonly win: Window;
  };
  const create = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: DomElementInfo | string,
  ): HTMLElementTagNameMap[K] => {
    const element = createHtmlElement(tag);
    const normalized = typeof options === "string" ? { cls: options } : options;
    if (normalized?.cls !== undefined) {
      element.className = Array.isArray(normalized.cls) ? normalized.cls.join(" ") : normalized.cls;
    }
    if (typeof normalized?.text === "string") element.textContent = normalized.text;
    return element;
  };
  nodePrototype.createEl = function (tag, options) {
    const element = create(tag, options);
    this.appendChild(element);
    return element;
  };
  nodePrototype.createDiv = function (options) {
    const element = create("div", options);
    this.appendChild(element);
    return element;
  };
  nodePrototype.createSpan = function (options) {
    const element = create("span", options);
    this.appendChild(element);
    return element;
  };
  Object.defineProperty(nodePrototype, "win", { configurable: true, get: () => window });
  const testWindow = window as Window & {
    createDiv: (options?: { readonly cls?: string; readonly text?: string }) => HTMLDivElement;
    createEl: typeof create;
    createFragment: () => DocumentFragment;
    createSpan: (options?: { readonly cls?: string; readonly text?: string }) => HTMLSpanElement;
  };
  testWindow.createDiv = (options) => create("div", options);
  testWindow.createEl = create;
  testWindow.createSpan = (options) => create("span", options);
  testWindow.createFragment = () => new window.DocumentFragment();
}

function installAnimationSubtreeAdapter(): void {
  const prototype = window.Element.prototype;
  if (animationSubtreeAdapters.has(prototype)) return;
  animationSubtreeAdapters.add(prototype);
  const getAnimations = Object.getOwnPropertyDescriptor(prototype, "getAnimations")
    ?.value as Element["getAnimations"];
  // Happy DOM omits the native subtree option used by lifecycle cleanup boundaries.
  prototype.getAnimations = function (this: Element, options): Animation[] {
    const elements = options?.subtree ? [this, ...this.querySelectorAll("*")] : [this];
    return elements.flatMap((element) => getAnimations.call(element));
  };
}
