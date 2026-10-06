import type { Page } from "@playwright/test";

/**
 * What the eye gets from the page, which the role queries cannot see: the colors the browser computed and the
 * markers it drew. Read in the page, with the canvas turning any color syntax into the pixels it paints.
 */
export async function lookOf(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no canvas");
    const rgba = (color: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const luminance = ([r, g, b]: number[]) => {
      const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((v) => {
        const s = (v ?? 0) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    // The surface under the text: the fills from the nearest opaque one down to the element's own, each painted over
    // the one below (a button's `bg-input/30` is a fraction of a color, not a color).
    const layers: Array<[number, number, number, number]> = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const painted = rgba(getComputedStyle(node).backgroundColor);
      if (painted[3] > 0) layers.push(painted);
      if (painted[3] > 0.99) break;
    }
    let surface: [number, number, number, number] = rgba(getComputedStyle(document.body).backgroundColor);
    for (const layer of layers.reverse()) {
      const [r, g, b, alpha] = layer;
      surface = [0, 1, 2].map((i) => [r, g, b][i]! * alpha + surface[i]! * (1 - alpha)).concat(1) as [number, number, number, number];
    }
    const style = getComputedStyle(element);
    const [high, low] = [luminance(rgba(style.color)), luminance(surface)].sort((a, b) => b - a);
    return {
      contrast: ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05),
      listStyle: style.listStyleType,
      paddingLeft: style.paddingLeft,
    };
  });
}
