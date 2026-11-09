import { sys } from "typescript";

/** Load the production stylesheet rules used by DOM interaction checks. */
export function installPluginStyles(...names: readonly string[]): void {
  const stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(
    names
      .map((name) => sys.readFile(sys.resolvePath(`src/obsidian/styles/${name}.css`)) ?? "")
      .join("\n"),
  );
  document.adoptedStyleSheets = [stylesheet];
}
