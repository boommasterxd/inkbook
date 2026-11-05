import { describe, it } from "vitest";
import { recognitionCorpus } from "../../../fixtures/domain/hand-drawn-recognition/corpus";
import { expectRecognitionExample } from "./recognition-fixtures";

describe("independent hand-drawn line development examples", () => {
  it.each(recognitionCorpus("development").filter((example) => example.kind === "line"))(
    "$id: $variation",
    (example) => expectRecognitionExample(example),
  );
});
