const MAX_SCENARIOS = 2_000;
const MAX_NAME_LENGTH = 4_096;
const MAX_PATTERN_LENGTH = 128 * 1024;

function scenarioKey(file, testName) {
  return JSON.stringify([file, testName]);
}

export function createScenarioSelection(scenarios, files) {
  if (scenarios === undefined) return undefined;
  if (!Array.isArray(scenarios) || scenarios.length === 0 || scenarios.length > MAX_SCENARIOS) {
    throw new Error("Invalid scenario selection population.");
  }
  const keys = new Set();
  const selectedFiles = new Set();
  const names = new Set();
  for (const scenario of scenarios) {
    if (
      !scenario ||
      !files.includes(scenario.file) ||
      typeof scenario.testName !== "string" ||
      scenario.testName.trim().length === 0 ||
      scenario.testName.length > MAX_NAME_LENGTH
    ) {
      throw new Error("Invalid selected scenario.");
    }
    const key = scenarioKey(scenario.file, scenario.testName);
    if (keys.has(key)) throw new Error("Duplicate selected scenario.");
    keys.add(key);
    names.add(scenario.testName);
    selectedFiles.add(scenario.file);
  }
  if (selectedFiles.size !== files.length)
    throw new Error("Selected scenario missing for test file.");
  const escaped = [...names].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = `^(?:${escaped.join("|")})$`;
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error("Scenario pattern exceeds limit.");
  return { keys, remaining: new Set(keys), pattern };
}

export function consumeScenarioResult(selection, file, assertion) {
  const name =
    Array.isArray(assertion.ancestorTitles) && typeof assertion.title === "string"
      ? [...assertion.ancestorTitles, assertion.title].join(" > ")
      : assertion.fullName;
  const key = scenarioKey(file, name);
  if (!selection.keys.has(key)) {
    if (assertion.status === "skipped") return false;
    throw new Error(`Unexpected executed scenario: ${key}.`);
  }
  if (!selection.remaining.delete(key)) throw new Error(`Duplicate scenario result: ${key}.`);
  return true;
}

export function validateSelectedMeasurements(selection, measurements) {
  const remaining = new Set(selection.keys);
  for (const record of measurements) {
    const key = scenarioKey(record.file, record.testName);
    if (!selection.keys.has(key)) throw new Error(`Unexpected scenario measurement: ${key}.`);
    remaining.delete(key);
  }
  if (remaining.size > 0)
    throw new Error(`Missing scenario measurements: ${[...remaining].join(", ")}.`);
}
