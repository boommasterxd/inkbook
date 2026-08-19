export class SchemaValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function resolveReference(rootSchema, reference) {
  if (!reference.startsWith("#/$defs/")) {
    throw new SchemaValidationError(
      `Unsupported schema reference ${reference}`,
    );
  }
  const definition = rootSchema.$defs[reference.slice("#/$defs/".length)];
  if (!definition) {
    throw new SchemaValidationError(`Missing schema definition ${reference}`);
  }
  return definition;
}

function validateObject(value, schema, rootSchema, location, seen) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaValidationError(`${location} must be an object`);
  }
  for (const key of schema.required ?? []) {
    if (!(key in value)) {
      throw new SchemaValidationError(`${location}.${key} is required`);
    }
  }
  const properties = schema.properties ?? {};
  for (const [key, child] of Object.entries(value)) {
    const childSchema = properties[key] ?? schema.additionalProperties;
    if (childSchema === false) {
      throw new SchemaValidationError(`${location}.${key} is not allowed`);
    }
    if (childSchema && childSchema !== true) {
      validateJsonSchema(
        child,
        childSchema,
        rootSchema,
        `${location}.${key}`,
        seen,
      );
    }
  }
  if (
    schema.minProperties !== undefined &&
    Object.keys(value).length < schema.minProperties
  ) {
    throw new SchemaValidationError(`${location} has too few properties`);
  }
}

function validateArray(value, schema, rootSchema, location, seen) {
  if (!Array.isArray(value)) {
    throw new SchemaValidationError(`${location} must be an array`);
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new SchemaValidationError(`${location} has too few items`);
  }
  if (schema.items) {
    value.forEach((entry, index) =>
      validateJsonSchema(
        entry,
        schema.items,
        rootSchema,
        `${location}[${index}]`,
        seen,
      ),
    );
  }
}

function validateString(value, schema, location) {
  if (typeof value !== "string") {
    throw new SchemaValidationError(`${location} must be a string`);
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new SchemaValidationError(`${location} must not be empty`);
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    throw new SchemaValidationError(`${location} has an invalid format`);
  }
}

function validateNumber(value, schema, location) {
  if (schema.type === "integer" && !Number.isInteger(value)) {
    throw new SchemaValidationError(`${location} must be an integer`);
  }
  if (
    schema.type === "number" &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new SchemaValidationError(`${location} must be a number`);
  }
  if (schema.type === "null" && value !== null) {
    throw new SchemaValidationError(`${location} must be null`);
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new SchemaValidationError(`${location} is below its minimum`);
  }
  if (
    schema.exclusiveMinimum !== undefined &&
    value <= schema.exclusiveMinimum
  ) {
    throw new SchemaValidationError(
      `${location} is not above its exclusive minimum`,
    );
  }
}

function validateAlternatives(value, schema, rootSchema, location, seen) {
  const errors = [];
  for (const candidate of schema.anyOf) {
    try {
      validateJsonSchema(value, candidate, rootSchema, location, new Set(seen));
      return true;
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new SchemaValidationError(
    `${location} does not match an allowed schema: ${errors.join("; ")}`,
  );
}

export function validateJsonSchema(
  value,
  schema,
  rootSchema = schema,
  location = "$",
  seen = new Set(),
) {
  const resolved = schema.$ref
    ? resolveReference(rootSchema, schema.$ref)
    : schema;
  const recursionKey = `${location}:${stableJson(resolved)}`;
  if (seen.has(recursionKey)) return;
  seen.add(recursionKey);

  if (resolved.anyOf) {
    validateAlternatives(value, resolved, rootSchema, location, seen);
    return;
  }
  if (
    resolved.const !== undefined &&
    stableJson(value) !== stableJson(resolved.const)
  ) {
    throw new SchemaValidationError(
      `${location} does not equal its required value`,
    );
  }
  if (
    resolved.enum &&
    !resolved.enum.some((entry) => stableJson(entry) === stableJson(value))
  ) {
    throw new SchemaValidationError(`${location} has an invalid enum value`);
  }
  if (resolved.type === "object")
    return validateObject(value, resolved, rootSchema, location, seen);
  if (resolved.type === "array")
    return validateArray(value, resolved, rootSchema, location, seen);
  if (resolved.type === "string")
    return validateString(value, resolved, location);
  if (["integer", "number", "null"].includes(resolved.type))
    return validateNumber(value, resolved, location);
}
