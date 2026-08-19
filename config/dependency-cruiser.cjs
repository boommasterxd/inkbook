/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "domain-is-framework-independent",
      severity: "error",
      from: { path: "^src/domain" },
      to: {
        path: "^(obsidian|@codemirror|react|src/(adapters|application|rendering|ui|workers))",
      },
    },
    {
      name: "no-node-or-electron-in-production",
      severity: "error",
      from: { path: "^src" },
      to: { path: "^(node:|electron$|fs$|path$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)node_modules/",
    tsConfig: { fileName: "tsconfig.json" },
  },
};
