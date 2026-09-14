interface TestApp {
  readonly workspace: { readonly containerEl: HTMLElement };
}

const modalStacks = new WeakMap<Document, Modal[]>();

export function nativeModalStack(ownerDocument: Document): readonly Modal[] {
  return (modalStacks.get(ownerDocument) ?? []).filter((modal) => modal.containerEl.isConnected);
}

/** Models the public Modal.close callback invoked by native navigation history. */
export function simulateNativeModalBack(ownerDocument: Document): boolean {
  const stack = nativeModalStack(ownerDocument);
  const modal = stack[stack.length - 1];
  if (modal === undefined) return false;
  modal.close();
  return true;
}

export class Modal {
  readonly containerEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  readonly modalEl: HTMLElement;
  readonly #escape = (event: KeyboardEvent): void => {
    const stack = nativeModalStack(this.modalEl.ownerDocument);
    if (event.key === "Escape" && !event.defaultPrevented && stack[stack.length - 1] === this) {
      event.preventDefault();
      this.close();
    }
  };

  public constructor(readonly app: TestApp) {
    const ownerDocument = app.workspace.containerEl.ownerDocument;
    this.containerEl = createOwnedElement(ownerDocument, "div");
    this.modalEl = this.containerEl.appendChild(createOwnedElement(ownerDocument, "div"));
    this.titleEl = this.modalEl.appendChild(createOwnedElement(ownerDocument, "div"));
    const close = this.modalEl.appendChild(createOwnedElement(ownerDocument, "button"));
    close.className = "modal-close-button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.close());
    this.modalEl.addEventListener("click", (event) => {
      if (event.target === this.modalEl) this.close();
    });
    this.contentEl = this.modalEl.appendChild(createOwnedElement(ownerDocument, "div"));
  }

  public open(): void {
    const stack = [...nativeModalStack(this.modalEl.ownerDocument)];
    if (!stack.includes(this)) stack.push(this);
    modalStacks.set(this.modalEl.ownerDocument, stack);
    this.modalEl.ownerDocument.body.append(this.containerEl);
    this.modalEl.ownerDocument.addEventListener("keydown", this.#escape);
    this.onOpen();
  }

  public close(): void {
    modalStacks.set(
      this.modalEl.ownerDocument,
      nativeModalStack(this.modalEl.ownerDocument).filter((modal) => modal !== this),
    );
    this.modalEl.ownerDocument.removeEventListener("keydown", this.#escape);
    this.onClose();
    this.containerEl.remove();
  }

  public onOpen(): void {}

  public onClose(): void {}

  public setTitle(title: string): this {
    this.modalEl.setAttribute("aria-label", title);
    return this;
  }
}

class ButtonComponent {
  readonly #element: HTMLButtonElement;

  public constructor(container: HTMLElement) {
    this.#element = container.appendChild(createOwnedElement(container.ownerDocument, "button"));
    this.#element.type = "button";
  }

  public setButtonText(text: string): this {
    this.#element.textContent = text;
    return this;
  }

  public onClick(callback: () => void): this {
    this.#element.addEventListener("click", callback);
    return this;
  }
}

class ToggleComponent {
  readonly #element: HTMLInputElement;

  public constructor(container: HTMLElement) {
    this.#element = container.appendChild(createOwnedElement(container.ownerDocument, "input"));
    this.#element.type = "checkbox";
  }

  public setValue(value: boolean): this {
    this.#element.checked = value;
    return this;
  }

  public onChange(callback: (value: boolean) => void): this {
    this.#element.addEventListener("change", () => callback(this.#element.checked));
    return this;
  }
}

class DropdownComponent {
  readonly #element: HTMLSelectElement;

  public constructor(container: HTMLElement) {
    this.#element = container.appendChild(createOwnedElement(container.ownerDocument, "select"));
  }

  public addOptions(options: Record<string, string>): this {
    for (const [value, label] of Object.entries(options)) {
      const option = createOwnedElement(this.#element.ownerDocument, "option");
      option.value = value;
      option.textContent = label;
      this.#element.append(option);
    }
    return this;
  }

  public setValue(value: string): this {
    this.#element.value = value;
    return this;
  }

  public onChange(callback: (value: string) => void): this {
    this.#element.addEventListener("change", () => callback(this.#element.value));
    return this;
  }
}

class TextComponent {
  readonly #element: HTMLInputElement;

  public constructor(container: HTMLElement) {
    this.#element = container.appendChild(createOwnedElement(container.ownerDocument, "input"));
    this.#element.type = "text";
  }

  public setValue(value: string): this {
    this.#element.value = value;
    return this;
  }

  public setPlaceholder(value: string): this {
    this.#element.placeholder = value;
    return this;
  }

  public onChange(callback: (value: string) => void): this {
    this.#element.addEventListener("input", () => callback(this.#element.value));
    return this;
  }
}

export class Setting {
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly controlEl: HTMLElement;

  public constructor(container: HTMLElement) {
    this.settingEl = container;
    this.infoEl = container.appendChild(createOwnedElement(container.ownerDocument, "div"));
    this.controlEl = container.appendChild(createOwnedElement(container.ownerDocument, "div"));
  }

  public setName(name: string): this {
    this.settingEl.dataset.settingName = name;
    return this;
  }

  public setDesc(description: string | DocumentFragment): this {
    this.settingEl.dataset.settingDescription =
      typeof description === "string" ? description : (description.textContent ?? "");
    return this;
  }

  public setDisabled(disabled: boolean): this {
    for (const control of this.settingEl.querySelectorAll<HTMLElement>("button, input, select")) {
      if ("disabled" in control) (control as HTMLButtonElement).disabled = disabled;
    }
    return this;
  }

  public setErrorMessage(message: string | null): this {
    this.settingEl.dataset.settingError = message ?? "";
    return this;
  }

  public addButton(configure: (button: ButtonComponent) => void): this {
    configure(new ButtonComponent(this.controlEl));
    return this;
  }

  public addToggle(configure: (toggle: ToggleComponent) => void): this {
    configure(new ToggleComponent(this.controlEl));
    return this;
  }

  public addDropdown(configure: (dropdown: DropdownComponent) => void): this {
    configure(new DropdownComponent(this.controlEl));
    return this;
  }

  public addText(configure: (text: TextComponent) => void): this {
    configure(new TextComponent(this.controlEl));
    return this;
  }
}

export class SettingGroup {
  readonly #container: HTMLElement;

  public constructor(container: HTMLElement) {
    this.#container = container.createDiv({ cls: "setting-group" });
  }

  public setHeading(heading: string): this {
    this.#container.createEl("h3", { text: heading });
    return this;
  }

  public addClass(className: string): this {
    this.#container.classList.add(className);
    return this;
  }

  public addSetting(configure: (setting: Setting) => void): this {
    const row = this.#container.createDiv({ cls: "setting-item" });
    configure(new Setting(row));
    return this;
  }
}

function createOwnedElement<K extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tag: K,
): HTMLElementTagNameMap[K] {
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Settings controls require an owning window.");
  return ownerWindow.createEl(tag);
}
