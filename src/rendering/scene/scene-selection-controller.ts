import type { SceneContentRenderer } from "./content-renderer";
import type { SceneFrameWriter } from "./scene-frame-writer";

interface SelectionChromePorts {
  readonly content: SceneContentRenderer;
  readonly writer: SceneFrameWriter;
  readonly schedule: () => void;
}

/** Owns the renderer's imperative selection chrome entrypoints and frame admission. */
export class SceneSelectionController {
  public constructor(private readonly ports: () => SelectionChromePorts) {}

  public readonly select = (ids: ReadonlySet<string>): void => {
    const ports = this.ports();
    ports.content.setSelectedElements(ids);
    ports.schedule();
  };

  public readonly highlights = (enabled: boolean): void => {
    const ports = this.ports();
    ports.content.setSelectionHighlightsEnabled(enabled);
    ports.schedule();
  };

  public readonly outline = (...args: Parameters<SceneFrameWriter["setSelectionPath"]>): void => {
    const ports = this.ports();
    ports.writer.setSelectionPath(...args);
    ports.schedule();
  };

  public readonly lockedOutline = (path: string | null): void => {
    const ports = this.ports();
    ports.writer.setLockedSelectionPath(path);
    ports.schedule();
  };

  public readonly snap = (path: string | null): void => {
    const ports = this.ports();
    ports.writer.setSnapPath(path);
    ports.schedule();
  };
}
