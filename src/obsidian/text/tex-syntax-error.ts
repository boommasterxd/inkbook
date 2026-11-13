import TexError from "@mathjax/src/js/input/tex/TexError.js";
import { TextMathSyntaxError } from "../../rendering/text/text-math-syntax-error";

// Grammar errors from the enabled base, AMS and newcommand packages only.
// Capacity limits, MathML attribute policy and unknown engine failures stay fatal.
const SYNTAX_ERRORS: readonly string[] = [
  "MissingArgFor",
  "ExtraCloseMissingOpen",
  "MissingCloseBrace",
  "ExtraCloseLooking",
  "MissingCloseBracket",
  "MissingOrUnrecognizedDelim",
  "MissingDimOrUnits",
  "TokenNotFoundForCommand",
  "Misplaced",
  "ExtraOpenMissingClose",
  "BadRawUnicode",
  "MathNotTerminated",
  "IllegalMacroParam",
  "ErroneousNestingEq",
  "BadBreakAlign",
  "TooManyAligns",
  "DoubleExponent",
  "DoubleSubscripts",
  "DoubleExponentPrime",
  "CantUseHash1",
  "MisplacedLimits",
  "MisplacedMoveRoot",
  "MultipleMoveRoot",
  "IntegerArg",
  "BreakNotInArray",
  "BreakFirstInEntry",
  "BreakFirstInRow",
  "BreakFirstInTable",
  "BreakType",
  "ExtraAlignTab",
  "BracketMustBeDimension",
  "UnsupportedHFill",
  "BadColumnName",
  "PositiveIntegerArg",
  "InvalidEnv",
  "BadAlignment",
  "MultipleCommand",
  "MultipleLabel",
  "AmbiguousUseOf",
  "EnvBadEnd",
  "EnvMissingEnd",
  "MissingBoxFor",
  "UndefinedControlSequence",
  "UnknownEnv",
  "CommandOnlyAllowedInEnv",
  "CommandAtTheBeginingOfLine",
  "IllegalAlign",
  "BadMathStyleFor",
  "CommandNotAllowedInEnv",
  "MultlineRowsOneCol",
  "XalignOverflow",
  "MismatchUseDef",
];

export function throwTexRenderError(error: unknown): never {
  if (error instanceof TexError && SYNTAX_ERRORS.includes(error.id))
    throw new TextMathSyntaxError(error.id);
  throw error;
}
