export default {
  forbidden: [
    {
      from: {},
      name: "no-circular-dependencies",
      severity: "error",
      to: { circular: true },
    },
    {
      from: { path: "^src/domain/" },
      name: "domain-is-independent",
      severity: "error",
      to: { path: "^src/(editor|obsidian|persistence|rendering)/" },
    },
    {
      from: { path: "^src/editor/" },
      name: "editor-depends-only-on-domain",
      severity: "error",
      to: { path: "^src/(obsidian|persistence|rendering)/" },
    },
    {
      from: { path: "^src/persistence/" },
      name: "persistence-depends-only-on-domain",
      severity: "error",
      to: { path: "^src/(editor|obsidian|rendering)/" },
    },
    {
      from: { path: "^src/rendering/" },
      name: "rendering-stays-host-independent",
      severity: "error",
      to: { path: "^src/(obsidian|persistence)/" },
    },
    {
      from: { path: "^src/main\\.ts$" },
      name: "entry-only-loads-obsidian",
      severity: "error",
      to: { path: "^src/(domain|editor|persistence|rendering)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx"],
    },
    includeOnly: "^src",
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: "specify",
  },
};
