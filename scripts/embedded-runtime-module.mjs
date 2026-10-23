const pluginRuntimeHostModules = new Set([
  "@codemirror/language",
  "@codemirror/state",
  "@codemirror/view",
  "obsidian",
]);

/** Exposes the bundled CommonJS runtime through the host's native module boundary. */
export function wrapPluginRuntime(source) {
  const requiredModules = [...source.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1]);
  const unsupportedModule = requiredModules.find(
    (moduleId) => moduleId === undefined || !pluginRuntimeHostModules.has(moduleId),
  );
  if (unsupportedModule !== undefined) {
    throw new Error(`Plugin runtime requires unsupported host module: ${unsupportedModule}`);
  }
  return `const hostModules=globalThis.__inkbookHostModules;
if(hostModules===undefined)throw new Error("Inkbook host modules are unavailable.");
const require=id=>{const dependency=hostModules[id];if(dependency===undefined)throw new Error("Unsupported Inkbook host module: "+id);return dependency;};
const module={exports:{}},exports=module.exports;
${source}
const activateInkbookPluginFromRuntime=module.exports.activateInkbookPlugin;
export{activateInkbookPluginFromRuntime as activateInkbookPlugin};`;
}
