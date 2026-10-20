const nativeMenuSelectors = [/\.menu(?![\w-])/, /\.menu-scroll/];
const ownedSurfaceSelector =
  /^(?!\.inkbook-(?:root(?![\w-])|menu-|adaptive-panel|tool-cursor-surface(?![\w-])|owned-menu$)|\.inkbook-(?:scrollbar-stable|scroll-anchor-suppressed)$|\.is-phone\s+\.inkbook-root\.inkbook-feedback-host$)/;

export default {
  extends: ["stylelint-config-standard"],
  rules: {
    "max-nesting-depth": 2,
    "no-descending-specificity": true,
    "no-duplicate-selectors": true,
    "property-no-unknown": true,
    "selector-max-specificity": "0,5,0",
    "selector-no-qualifying-type": true,
    "selector-disallowed-list": [nativeMenuSelectors, { splitList: true }],
  },
  overrides: [
    {
      files: [
        "src/obsidian/styles/{inkbook,feedback,focus-navigation,editor-toolbar,editor-menus,background-menu,adaptive-panel}.css",
      ],
      rules: {
        "selector-disallowed-list": [
          [...nativeMenuSelectors, ownedSurfaceSelector],
          { ignore: ["keyframe-selectors"], splitList: true },
        ],
      },
    },
  ],
};
