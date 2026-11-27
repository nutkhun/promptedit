// The font families the Text section offers (docs/spec/04-ui.md §1.5 Text). Where the webview has
// the Local Font Access API (`queryLocalFonts`, Chromium/WebView2) every installed family is listed;
// otherwise (WKWebView, or permission refused) a curated cross-platform list, filtered to the faces
// this machine actually has. "" is "System", listed first.

interface LocalFont { family: string }
type QueryLocalFonts = () => Promise<LocalFont[]>;

/** Families commonly installed on macOS and/or Windows. */
export const CURATED_FONTS = [
  "American Typewriter", "Andale Mono", "Arial", "Arial Black", "Arial Narrow", "Arial Rounded MT Bold",
  "Avenir", "Avenir Next", "Avenir Next Condensed", "Bahnschrift", "Baskerville", "Big Caslon", "Bodoni 72",
  "Bradley Hand", "Brush Script MT", "Calibri", "Cambria", "Candara", "Chalkboard SE", "Chalkduster",
  "Charter", "Cochin", "Comic Sans MS", "Consolas", "Constantia", "Copperplate", "Corbel", "Courier New",
  "Didot", "DIN Alternate", "DIN Condensed", "Ebrima", "Franklin Gothic Medium", "Futura", "Gabriola",
  "Georgia", "Gill Sans", "Helvetica", "Helvetica Neue", "Hoefler Text", "Impact", "Ink Free",
  "Lucida Console", "Lucida Grande", "Marker Felt", "Menlo", "Monaco", "Noteworthy", "Optima",
  "Palatino", "Palatino Linotype", "Papyrus", "Phosphate", "Rockwell", "Savoye LET", "Segoe Print",
  "Segoe Script", "Segoe UI", "Segoe UI Variable Display", "SignPainter", "Sitka", "Skia", "Snell Roundhand",
  "Sylfaen", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Zapfino",
];

let cached: Promise<string[]> | undefined;

/** Every family to offer, sorted, without "System" (the caller adds it). */
export function fontFamilies(): Promise<string[]> {
  cached ??= load();
  return cached;
}

async function load(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (query) {
    try {
      const fonts = await query();
      const families = [...new Set(fonts.map((f) => f.family))].filter(Boolean);
      if (families.length > 0) return families.sort((a, b) => a.localeCompare(b));
    } catch {
      // Permission refused or unavailable: fall back to the curated list.
    }
  }
  return CURATED_FONTS.filter(installed).sort((a, b) => a.localeCompare(b));
}

/**
 * Whether a family is installed: text set in it measures differently from each generic fallback.
 * (document.fonts.check() can't tell for local system fonts.)
 */
function installed(family: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return true;
  const sample = "mmmmmmmmmmlliWW@#0123";
  return ["monospace", "serif", "sans-serif"].some((base) => {
    ctx.font = `72px ${base}`;
    const a = ctx.measureText(sample).width;
    ctx.font = `72px "${family}", ${base}`;
    return ctx.measureText(sample).width !== a;
  });
}

/** The CSS font-family for a TextStyle font name ("" is the system face). */
export const cssFamily = (name: string) =>
  name ? `"${name.replace(/"/g, "")}", var(--font)` : "var(--font)";
