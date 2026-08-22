import type { BackgroundSpacing, BackgroundType } from "../../../rendering/ui/index";
import type { EditableDocumentModel } from "../vault-document-session";
import {
  pageWithBackgroundSpacing,
  pageWithBackgroundType,
  type BackgroundSpacingDefaults,
} from "./controller-helpers";
import type { ActiveEditorHistory } from "./history";

export interface ActiveEditorBackgroundSessionOptions {
  readonly backgroundSpacing: () => BackgroundSpacingDefaults;
  readonly history: ActiveEditorHistory;
  readonly model: EditableDocumentModel;
  readonly onPageChanged: () => void;
  readonly onStateChanged: () => void;
}

export class ActiveEditorBackgroundSession {
  readonly #options: ActiveEditorBackgroundSessionOptions;

  public constructor(options: ActiveEditorBackgroundSessionOptions) {
    this.#options = options;
  }

  public changeSpacing(spacing: BackgroundSpacing): void {
    const page = this.#options.model.page;
    const replacement = pageWithBackgroundSpacing(page, spacing);
    if (replacement === null) return;
    if (this.#options.history.updatePage(page, replacement)) this.#changed();
  }

  public changeType(type: BackgroundType): void {
    const page = this.#options.model.page;
    const replacement = pageWithBackgroundType(page, type, this.#options.backgroundSpacing());
    if (replacement === page) return;
    if (this.#options.history.updatePage(page, replacement)) this.#changed();
  }

  #changed(): void {
    this.#options.onPageChanged();
    this.#options.onStateChanged();
  }
}
