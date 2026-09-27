import { vi } from "vitest";

export function inkbookRoot(root: FakePresentationElement): FakePresentationElement {
  const presentation = root.children[0]?.children.find((child) =>
    child.classNames.has("inkbook-root"),
  );
  if (presentation === undefined) throw new Error("Missing Inkbook presentation root.");
  return presentation;
}

interface FakePresentationCollection {
  readonly length: number;
  item(index: number): FakePresentationElement | null;
}

interface FakePresentationEvent {
  event: Event;
  stopped: boolean;
}

export class FakePresentationElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakePresentationElement[] = [];
  readonly classNames = new Set<string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly ownerDocument: Document;
  readonly localName: string;
  readonly namespaceURI: string;
  readonly tagName: string;
  readonly style = {
    "--inkbook-preview-aspect-ratio": "",
    "--inkbook-preview-image": "",
    colorScheme: "",
    insetBlockEnd: "",
    insetBlockStart: "",
    insetInlineStart: "",
    maxInlineSize: "",
    pointerEvents: "",
    removeProperty: (name: string): void => {
      const key = name.startsWith("--")
        ? name
        : name.replaceAll(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      delete (this.style as unknown as Record<string, unknown>)[key];
    },
    setProperty: (name: string, value: string): void => {
      (this.style as unknown as Record<string, unknown>)[name] = value;
    },
    visibility: "",
  };
  alt = "";
  clientHeight = 100;
  clientLeft = 0;
  clientTop = 0;
  clientWidth = 600;
  currentSrc = "";
  hidden = false;
  isConnected = true;
  parentElement: FakePresentationElement | null = null;
  scrollHeight = 200;
  scrollTop = 0;
  src = "";
  textContent = "";

  public constructor(ownerDocument?: Document, tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.namespaceURI =
      this.localName === "svg" || this.localName === "style"
        ? "http://www.w3.org/2000/svg"
        : "http://www.w3.org/1999/xhtml";
    if (ownerDocument !== undefined) {
      this.ownerDocument = ownerDocument;
      return;
    }
    const documentPort: {
      baseURI: string;
      body: FakePresentationElement;
      defaultView: unknown;
      documentElement: FakePresentationElement;
      importNode: (node: FakePresentationElement, deep: boolean) => FakePresentationElement;
      scrollingElement: FakePresentationElement | null;
    } = {
      baseURI: "app://vault/",
      body: this,
      defaultView: undefined,
      documentElement: this,
      importNode: (node, deep) => node.cloneNode(deep),
      scrollingElement: this,
    };
    const documentListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    Object.assign(documentPort, {
      createElementNS: (_namespace: string, name: string) =>
        new FakePresentationElement(documentPort as unknown as Document, name),
      addEventListener: (type: string, callback: EventListenerOrEventListenerObject) => {
        const listeners = documentListeners.get(type) ?? new Set();
        listeners.add(callback);
        documentListeners.set(type, listeners);
      },
      removeEventListener: (type: string, callback: EventListenerOrEventListenerObject) => {
        documentListeners.get(type)?.delete(callback);
      },
    });
    const windowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    let frameTime = 0;
    const owningWindow = {
      addEventListener: (type: string, callback: EventListenerOrEventListenerObject) => {
        const listeners = windowListeners.get(type) ?? new Set();
        listeners.add(callback);
        windowListeners.set(type, listeners);
      },
      DOMParser: class {
        public parseFromString(): { documentElement: FakePresentationElement } {
          const svg = new FakePresentationElement(documentPort as unknown as Document, "svg");
          svg.append(new FakePresentationElement(documentPort as unknown as Document, "style"));
          return { documentElement: svg };
        }
      },
      document: documentPort as unknown as Document,
      ResizeObserver: class {
        public disconnect(): void {}
        public observe(): void {}
      },
      cancelAnimationFrame: vi.fn(),
      clearTimeout: vi.fn(),
      dispatchEvent: (event: Event) => {
        for (const callback of windowListeners.get(event.type) ?? []) {
          if (typeof callback === "function") callback(event);
          else callback.handleEvent(event);
        }
        return true;
      },
      getComputedStyle: () => ({ overflowY: "visible" }),
      performance,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frameTime += 16;
        callback(frameTime);
        return 1;
      },
      removeEventListener: (type: string, callback: EventListenerOrEventListenerObject) => {
        windowListeners.get(type)?.delete(callback);
      },
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
    };
    documentPort.defaultView = owningWindow;
    this.ownerDocument = documentPort as unknown as Document;
  }

  public get childNodes(): readonly FakePresentationElement[] {
    return this.children;
  }

  public get nextSibling(): FakePresentationElement | null {
    if (this.parentElement === null) return null;
    const index = this.parentElement.children.indexOf(this);
    return index < 0 ? null : (this.parentElement.children[index + 1] ?? null);
  }

  public get parentNode(): FakePresentationElement | null {
    return this.parentElement;
  }

  readonly classList = {
    add: (...names: string[]): void => {
      for (const name of names) this.classNames.add(name);
    },
    contains: (name: string): boolean => this.classNames.has(name),
    remove: (...names: string[]): void => {
      for (const name of names) this.classNames.delete(name);
    },
  };

  public addEventListener(type: string, callback: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, callback: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(callback);
  }

  public append(child: FakePresentationElement): void {
    if (child.parentElement !== null) {
      const previousIndex = child.parentElement.children.indexOf(child);
      if (previousIndex >= 0) child.parentElement.children.splice(previousIndex, 1);
    }
    child.parentElement = this;
    child.isConnected = this.isConnected;
    this.children.push(child);
  }

  public insertBefore(child: FakePresentationElement, reference: FakePresentationElement): void {
    const referenceIndex = this.children.indexOf(reference);
    if (referenceIndex < 0) {
      this.append(child);
      return;
    }
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    child.isConnected = this.isConnected;
    this.children.splice(referenceIndex, 0, child);
  }

  private removeChild(child: FakePresentationElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    child.isConnected = false;
  }

  public cloneNode(deep = false): FakePresentationElement {
    const clone = new FakePresentationElement(this.ownerDocument, this.tagName);
    clone.alt = this.alt;
    clone.currentSrc = this.currentSrc;
    clone.src = this.src;
    for (const [name, value] of this.attributes) clone.attributes.set(name, value);
    for (const className of this.classNames) clone.classNames.add(className);
    if (deep) for (const child of this.children) clone.append(child.cloneNode(true));
    return clone;
  }

  public contains(element: unknown): boolean {
    if (element === this) return true;
    return this.children.some((child) => child.contains(element));
  }

  public closest(selectors: string): FakePresentationElement | null {
    const tagNames = selectors.split(",").map((selector) => selector.trim().toUpperCase());
    if (tagNames.includes(this.tagName)) return this;
    return this.parentElement?.closest(selectors) ?? null;
  }

  public createEl(
    tag: string,
    options?: { readonly attr?: Record<string, string>; readonly cls?: string },
  ): FakePresentationElement {
    const child = new FakePresentationElement(this.ownerDocument, tag);
    child.alt = options?.attr?.alt ?? "";
    child.src = options?.attr?.src ?? "";
    for (const [name, value] of Object.entries(options?.attr ?? {})) {
      child.setAttribute(name, value);
    }
    for (const className of options?.cls?.split(" ") ?? []) child.classList.add(className);
    this.append(child);
    return child;
  }

  public createDiv(options?: { readonly cls?: string }): FakePresentationElement {
    const child = new FakePresentationElement(this.ownerDocument);
    for (const className of options?.cls?.split(" ") ?? []) child.classList.add(className);
    this.append(child);
    return child;
  }

  public setCssProps(properties: Record<string, string>): void {
    for (const [name, value] of Object.entries(properties)) {
      this.style.setProperty(name, value);
    }
  }

  public createSpan(options?: {
    readonly cls?: string;
    readonly text?: string;
  }): FakePresentationElement {
    const child = new FakePresentationElement(this.ownerDocument, "span");
    for (const className of options?.cls?.split(" ") ?? []) child.classList.add(className);
    child.textContent = options?.text ?? "";
    this.append(child);
    return child;
  }

  public replaceWith(replacement: FakePresentationElement): void {
    if (this.parentElement !== null) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1, replacement);
      replacement.parentElement = this.parentElement;
      replacement.isConnected = this.isConnected;
      this.parentElement = null;
    }
    this.isConnected = false;
  }

  public replaceChildren(...replacements: FakePresentationElement[]): void {
    for (const child of [...this.children]) this.removeChild(child);
    for (const replacement of replacements) this.append(replacement);
  }

  public remove(): void {
    this.parentElement?.removeChild(this);
    this.isConnected = false;
  }

  public dispatch(type: string): void {
    const dispatched: FakePresentationEvent = {
      event: undefined as unknown as Event,
      stopped: false,
    };
    dispatched.event = {
      preventDefault: vi.fn(),
      stopPropagation: () => {
        dispatched.stopped = true;
      },
      type,
    } as unknown as Event;
    this.dispatchEvent(dispatched);
  }

  private dispatchEvent(dispatched: FakePresentationEvent): void {
    for (const callback of this.listeners.get(dispatched.event.type) ?? []) {
      if (typeof callback === "function") callback(dispatched.event);
      else callback.handleEvent(dispatched.event);
    }
    if (!dispatched.stopped) this.parentElement?.dispatchEvent(dispatched);
  }

  public getElementsByTagName(name: string): FakePresentationCollection {
    const tagName = name.toUpperCase();
    return this.collectElements((element) => element.tagName === tagName);
  }

  public getElementsByClassName(name: string): FakePresentationCollection {
    return this.collectElements((element) => element.classNames.has(name));
  }

  private collectElements(
    matches: (element: FakePresentationElement) => boolean,
  ): FakePresentationCollection {
    const elements: FakePresentationElement[] = [];
    const collect = (element: FakePresentationElement): void => {
      for (const child of element.children) {
        if (matches(child)) elements.push(child);
        collect(child);
      }
    };
    collect(this);
    return { length: elements.length, item: (index) => elements[index] ?? null };
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getBoundingClientRect(): Pick<
    DOMRect,
    "bottom" | "height" | "left" | "right" | "top" | "width"
  > {
    return { bottom: 100, height: 100, left: 0, right: 600, top: 0, width: 600 };
  }
}
