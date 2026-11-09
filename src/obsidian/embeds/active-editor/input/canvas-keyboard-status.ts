import { Localization } from "../../../../domain/localization";
import { bindEmbedDescription } from "../../presentation/embed-description";

let nextStatus = 0;

/** One lifecycle-owned explanation and live status, independent of the culled SVG. */
export class CanvasKeyboardStatus {
  readonly #surface: HTMLElement;
  readonly #instructions: HTMLElement;
  readonly #status: HTMLElement;
  readonly #releaseDescription: () => void;
  readonly #releaseLocalization: () => void;

  public constructor(surface: HTMLElement, localization: Localization = new Localization()) {
    this.#surface = surface;
    const labelId = surface.getAttribute("aria-labelledby");
    const label = labelId === null ? null : surface.ownerDocument.getElementById(labelId);
    const updateName = () => {
      if (label !== null && surface.contains(label))
        label.textContent = localization.t("canvas.name");
    };
    updateName();
    this.#instructions = surface.createSpan({
      cls: "inkbook-menu-visually-hidden",
      text: localization.t("canvas.keyboard_instructions"),
    });
    this.#releaseLocalization = localization.subscribe(() => {
      updateName();
      this.#instructions.textContent = localization.t("canvas.keyboard_instructions");
      this.#status.textContent = "";
    });
    this.#instructions.id = `inkbook-canvas-instructions-${++nextStatus}`;
    this.#status = surface.createSpan({ cls: "inkbook-menu-visually-hidden" });
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("aria-atomic", "true");
    const previous = surface.getAttribute("aria-describedby");
    surface.setAttribute(
      "aria-describedby",
      [previous, this.#instructions.id].filter(Boolean).join(" "),
    );
    const root = surface.closest<HTMLElement>(".inkbook-embed-root");
    this.#releaseDescription =
      root === null ? () => undefined : bindEmbedDescription(root, surface);
  }

  public announce(message: string): void {
    this.#status.textContent = message;
  }

  public dispose(): void {
    this.#releaseLocalization();
    this.#releaseDescription();
    const ids = (this.#surface.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((id) => id && id !== this.#instructions.id);
    if (ids.length) this.#surface.setAttribute("aria-describedby", ids.join(" "));
    else this.#surface.removeAttribute("aria-describedby");
    this.#status.remove();
    this.#instructions.remove();
  }
}
