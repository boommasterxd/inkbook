export class Component {
  public addChild<T>(child: T): T {
    return child;
  }

  public load(): void {
    return undefined;
  }

  public unload(): void {
    return undefined;
  }
}

export const Platform = Object.freeze({
  isAndroidApp: false,
  isDesktop: true,
  isDesktopApp: true,
  isIosApp: false,
  isMacOS: false,
  isMobile: false,
  isMobileApp: false,
  isPhone: false,
  isTablet: false,
  isWin: false,
});

export function normalizePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

export class Plugin extends Component {
  public readonly commands: unknown[] = [];
  public readonly editorExtensions: unknown[] = [];
  public readonly postProcessors: unknown[] = [];
  public readonly events: unknown[] = [];
  public loadedData: unknown = null;
  public readonly savedData: unknown[] = [];

  public constructor(
    public readonly app: unknown,
    public readonly manifest: unknown,
  ) {
    super();
  }

  public addCommand(command: unknown): unknown {
    this.commands.push(command);
    return command;
  }

  public registerEditorExtension(extension: unknown): void {
    this.editorExtensions.push(extension);
  }

  public registerEvent(event: unknown): void {
    this.events.push(event);
  }

  public registerMarkdownPostProcessor(processor: unknown): unknown {
    this.postProcessors.push(processor);
    return processor;
  }

  public loadData(): Promise<unknown> {
    return Promise.resolve(this.loadedData);
  }

  public saveData(value: unknown): Promise<void> {
    this.savedData.push(value);
    return Promise.resolve();
  }
}

export class MarkdownView extends Component {}

export abstract class TAbstractFile {
  public constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  public readonly stat = { ctime: 0, mtime: 0, size: 0 };
  public basename = "";
  public extension = "";
  public name = "";
  public parent = null;
  public vault = null;
}

export class TFolder extends TAbstractFile {
  public readonly children: TAbstractFile[] = [];
  public isRoot(): boolean {
    return this.path.length === 0;
  }
  public name = "";
  public parent = null;
  public vault = null;
}

export class MarkdownRenderChild extends Component {
  public constructor(public readonly containerEl: unknown) {
    super();
  }
}

class MenuItem {
  public disabled = false;
  public icon = "";
  public title = "";

  public setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  public setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }

  public setTitle(title: string): this {
    this.title = title;
    return this;
  }
}

export class Menu {
  public static readonly positions: {
    document: Document | undefined;
    position: Readonly<{ x: number; y: number }>;
  }[] = [];
  public lastEvent: MouseEvent | undefined;
  public onHideCallback: (() => void) | undefined;

  public addItem(callback: (item: MenuItem) => void): this {
    callback(new MenuItem());
    return this;
  }

  public showAtMouseEvent(event: MouseEvent): this {
    this.lastEvent = event;
    return this;
  }

  public showAtPosition(
    position: Readonly<{ x: number; y: number }>,
    document?: Document,
  ): this {
    Menu.positions.push({ document, position });
    return this;
  }

  public onHide(callback: () => void): void {
    this.onHideCallback = callback;
  }
}

export class Notice {
  public static readonly messages: string[] = [];

  public constructor(public readonly message: string) {
    Notice.messages.push(message);
  }
}
