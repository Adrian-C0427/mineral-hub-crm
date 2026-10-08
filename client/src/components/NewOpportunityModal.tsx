import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Modal, Req } from "./ui";
import { Select } from "./Select";
import { StateSelect } from "./StateSelect";
import { DateField } from "./DateField";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { isOpportunityPipeline, type PipelineInfo } from "../stages";
import { countiesForStates } from "../lib/options";
import { formatPhoneAsYouType, normalizePhone } from "../lib/phone";
import type { ContactRow } from "../pages/Contacts";
import type { Opp, UserLite } from "../types";

const numOrNull = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const strOrNull = (v: string) => (v.trim() === "" ? null : v.trim());

/**
 * Create an opportunity (a lightweight prospect) in an OPPORTUNITIES pipeline.
 * Only the name is required; everything else lives behind "More details" so a
 * prospect can be captured in seconds and filled in later on its page.
 */
export function NewOpportunityModal({ pipelines, pipelineId, onClose, onCreated, onPipelinesChanged }: {
  pipelines: PipelineInfo[];
  /** Pipeline to preselect (the board's current selection). */
  pipelineId?: string;
  onClose: () => void;
  onCreated: (o: Opp) => void;
  /** The server's pipeline list differs from the app's copy — refresh it. */
  onPipelinesChanged?: () => void;
}) {
  const { user } = useAuth();
  // Fetched fresh on open: the pipeline sent to the server must be one that
  // exists in this org right now. The app's copy is only the first paint.
  const [fresh, setFresh] = useState<PipelineInfo[] | null>(null);
  const oppPipelines = (fresh ?? pipelines).filter(isOpportunityPipeline);
  const pick = (list: PipelineInfo[]) => (list.some((p) => p.id === pipelineId) ? pipelineId! : list[0]?.id ?? "");
  const [pid, setPid] = useState(() => pick(oppPipelines));
  const refreshPipelines = (keep: boolean) =>
    api.get<PipelineInfo[]>("/pipeline/pipelines").then((ps) => {
      const opp = ps.filter(isOpportunityPipeline);
      setFresh(ps);
      setPid((cur) => (keep && opp.some((p) => p.id === cur) ? cur : pick(opp)));
      const known = new Set(pipelines.map((p) => p.id));
      if (ps.length !== pipelines.length || ps.some((p) => !known.has(p.id))) onPipelinesChanged?.();
      return opp;
    });
  useEffect(() => { void refreshPipelines(true).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pipeline = oppPipelines.find((p) => p.id === pid);
  const activeStages = pipeline?.stages.filter((s) => !s.isTerminal) ?? [];
  const [stage, setStage] = useState(activeStages[0]?.key ?? "");
  // Switching pipelines resets the stage to that pipeline's first active one.
  useEffect(() => { setStage(activeStages[0]?.key ?? ""); }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ownerId, setOwnerId] = useState(user?.id ?? "");
  const [users, setUsers] = useState<UserLite[]>([]);
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [f, setF] = useState({
    name: "", contactId: "", sellerName: "", companyName: "", phone: "", email: "",
    state: "", county: "", abstract: "", survey: "", estAcres: "", estNma: "", estNra: "",
    source: "", nextFollowUpDate: "", notes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => { api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);
  // Contacts load once the optional section opens (most prospects need none).
  useEffect(() => {
    if (!more || contacts) return;
    api.get<ContactRow[]>("/contacts").then(setContacts).catch(() => setContacts([]));
  }, [more, contacts]);

  // Linking a contact fills the blank seller fields from it (editable after).
  function pickContact(id: string) {
    const c = contacts?.find((x) => x.id === id);
    setF((p) => ({
      ...p, contactId: id,
      sellerName: p.sellerName || (c ? c.name : ""),
      companyName: p.companyName || (c?.entityName ?? ""),
      phone: p.phone || (c?.phone ? formatPhoneAsYouType(c.phone) : ""),
      email: p.email || (c?.email ?? ""),
    }));
  }

  const dirty = Object.values(f).some((v) => v.trim() !== "");
  const countyOptions = countiesForStates(f.state ? [f.state] : []);

  async function submit() {
    if (!f.name.trim()) { setError("Give the opportunity a name."); return; }
    if (!pid) { setError("Create an Opportunities pipeline first (Pipeline settings)."); return; }
    setBusy(true); setError(null);
    try {
      const o = await api.post<Opp>("/opportunities", {
        name: f.name.trim(),
        pipelineId: pid,
        stage: stage || undefined,
        ownerId: ownerId || null,
        contactId: f.contactId || null,
        sellerName: strOrNull(f.sellerName), companyName: strOrNull(f.companyName),
        phone: normalizePhone(f.phone) || null, email: strOrNull(f.email),
        state: strOrNull(f.state), county: strOrNull(f.county), abstract: strOrNull(f.abstract), survey: strOrNull(f.survey),
        estAcres: numOrNull(f.estAcres), estNma: numOrNull(f.estNma), estNra: numOrNull(f.estNra),
        source: strOrNull(f.source), nextFollowUpDate: f.nextFollowUpDate || null, notes: strOrNull(f.notes),
      });
      onCreated(o);
    } catch (err) {
      // The chosen pipeline no longer exists (deleted, or the workspace was
      // reset elsewhere): reload the list, reselect a valid one, say so.
      if (err instanceof ApiError && err.status === 400 && /unknown pipeline/i.test(err.message)) {
        const opp = await refreshPipelines(false).catch(() => [] as PipelineInfo[]);
        setError(opp.length
          ? "That pipeline was changed or removed. The list is up to date now — check the pipeline and try again."
          : "There is no Opportunities pipeline yet. Create one in Pipeline settings.");
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to create opportunity");
      }
      setBusy(false);
    }
  }

  const stageLabel = activeStages.find((s) => s.key === stage)?.label;
  return (
    <Modal
      title="New opportunity"
      subtitle={<>{stageLabel ? <>Starts in <strong>{stageLabel}</strong> · </> : null}only a name is required</>}
      onClose={onClose}
      dirty={dirty}
      footer={<>
        <span className="modal-req-note"><Req /> Required</span>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" onClick={() => void submit()} disabled={busy || !f.name.trim() || !pid}>{busy ? "Saving…" : "Create opportunity"}</button>
      </>}
    >
      <div className="nop">
        <div className="field">
          <label>Name <Req /></label>
          <input value={f.name} onChange={(e) => set("name")(e.target.value)} autoFocus placeholder="e.g. Hernandez minerals · Leon Co."
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }} />
        </div>
        <div className="nop-grid">
          <div className="field">
            <label>Pipeline</label>
            <Select value={pid} onChange={setPid} ariaLabel="Pipeline" placeholder="No opportunity pipelines"
              options={oppPipelines.map((p) => ({ value: p.id, label: p.name }))} />
          </div>
          <div className="field">
            <label>Stage</label>
            <Select value={stage} onChange={setStage} ariaLabel="Stage" placeholder="No stages yet"
              options={activeStages.map((s) => ({ value: s.key, label: s.label }))} />
          </div>
          <div className="field">
            <label>Owner</label>
            <Select value={ownerId} onChange={setOwnerId} ariaLabel="Owner" clearable searchable placeholder="Unassigned"
              options={users.map((u) => ({ value: u.id, label: u.name }))} />
          </div>
        </div>

        <button type="button" className={`nop-more ${more ? "open" : ""}`} aria-expanded={more} onClick={() => setMore((m) => !m)}>
          <ChevronDown size={14} strokeWidth={2.2} aria-hidden="true" /><span>More details</span>
          <span className="nop-more-hint">seller, property, follow-up, notes — all optional</span>
        </button>

        {more && (
          <div className="nop-details">
            <div className="modal-sec">Seller &amp; contact</div>
            <div className="nop-grid">
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>Contact</label>
                <Select value={f.contactId} onChange={pickContact} ariaLabel="Linked contact" clearable searchable
                  placeholder={contacts ? "Search contacts…" : "Loading contacts…"} emptyText="No matching contacts"
                  options={(contacts ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.entityName ?? undefined }))} />
              </div>
              <div className="field"><label>Seller name</label><input value={f.sellerName} onChange={(e) => set("sellerName")(e.target.value)} /></div>
              <div className="field"><label>Company</label><input value={f.companyName} onChange={(e) => set("companyName")(e.target.value)} /></div>
              <div className="field"><label>Phone</label><input value={f.phone} inputMode="tel" placeholder="(555) 000-0000" onChange={(e) => set("phone")(formatPhoneAsYouType(e.target.value))} /></div>
              <div className="field"><label>Email</label><input value={f.email} inputMode="email" placeholder="name@example.com" onChange={(e) => set("email")(e.target.value)} /></div>
            </div>

            <div className="modal-sec">Property</div>
            <div className="nop-grid">
              <div className="field"><label>State</label><StateSelect value={f.state} onChange={(v) => setF((p) => ({ ...p, state: v, county: v && p.county && !countiesForStates([v]).includes(p.county) ? "" : p.county }))} /></div>
              <div className="field">
                <label>County</label>
                <Select value={f.county} onChange={set("county")} ariaLabel="County" clearable searchable creatable placeholder="Search counties…" options={countyOptions} />
              </div>
              <div className="field"><label>Abstract</label><input value={f.abstract} onChange={(e) => set("abstract")(e.target.value)} placeholder="e.g. A-123" /></div>
              <div className="field"><label>Survey</label><input value={f.survey} onChange={(e) => set("survey")(e.target.value)} /></div>
              <div className="field"><label>Est. acres</label><input type="number" min={0} value={f.estAcres} onChange={(e) => set("estAcres")(e.target.value)} placeholder="0" /></div>
              <div className="field"><label title="Estimated net mineral acres">Est. NMA</label><input type="number" min={0} value={f.estNma} onChange={(e) => set("estNma")(e.target.value)} placeholder="0" /></div>
              <div className="field"><label title="Estimated net royalty acres">Est. NRA</label><input type="number" min={0} value={f.estNra} onChange={(e) => set("estNra")(e.target.value)} placeholder="0" /></div>
            </div>

            <div className="modal-sec">Details</div>
            <div className="nop-grid">
              <div className="field"><label>Source</label><input value={f.source} onChange={(e) => set("source")(e.target.value)} placeholder="Referral, mailer, courthouse…" /></div>
              <div className="field"><label>Next follow-up</label><DateField value={f.nextFollowUpDate} onChange={set("nextFollowUpDate")} ariaLabel="Next follow-up" /></div>
              <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><textarea rows={3} value={f.notes} onChange={(e) => set("notes")(e.target.value)} placeholder="Anything worth remembering about this prospect…" /></div>
            </div>
          </div>
        )}
        {error && <div className="error-text" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}
