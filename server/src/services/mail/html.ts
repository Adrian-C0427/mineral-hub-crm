/**
 * Email HTML — sanitizing what is displayed or stored, and assembling what is
 * sent so it reads like a message written in Outlook.
 *
 *  - Received mail (display): broad formatting kept (tables, inline styles,
 *    <style> blocks, images) so newsletters and branded mail look right; no
 *    scripts, frames, forms, event handlers or javascript: URLs. The client
 *    renders it in a sandboxed iframe (no scripts), so CSS stays contained.
 *  - What a member types (compose): ordinary formatting only.
 *  - Signatures: formatting, fonts, colors, links, tables and images kept
 *    exactly (incl. Outlook's <style> block); images only by https or cid:.
 *  - Outgoing body: the member's text in Outlook's default compose font, then
 *    the signature in <div id="Signature"> (Outlook's own marker), then — for
 *    replies/forwards — the quoted thread Microsoft generated. Any signature
 *    block already in the text is removed first, so a signature never doubles
 *    up (replying, forwarding, or editing a draft). Nothing CRM-branded is added.
 */
import sanitizeHtml from "sanitize-html";

const COMMON_ATTRS = [
  "style", "class", "id", "align", "valign", "width", "height", "dir", "lang", "title",
  "bgcolor", "color", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "face", "size", "role",
];

const LAYOUT_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  "img", "font", "center", "span", "div", "u", "s", "strike", "small", "big", "hr", "br",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col", "caption",
];

/** No javascript:/expression()/@import or HTML breakouts in CSS we keep. */
function cleanCss(css: string): string {
  return css
    .replace(/<\/?\s*style/gi, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "x(")
    .replace(/javascript\s*:/gi, "")
    .replace(/behavior\s*:/gi, "x-behavior:");
}

const linkTransform: sanitizeHtml.Transformer = (tagName, attribs) => ({
  tagName,
  attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" },
});

/** A received email body, safe to show (in the sandboxed viewer) and to store. */
export function sanitizeReceived(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [...LAYOUT_TAGS, "style"],
    allowVulnerableTags: true, // <style> only: rendered in a script-less sandboxed iframe
    allowedAttributes: { "*": COMMON_ATTRS, a: ["href", "name", "target", "rel"], img: ["src", "alt", "width", "height"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "cid", "data"] },
    allowProtocolRelative: false,
    transformTags: { a: linkTransform },
    exclusiveFilter: (frame) => frame.tag === "style" && /@import|expression\s*\(|javascript:/i.test(frame.text),
  });
}

/** What a member wrote in the composer: formatting and links only. */
export function sanitizeComposed(html: string): string {
  // A pasted signature block must never ride along with the text — the
  // chosen signature is added (once) when the message is sent. Removed first,
  // while its id is still visible (the formatting pass drops ids).
  return sanitizeHtml(stripSignatureBlock(html), {
    allowedTags: ["p", "div", "span", "br", "b", "strong", "i", "em", "u", "s", "strike", "a", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "font", "img", "table", "tbody", "tr", "td", "hr", "sup", "sub"],
    allowedAttributes: { "*": ["style", "dir", "align"], a: ["href", "target", "rel"], img: ["src", "alt", "width", "height"], font: ["color", "face", "size"], td: ["colspan", "rowspan", "width"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https", "cid"] },
    allowProtocolRelative: false,
  });
}

/** An imported Outlook signature: everything that shapes it, nothing that runs. */
export function sanitizeSignature(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => cleanCss(m[1])).join("\n");
  const clean = sanitizeHtml(body, {
    allowedTags: LAYOUT_TAGS,
    allowedAttributes: { "*": COMMON_ATTRS.filter((a) => a !== "id"), a: ["href", "name", "target", "rel"], img: ["src", "alt", "width", "height", "style"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https", "cid"] },
    allowProtocolRelative: false,
  });
  // Outlook desktop keeps its fonts/spacing in a <style> block (MsoNormal…).
  return styles.trim() ? `<style>${styles}</style>${clean}` : clean;
}

/** Remove a signature block from HTML (a draft opened for editing). */
export function stripSignatureBlock(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: false, allowedAttributes: false, allowVulnerableTags: true,
    exclusiveFilter: (frame) => frame.attribs?.id === "Signature" || frame.attribs?.id === "signature",
  });
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Outlook's default compose font (new Outlook / Outlook on the web). */
export const COMPOSE_STYLE = "font-family: Aptos, Aptos_EmbeddedFont, Aptos_MSFontService, Calibri, Helvetica, sans-serif; font-size: 12pt; color: rgb(0, 0, 0);";

function composedBlock(userHtml: string, signatureHtml: string | null): string {
  const text = `<div class="elementToProof" style="${COMPOSE_STYLE}">${sanitizeComposed(userHtml) || "<br>"}</div>`;
  const sig = signatureHtml ? `<div id="Signature">${signatureHtml}</div>` : "";
  return text + sig;
}

/** A new message's full HTML body. */
export function newMessageBody(userHtml: string, signatureHtml: string | null): string {
  return `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>${composedBlock(userHtml, signatureHtml)}</body></html>`;
}

/**
 * A reply/forward body: the member's text and signature placed above the
 * quoted thread Microsoft generated for the draft (createReply/createForward),
 * exactly where Outlook puts them.
 */
export function replyBody(userHtml: string, signatureHtml: string | null, draftHtml: string): string {
  const block = composedBlock(userHtml, signatureHtml) + "<br>";
  const withoutOldSig = stripSignatureBlockBeforeQuote(draftHtml);
  const m = withoutOldSig.match(/<body[^>]*>/i);
  if (!m || m.index == null) return newMessageBody(userHtml, signatureHtml) + withoutOldSig;
  const at = m.index + m[0].length;
  return withoutOldSig.slice(0, at) + block + withoutOldSig.slice(at);
}

/**
 * A draft re-opened for editing may already carry our signature above the
 * quote; drop only that one (the quoted thread's own signatures are part of
 * the history and stay).
 */
function stripSignatureBlockBeforeQuote(html: string): string {
  const quoteAt = html.search(/<div[^>]+id=["']?(divRplyFwdMsg|appendonsend)["']?/i);
  if (quoteAt < 0) return html;
  const head = html.slice(0, quoteAt);
  return (/id=["']?Signature["']?/i.test(head) ? stripSignatureBlock(head) : head) + html.slice(quoteAt);
}

/** Plain text of HTML, for previews and timeline snippets. */
export function htmlToText(html: string, max = 500): string {
  const text = sanitizeHtml(html.replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, "\n"), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;|\u00a0/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Plain text → minimal HTML (a template body, a bulk-send body). */
export function textToHtml(text: string): string {
  return escapeHtml(text).split(/\r?\n/).map((l) => (l ? `<div>${l}</div>` : "<div><br></div>")).join("");
}
