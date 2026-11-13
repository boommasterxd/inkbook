import type { TextFontLibraryPort } from "../active-editor/text-preparation";
import type { PhoneSheetHostPort } from "../../menus/panels/phone-sheet-host";
import type { Localization } from "../../../domain/localization";
import type { Keymap } from "obsidian";
import type { EditorChromeOpenings } from "../active-scene/editor-chrome-openings";
import type { DeviceLocalStoragePort } from "../../storage/trusted-document-head-ledger";
import type { HeadlessRecoveryActions, HeadlessRecoveryNotice } from "./recovery-notice";

import { InkbookFeedbackManager, type InkbookFeedbackCode } from "../../feedback";

export interface WorkspaceFeedbackHost {
  readonly localization?: Localization | undefined;
  readonly confirmEraseAll?: (signal: AbortSignal) => Promise<boolean>;
  readonly openRecovery?: (actions: HeadlessRecoveryActions) => HeadlessRecoveryNotice;
  readonly fallbackOwnerWindow: () => Window | undefined;
  readonly createPhoneSheetHost?: () => PhoneSheetHostPort;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
  readonly manager: InkbookFeedbackManager;
}

export interface WorkspaceRuntimeHost
  extends WorkspaceFeedbackHost, Omit<EditorChromeOpenings, "confirmEraseAll"> {
  readonly textFonts?: TextFontLibraryPort | undefined;
  readonly deviceStorage?: DeviceLocalStoragePort;
  readonly resolveDocumentStatusPane?: (root: HTMLElement) => HTMLElement | undefined;
}

export class WorkspaceFeedbackRouter {
  readonly #manager: InkbookFeedbackManager;
  readonly #owningWindow: (documentId: string) => Window;

  public constructor(
    manager: InkbookFeedbackManager,
    owningWindow: (documentId: string) => Window,
  ) {
    this.#manager = manager;
    this.#owningWindow = owningWindow;
  }

  public closePresentation(root: HTMLElement): void {
    this.#manager.closePresentation(root);
  }

  public showInPresentation(root: HTMLElement, code: InkbookFeedbackCode): void {
    this.#manager.showInPresentation(root, { code });
  }

  public showRecoveryCopySaved(documentId: string): void {
    this.#manager.showInWindow(this.#owningWindow(documentId), {
      code: "recovery-copy-saved",
    });
  }
}
