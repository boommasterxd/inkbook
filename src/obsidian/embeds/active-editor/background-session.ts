import type { PageV1 } from "../../../domain/schema/public";
import type { BackgroundSpacing, BackgroundType } from "../../menus/editor-menu-types";
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
  readonly onPagePreviewFinish: (committed: boolean) => void;
  readonly onPagePreview: (page: PageV1) => void;
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
    const committed = this.#options.history.updatePage(page, replacement);
    this.#options.onPagePreviewFinish(committed);
    if (committed) this.#changed();
  }

  public previewSpacing(spacing: BackgroundSpacing): void {
    if (this.#options.model.mutationAvailability === "revision-exhausted") return;
    const page = this.#options.model.page;
    this.#options.onPagePreview(pageWithBackgroundSpacing(page, spacing) ?? page);
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
