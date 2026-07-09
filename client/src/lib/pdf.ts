/**
 * Render a DOM element to a professional multi-page A4 PDF, faithfully
 * capturing what's on screen. The element should already contain the report
 * header (title, date, period, filters, executive summary), KPIs, charts and
 * tables — this rasterizes it, then paginates on *intelligent* break points so
 * charts, metric cards, and table rows are never sliced through the middle, and
 * stamps a consistent footer (page x of n · generated date) on every page.
 *
 * html2canvas + jsPDF (~350 KB combined) load on first export, not with the
 * page chunk — most report views never export.
 */
export async function exportElementToPdf(el: HTMLElement, filename: string): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);

  // Measure candidate break lines (relative to the element) BEFORE capture, so
  // pagination can avoid cutting through a chart, card, or table row. We prefer
  // to break in the gap *above* each of these blocks.
  const rect = el.getBoundingClientRect();
  const breakSelectors = ".panel, .metrics-row, .chart-grid, .report-section, .dash-main, table tr, .match-card";
  const breakTops = new Set<number>();
  el.querySelectorAll(breakSelectors).forEach((node) => {
    const r = (node as HTMLElement).getBoundingClientRect();
    const top = r.top - rect.top;
    if (top > 4) breakTops.add(top);
  });

  // The app is dark-themed; flip the captured region to dark-on-white so the
  // PDF is readable on paper (see `.report-capture.pdf-light` in styles.css).
  el.classList.add("pdf-light");
  let canvas: HTMLCanvasElement;
  try {
    canvas = await html2canvas(el, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      windowWidth: el.scrollWidth,
      // html2canvas 1.x cannot parse modern CSS color functions (color-mix(),
      // oklch/oklab, lab/lch, color()). Left untouched it throws mid-capture —
      // which is exactly the "flash white, no file, no error" failure. Before it
      // rasterizes, resolve every such value in the CLONE to a concrete color the
      // parser understands, so the capture always succeeds. See resolveColors().
      onclone: (doc) => resolveModernColors(doc),
    });
  } finally {
    el.classList.remove("pdf-light");
  }

  const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 36;              // ~0.5in print-safe margins
  const footerH = 22;            // reserved band for the running footer
  const usableW = pageW - margin * 2;
  const usableH = pageH - margin * 2 - footerH;

  // CSS-px → canvas-px scale (html2canvas renders at `scale`, but we derive the
  // exact ratio from the measured width so break points map precisely).
  const ratio = canvas.width / rect.width;
  const breaks = [...breakTops].map((t) => t * ratio).sort((a, b) => a - b);
  const pageCanvasH = (usableH * canvas.width) / usableW;

  // Build slice ranges [start,end] in canvas px, snapping the bottom of each
  // page to the nearest break line above the hard page limit (never sooner than
  // 35% down the page, so we don't produce near-empty pages).
  const slices: [number, number][] = [];
  let start = 0;
  while (start < canvas.height - 1) {
    let end = Math.min(start + pageCanvasH, canvas.height);
    if (end < canvas.height) {
      const minEnd = start + pageCanvasH * 0.35;
      let snap = -1;
      for (const b of breaks) { if (b > minEnd && b <= end) snap = b; }
      if (snap > 0) end = snap;
    }
    slices.push([start, Math.round(end)]);
    start = Math.round(end);
  }

  const generated = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const total = slices.length;

  slices.forEach(([sTop, sBottom], i) => {
    const sliceH = sBottom - sTop;
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = sliceH;
    const ctx = slice.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, sTop, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
    }
    const drawH = (sliceH * usableW) / canvas.width;
    if (i > 0) pdf.addPage();
    pdf.addImage(slice.toDataURL("image/png"), "PNG", margin, margin, usableW, drawH);

    // Consistent footer on every page: hairline rule + generated date + pagination.
    const footY = pageH - margin + 6;
    pdf.setDrawColor(210).setLineWidth(0.5).line(margin, footY - 8, pageW - margin, footY - 8);
    pdf.setFont("helvetica", "normal").setFontSize(8).setTextColor(130);
    pdf.text(`Generated ${generated}`, margin, footY);
    pdf.text(`Page ${i + 1} of ${total}`, pageW - margin, footY, { align: "right" });
  });

  pdf.save(filename);
}

// Color-bearing properties that may carry a modern CSS color function.
const COLOR_PROPS = [
  "color", "backgroundColor", "borderTopColor", "borderRightColor", "borderBottomColor",
  "borderLeftColor", "outlineColor", "fill", "stroke", "textDecorationColor", "caretColor", "columnRuleColor",
] as const;
// Functions html2canvas 1.x can't parse. `color(` also covers color(srgb …) etc.
const UNPARSEABLE = /(color-mix|oklch|oklab|\blab\(|\blch\(|\bcolor\()/i;

/**
 * Rewrite every unparseable modern color (color-mix/oklch/lab/…) in the cloned
 * capture document to a concrete color html2canvas can read. The browser resolves
 * the value for us via a canvas 2d context (which understands these functions on
 * every current browser); anything that still can't be resolved falls back to a
 * neutral so a capture is never aborted by a single unsupported color.
 */
function resolveModernColors(doc: Document): void {
  const win = doc.defaultView ?? window;
  const probe = doc.createElement("canvas").getContext("2d", { willReadFrequently: true });
  // Rasterize the color to a single pixel and read it back as sRGB bytes. Canvas
  // accepts color-mix/oklch/oklab/color(srgb …) and rasterizes them all, so this
  // yields a concrete rgb()/rgba() html2canvas can parse — alpha preserved.
  const resolve = (value: string): string | null => {
    if (!probe) return null;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    try { probe.fillStyle = value; } catch { return null; }
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  };
  const fallback = (prop: string): string =>
    prop === "color" || prop === "fill" || prop === "stroke" ? "#333333" : "transparent";

  doc.querySelectorAll<HTMLElement>("*").forEach((el) => {
    const cs = win.getComputedStyle(el);
    for (const prop of COLOR_PROPS) {
      const v = cs[prop as keyof CSSStyleDeclaration] as string;
      if (v && UNPARSEABLE.test(v)) el.style[prop as never] = (resolve(v) ?? fallback(prop)) as never;
    }
    // Shadows and gradient backgrounds can embed a color-mix too — neutralize
    // them rather than risk an unparseable token slipping through.
    if (UNPARSEABLE.test(cs.boxShadow)) el.style.boxShadow = "none";
    if (UNPARSEABLE.test(cs.backgroundImage)) el.style.backgroundImage = "none";
  });
}
