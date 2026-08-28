import type { Keymap } from "obsidian";

import { InkbookFeedbackManager, type InkbookFeedbackCode } from "../feedback";

export interface WorkspaceFeedbackHost {
  readonly fallbackOwnerWindow: () => Window | undefined;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
  readonly manager: InkbookFeedbackManager;
  readonly view: () => HTMLElement | undefined;
}

export class WorkspaceFeedbackRouter {
  readonly #manager: InkbookFeedbackManager;
  readonly #owningWindow: (documentId: string) => Window;
  readonly #view: () => HTMLElement | undefined;

  public constructor(
    manager: InkbookFeedbackManager,
    view: () => HTMLElement | undefined,
    owningWindow: (documentId: string) => Window,
  ) {
    this.#manager = manager;
    this.#owningWindow = owningWindow;
    this.#view = view;
  }

  public closePresentation(root: HTMLElement): void {
    this.#manager.closePresentation(root);
  }

  public showInPresentation(root: HTMLElement, code: InkbookFeedbackCode): void {
    this.#manager.showInPresentation(root, { code });
  }

  public showRecoveryCopySaved(documentId: string): void {
    this.#manager.showInViewOrWindow(this.#owningWindow(documentId), this.#view(), {
      code: "recovery-copy-saved",
    });
  }
}
