/**
 * Professional PDF report engine — one design language for every export.
 *
 * Renders a DOM element to a multi-page US-Letter PDF with:
 *  - a branded cover header on page 1 (company logo + name, report title,
 *    subtitle, generated date, accent rule);
 *  - a compact running header on subsequent pages;
 *  - a consistent footer on every page (rule · org + generated date · Page x of n);
 *  - intelligent page breaks that never slice a chart, metric card, or table row,
 *    and never leave an orphaned section title at the bottom of a page;
 *  - graceful handling of very large reports (capture scale adapts so the
 *    browser's canvas limits are never exceeded — no silent blank output).
 *
 * html2canvas + jsPDF (~350 KB combined) load on first export, not with the
 * page chunk — most report views never export.
 */

export interface PdfBranding {
  /** Report title — header band + PDF document metadata. */
  title?: string;
  /** Secondary line under the title (period, filters, analysis name…). */
  subtitle?: string;
  /** Company name (falls back to "Mineral Hub"). */
  orgName?: string | null;
  /** Company logo URL (Settings → Company Branding); omitted when unset. */
  logoUrl?: string | null;
}

// US Letter in points.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;               // 2/3" print-safe margins
const FOOTER_H = 26;             // reserved band for the running footer
const HEADER_H_FIRST = 92;       // branded band on page 1
const HEADER_H_REST = 34;        // compact running header on pages 2+
const ACCENT: [number, number, number] = [37, 99, 235];   // brand blue
const INK: [number, number, number] = [17, 24, 39];       // near-black text
const DIM: [number, number, number] = [120, 128, 140];    // muted text

/** Load an image (logo) and rasterize it to a PNG data-URL jsPDF can embed. */
async function logoDataUrl(src: string): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = src;
    });
    if (!img || !img.width || !img.height) return null;
    // Rasterize at 2x the drawn size for crisp print output (also converts SVG).
    const drawH = 40, drawW = (img.width / img.height) * drawH;
    const c = document.createElement("canvas");
    c.width = Math.round(drawW * 4); c.height = Math.round(drawH * 4);
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { data: c.toDataURL("image/png"), w: drawW, h: drawH };
  } catch {
    return null;
  }
}

export async function exportElementToPdf(el: HTMLElement, filename: string, branding: PdfBranding = {}): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);

  const orgName = branding.orgName || "Mineral Hub";
  const logo = branding.logoUrl ? await logoDataUrl(branding.logoUrl) : null;

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
  // Section titles must never be orphaned at the bottom of a page: if a break
  // would leave a heading in the last stretch of a page, the break moves up to
  // just above that heading so the title starts the next page with its content.
  const headingTops: number[] = [];
  el.querySelectorAll("h1, h2, h3, h4, .section-head, .panel-title").forEach((node) => {
    const r = (node as HTMLElement).getBoundingClientRect();
    const top = r.top - rect.top;
    if (top > 4) headingTops.push(top);
  });
  headingTops.sort((a, b) => a - b);

  // Capture scale: 2x for print sharpness, clamped so very large reports stay
  // inside browser canvas limits (max dimension + total area) instead of
  // silently producing a blank canvas.
  const MAX_DIM = 16000;
  const MAX_AREA = 60_000_000; // px²
  const contentH = Math.max(el.scrollHeight, rect.height);
  const scale = Math.max(
    0.75,
    Math.min(2, MAX_DIM / rect.width, MAX_DIM / contentH, Math.sqrt(MAX_AREA / (rect.width * contentH))),
  );

  // The app is dark-themed; flip the captured region to dark-on-white so the
  // PDF is readable on paper (see `.report-capture.pdf-light` in styles.css).
  el.classList.add("pdf-light");
  let canvas: HTMLCanvasElement;
  try {
    canvas = await html2canvas(el, {
      scale,
      useCORS: true,
      backgroundColor: "#ffffff",
      windowWidth: el.scrollWidth,
      // html2canvas 1.x cannot parse modern CSS color functions (color-mix(),
      // oklch/oklab, lab/lch, color()). Left untouched it throws mid-capture —
      // the "flash white, no file, no error" failure. Resolve every such value
      // in the CLONE to a concrete color before it rasterizes.
      onclone: (doc) => resolveModernColors(doc),
    });
  } finally {
    el.classList.remove("pdf-light");
  }
  if (!canvas.width || !canvas.height) throw new Error("Could not capture the report content — try again.");

  const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
  pdf.setProperties({ title: branding.title ?? filename.replace(/\.pdf$/i, ""), author: orgName, creator: "Mineral Hub" });

  const usableW = PAGE_W - MARGIN * 2;
  // Per-page content geometry (pt): page 1 sits below the branded band, later
  // pages below the compact running header; every page reserves the footer.
  const contentTopFirst = MARGIN + HEADER_H_FIRST;
  const contentTopRest = MARGIN + HEADER_H_REST;
  const contentBottom = PAGE_H - MARGIN - FOOTER_H;
  const capacityFirst = contentBottom - contentTopFirst;
  const capacityRest = contentBottom - contentTopRest;

  // CSS-px → canvas-px ratio (derived from the measured width so break points
  // map precisely regardless of the clamped capture scale).
  const ratio = canvas.width / rect.width;
  const breaks = [...breakTops].map((t) => t * ratio).sort((a, b) => a - b);
  const headings = headingTops.map((t) => t * ratio);
  const ptToCanvas = canvas.width / usableW; // canvas px per pt of page width
  // A heading within this distance of the bottom of a page is "orphaned".
  const ORPHAN_GUARD = 64 * ptToCanvas;

  // Build slice ranges [start,end] in canvas px. The bottom of each page snaps
  // to the nearest safe break above the hard limit (never sooner than 35% down
  // the page so we don't emit near-empty pages), then backs off any heading
  // that would be stranded at the very bottom.
  const slices: [number, number][] = [];
  let start = 0;
  let pageIndex = 0;
  while (start < canvas.height - 1) {
    const capacityPt = pageIndex === 0 ? capacityFirst : capacityRest;
    const pageCanvasH = capacityPt * ptToCanvas;
    let end = Math.min(start + pageCanvasH, canvas.height);
    if (end < canvas.height) {
      const minEnd = start + pageCanvasH * 0.35;
      let snap = -1;
      for (const b of breaks) { if (b > minEnd && b <= end) snap = b; }
      if (snap > 0) end = snap;
      // Orphaned-title guard: a heading sitting in the last stretch of the page
      // pulls the break up to its own top.
      for (const h of headings) {
        if (h > end - ORPHAN_GUARD && h <= end && h - 4 > minEnd) { end = h - 4; break; }
      }
    }
    slices.push([Math.round(start), Math.round(end)]);
    start = Math.round(end);
    pageIndex++;
  }

  const generated = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const total = slices.length;

  const drawFirstHeader = () => {
    let x = MARGIN;
    if (logo) {
      pdf.addImage(logo.data, "PNG", MARGIN, MARGIN - 6, logo.w, logo.h);
      x = MARGIN + logo.w + 14;
    }
    pdf.setFont("helvetica", "bold").setFontSize(9).setTextColor(...DIM);
    pdf.text(orgName.toUpperCase(), x, MARGIN + 4);
    pdf.setFont("helvetica", "bold").setFontSize(19).setTextColor(...INK);
    pdf.text(branding.title ?? "Report", x, MARGIN + 24);
    pdf.setFont("helvetica", "normal").setFontSize(10).setTextColor(...DIM);
    const sub = [branding.subtitle, `Generated ${generated}`].filter(Boolean).join("  ·  ");
    pdf.text(sub, x, MARGIN + 40);
    // Accent rule closing the band.
    pdf.setDrawColor(...ACCENT).setLineWidth(2);
    pdf.line(MARGIN, MARGIN + HEADER_H_FIRST - 16, MARGIN + 64, MARGIN + HEADER_H_FIRST - 16);
    pdf.setDrawColor(226, 230, 236).setLineWidth(0.75);
    pdf.line(MARGIN + 64, MARGIN + HEADER_H_FIRST - 16, PAGE_W - MARGIN, MARGIN + HEADER_H_FIRST - 16);
  };

  const drawRunningHeader = () => {
    pdf.setFont("helvetica", "bold").setFontSize(8.5).setTextColor(...DIM);
    pdf.text((branding.title ?? "Report").toUpperCase(), MARGIN, MARGIN + 2);
    pdf.setFont("helvetica", "normal");
    pdf.text(orgName, PAGE_W - MARGIN, MARGIN + 2, { align: "right" });
    pdf.setDrawColor(226, 230, 236).setLineWidth(0.5);
    pdf.line(MARGIN, MARGIN + 10, PAGE_W - MARGIN, MARGIN + 10);
  };

  const drawFooter = (page: number) => {
    const footY = PAGE_H - MARGIN + 8;
    pdf.setDrawColor(226, 230, 236).setLineWidth(0.5);
    pdf.line(MARGIN, footY - 10, PAGE_W - MARGIN, footY - 10);
    pdf.setFont("helvetica", "normal").setFontSize(8).setTextColor(...DIM);
    pdf.text(`${orgName}  ·  Generated ${generated}`, MARGIN, footY);
    pdf.text(`Page ${page} of ${total}`, PAGE_W - MARGIN, footY, { align: "right" });
  };

  slices.forEach(([sTop, sBottom], i) => {
    const sliceH = Math.max(1, sBottom - sTop);
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = sliceH;
    const ctx = slice.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, sTop, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
    }
    const drawH = sliceH / ptToCanvas;
    if (i > 0) pdf.addPage();
    if (i === 0) drawFirstHeader(); else drawRunningHeader();
    // High-quality JPEG keeps multi-page reports at a shareable size (PNG slices
    // of a rasterized page run 10–20× larger with no visible benefit at 2x scale).
    pdf.addImage(slice.toDataURL("image/jpeg", 0.9), "JPEG", MARGIN, i === 0 ? contentTopFirst : contentTopRest, usableW, drawH);
    drawFooter(i + 1);
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

  doc.querySelectorAll<HTMLElement>("*").forEach((node) => {
    const cs = win.getComputedStyle(node);
    for (const prop of COLOR_PROPS) {
      const v = cs[prop as keyof CSSStyleDeclaration] as string;
      if (v && UNPARSEABLE.test(v)) node.style[prop as never] = (resolve(v) ?? fallback(prop)) as never;
    }
    // Shadows and gradient backgrounds can embed a color-mix too — neutralize
    // them rather than risk an unparseable token slipping through.
    if (UNPARSEABLE.test(cs.boxShadow)) node.style.boxShadow = "none";
    if (UNPARSEABLE.test(cs.backgroundImage)) node.style.backgroundImage = "none";
  });
}
