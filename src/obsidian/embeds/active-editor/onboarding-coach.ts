import { Component, type Keymap } from "obsidian";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { effectiveTransitionDuration } from "../../runtime/effective-motion";
import { registerFocusNavigation } from "../../runtime/focus-navigation";
import { observeMenuMotionPreference } from "../../menus/feedback/menu-motion";
import { installMenuEscapeScope } from "../../menus/menu-escape-scope";
import type { BrowserScrollElement } from "../../scrolling/index";
import { OnboardingViewport } from "./onboarding-viewport";
import {
  layoutOnboardingNote,
  onboardingNoteWidth,
  ONBOARDING_COMPACT_HEIGHT,
  type OnboardingBounds,
  type OnboardingLayout,
} from "./onboarding-layout";
import { OnboardingInk } from "./onboarding-ink";
import { OnboardingPresence } from "./onboarding-presence";
import { mountToolbarButtonFeedback } from "../../runtime/toolbar-button-feedback";
import { revealOnboardingTarget } from "./onboarding-target";
import type { ToolbarAction } from "../../../rendering/ui/toolbar-types";

export interface CoachStep {
  readonly action: ToolbarAction;
  readonly title: string;
  readonly lines: readonly string[];
  readonly description: string;
  readonly previewContext?: boolean;
  readonly optional?: boolean;
}

interface CoachOptions {
  readonly root: HTMLElement;
  readonly workScheduler: WorkScheduler;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
  readonly renderIcon?: (element: HTMLElement, icon: string) => void;
  readonly onClose: (restoreFocus?: boolean) => void;
  readonly onNavigate: (direction: number) => void;
  readonly onSpaceRequired?: (minimum: number) => void;
  readonly scrollOwner?: () => BrowserScrollElement;
}

export class OnboardingCoach extends Component {
  readonly #options: CoachOptions;
  readonly #layer: HTMLElement;
  readonly #dialog: HTMLElement;
  readonly #note: HTMLElement;
  readonly #navigation: HTMLElement;
  readonly #progress: HTMLElement;
  readonly #back: HTMLButtonElement;
  readonly #next: HTMLButtonElement;
  readonly #presence: OnboardingPresence;
  readonly #arrow: SVGSVGElement;
  readonly #paper: HTMLElement;
  readonly #viewport: OnboardingViewport;
  #action: ToolbarAction | undefined;
  #frame: number | undefined;
  #ink = new OnboardingInk();
  #arrowPath: SVGPathElement | undefined;
  #arrowHead: SVGPathElement | undefined;
  #closed = false;
  #initialFocus: HTMLButtonElement | undefined;
  #feedback: ReturnType<typeof mountToolbarButtonFeedback> | undefined;
  #title: SVGSVGElement | undefined;
  #titleInk: DOMRect | undefined;
  #last = false;
  #revealAllowed = true;

  public constructor(options: CoachOptions) {
    super();
    this.#options = options;
    const { root } = options;
    this.#viewport = new OnboardingViewport(root, options.scrollOwner);
    this.#paper = root.querySelector<HTMLElement>(".inkbook-background-container") ?? root;
    this.#layer = this.#paper.createDiv({ cls: "inkbook-onboarding-layer" });
    this.#arrow = this.#layer.createSvg("svg");
    this.#arrow.classList.add("inkbook-onboarding-arrow");
    this.#arrow.setAttribute("aria-hidden", "true");
    this.#arrow.setAttribute("focusable", "false");
    this.#dialog = this.#layer.createEl("section", { cls: "inkbook-onboarding-tour" });
    this.#dialog.setAttribute("role", "dialog");
    this.#dialog.tabIndex = -1;
    this.#note = this.#dialog.createDiv({ cls: "inkbook-onboarding-note" });
    this.#note.setAttribute("aria-live", "polite");
    this.#note.setAttribute("aria-atomic", "true");
    this.#navigation = this.#dialog.createDiv({ cls: "inkbook-onboarding-navigation" });
    this.#progress = this.#navigation.createSpan({ cls: "inkbook-onboarding-progress" });
    const actions = this.#navigation.createDiv({ cls: "inkbook-onboarding-actions" });
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Tour navigation");
    this.#back = this.#button(actions, {
      text: "Back",
      icon: "arrow-left",
      action: () => options.onNavigate(-1),
    });
    this.#next = this.#button(actions, {
      text: "Next",
      icon: "arrow-right",
      action: () => (this.#last ? options.onClose() : options.onNavigate(1)),
    });
    this.#button(actions, { text: "Skip tour", icon: "x", action: () => options.onClose() });
    this.#layer.append(this.#arrow);
    this.#presence = new OnboardingPresence(this.#layer, root);
    this.load();
  }

  public override onload(): void {
    const { root, keymap, onClose } = this.#options;
    const document = root.ownerDocument;
    const ownerWindow = document.defaultView;
    if (ownerWindow === null) return;
    this.register(registerFocusNavigation(this.#dialog));
    this.register(installMenuEscapeScope(keymap, onClose));
    this.registerDomEvent(
      document,
      "keydown",
      (event) => {
        if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key))
          this.#revealAllowed = false;
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      },
      true,
    );
    this.registerDomEvent(
      document,
      "pointerdown",
      (event) => {
        if (event.pointerType === "touch") this.#revealAllowed = false;
        if (event.target === null || !("nodeType" in event.target)) return;
        const target = event.target as Node;
        const element = target.nodeType === 1 ? (target as Element) : target.parentElement;
        if (element?.closest('[data-inkbook-tour-preview="true"]') && root.contains(element)) {
          event.preventDefault();
          return;
        }
        if (!this.#dialog.contains(target)) onClose(false);
      },
      true,
    );
    this.registerDomEvent(document, "scroll", this.#schedulePosition, true);
    this.registerDomEvent(
      document,
      "wheel",
      () => {
        this.#revealAllowed = false;
      },
      { capture: true, passive: true },
    );
    this.registerDomEvent(ownerWindow, "resize", this.#revealAfterResize);
    const viewport = ownerWindow.visualViewport;
    viewport?.addEventListener("resize", this.#revealAfterResize);
    viewport?.addEventListener("scroll", this.#schedulePosition);
    this.register(() => {
      viewport?.removeEventListener("resize", this.#revealAfterResize);
      viewport?.removeEventListener("scroll", this.#schedulePosition);
    });
    const observer = new ownerWindow.ResizeObserver(this.#schedulePosition);
    observer.observe(this.#paper);
    observer.observe(this.#note);
    this.#viewport.observe(observer);
    this.register(() => observer.disconnect());
    const scheme = new ownerWindow.MutationObserver(this.#schedulePosition);
    scheme.observe(root, { attributes: true, attributeFilter: ["data-inkbook-scheme"] });
    this.register(() => scheme.disconnect());
    const toolbar = root.querySelector(".inkbook-toolbar-composition");
    if (toolbar !== null) {
      const toolbarChanges = new ownerWindow.MutationObserver(this.#schedulePosition);
      toolbarChanges.observe(toolbar, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "data-presence"],
      });
      observer.observe(toolbar);
      this.register(() => toolbarChanges.disconnect());
    }
    this.register(observeMenuMotionPreference(root, ownerWindow, () => this.#ink.finish()));
    this.#feedback = mountToolbarButtonFeedback(this.#navigation, root);
  }

  public show(step: CoachStep, index: number, total: number): void {
    this.#revealAllowed = true;
    const root = this.#options.root;
    this.#action = step.action;
    this.#ink.dispose();
    this.#ink = new OnboardingInk();
    this.#arrow.replaceChildren();
    this.#arrowPath = this.#ink.path(this.#arrow, 180, 500);
    this.#arrowHead = this.#ink.path(this.#arrow, 680, 100);
    this.#note.replaceChildren();
    const heading = this.#note.createEl("h2", {
      cls: "inkbook-menu-visually-hidden",
      text: step.description,
    });
    heading.id = `inkbook-coach-${root.ownerDocument.defaultView!.crypto.randomUUID()}`;
    this.#dialog.setAttribute("aria-labelledby", heading.id);
    this.#title = this.#ink.lettering(this.#note, step.title, true, 780);
    this.#titleInk = this.#title.getBBox?.();
    step.lines.forEach((text, line) =>
      this.#ink.lettering(this.#note, text, false, 1580 + line * 720),
    );
    this.#progress.textContent = `${String(index + 1)}/${String(total)}`;
    this.#progress.setAttribute("aria-label", `Step ${String(index + 1)} of ${String(total)}`);
    this.#back.disabled = index === 0;
    this.#last = index === total - 1;
    const nextLabel = this.#last ? "Done" : "Next";
    this.#next.setAttribute("aria-label", nextLabel);
    this.#next.querySelector(".inkbook-menu-visually-hidden")!.textContent = nextLabel;
    const nextIcon = this.#next.querySelector<HTMLElement>(".inkbook-onboarding-action-icon")!;
    nextIcon.replaceChildren();
    this.#options.renderIcon?.(nextIcon, this.#last ? "check" : "arrow-right");
    this.#feedback?.refresh();
    const ownerWindow = root.ownerDocument.defaultView;
    this.#initialFocus = this.#next;
    this.#position();
    this.#ink.play(
      ownerWindow === null || effectiveTransitionDuration(root, ownerWindow, "adaptiveMenu") === 0,
    );
  }

  public close(onExited: () => void): void {
    if (this.#closed) return;
    this.#stop();
    this.#presence.close(onExited);
  }

  public dispose(): void {
    if (!this.#closed) this.#stop();
    this.#presence.dispose();
  }

  #stop(): void {
    this.#closed = true;
    this.#ink.dispose();
    this.#feedback?.dispose();
    this.#feedback = undefined;
    this.#title = undefined;
    this.#titleInk = undefined;
    if (this.#frame !== undefined) this.#options.workScheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.unload();
    this.#viewport.dispose();
  }

  public revealIfNeeded(): void {
    if (this.#closed || !this.#revealAllowed) return;
    this.#viewport.reveal(this.#paper);
    this.#schedulePosition();
  }

  #button(
    parent: HTMLElement,
    options: {
      text: string;
      icon: string;
      action: () => void;
    },
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      type: "button",
      cls: "inkbook-onboarding-action inkbook-onboarding-icon-action",
    });
    const label = button.createSpan({ text: options.text });
    button.setAttribute("aria-label", options.text);
    label.classList.add("inkbook-menu-visually-hidden");
    button.createSpan({ cls: "inkbook-toolbar-button-surface", attr: { "aria-hidden": "true" } });
    const icon = button.createSpan({ cls: "inkbook-onboarding-action-icon" });
    icon.setAttribute("aria-hidden", "true");
    this.#options.renderIcon?.(icon, options.icon);
    button.addEventListener("click", () => options.action());
    return button;
  }

  readonly #schedulePosition = (): void => {
    if (this.#closed || this.#frame !== undefined) return;
    this.#frame = this.#options.workScheduler.requestFrame(() => {
      this.#frame = undefined;
      if (!this.#closed) this.#position();
    });
  };

  readonly #revealAfterResize = (): void => {
    this.#revealAllowed = true;
    this.revealIfNeeded();
  };

  #relativeTitleBounds(): OnboardingBounds | undefined {
    const title = this.#title;
    const ink = this.#titleInk;
    if (title === undefined || ink === undefined) return;
    const matrix = title.getScreenCTM?.();
    if (matrix === null || matrix === undefined) return;
    const note = this.#note.getBoundingClientRect();
    const corners = [
      [ink.x, ink.y],
      [ink.x + ink.width, ink.y],
      [ink.x, ink.y + ink.height],
      [ink.x + ink.width, ink.y + ink.height],
    ].map(([x, y]) => ({
      x: matrix.a * x! + matrix.c * y! + matrix.e,
      y: matrix.b * x! + matrix.d * y! + matrix.f,
    }));
    const left = Math.min(...corners.map((point) => point.x));
    const top = Math.min(...corners.map((point) => point.y));
    return {
      left: left - note.left,
      top: top - note.top,
      width: Math.max(...corners.map((point) => point.x)) - left,
      height: Math.max(...corners.map((point) => point.y)) - top,
    };
  }

  #position(): void {
    const target = this.#options.root.querySelector<HTMLElement>(
      `button[data-inkbook-action="${this.#action ?? "draw"}"]:not([data-presence="exiting"])`,
    );
    const ownerWindow = this.#options.root.ownerDocument.defaultView;
    if (ownerWindow === null) {
      this.#layer.classList.add("inkbook-onboarding-hidden");
      return;
    }
    if (target !== null) revealOnboardingTarget(target);
    const scheme = this.#options.root.dataset.inkbookScheme ?? "light";
    if (this.#layer.dataset.inkbookScheme !== scheme) this.#layer.dataset.inkbookScheme = scheme;
    const paper = this.#paper.getBoundingClientRect();
    const bounds = target?.getBoundingClientRect() ?? paper;
    const viewport = this.#viewport.read();
    const compact = viewport.height < ONBOARDING_COMPACT_HEIGHT;
    this.#layer.dataset.compact = String(compact);
    const width = `${String(onboardingNoteWidth(paper, viewport, compact))}px`;
    if (this.#note.style.width !== width) this.#note.style.width = width;
    const corridor = target
      ?.closest(".inkbook-toolbar-composition-scrollable")
      ?.getBoundingClientRect();
    const noteHeight = this.#note.offsetHeight;
    const title = this.#relativeTitleBounds();
    const navigationHeight = this.#navigation.offsetHeight;
    this.#options.onSpaceRequired?.(Math.max(360, noteHeight + navigationHeight + 144));
    const layout = layoutOnboardingNote({
      paper,
      target: bounds,
      viewport,
      noteHeight,
      navigationHeight,
      compact,
      ...(title === undefined ? {} : { title }),
      targetVisible:
        target !== null &&
        (corridor === undefined ||
          (bounds.left >= corridor.left && bounds.right <= corridor.right)),
    });
    if (this.#revealClippedLayout(layout, paper, viewport, bounds)) {
      this.#schedulePosition();
      return;
    }
    this.#applyLayout(layout);
  }

  #revealClippedLayout(
    layout: OnboardingLayout,
    paper: OnboardingBounds,
    viewport: OnboardingBounds,
    target: OnboardingBounds,
  ): boolean {
    const bottom = viewport.top + viewport.height;
    const targetClipped = target.top < viewport.top || target.top + target.height > bottom;
    return (
      this.#revealAllowed &&
      (!layout.visible || targetClipped) &&
      paper.top < bottom &&
      paper.top + paper.height > viewport.top &&
      this.#viewport.reveal(this.#paper, viewport, target)
    );
  }

  #applyLayout(layout: OnboardingLayout): void {
    this.#layer.classList.toggle(
      "inkbook-onboarding-hidden",
      !layout.visible && !layout.navigationVisible,
    );
    this.#note.style.visibility = layout.visible ? "visible" : "hidden";
    this.#navigation.style.visibility = layout.navigationVisible ? "visible" : "hidden";
    if (layout.navigationVisible && this.#initialFocus !== undefined) {
      this.#initialFocus.focus({ preventScroll: true });
      this.#initialFocus = undefined;
    }
    const layer = this.#layer.getBoundingClientRect();
    this.#note.style.left = `${String(layout.left - layer.left)}px`;
    this.#note.style.top = `${String(layout.top - layer.top)}px`;
    this.#navigation.style.left = `${String(layout.navigationLeft - layer.left)}px`;
    this.#navigation.style.top = `${String(layout.navigationTop - layer.top)}px`;
    this.#arrow.setAttribute(
      "viewBox",
      `${String(layer.left)} ${String(layer.top)} ${String(layer.width)} ${String(layer.height)}`,
    );
    this.#arrow.style.visibility = layout.showArrow ? "visible" : "hidden";
    this.#arrowPath?.setAttribute("d", layout.arrow);
    this.#arrowHead?.setAttribute("d", layout.arrowHead);
  }
}
