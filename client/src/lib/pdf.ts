import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

/**
 * Render a DOM element to a professional multi-page A4 PDF, faithfully
 * capturing what's on screen. The element should already contain the report
 * header (title, date, period, filters, executive summary), KPIs, charts and
 * tables — this just rasterizes and paginates it.
 */
export async function exportElementToPdf(el: HTMLElement, filename: string): Promise<void> {
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
    });
  } finally {
    el.classList.remove("pdf-light");
  }

  const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const usableW = pageW - margin * 2;
  const usableH = pageH - margin * 2;

  const imgW = usableW;
  const imgH = (canvas.height * imgW) / canvas.width;

  if (imgH <= usableH) {
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", margin, margin, imgW, imgH);
  } else {
    // Slice the tall canvas into page-height chunks.
    const pageCanvasHeightPx = (usableH * canvas.width) / usableW;
    let renderedPx = 0;
    let page = 0;
    while (renderedPx < canvas.height) {
      const sliceH = Math.min(pageCanvasHeightPx, canvas.height - renderedPx);
      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = sliceH;
      const ctx = slice.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, renderedPx, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
      }
      const sliceImgH = (sliceH * imgW) / canvas.width;
      if (page > 0) pdf.addPage();
      pdf.addImage(slice.toDataURL("image/png"), "PNG", margin, margin, imgW, sliceImgH);
      renderedPx += sliceH;
      page++;
    }
  }

  pdf.save(filename);
}
