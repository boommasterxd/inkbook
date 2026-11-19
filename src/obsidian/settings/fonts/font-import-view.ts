import { setIcon, setTooltip } from "obsidian";
import type { Localization, Translator } from "../../../domain/localization";
import type { FontImportConflict, FontImportReview } from "../../fonts/font-import-plan";
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
  readonly specimen?: HTMLElement;
}

export interface FontImportViewCallbacks {
  readonly chooseFiles: () => void;
  readonly filesSelected: (files: readonly File[]) => void;
  readonly removeFile: (id: string) => void;
  readonly nameChanged: (name: string) => void;
  readonly familyChanged: (family: string | undefined) => void;
  readonly previewChanged: (id: string) => void;
  readonly preparePreview: () => void;
  readonly back: () => void;
  readonly next: () => void;
  readonly confirm: () => void;
}

export interface FontImportViewHandle {
  readonly root: HTMLElement;
  readonly heading: HTMLElement;
  readonly nameInput?: HTMLInputElement;
  readonly primary: HTMLButtonElement;
  readonly back: HTMLButtonElement;
  readonly showReview: (review: FontImportReview) => void;
}

let nextImportLabel = 0;

/** Renders one review step; the owner coordinates state, feedback and font resources. */
export function renderFontImportView(
  container: HTMLElement,
  footer: HTMLElement,
  model: FontImportViewModel,
  callbacks: FontImportViewCallbacks,
  localization: Localization,
): FontImportViewHandle {
  const { t } = localization;
  const root = container.createDiv({ cls: "inkbook-font-import" });
  root.classList.toggle("inkbook-font-import-review", model.step > 1);
  root.setAttribute("aria-busy", String(model.busy));
  const titles = [t("fonts.chooseStep"), t("fonts.checkStep"), t("fonts.addStep")];
  const header = root.createDiv({ cls: "inkbook-font-import-heading" });
  const progress = header.createEl("p", {
    cls: "inkbook-font-import-hint inkbook-font-import-progress",
    text: t("fonts.importProgress", { step: model.step, total: titles.length }),
  });
  progress.id = `inkbook-font-import-progress-${++nextImportLabel}`;
  const heading = header.createEl("h3", { text: titles[model.step - 1]! });
  heading.tabIndex = -1;
  heading.setAttribute("aria-describedby", progress.id);
  const nameInput = renderStep(root, model, callbacks, t);
  const files = renderFiles(root, model, callbacks.removeFile, t);
  const showReview =
    model.step === 1 ? () => undefined : renderReviewNotice(footer, files, model.busy, t);
  if (model.step === 3)
    root.createEl("p", { text: t("fonts.storageNotice"), cls: "inkbook-font-import-hint" });
  const navigation = footer.createDiv({
    cls: "inkbook-dialog-actions inkbook-font-import-navigation",
  });
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
    disabled: model.busy || model.files.length === 0,
    action: model.step === 3 ? callbacks.confirm : callbacks.next,
  });
  primary.classList.add("mod-cta");
  if (model.step === 1 && !primary.disabled) {
    primary.addEventListener("pointerenter", callbacks.preparePreview);
    primary.addEventListener("pointerdown", callbacks.preparePreview);
    primary.addEventListener("focus", callbacks.preparePreview);
  }
  return {
    root,
    heading,
    ...(nameInput === undefined ? {} : { nameInput }),
    primary,
    back,
    showReview,
  };
}

interface ImportFileIssue {
  readonly row: HTMLLIElement;
  readonly remove: HTMLButtonElement;
  readonly message: HTMLElement;
}

function renderReviewNotice(
  footer: HTMLElement,
  files: ReadonlyMap<string, ImportFileIssue>,
  busy: boolean,
  t: Translator,
): (review: FontImportReview) => void {
  const notice = footer.createDiv({ cls: "inkbook-font-import-review-notice" });
  const status = notice.createEl("p", { cls: "inkbook-font-import-issue" });
  status.id = `inkbook-font-import-notice-${++nextImportLabel}`;
  status.setAttribute("role", "status");
  let firstIssue: ImportFileIssue | undefined;
  const openFile = renderAction(notice, {
    label: t("fonts.showConflictFile"),
    icon: "arrow-up",
    disabled: busy,
    action: () => {
      firstIssue?.row.scrollIntoView({ block: "nearest", behavior: "instant" });
      firstIssue?.remove.focus({ preventScroll: true });
    },
  });
  openFile.setAttribute("aria-describedby", status.id);
  return ({ conflicts, error }) => {
    firstIssue = undefined;
    let summary = "";
    for (const [id, file] of files) {
      const conflict = conflicts.get(id);
      file.message.textContent = conflictMessage(conflict, t);
      file.message.hidden = conflict === undefined;
      if (conflict === undefined || firstIssue !== undefined) continue;
      firstIssue = file;
      summary = t(conflict === "face-conflict" ? "fonts.overlappingFaces" : "fonts.assignedFace");
    }
    openFile.hidden = firstIssue === undefined;
    if (error !== undefined && firstIssue === undefined)
      summary = t(error === "library-full" ? "fonts.libraryFull" : "fonts.unavailableFamily");
    if (status.textContent !== summary) status.textContent = summary;
  };
}

function renderStep(
  root: HTMLElement,
  model: FontImportViewModel,
  callbacks: FontImportViewCallbacks,
  t: Translator,
): HTMLInputElement | undefined {
  if (model.step === 1) renderChoose(root, model, callbacks, t);
  if (model.step === 2) return renderCheck(root, model, callbacks, t);
  if (model.step === 3)
    root.createEl("strong", { text: model.name, cls: "inkbook-font-import-name" });
  return undefined;
}

function conflictMessage(conflict: FontImportConflict | undefined, t: Translator): string {
  if (conflict === "face-conflict") return t("fonts.overlappingFace");
  if (conflict === "duplicate-family") return t("fonts.assignedFace");
  return "";
}

function renderChoose(
  root: HTMLElement,
  model: FontImportViewModel,
  callbacks: FontImportViewCallbacks,
  t: Translator,
): void {
  const upload = root.createDiv({ cls: "inkbook-font-import-upload" });
  upload.dataset.inkbookSettingIdentity = "font-import-upload";
  const button = renderIconButton(upload, {
    label: t("fonts.chooseFiles"),
    icon: "upload",
    disabled: model.busy,
    action: callbacks.chooseFiles,
  });
  button.classList.remove("inkbook-font-library-icon-button");
  button.classList.add("inkbook-font-import-dropzone");
  const copy = button.createSpan({ cls: "inkbook-font-import-source-copy" });
  copy.createSpan({ text: t("fonts.chooseFiles") });
  copy.append(" ");
  copy.createSpan({ text: t("fonts.dropFiles"), cls: "inkbook-font-import-hint" });
  button.setAttribute("aria-label", `${t("fonts.chooseFiles")} ${t("fonts.dropFiles")}`);
  upload.createEl("p", { text: t("fonts.fileLimit"), cls: "inkbook-font-import-hint" });
  bindFileDrop(button, callbacks.filesSelected);
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
): HTMLInputElement {
  if (model.specimen !== undefined) root.append(model.specimen);
  if (model.files.length > 1) renderPreviewChoice(root, model, callbacks, t);
  else if (model.files[0] !== undefined)
    root.createEl("p", {
      cls: "inkbook-font-import-hint",
      text: t("fonts.previewSingleStyle", { style: importFaceLabel(model.files[0], t) }),
    });
  if (!model.fixedFamily && model.existingChoices.length > 0)
    renderTarget(root, model, callbacks, t);
  const label = root.createEl("label", { cls: "inkbook-font-import-field" });
  label.dataset.inkbookSettingIdentity = "font-import-name";
  label.createSpan({ text: t("fonts.pickerName") });
  const nameInput = label.createEl("input", { type: "text" });
  nameInput.value = model.name;
  nameInput.maxLength = 128;
  nameInput.required = true;
  nameInput.disabled = model.busy || model.targetFamily !== undefined;
  nameInput.addEventListener("input", () => callbacks.nameChanged(nameInput.value));
  return nameInput;
}

function renderTarget(
  root: HTMLElement,
  model: FontImportViewModel,
  callbacks: FontImportViewCallbacks,
  t: Translator,
): void {
  const label = root.createEl("label", { cls: "inkbook-font-import-field" });
  label.dataset.inkbookSettingIdentity = "font-import-family";
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
  label.dataset.inkbookSettingIdentity = "font-import-preview";
  label.createSpan({ text: t("fonts.previewStyle") });
  const select = label.createEl("select");
  for (const face of model.files) {
    select.createEl("option", {
      value: face.id,
      text: `${importFaceLabel(face, t)} · ${face.fileName}`,
    });
  }
  select.value = model.previewId ?? model.files[0]!.id;
  select.disabled = model.busy;
  select.addEventListener("change", () => callbacks.previewChanged(select.value));
}

function importFaceLabel(face: PreparedLibraryFontFace, t: Translator): string {
  const weight = face.weightRange?.join("–") ?? String(face.weight);
  return `${friendlyFontVariant(face, t)} · ${weight}`;
}

function renderFiles(
  root: HTMLElement,
  model: FontImportViewModel,
  remove: (id: string) => void,
  t: Translator,
): ReadonlyMap<string, ImportFileIssue> {
  const issues = new Map<string, ImportFileIssue>();
  if (model.files.length === 0) return issues;
  const list = root.createEl("ul", { cls: "inkbook-font-import-files" });
  list.setAttribute("aria-label", t("fonts.selectedFiles"));
  for (const face of model.files) {
    const item = list.createEl("li");
    item.dataset.inkbookSettingIdentity = `font-import-file:${face.id}`;
    const copy = item.createDiv({ cls: "inkbook-font-import-file-copy" });
    copy.createSpan({ text: face.fileName });
    copy.createSpan({ text: importFaceLabel(face, t), cls: "inkbook-font-import-hint" });
    const actions = item.createDiv({ cls: "inkbook-dialog-actions" });
    const button = renderIconButton(actions, {
      label: t("fonts.removeFile", { name: face.fileName }),
      icon: "x",
      disabled: model.busy,
      action: () => remove(face.id),
    });
    if (model.step === 1) continue;
    const issue = copy.createSpan({ cls: "inkbook-font-import-issue" });
    issue.id = `inkbook-font-import-issue-${++nextImportLabel}`;
    issue.hidden = true;
    button.setAttribute("aria-describedby", issue.id);
    issues.set(face.id, { row: item, remove: button, message: issue });
  }
  return issues;
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
  button.classList.remove("clickable-icon", "inkbook-font-library-icon-button");
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
