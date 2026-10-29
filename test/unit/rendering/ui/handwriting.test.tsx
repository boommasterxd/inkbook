// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Handwriting } from "../../../../src/rendering/ui/handwriting";

it("makes reduced-motion lettering complete immediately and leaves accessible copy to its caller", () => {
  const document = new DOMParser().parseFromString(
    renderToStaticMarkup(
      <Handwriting text="a little tour?" reduced delay={1000} duration={2000} />,
    ),
    "text/html",
  );
  const graphic = document.querySelector("svg");
  expect(graphic?.getAttribute("aria-hidden")).toBe("true");
  expect(graphic?.getAttribute("focusable")).toBe("false");
  const paths = [...document.querySelectorAll("path")];
  expect(paths.length).toBeGreaterThan(0);
  // Complete normalized dashes are present in the first render, independent of delay.
  for (const path of paths) {
    expect(path.getAttribute("pathLength")).toBe("1");
    expect(path.getAttribute("stroke-dasharray")).toBe("1 1");
  }
});
