import type { Translator } from "../../../domain/localization";
import type { ChangeDesc } from "@codemirror/state";
import type { TextElementV2 } from "../../../domain/schema/public";
import type { Bounds } from "../../../domain/geometry/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { TextDefaultsV2 } from "../../../domain/settings/types";
import type { TextSourceState } from "../../../domain/text/text-types";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { TextEditingSurface } from "../../../rendering/scene/text-editing-surface";
import type { StyleChoiceOption } from "../../menus/editor-menu-types";
import { createTextStyleControls } from "../../menus/text-style-controls";
import type { TextFieldEditor } from "../../text/editor/text-field-editor";
import type { TextTableUiPort } from "../../text/editor/text-table-controls";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import type { ActiveEditorHistory } from "./history";
import { ActiveTextPreparation, type TextFontLibraryPort } from "./text-preparation";
import * as TextHistory from "./text-session-history";
import { createAndAppendTextField } from "./text-session-creation";
import { ProvisionalTextCreation } from "./text-provisional-creation";
import type { TextSessionExtent, TextSourceExtentLayout } from "./text-session-extent";
import * as TextEditor from "./text-session-editor";
import * as TextGeometry from "./text-session-geometry";
import type { TextReflow } from "../../../editor/selection/transform/text-reflow-session";
export interface ActiveTextSessionOptions {
  readonly model: EditableDocumentModel;
  readonly history: ActiveEditorHistory;
  readonly renderer: SvgSceneRenderer;
  readonly ownerWindow: Window;
  readonly scheduler: WorkScheduler;
  readonly defaults: () => TextDefaultsV2;
  readonly library?: TextFontLibraryPort;
  readonly tableCellLabel?: string;
  readonly tableUi?: TextTableUiPort;
  readonly onSelection: (selection: ReadonlySet<string>) => void;
  readonly onStateChanged: () => void;
  readonly onHeightChanged?: TextGeometry.TextHeightChanged;
  readonly onError: (error: unknown) => void;
  readonly onFinished?: () => void;
  readonly onRevealBounds?: (bounds: Bounds) => void;
  readonly onScrollInterrupt?: () => void;
  readonly sourceExtentLayout?: TextSourceExtentLayout;
  readonly onPointerDown?: (event: PointerEvent) => boolean;
  readonly onKeyDown?: (event: KeyboardEvent) => void;
  readonly reconcileHostLayout?: (callback: () => void) => void;
}
/** Owns input, coalesced canonical layout and one shared document-history stream. */
export class ActiveTextSession {
  readonly #options: ActiveTextSessionOptions;
  readonly #creation: ProvisionalTextCreation;
  readonly #geometry: TextGeometry.TextSessionGeometry;
  #preparation: ActiveTextPreparation | undefined;
  readonly #lifetime = new AbortController();
  readonly #leases = new Set<() => void>();
  #input: TextFieldEditor | undefined;
  #surface: TextEditingSurface | undefined;
  #extent: TextSessionExtent | undefined;
  #element: TextElementV2 | undefined;
  #draft: TextElementV2 | undefined;
  #pending: TextElementV2 | undefined;
  #running: Promise<boolean> | undefined;
  #opening: Promise<boolean> | undefined;
  #finishing: Promise<boolean> | undefined;
  #unregisterExport: (() => void) | undefined;
  #layoutAbort: AbortController | undefined;
  #inputRelease: (() => void) | undefined;
  #inputVersion = 0;
  #failures = 0;
  #disposed = false;
  public constructor(options: ActiveTextSessionOptions) {
    this.#options = options;
    this.#creation = new ProvisionalTextCreation(
      options.model,
      options.history,
      () => this.#lease(),
      () => this.#input?.hasMeaningfulUserInput === true,
    );
    this.#geometry = new TextGeometry.TextSessionGeometry({
      current: () =>
        this.#input && this.#surface && this.#element
          ? {
              input: this.#input,
              surface: this.#surface,
              element: this.#element,
              preparation: this.#prepare(),
            }
          : undefined,
      store: options.model.store,
      flush: () => this.flush(),
      update: (element, preview) => this.#updateGeometry(element, preview),
      renderer: options.renderer,
      onError: options.onError,
      reconcileHostLayout: options.reconcileHostLayout,
    });
  }
  public get active(): boolean {
    return !this.#disposed && (this.#input !== undefined || this.#opening !== undefined);
  }
  public get activeId(): string | undefined {
    return this.#element?.id;
  }
  public get inputElement(): HTMLElement | undefined {
    return this.#input?.inputView.contentDOM;
  }
  public get inputCoordinates() {
    return this.#surface?.coordinates;
  }
  public readonly hostLayoutChanged = (height: number) => this.#geometry.hostLayoutChanged(height);
  public get geometrySuspended(): boolean {
    return this.#geometry.suspended;
  }
  public suspendForGeometry(): Promise<boolean> {
    return this.#geometry.suspend();
  }
  public resumeAfterGeometry(): Promise<boolean> {
    return this.#geometry.resume();
  }
  public registerProvisionalGeometryHistory(
    ...args: Parameters<ProvisionalTextCreation["registerGeometryApplied"]>
  ) {
    return this.#creation.registerGeometryApplied(...args);
  }
  public async create(
    box: { readonly x: number; readonly y: number; readonly width: number },
    source = "",
    edit = true,
  ): Promise<boolean> {
    if (!edit && source.trim().length === 0) return false;
    if (!(await this.finish())) return false;
    return this.#start(() =>
      createAndAppendTextField(box, source, {
        ...this.#options,
        creation: this.#creation,
        edit,
        isDisposed: () => this.#disposed,
        mount: (created) => this.#mount(created),
        reflow: this.reflow,
        signal: this.#lifetime.signal,
      }),
    );
  }
  public async edit(
    id: string,
    point?: number | { readonly x: number; readonly y: number },
    options: TextGeometry.TextSessionEditOptions = {},
  ): Promise<boolean> {
    if (this.activeId === id && this.#input) {
      this.#input.focusAt(point);
      return true;
    }
    if (!(await this.finish())) return false;
    return this.#start(async () => {
      const element = await TextGeometry.prepareTextEditingElement(id, {
        ...this.#options,
        ...options,
        preparation: this.#prepare(),
        signal: this.#lifetime.signal,
      });
      return element ? this.#mount(element, point) : false;
    });
  }
  public readonly reflow: TextReflow = (element, signal, options) =>
    this.#geometry.reflow(element, signal, this.#prepare(), options);
  public controls(t: Translator, fonts?: readonly StyleChoiceOption[]) {
    const summary = this.styleSummary();
    return summary ? createTextStyleControls(summary, t, fonts) : undefined;
  }
  public styleSummary() {
    return TextEditor.textSessionStyleSummary(this.#input, this.#draft, this.#preparation);
  }
  public focusInput(): void {
    TextEditor.revealTextSessionCaret(this.#input, true);
  }
  public requestCaretReveal(): void {
    TextEditor.revealTextSessionCaret(this.#input);
  }
  public reserveSourceBottom(bottom?: number): void {
    this.#extent?.reserveBottom(bottom);
  }
  public applyStyle(id: string, raw: boolean | number | string): boolean {
    const input = this.#input;
    if (!input || !this.#draft || this.#disposed) return false;
    const changed = TextEditor.applyTextSessionStyle(input, id, raw);
    if (changed) this.#options.onStateChanged();
    return changed;
  }
  public async flush(): Promise<boolean> {
    if (this.#opening && !(await this.#opening)) return false;
    if (this.#disposed) return false;
    if (this.#removed()) this.#closeInput();
    const failures = this.#failures;
    try {
      await this.#input?.flushChanges();
    } catch (error) {
      if (!this.#disposed) this.#options.onError(error);
      return false;
    }
    if (failures !== this.#failures) return false;
    if (!this.#running && this.#pending) this.#runPending();
    while (this.#running) if (!(await this.#running)) return false;
    return true;
  }
  public finish(): Promise<boolean> {
    this.#finishing ??= this.#finish().finally(() => {
      this.#finishing = undefined;
    });
    return this.#finishing;
  }
  async #finish(): Promise<boolean> {
    const settlement = this.#geometry.settled();
    if (settlement) await settlement;
    if (this.#disposed) return false;
    let version: number;
    do {
      version = this.#inputVersion;
      if (!(await this.flush())) return false;
      if (this.#creation.pending) {
        if (!(await this.#creation.discard(() => this.#inputVersion))) return false;
        this.#options.onSelection(new Set());
      }
      if (this.#removed()) this.#closeInput();
      if (this.activeId) {
        try {
          await this.#options.renderer.waitForTextElement(this.activeId, this.#lifetime.signal);
        } catch (error) {
          if (this.#removed()) {
            this.#closeInput();
            return true;
          }
          if (!this.#disposed) this.#options.onError(error);
          return false;
        }
      }
    } while (version !== this.#inputVersion);
    this.#closeInput();
    return true;
  }
  #removed(): boolean {
    const id = this.activeId;
    return id !== undefined && this.#options.model.store.get(id)?.element.kind !== "text";
  }
  #closeInput(): void {
    this.#geometry.cancel();
    const active = this.#input !== undefined;
    this.#extent?.dispose();
    this.#extent = undefined;
    this.#layoutAbort?.abort();
    this.#input?.dispose();
    this.#surface?.dispose();
    this.#input = undefined;
    this.#surface = undefined;
    this.#element = undefined;
    this.#draft = undefined;
    this.#creation.release();
    this.#pending = undefined;
    this.#preparation?.clearBindings();
    this.#releaseExport();
    if (active) {
      this.#options.onStateChanged();
      this.#options.onFinished?.();
    }
  }
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#geometry.dispose();
    this.#creation.release();
    this.#lifetime.abort();
    this.#layoutAbort?.abort();
    this.#inputRelease?.();
    this.#inputRelease = undefined;
    this.#extent?.dispose();
    this.#input?.dispose();
    this.#surface?.dispose();
    this.#input = undefined;
    this.#surface = undefined;
    this.#pending = undefined;
    this.#element = undefined;
    this.#draft = undefined;
    this.#preparation?.dispose();
    this.#releaseExport();
    for (const release of this.#leases) release();
  }
  #prepare(): ActiveTextPreparation {
    this.#preparation ??= new ActiveTextPreparation(this.#options);
    return this.#preparation;
  }
  async #start(operation: () => Promise<boolean>): Promise<boolean> {
    if (
      this.#disposed ||
      this.#opening ||
      this.#options.history.isTraversing ||
      this.#options.history.isDisposed
    )
      return false;
    try {
      this.#unregisterExport ??= this.#options.model.registerExportPreparation?.(async () => {
        if (!(await this.finish()))
          throw new Error("Current text changes could not be prepared for export.");
      });
    } catch (error) {
      this.#options.onError(error);
      return false;
    }
    const release = this.#lease();
    const opening = operation()
      .catch((error: unknown) => {
        if (!this.#disposed) this.#options.onError(error);
        return false;
      })
      .finally(() => {
        release?.();
        this.#opening = undefined;
        if (!this.active) this.#releaseExport();
      });
    this.#opening = opening;
    return opening;
  }

  async #mount(
    element: TextElementV2,
    point?: number | { readonly x: number; readonly y: number },
  ): Promise<boolean> {
    await this.#options.renderer.waitForTextElement(element.id, this.#lifetime.signal);
    if (this.#disposed) return false;
    const surface = this.#options.renderer.beginTextEditing(element.id, {
      onContentHeightChanged: this.#options.onHeightChanged,
      onDocumentInvalidated: () => {
        void TextHistory.replaceTextSessionDocument(
          this,
          this.#input?.selectionStart,
          () => this.#disposed,
        );
      },
      onGeometryChanged: this.#geometry.published,
      ...TextEditor.textSessionInputCallbacks(this.#options, () => this.finish()),
      onViewportChanged: TextEditor.textSessionViewportChanged(
        () => this.#input,
        () => this.#extent,
      ),
    });
    if (!surface) return false;
    this.#surface = surface;
    if (!(await TextEditor.prepareTextSessionSurface(surface, this.#lifetime.signal))) return false;
    this.#element = element;
    this.#draft = element;
    this.#preparation?.adopt(element);
    const editor = TextEditor.createTextSessionEditor({
      surface,
      element,
      ...(this.#options.tableCellLabel ? { tableCellLabel: this.#options.tableCellLabel } : {}),
      ...(this.#options.tableUi ? { tableUi: this.#options.tableUi } : {}),
      scheduler: this.#options.scheduler,
      preparation: this.#prepare(),
      sourceExtentLayout: this.#options.sourceExtentLayout,
      currentElement: () => this.#element,
      draft: () => this.#draft,
      onChange: (state, changes) => this.#sourceChanged(state, changes),
      onInputPending: (pending) => this.#inputPending(pending),
      onStateChanged: this.#options.onStateChanged,
      onFinish: () => {
        void this.finish();
      },
      onUndoRedo: TextHistory.textHistoryNavigator(
        this,
        { ...this.#options, isDisposed: () => this.#disposed },
        () => this.#input?.selectionStart,
      ),
      onError: this.#options.onError,
      onRevealBounds: this.#options.onRevealBounds,
      ...(this.#options.onScrollInterrupt
        ? { onScrollInterrupt: this.#options.onScrollInterrupt }
        : {}),
    });
    this.#input = editor.input;
    this.#geometry.primeHostLayout();
    this.#extent = editor.extent;
    this.#input.focusAt(point ?? element.source.length, false);
    await this.#input.ready;
    if (this.#disposed || this.#lifetime.signal.aborted) return false;
    surface.setReady?.();
    this.#options.onSelection(new Set([element.id]));
    this.#input.focusSelectionPreserved();
    this.#options.onStateChanged();
    return true;
  }
  #updateGeometry(element: TextElementV2, preview = false): void {
    if (!preview) this.#element = element;
    this.#draft = element;
    this.#input?.updateElement(element);
    this.#surface?.updateBounds(element, element);
    this.#extent?.update(preview);
    if (!preview && !this.#geometry.settled()) this.requestCaretReveal();
    if (!preview) this.#options.onStateChanged();
  }

  #sourceChanged(state: TextSourceState, changes?: ChangeDesc): void {
    const element = this.#draft;
    if (!element || this.#disposed) return;
    this.#inputVersion += 1;
    if (changes) this.#preparation?.mapChanges(changes);
    // The prepared store pipeline owns the immutable copy; editor arrays are never mutated here.
    this.#queue({
      ...element,
      source: state.source,
      ranges: state.ranges as TextElementV2["ranges"],
      paragraphs: state.paragraphs as TextElementV2["paragraphs"],
    });
  }
  #queue(element: TextElementV2): void {
    this.#draft = element;
    this.#pending = element;
    this.#layoutAbort?.abort();
    if (!this.#running) this.#runPending();
    this.#options.onStateChanged();
  }

  #inputPending(pending: boolean): void {
    if (pending && !this.#inputRelease) {
      this.#inputVersion += 1;
      this.#inputRelease = this.#lease();
      this.#layoutAbort?.abort();
    } else if (!pending) {
      this.#inputRelease?.();
      this.#inputRelease = undefined;
    }
  }
  #releaseExport(): void {
    this.#unregisterExport?.();
    this.#unregisterExport = undefined;
  }

  #runPending(): void {
    const release = this.#lease();
    let completed = false;
    this.#running = this.#drain()
      .then((result) => {
        completed = result;
        return result;
      })
      .finally(() => {
        this.#running = undefined;
        if (completed && this.#pending && !this.#disposed) this.#runPending();
        release();
      });
  }

  #lease(): () => void {
    const releaseModel = this.#options.model.beginInteractiveOperation?.();
    const release = () => {
      if (this.#leases.delete(release)) releaseModel?.();
    };
    this.#leases.add(release);
    return release;
  }

  async #drain(): Promise<boolean> {
    while (this.#pending && !this.#disposed) {
      const pending = this.#pending;
      this.#pending = undefined;
      const abort = new AbortController();
      let preview: ReturnType<SvgSceneRenderer["beginPreviewCommit"]> | undefined;
      this.#layoutAbort = abort;
      try {
        preview = this.#options.renderer.beginPreviewCommit();
        const element = await this.reflow(pending, abort.signal);
        if (abort.signal.aborted || this.#disposed) continue;
        if (
          !(await TextHistory.commitTextReplacement(
            this.#options.model,
            this.#creation,
            element,
            abort.signal,
            () => preview!.arm([element.id]),
          ))
        ) {
          if (abort.signal.aborted) continue;
          throw new Error("Text changes could not be committed.");
        }
        this.#preparation?.adopt(element);
        if (!abort.signal.aborted && !this.#pending) this.#updateGeometry(element);
        else this.#element = element;
      } catch (error) {
        if (abort.signal.aborted || this.#disposed) continue;
        if (this.#removed()) {
          this.#closeInput();
          return true;
        }
        this.#pending ??= pending;
        this.#failures += 1;
        this.#options.onError(error);
        return false;
      } finally {
        preview?.cancel();
        if (this.#layoutAbort === abort) this.#layoutAbort = undefined;
      }
    }
    return !this.#disposed;
  }
}
