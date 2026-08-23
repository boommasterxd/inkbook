import { StateField } from "@codemirror/state";

export interface TestEditorInfo {
  readonly editor?: Editor;
  readonly file: { readonly path: string } | null;
}

let editorInfo: TestEditorInfo = { file: null };
let livePreview = false;

export const Platform = {
  isAndroidApp: false,
  isDesktop: true,
  isDesktopApp: true,
  isIosApp: false,
  isMobile: false,
  isMobileApp: false,
  isPhone: false,
  isTablet: false,
};

export function configureTestEditorState(options: {
  readonly file?: { readonly path: string } | null;
  readonly livePreview?: boolean;
}): void {
  if (options.file !== undefined) {
    editorInfo = { file: options.file };
  }
  if (options.livePreview !== undefined) {
    livePreview = options.livePreview;
  }
}

export const editorInfoField = StateField.define<TestEditorInfo>({
  create: () => editorInfo,
  update: (value) => value,
});

export const editorLivePreviewField = StateField.define<boolean>({
  create: () => livePreview,
  update: (value) => value,
});

export interface EventRef {
  readonly detach?: () => void;
}

export class Tasks {
  readonly #tasks: Array<() => Promise<unknown>> = [];

  add(callback: () => Promise<unknown>): void {
    this.#tasks.push(callback);
  }

  addPromise(promise: Promise<unknown>): void {
    this.add(async () => promise);
  }

  isEmpty(): boolean {
    return this.#tasks.length === 0;
  }

  async promise(): Promise<unknown> {
    return Promise.all(this.#tasks.map(async (task) => task()));
  }
}

export class Component {
  readonly #children: Component[] = [];
  readonly #cleanup: Array<() => void> = [];
  #loaded = false;

  load(): void {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    this.onload();
    for (const child of this.#children) {
      child.load();
    }
  }

  onload(): void {}

  unload(): void {
    if (!this.#loaded) {
      return;
    }
    for (const child of [...this.#children].reverse()) {
      child.unload();
    }
    for (const cleanup of [...this.#cleanup].reverse()) {
      cleanup();
    }
    this.onunload();
    this.#loaded = false;
  }

  onunload(): void {}

  addChild<T extends Component>(component: T): T {
    this.#children.push(component);
    if (this.#loaded) {
      component.load();
    }
    return component;
  }

  register(callback: () => void): void {
    this.#cleanup.push(callback);
  }

  registerEvent(eventRef: EventRef): void {
    this.register(() => eventRef.detach?.());
  }

  registerDomEvent(
    element: {
      addEventListener(type: string, callback: EventListenerOrEventListenerObject): void;
      removeEventListener(type: string, callback: EventListenerOrEventListenerObject): void;
    },
    type: string,
    callback: EventListenerOrEventListenerObject,
  ): void {
    element.addEventListener(type, callback);
    this.register(() => {
      element.removeEventListener(type, callback);
    });
  }
}

export class MarkdownRenderChild extends Component {
  readonly containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.containerEl = containerEl;
  }
}

export class TAbstractFile {
  readonly name: string;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    const segments = path.split("/");
    this.name = segments[segments.length - 1] ?? path;
  }
}

export class TFile extends TAbstractFile {
  readonly extension: string;
  readonly stat: { ctime: number; mtime: number; size: number };

  constructor(path: string, size = 0) {
    super(path);
    const segments = path.split(".");
    this.extension = segments[segments.length - 1] ?? "";
    this.stat = { ctime: 0, mtime: 0, size };
  }
}

export class TFolder extends TAbstractFile {}

export function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/");
}

export interface MarkdownPostProcessorContext {
  readonly sourcePath: string;
  addChild(child: MarkdownRenderChild): void;
  getSectionInfo(element: HTMLElement): { readonly text: string } | null;
}

export type MarkdownPostProcessor = (
  element: HTMLElement,
  context: MarkdownPostProcessorContext,
) => Promise<unknown> | void;

export interface App {
  readonly fileManager: unknown;
  isDarkMode(): boolean;
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
  readonly metadataCache: {
    getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null;
    on(name: "changed" | "resolved", callback: () => void): EventRef;
    readonly resolvedLinks: Record<string, Record<string, number>>;
  };
  readonly vault: {
    getResourcePath(file: TFile): string;
    on(name: "create" | "modify", callback: (file: TAbstractFile) => void): EventRef;
  };
  readonly workspace: {
    readonly containerEl: HTMLElement;
    getActiveViewOfType<T>(viewType: abstract new (...arguments_: never[]) => T): T | null;
    on(name: "quit", callback: (tasks: Tasks) => void): EventRef;
    on(name: string, callback: (...arguments_: never[]) => void): EventRef;
    onLayoutReady(callback: () => void): void;
  };
}

export interface Editor {
  getCursor(): { readonly ch: number; readonly line: number };
  getLine(line: number): string;
  getRange(
    from: { readonly ch: number; readonly line: number },
    to: { readonly ch: number; readonly line: number },
  ): string;
  lineCount(): number;
  replaceRange(
    replacement: string,
    from: { readonly ch: number; readonly line: number },
    to?: { readonly ch: number; readonly line: number },
  ): void;
}

export interface MarkdownFileInfo {
  readonly editor?: Editor;
  readonly file: TFile | null;
}

export class MarkdownView extends Component implements MarkdownFileInfo {
  containerEl!: HTMLElement;
  editor!: Editor;
  file: TFile | null = null;
}

export class Plugin extends Component {
  app!: App;
  readonly commands: Array<{
    readonly id: string;
    readonly name: string;
    readonly checkCallback?: (checking: boolean) => boolean | void;
    readonly editorCheckCallback?: (
      checking: boolean,
      editor: Editor,
      context: MarkdownView,
    ) => boolean | void;
  }> = [];
  readonly editorExtensions: unknown[] = [];
  readonly postProcessors: MarkdownPostProcessor[] = [];
  readonly settingTabs: PluginSettingTab[] = [];
  settingsData: unknown;

  constructor(app?: App) {
    super();
    if (app !== undefined) this.app = app;
  }

  async loadData(): Promise<unknown> {
    return this.settingsData;
  }

  async saveData(data: unknown): Promise<void> {
    this.settingsData = data;
  }

  addCommand(command: (typeof this.commands)[number]): (typeof this.commands)[number] {
    this.commands.push(command);
    return command;
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }

  registerEditorExtension(extension: unknown): void {
    this.editorExtensions.push(extension);
  }

  registerMarkdownPostProcessor(processor: MarkdownPostProcessor): MarkdownPostProcessor {
    this.postProcessors.push(processor);
    return processor;
  }
}

export class PluginSettingTab extends Component {
  readonly app: App;
  readonly plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    super();
    this.app = app;
    this.plugin = plugin;
  }

  getControlValue(_key: string): unknown {
    return undefined;
  }

  setControlValue(_key: string, _value: unknown): Promise<void> | void {}

  getSettingDefinitions(): unknown[] {
    return [];
  }

  refreshDomState(): void {}

  update(): void {}
}

export class MenuItem {
  setTitle(_title: string): this {
    return this;
  }

  setIcon(_icon: string): this {
    return this;
  }

  setDisabled(_disabled: boolean): this {
    return this;
  }

  setWarning(_warning: boolean): this {
    return this;
  }

  setIsLabel(_label: boolean): this {
    return this;
  }

  onClick(_callback: (event: unknown) => void): this {
    return this;
  }
}

export class Menu extends Component {
  static forEvent(_event: MouseEvent | PointerEvent): Menu {
    return new Menu();
  }

  addItem(configure: (item: MenuItem) => void): this {
    configure(new MenuItem());
    return this;
  }

  addSeparator(): this {
    return this;
  }

  showAtPosition(_position: unknown, _document?: Document): this {
    return this;
  }

  onHide(_callback: () => void): void {}

  close(): void {}
}

export class Notice {
  static readonly instances: Notice[] = [];
  readonly message: string | DocumentFragment;
  readonly messageEl: HTMLElement;
  hidden = false;

  constructor(message: string | DocumentFragment, _duration?: number) {
    this.message = message;
    this.messageEl = new TestNoticeElement() as unknown as HTMLElement;
    Notice.instances.push(this);
  }

  hide(): void {
    this.hidden = true;
  }
}

export function setIcon(element: HTMLElement, icon: string): void {
  element.setAttribute("data-icon", icon);
}

class TestNoticeElement {
  readonly attributes = new Map<string, string>();
  readonly children: TestNoticeElement[] = [];
  disabled = false;
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly ownerDocument = { defaultView: null };
  removed = false;
  readonly tagName: string;
  textContent = "";

  constructor(tagName = "div") {
    this.tagName = tagName;
  }

  createEl(tag: string, options?: { readonly text?: string }): TestNoticeElement {
    return this.createChild(tag, options);
  }

  createDiv(): TestNoticeElement {
    return this.createChild("div");
  }

  createSpan(options?: { readonly text?: string }): TestNoticeElement {
    return this.createChild("span", options);
  }

  private createChild(tagName: string, options?: { readonly text?: string }): TestNoticeElement {
    const child = new TestNoticeElement(tagName);
    child.textContent = options?.text ?? "";
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener({ type } as Event);
      else listener.handleEvent({ type } as Event);
    }
  }

  remove(): void {
    this.removed = true;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getElementsByTagName(tag: string): {
    readonly length: number;
    item(index: number): TestNoticeElement | null;
  } {
    const matches = this.children.flatMap((child) => [
      ...(child.tagName === tag ? [child] : []),
      ...child.collectByTagName(tag),
    ]);
    return { length: matches.length, item: (index) => matches[index] ?? null };
  }

  private collectByTagName(tag: string): TestNoticeElement[] {
    return this.children.flatMap((child) => [
      ...(child.tagName === tag ? [child] : []),
      ...child.collectByTagName(tag),
    ]);
  }
}
