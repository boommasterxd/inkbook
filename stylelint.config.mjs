export default {
  extends: ["stylelint-config-standard"],
  rules: {
    "max-nesting-depth": 2,
    "no-descending-specificity": true,
    "no-duplicate-selectors": true,
    "property-no-unknown": true,
    "selector-max-specificity": "0,5,0",
    "selector-no-qualifying-type": true,
  },
};
