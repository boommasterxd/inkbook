/** Installs the scrolled phone viewport used by editable-sheet keyboard tests. */
export function installPhoneSheetViewport() {
  const previous = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = Object.assign(new EventTarget(), {
    height: 400,
    offsetTop: 100,
    offsetLeft: 0,
    width: 360,
  });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return {
    viewport,
    restore() {
      if (previous) Object.defineProperty(window, "visualViewport", previous);
      else Reflect.deleteProperty(window, "visualViewport");
    },
  };
}
