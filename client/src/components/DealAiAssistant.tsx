import { useMemo, useState } from "react";
import { api, ApiError } from "../api/client";

// AI assistant for a deal — powered by the org's connected Claude integration.
// Two actions: summarize the deal, and draft a buyer-outreach email. Self-
// contained so it drops into DealDetail with a single line.

interface BuyerOption { id: string; name: string; company: string }

export function DealAiAssistant({ dealId, buyers }: { dealId: string; buyers: BuyerOption[] }) {
  const options = useMemo(() => {
    const seen = new Set<string>();
    return buyers.filter((b) => b.id && !seen.has(b.id) && seen.add(b.id));
  }, [buyers]);

  const [mode, setMode] = useState<"summary" | "draft">("summary");
  const [buyerId, setBuyerId] = useState<string>(options[0]?.id ?? "");
  const [instructions, setInstructions] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function run() {
    setBusy(true); setError(null); setResult(null); setCopied(false);
    try {
      if (mode === "summary") {
        const r = await api.post<{ text: string }>(`/ai/deals/${dealId}/summary`, {});
        setResult(r.text);
      } else {
        if (!buyerId) { setError("Pick a buyer to draft an email to."); setBusy(false); return; }
        const r = await api.post<{ text: string }>(`/ai/deals/${dealId}/draft-email`, { buyerId, instructions: instructions.trim() || undefined });
        setResult(r.text);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed.");
    } finally { setBusy(false); }
  }

  function copy() {
    if (!result) return;
    navigator.clipboard?.writeText(result).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  }

  return (
    <div className="panel">
      <div className="section-head">
        <h3 style={{ margin: 0 }}>AI assistant <span className="chip-mini" style={{ marginLeft: 6 }}>Claude</span></h3>
      </div>

      <div className="chip-row" style={{ marginBottom: 10 }}>
        <span className={`chip ${mode === "summary" ? "active" : ""}`} onClick={() => { setMode("summary"); setResult(null); setError(null); }}>Summarize deal</span>
        <span className={`chip ${mode === "draft" ? "active" : ""}`} onClick={() => { setMode("draft"); setResult(null); setError(null); }}>Draft buyer email</span>
      </div>

      {mode === "draft" && (
        <>
          <div className="field">
            <label>Buyer</label>
            {options.length === 0 ? (
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>No buyers linked to this deal yet — add buyer activity or a matched buyer first.</p>
            ) : (
              <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)}>
                {options.map((b) => <option key={b.id} value={b.id}>{b.name}{b.company ? ` · ${b.company}` : ""}</option>)}
              </select>
            )}
          </div>
          <div className="field">
            <label>Extra instructions (optional)</label>
            <input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. mention we can close quickly; keep it casual" />
          </div>
        </>
      )}

      <button className="primary" disabled={busy || (mode === "draft" && options.length === 0)} onClick={run}>
        {busy ? "Generating…" : mode === "summary" ? "Summarize" : "Draft email"}
      </button>

      {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}

      {result && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em" }}>{mode === "summary" ? "Summary" : "Draft"}</span>
            <button className="small" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
          </div>
          <div style={{ whiteSpace: "pre-wrap", background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", fontSize: 14, lineHeight: 1.5 }}>{result}</div>
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>AI-generated from this deal's data — review before sending. Uses your organization's connected Claude key.</p>
        </div>
      )}
    </div>
  );
}
