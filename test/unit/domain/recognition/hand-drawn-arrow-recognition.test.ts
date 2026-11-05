import { describe, it } from "vitest";
import { recognitionCorpus } from "../../../fixtures/domain/hand-drawn-recognition/corpus";
import { expectRecognitionExample } from "./recognition-fixtures";

const examples = recognitionCorpus("development").filter((example) => example.kind === "arrow");

describe("independent handwritten arrow development corpus", () => {
  it.each(examples)("recognizes $id", (example) => expectRecognitionExample(example));
});
