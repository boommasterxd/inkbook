import { bindEmbedDescription } from "../../presentation/embed-description";

const INSTRUCTIONS =
  "Page Up and Page Down select objects. Home and End select the first and last object. Enter starts geometry editing. In geometry editing, Page Up and Page Down choose a handle, arrow keys adjust it by 1 document unit or 1 degree, and Shift adjusts by 10. Enter or Escape leaves geometry editing. Tab leaves the canvas.";
let nextStatus = 0;

/** One lifecycle-owned explanation and live status, independent of the culled SVG. */
export class CanvasKeyboardStatus {
  readonly #surface: HTMLElement;
  readonly #instructions: HTMLElement;
  readonly #status: HTMLElement;
  readonly #releaseDescription: () => void;

  public constructor(surface: HTMLElement) {
    this.#surface = surface;
    this.#instructions = surface.createSpan({
      cls: "inkbook-menu-visually-hidden",
      text: INSTRUCTIONS,
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
