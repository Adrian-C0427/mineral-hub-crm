import { useEffect, useRef, useState } from "react";
import { authedObjectUrl, type MailAttachment } from "../../lib/mail";

/**
 * An email body (or a signature), shown the way the sender designed it: in a
 * sandboxed iframe (no scripts can run; the server already removed them) on
 * a white page like Outlook's reading pane, sized to its content. Inline
 * images (cid:) are resolved to object/data URLs; links open in a new tab.
 */
export function MailBody({ html, resolveCid, compact = false }: {
  html: string;
  /** cid → displayable URL (fetched with the member's session), or null. */
  resolveCid?: (cid: string) => Promise<string | null>;
  /** Signature previews: tighter padding. */
  compact?: boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [height, setHeight] = useState(compact ? 40 : 120);

  useEffect(() => {
    let live = true;
    const made: string[] = [];
    (async () => {
      let out = html;
      if (resolveCid) {
        const cids = [...new Set([...html.matchAll(/cid:([^"'\s)>]+)/gi)].map((m) => m[1]))];
        for (const cid of cids) {
          const url = await resolveCid(cid).catch(() => null);
          if (!url) continue;
          if (url.startsWith("blob:")) made.push(url);
          out = out.split(`cid:${cid}`).join(url);
        }
      }
      if (live) setDoc(frame(out, compact));
    })();
    return () => { live = false; for (const u of made) URL.revokeObjectURL(u); };
  }, [html, resolveCid, compact]);

  function fit() {
    const d = ref.current?.contentDocument;
    if (!d?.body) return;
    for (const a of Array.from(d.querySelectorAll("a[href]"))) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); }
    const measure = () => setHeight(Math.min(20_000, Math.max(compact ? 24 : 80, d.documentElement.scrollHeight)));
    measure();
    for (const img of Array.from(d.images)) if (!img.complete) img.addEventListener("load", measure, { once: true });
  }

  if (doc == null) return <div className={`mail-body-loading ${compact ? "compact" : ""}`} />;
  return (
    <iframe
      ref={ref}
      className={`mail-body ${compact ? "compact" : ""}`}
      title={compact ? "Signature preview" : "Email message"}
      srcDoc={doc}
      onLoad={fit}
      style={{ height }}
      // No allow-scripts: nothing in an email can run. allow-same-origin only
      // lets this page measure the content height.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
    />
  );
}

/** Resolver for a mailbox message's inline attachments. */
export function messageCidResolver(attachmentPath: string, attachments: readonly MailAttachment[]) {
  return async (cid: string) => {
    const a = attachments.find((x) => x.contentId && x.contentId.replace(/^<|>$/g, "") === cid);
    return a ? authedObjectUrl(`${attachmentPath}/${encodeURIComponent(a.id)}?inline=1`) : null;
  };
}

/** Resolver for a saved signature's images. */
export function signatureCidResolver(signatureId: string) {
  return (cid: string) => authedObjectUrl(`/mail/signatures/${encodeURIComponent(signatureId)}/assets/${encodeURIComponent(cid)}`);
}

function frame(body: string, compact: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
html,body{margin:0;padding:0;background:#fff;color:#111;overflow-y:hidden;}
body{padding:${compact ? "8px 10px" : "16px 18px"};font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Aptos,Calibri,Helvetica,Arial,sans-serif;overflow-wrap:anywhere;}
img{max-width:100%;}
table{max-width:100%;}
blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:2px solid #ccc;color:#444;}
</style></head><body>${body}</body></html>`;
}
