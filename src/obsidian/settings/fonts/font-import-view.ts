import { setIcon, setTooltip } from "obsidian";
import type { Localization, Translator } from "../../../domain/localization";
import type { PreparedLibraryFontFace } from "../../fonts/font-import-staging";

export interface FontImportViewModel {
  readonly step: 1 | 2 | 3;
  readonly files: readonly PreparedLibraryFontFace[];
  readonly name: string;
  readonly targetFamily?: string;
  readonly fixedFamily?: boolean;
  readonly existingChoices: readonly { readonly value: string; readonly label: string }[];
  readonly busy: boolean;
  readonly previewId?: string;
}

export interface FontImportViewCallbacks {
  readonly chooseFiles: () => void;
  readonly filesSelected: (files: readonly File[]) => void;
  readonly removeFile: (id: string) => void;
  readonly nameChanged: (name: string) => void;
  readonly familyChanged: (family: string | undefined) => void;
  readonly previewChanged: (id: string) => void;
  readonly back: () => void;
  readonly next: () => void;
  readonly confirm: () => void;
}

export interface FontImportViewHandle {
  readonly root: HTMLElement;
  readonly heading: HTMLElement;
  readonly preview?: HTMLElement;
  readonly nameInput?: HTMLInputElement;
  readonly primary: HTMLButtonElement;
  readonly back: HTMLButtonElement;
}

/** Renders one review step; the owner coordinates state, feedback and font resources. */
export function renderFontImportView(
  container: HTMLElement,
  model: FontImportViewModel,
  callbacks: FontImportViewCallbacks,
  localization: Localization,
): FontImportViewHandle {
  const { t } = localization;
  const root = container.createDiv({ cls: "inkbook-font-import" });
  root.setAttribute("aria-busy", String(model.busy));
  const titles = [t("fonts.chooseStep"), t("fonts.checkStep"), t("fonts.addStep")];
  renderProgress(root, titles, model.step, t);
  const heading = root.createEl("h3", { text: titles[model.step - 1]! });
  heading.tabIndex = -1;
  let fields: Pick<FontImportViewHandle, "preview" | "nameInput"> = {};
  if (model.step === 1) renderChoose(root, model, callbacks, t);
  if (model.step === 2) fields = renderCheck(root, model, callbacks, t);
  if (model.step === 3) renderReview(root, model, t);
  const navigation = root.createDiv({ cls: "inkbook-font-import-navigation" });
  const back = renderAction(navigation, {
    label: t(model.step === 1 ? "fonts.backToLibrary" : "fonts.backStep"),
    icon: "arrow-left",
    disabled: model.busy,
    action: callbacks.back,
  });
  const primary = renderAction(navigation, {
    label: t(model.step === 3 ? "fonts.confirmAdd" : "fonts.nextStep"),
    icon: model.step === 3 ? "check" : "arrow-right",
    iconPosition: "end",
    disabled:
      model.busy || model.files.length === 0 || (model.step > 1 && model.name.trim() === ""),
    action: model.step === 3 ? callbacks.confirm : callbacks.next,
  });
  return { root, heading, ...fields, primary, back };
}

function renderProgress(
  root: HTMLElement,
  titles: readonly string[],
  current: number,
  t: Translator,
): void {
  const progress = root.createEl("ol", { cls: "inkbook-font-import-progress" });
  progress.setAttribute("aria-label", t("fonts.importProgress"));
  for (const [index, title] of titles.entries()) {
    const item = progress.createEl("li", { text: String(index + 1) });
    item.setAttribute("aria-label", title);
    if (index + 1 === current) item.setAttribute("aria-current", "step");
  }
}

function renderChoose(
  root: HTMLElement,
  model: FontImportViewModel,
  callbacks: FontImportViewCallbacks,
  t: Translator,
): void {
  const upload = root.createDiv({ cls: "inkbook-font-import-upload" });
  const button = renderIconButton(upload, {
    label: t("fonts.chooseFiles"),
    icon: "upload",
    disabled: model.busy,
    action: callbacks.chooseFiles,
  });
  button.classList.remove("inkbook-font-library-icon-button");
  button.classList.add("inkbook-font-import-dropzone");
  button.createSpan({ text: t("fonts.chooseFiles") });
  button.append(" ");
  button.createSpan({ text: t("fonts.dropFiles"), cls: "inkbook-font-import-hint" });
  button.setAttribute("aria-label", `${t("fonts.chooseFiles")} ${t("fonts.dropFiles")}`);
  upload.createEl("p", { text: t("fonts.fileLimit"), cls: "inkbook-font-import-hint" });
  bindFileDrop(button, callbacks.filesSelected);
  renderFiles(root, model, t, callbacks.removeFile);
}

function bindFileDrop(button: HTMLButtonElement, selected: (files: readonly File[]) => void): void {
  let depth = 0;
  const files = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
  const clear = () => {
    depth = 0;
    delete button.dataset.inkbookDropActive;
  };
  button.addEventListener("dragenter", (event) => {
    event.stopPropagation();
    if (button.disabled || !files(event)) return;
    event.preventDefault();
    depth += 1;
    button.dataset.inkbookDropActive = "true";
  });
  button.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const allowed = !button.disabled && files(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? "copy" : "none";
    if (allowed) button.dataset.inkbookDropActive = "true";
    else clear();
  });
  button.addEventListener("dragleave", (event) => {
    event.stopPropagation();
    depth = Math.max(0, depth - 1);
    if (depth === 0) clear();
  });
  button.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clear();
    if (!button.disabled && files(event)) selected([...(event.dataTransfer?.files ?? [])]);
  });
  button.addEventListener("dragend", clear);
}

function renderCheck(
  root: HTMLElement,
  model: FontImportViewModel,
  callbacks: FontImportViewCallbacks,
  t: Translator,
): Pick<FontImportViewHandle, "preview" | "nameInput"> {
  const label = root.createEl("label", { cls: "inkbook-font-import-field" });
  label.createSpan({ text: t("fonts.pickerName") });
  const nameInput = label.createEl("input", { type: "text" });
  nameInput.value = model.name;
  nameInput.maxLength = 128;
  nameInput.required = true;
  nameInput.disabled = model.busy || model.targetFamily !== undefined;
  nameInput.addEventListener("input", () => callbacks.nameChanged(nameInput.value));
  if (!model.fixedFamily && model.existingChoices.length > 0)
    renderTarget(root, model, callbacks, t);
  renderFiles(root, model, t);
  const previewSection = root.createDiv({ cls: "inkbook-font-import-preview" });
  previewSection.createEl("h4", { text: t("fonts.preview") });
  if (model.files.length > 1) renderPreviewChoice(previewSection, model, callbacks, t);
  const preview = previewSection.createEl("p", {
    text: t("fonts.sample"),
    cls: "inkbook-font-sample",
  });
  return { nameInput, preview };
}

function renderTarget(
  root: HTMLElement,
  model: FontImportViewModel,
  callbacks: FontImportViewCallbacks,
  t: Translator,
): void {
  const label = root.createEl("label", { cls: "inkbook-font-import-field" });
  label.createSpan({ text: t("fonts.addToExisting") });
  const select = label.createEl("select");
  select.createEl("option", { value: "", text: t("fonts.newFont") });
  for (const choice of model.existingChoices) {
    select.createEl("option", { value: choice.value, text: choice.label });
  }
  select.value = model.targetFamily ?? "";
  select.disabled = model.busy;
  select.addEventListener("change", () => callbacks.familyChanged(select.value || undefined));
}

function renderPreviewChoice(
  root: HTMLElement,
  model: FontImportViewModel,
  callbacks: FontImportViewCallbacks,
  t: Translator,
): void {
  const label = root.createEl("label", { cls: "inkbook-font-import-field" });
  label.createSpan({ text: t("fonts.previewStyle") });
  const select = label.createEl("select");
  for (const face of model.files) {
    select.createEl("option", {
      value: face.id,
      text: `${friendlyFontVariant(face, t)} · ${face.fileName}`,
    });
  }
  select.value = model.previewId ?? model.files[0]!.id;
  select.disabled = model.busy;
  select.addEventListener("change", () => callbacks.previewChanged(select.value));
}

function renderReview(root: HTMLElement, model: FontImportViewModel, t: Translator): void {
  root.createEl("strong", { text: model.name, cls: "inkbook-font-import-name" });
  renderFiles(root, model, t);
  root.createEl("p", { text: t("fonts.storageNotice"), cls: "inkbook-font-import-hint" });
}

function renderFiles(
  root: HTMLElement,
  model: FontImportViewModel,
  t: Translator,
  remove?: (id: string) => void,
): void {
  if (model.files.length === 0) return;
  const list = root.createEl("ul", { cls: "inkbook-font-import-files" });
  list.setAttribute("aria-label", t("fonts.selectedFiles"));
  for (const face of model.files) {
    const item = list.createEl("li");
    const copy = item.createDiv({ cls: "inkbook-font-import-file-copy" });
    copy.createSpan({ text: face.fileName });
    copy.createSpan({ text: friendlyFontVariant(face, t), cls: "inkbook-font-import-hint" });
    if (remove !== undefined) {
      renderIconButton(item, {
        label: t("fonts.removeFile", { name: face.fileName }),
        icon: "x",
        disabled: model.busy,
        action: () => remove(face.id),
      });
    }
  }
}

interface IconAction {
  readonly label: string;
  readonly icon: string;
  readonly disabled: boolean;
  readonly action: () => void;
  readonly iconPosition?: "end";
}

function renderAction(container: HTMLElement, action: IconAction): HTMLButtonElement {
  const button = renderIconButton(container, action);
  button.classList.remove("inkbook-font-library-icon-button");
  button.classList.add("inkbook-font-import-action");
  const label = button.createSpan({ text: action.label });
  if (action.iconPosition === "end") button.prepend(label);
  return button;
}

function renderIconButton(container: HTMLElement, action: IconAction): HTMLButtonElement {
  const button = container.createEl("button", {
    cls: "clickable-icon inkbook-font-library-icon-button",
    type: "button",
  });
  button.disabled = action.disabled;
  button.setAttribute("aria-label", action.label);
  setIcon(button, action.icon);
  button.querySelector("svg")?.setAttribute("aria-hidden", "true");
  setTooltip(button, action.label);
  button.addEventListener("click", action.action);
  return button;
}

export function friendlyFontVariant(
  face: {
    readonly weight: number;
    readonly style: string;
    readonly weightRange?: readonly [number, number];
  },
  t: Translator,
): string {
  if (face.weightRange !== undefined) {
    return t(face.style === "italic" ? "fonts.variableItalic" : "fonts.variable");
  }
  if (face.weight >= 600) return t(face.style === "italic" ? "fonts.boldItalic" : "fonts.bold");
  if (face.weight < 400) return t(face.style === "italic" ? "fonts.lightItalic" : "fonts.light");
  return t(face.style === "italic" ? "fonts.italic" : "fonts.regular");
}
