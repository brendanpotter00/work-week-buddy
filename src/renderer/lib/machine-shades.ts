/**
 * The greys the "This week" stack is painted in.
 *
 * ── ONE RAMP, NOT TWO ───────────────────────────────────────────────────────
 * They come out of the heatmap's own five-stop ramp, which `App.tsx` already
 * owns and `test/renderer/port-fidelity.test.ts` already pins. A second grey
 * scale invented next to it would drift the moment either was touched, and the
 * two sit fourteen pixels apart on the page.
 *
 * ── WHY THE FIRST STOP IS THROWN AWAY ───────────────────────────────────────
 * Both ramps are ordered background-adjacent → most contrast, and stop 0 IS
 * roughly the card:
 *
 *   light  #F1F0EE on #ffffff → 1.09:1     dark  #242424 on #202020 → 1.05:1
 *
 * A bar painted in it is an invisible bar. The heatmap can use it because an
 * empty day is *supposed* to disappear; a machine's hours are not. So the
 * palette is stops 4, 3, 2, 1 — strongest first, so the Mac that did the most
 * work (the order `byMachine` returns) gets the shade that reads best, and the
 * marginal stop is reached only by a fourth machine:
 *
 *   light  #37352F 12.3:1 · #6B6862 5.6:1 · #A8A49C 2.5:1 · #D3D1CB 1.5:1
 *   dark   #D4D4D4 11.0:1 · #8A8A8A 4.7:1 · #5C5C5C 2.4:1 · #3A3A3A 1.4:1
 *
 * Adjacent stops differ by ~2:1 either way, which is what makes two touching
 * segments of a 34-px bar tell themselves apart.
 *
 * ── FIVE OR MORE ────────────────────────────────────────────────────────────
 * The ramp runs out. Rather than repeat a shade — which would give two machines
 * the same swatch in the legend, the one thing the legend exists to prevent —
 * the range from the strongest usable stop to the weakest is subdivided evenly.
 * The greys get closer together, honestly so: five Macs' worth of monochrome is
 * genuinely harder to read, and the tooltip and the legend carry the names.
 */

/**
 * The heatmap's ramp for one theme: background-adjacent first, five stops.
 *
 * Mutable, not `readonly`: `<ActivityCalendar theme=…>` takes `string[]`, and
 * the whole point is that the bars and the calendar read ONE array.
 */
export type Ramp = [string, string, string, string, string];

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

const hex2 = (v: number): string =>
  Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0").toUpperCase();

function mix(a: Rgb, b: Rgb, t: number): string {
  return `#${hex2(a.r + (b.r - a.r) * t)}${hex2(a.g + (b.g - a.g) * t)}${hex2(a.b + (b.b - a.b) * t)}`;
}

/**
 * `count` shades from `ramp`, strongest first. Never returns the ramp's
 * background-adjacent stop, and never returns the same colour twice.
 */
export function machineShades(count: number, ramp: Ramp): string[] {
  if (count <= 0) return [];
  // Stops 4 → 1. Stop 0 is the background; see the header.
  const usable = [ramp[4], ramp[3], ramp[2], ramp[1]];
  if (count <= usable.length) return usable.slice(0, count);

  const from = parseHex(usable[0]!);
  const to = parseHex(usable[usable.length - 1]!);
  return Array.from({ length: count }, (_, i) => mix(from, to, i / (count - 1)));
}

/**
 * Relative luminance and contrast, WCAG's definition — used by the tests to
 * assert the two properties the greys have to have rather than to assert the
 * hex strings, which would pass just as happily on a palette nobody can read.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
