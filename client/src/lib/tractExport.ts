import type maplibregl from "maplibre-gl";
import { jsPDF } from "jspdf";

/**
 * Professional exports for the deal tract map: the live MapLibre canvas is
 * composed with a branded header (logo, deal, date), north arrow, scale bar
 * and legend into a single sheet, then delivered as PNG/JPEG/PDF. SVG is a
 * true vector export of the tract drawing (polygons projected through the
 * current view) — no raster basemap, ideal for further editing.
 */

export interface TractExportSummary { name: string; acres: number | null; closes: boolean | null }

export interface TractExportOpts {
  format: "png" | "jpeg" | "pdf" | "svg";
  pageSize: "letter" | "a4";
  orientation: "portrait" | "landscape";
  dealName: string;
  orgName: string;
  logoUrl?: string | null;
  notes?: string;
  tracts: TractExportSummary[];
  /** lon/lat rings per tract for the SVG export. */
  rings: { name: string; ring: [number, number][]; pob: [number, number] | null }[];
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Ground meters per CSS pixel at the map's current center/zoom. */
function metersPerPixel(map: maplibregl.Map): number {
  const lat = map.getCenter().lat;
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
}

/** Pick a round scale-bar length (feet or miles) near a target pixel width. */
function scaleBar(map: maplibregl.Map, targetPx: number): { px: number; label: string } {
  const ftPerPx = metersPerPixel(map) * 3.2808399;
  const targetFt = ftPerPx * targetPx;
  const NICE_FT = [100, 200, 500, 1000, 2000, 2640, 5280, 10560, 26400, 52800, 105600, 264000];
  let ft = NICE_FT[NICE_FT.length - 1];
  for (const n of NICE_FT) if (n >= targetFt) { ft = n; break; }
  const label = ft >= 5280 ? `${(ft / 5280).toLocaleString()} mi` : `${ft.toLocaleString()} ft`;
  return { px: ft / ftPerPx, label };
}

function drawNorthArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fill();
  ctx.strokeStyle = "#0f172a"; ctx.lineWidth = Math.max(1, r * 0.06); ctx.stroke();
  ctx.beginPath(); // north-pointing needle
  ctx.moveTo(cx, cy - r * 0.62); ctx.lineTo(cx - r * 0.26, cy + r * 0.3); ctx.lineTo(cx, cy + r * 0.08); ctx.closePath();
  ctx.fillStyle = "#dc2626"; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.62); ctx.lineTo(cx + r * 0.26, cy + r * 0.3); ctx.lineTo(cx, cy + r * 0.08); ctx.closePath();
  ctx.fillStyle = "#334155"; ctx.fill();
  ctx.fillStyle = "#0f172a"; ctx.font = `bold ${Math.round(r * 0.5)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center"; ctx.fillText("N", cx, cy + r * 0.85);
  ctx.restore();
}

/** Compose header + map (with north arrow & scale bar) + legend into a canvas. */
async function composeSheet(map: maplibregl.Map, opts: TractExportOpts): Promise<HTMLCanvasElement> {
  map.triggerRepaint();
  await new Promise((r) => map.once("idle", r)); // ensure a fresh frame in the buffer
  const src = map.getCanvas();
  const W = src.width;
  const dpr = W / map.getContainer().clientWidth || 1;
  const headerH = Math.round(84 * dpr);
  const legendLines = 1 + (opts.notes ? 1 : 0);
  const footerH = Math.round((46 + legendLines * 20) * dpr);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = headerH + src.height + footerH;
  const ctx = canvas.getContext("2d")!;
  const px = (n: number) => Math.round(n * dpr);

  // Header band: logo · deal + title · date.
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, canvas.height);
  ctx.fillStyle = "#0f172a"; ctx.fillRect(0, headerH - px(3), W, px(3));
  let textX = px(20);
  if (opts.logoUrl) {
    const logo = await loadImage(opts.logoUrl);
    if (logo) {
      const h = headerH - px(28); const w = (logo.width / logo.height) * h;
      ctx.drawImage(logo, px(20), px(14), w, h);
      textX = px(20) + w + px(16);
    }
  }
  ctx.fillStyle = "#0f172a"; ctx.textBaseline = "top";
  ctx.font = `bold ${px(19)}px Inter, system-ui, sans-serif`;
  ctx.fillText(opts.dealName, textX, px(16));
  ctx.font = `${px(13)}px Inter, system-ui, sans-serif`; ctx.fillStyle = "#475569";
  ctx.fillText(`Tract Description Map · ${opts.orgName}`, textX, px(42));
  const dateStr = `Generated ${new Date().toLocaleDateString()}`;
  ctx.textAlign = "right";
  ctx.fillText(dateStr, W - px(20), px(42));
  ctx.textAlign = "left";

  // Map frame.
  ctx.drawImage(src, 0, headerH);

  // North arrow (top-right of the map area) + scale bar (bottom-left).
  drawNorthArrow(ctx, W - px(44), headerH + px(44), px(24));
  const bar = scaleBar(map, 140);
  const barPx = bar.px * dpr;
  const bx = px(20), by = headerH + src.height - px(26);
  ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.fillRect(bx - px(6), by - px(18), barPx + px(12), px(30));
  ctx.strokeStyle = "#0f172a"; ctx.lineWidth = px(2);
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx, by - px(5)); ctx.lineTo(bx, by + px(5)); ctx.moveTo(bx + barPx, by - px(5)); ctx.lineTo(bx + barPx, by + px(5)); ctx.stroke();
  ctx.fillStyle = "#0f172a"; ctx.font = `${px(11)}px Inter, system-ui, sans-serif`;
  ctx.fillText(bar.label, bx + px(4), by - px(16));

  // Footer: legend + tract summary + optional notes.
  let fy = headerH + src.height + px(14);
  const swatch = (x: number, color: string, stroke: string) => {
    ctx.fillStyle = color; ctx.fillRect(x, fy, px(18), px(12));
    ctx.strokeStyle = stroke; ctx.lineWidth = px(1.5); ctx.strokeRect(x, fy, px(18), px(12));
  };
  ctx.font = `${px(12)}px Inter, system-ui, sans-serif`;
  let lx = px(20);
  swatch(lx, "rgba(16,185,129,0.35)", "#047857"); ctx.fillStyle = "#0f172a"; ctx.fillText("Tract boundary", lx + px(24), fy);
  lx += px(140);
  ctx.beginPath(); ctx.arc(lx + px(9), fy + px(6), px(5), 0, Math.PI * 2); ctx.fillStyle = "#dc2626"; ctx.fill();
  ctx.fillStyle = "#0f172a"; ctx.fillText("Point of Beginning", lx + px(24), fy);
  lx += px(160);
  swatch(lx, "rgba(59,130,246,0.06)", "#6b7280"); ctx.fillStyle = "#0f172a"; ctx.fillText("Abstract / survey boundary", lx + px(24), fy);
  const summary = opts.tracts.map((t) => `${t.name}${t.acres != null ? ` — ${t.acres.toLocaleString()} ac` : ""}${t.closes === false ? " (open)" : ""}`).join("   ·   ");
  fy += px(22);
  ctx.fillStyle = "#475569"; ctx.fillText(summary.slice(0, 300), px(20), fy);
  if (opts.notes) { fy += px(20); ctx.fillText(`Notes: ${opts.notes.slice(0, 280)}`, px(20), fy); }
  return canvas;
}

function svgEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Vector export: tract rings projected through the current view. */
function buildSvg(map: maplibregl.Map, opts: TractExportOpts): string {
  const w = map.getContainer().clientWidth;
  const h = map.getContainer().clientHeight;
  const headerH = 70;
  const bar = scaleBar(map, 140);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h + headerH + 60}" font-family="Manrope, system-ui, sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  parts.push(`<text x="20" y="30" font-size="19" font-weight="bold" fill="#0f172a">${svgEscape(opts.dealName)}</text>`);
  parts.push(`<text x="20" y="52" font-size="13" fill="#475569">Tract Description Map · ${svgEscape(opts.orgName)} · Generated ${new Date().toLocaleDateString()}</text>`);
  parts.push(`<line x1="0" y1="${headerH - 2}" x2="${w}" y2="${headerH - 2}" stroke="#0f172a" stroke-width="2"/>`);
  parts.push(`<g transform="translate(0 ${headerH})">`);
  for (const t of opts.rings) {
    const pts = t.ring.map(([lon, lat]) => { const p = map.project([lon, lat]); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(" ");
    parts.push(`<polygon points="${pts}" fill="rgba(16,185,129,0.3)" stroke="#047857" stroke-width="2"/>`);
    const c = map.project([t.ring[0][0], t.ring[0][1]]);
    parts.push(`<text x="${c.x + 6}" y="${c.y - 6}" font-size="12" fill="#065f46">${svgEscape(t.name)}</text>`);
    if (t.pob) {
      const p = map.project(t.pob);
      parts.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="#dc2626" stroke="#fff" stroke-width="2"/><text x="${p.x}" y="${p.y + 18}" font-size="10" fill="#b91c1c" text-anchor="middle">POB</text>`);
    }
  }
  // North arrow + scale bar.
  parts.push(`<g transform="translate(${w - 44} 44)"><circle r="22" fill="rgba(255,255,255,0.9)" stroke="#0f172a"/><path d="M0,-14 L-6,7 L0,2 Z" fill="#dc2626"/><path d="M0,-14 L6,7 L0,2 Z" fill="#334155"/><text y="19" font-size="11" font-weight="bold" text-anchor="middle" fill="#0f172a">N</text></g>`);
  parts.push(`<g transform="translate(20 ${h - 26})"><line x1="0" y1="0" x2="${bar.px.toFixed(0)}" y2="0" stroke="#0f172a" stroke-width="2"/><line y1="-5" y2="5" stroke="#0f172a" stroke-width="2"/><line x1="${bar.px.toFixed(0)}" x2="${bar.px.toFixed(0)}" y1="-5" y2="5" stroke="#0f172a" stroke-width="2"/><text x="4" y="-8" font-size="11" fill="#0f172a">${bar.label}</text></g>`);
  parts.push(`</g>`);
  const summary = opts.tracts.map((t) => `${t.name}${t.acres != null ? ` — ${t.acres.toLocaleString()} ac` : ""}`).join("   ·   ");
  parts.push(`<text x="20" y="${h + headerH + 24}" font-size="12" fill="#475569">${svgEscape(summary.slice(0, 260))}</text>`);
  if (opts.notes) parts.push(`<text x="20" y="${h + headerH + 44}" font-size="12" fill="#475569">Notes: ${svgEscape(opts.notes.slice(0, 240))}</text>`);
  parts.push(`</svg>`);
  return parts.join("");
}

export async function exportTractMap(map: maplibregl.Map, opts: TractExportOpts): Promise<void> {
  const stem = `${opts.dealName.replace(/[^\w-]+/g, "-").toLowerCase()}-tract-map`;
  if (opts.format === "svg") {
    download(new Blob([buildSvg(map, opts)], { type: "image/svg+xml" }), `${stem}.svg`);
    return;
  }
  const canvas = await composeSheet(map, opts);
  if (opts.format === "png" || opts.format === "jpeg") {
    const type = opts.format === "png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.92));
    if (blob) download(blob, `${stem}.${opts.format}`);
    return;
  }
  // PDF: fit the composed sheet inside the chosen page, preserving aspect.
  const pdf = new jsPDF({ orientation: opts.orientation, unit: "pt", format: opts.pageSize });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const scale = Math.min((pageW - margin * 2) / canvas.width, (pageH - margin * 2) / canvas.height);
  const w = canvas.width * scale, h = canvas.height * scale;
  pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", (pageW - w) / 2, (pageH - h) / 2, w, h);
  pdf.save(`${stem}.pdf`);
}
