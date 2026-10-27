import { useEffect, useMemo, useState } from "react";
import { Modal, Req } from "./ui";
import { Select } from "./Select";
import { userOptions } from "./UserAvatar";
import { DateField } from "./DateField";
import { GeoFields } from "./GeoFields";
import { GeoTagFields } from "./GeoTagFields";
import { FormSection } from "./kit";
import { SellerInformation, emptySellerInfo, sellerInfoBody, sellerInfoFromContact, sellerInfoInvalid, sellerInfoMissing, type SellerInfoForm } from "./SellerInformation";
import { SectionRail, useSectionRail, type RailSection } from "./SectionRail";
import { useAbstractIndex } from "./AbstractPicker";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { isOpportunityPipeline, type PipelineInfo } from "../stages";
import { acres, prettyStage } from "../lib/format";
import { surveyLabel } from "../lib/abstracts";
import { checkOppForm, choosePipelineStage, emptyOppForm, isAbstractId, oppBody, oppFormFromRecord, oppPatchBody, type OppForm } from "../lib/opportunityForm";
import type { Opp, UserLite, UserRef } from "../types";

export type OppFormSection = "basics" | "seller" | "property" | "acreage" | "followup";

// The form's sections, in order, as listed in the rail. Basics and the seller
// hold required fields; everything else can be filled in now or later.
const SECTIONS: RailSection<OppFormSection>[] = [
  { key: "basics", label: "Basics", required: true },
  { key: "seller", label: "Seller", required: true },
  { key: "property", label: "Property" },
  { key: "acreage", label: "Acreage" },
  { key: "followup", label: "Follow-up & notes" },
];

/** Pipelines + their active stage keys, to notice when a list changed. */
const pipelineSig = (ps: PipelineInfo[]) => ps.map((p) => `${p.id}:${p.stages.map((s) => s.key).join(",")}`).join("|");

/**
 * Create an opportunity — or, with `opp`, edit one. The same sectioned form as
 * New deal (section rail, required-field count, summary footer, the shared
 * field components) holding the Opportunity fields only: basics (name,
 * pipeline, starting stage, owner), seller & contact, property (State → County
 * → Abstract, one of each), acreage estimates, and follow-up & notes.
 *
 * Creating: the pipeline list is fetched fresh on open, so the pipeline sent is
 * one that exists in this org right now; a pipeline or stage removed in the
 * meantime is caught, the list reloaded and the user told. Editing keeps the
 * pipeline and stage as they are (Move stage changes the stage, with its
 * history) and saves only the fields that changed.
 */
export function NewOpportunityModal({ pipelines, pipelineId, opp, initialSection, onClose, onCreated, onSaved, onPipelinesChanged }: {
  pipelines: PipelineInfo[];
  /** Pipeline to preselect (the board's current selection). */
  pipelineId?: string;
  /** Edit this opportunity instead of creating one. */
  opp?: Opp;
  /** Section to open on (the Edit button of one of the page's cards). */
  initialSection?: OppFormSection;
  onClose: () => void;
  /** Created — with where it landed, for the confirmation. */
  onCreated?: (o: Opp, where: { pipelineName: string; stageLabel: string }) => void;
  /** Edited — the saved record. */
  onSaved?: (o: Opp) => void;
  /** The server's pipeline list differs from the app's copy — refresh it. */
  onPipelinesChanged?: () => void;
}) {
  const editing = !!opp;
  const { user } = useAuth();
  // The values the form opened with: a blank form, or the saved record.
  const [initial] = useState<OppForm>(() => (opp ? oppFormFromRecord(opp) : emptyOppForm(user?.id ?? "")));
  const [f, setF] = useState<OppForm>(initial);
  const set = (k: keyof OppForm) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  // The seller — the shared Seller Information block. Editing seeds it from the
  // linked contact (the shared record), else from the opportunity's own fields.
  const [seller, setSeller] = useState<SellerInfoForm>(() => sellerSeed(opp));
  const sellerInitial = useState(() => sellerInfoBody(sellerSeed(opp)))[0];
  const sellerChanged = JSON.stringify(sellerInfoBody(seller)) !== JSON.stringify(sellerInitial);

  // --- pipeline + starting stage ------------------------------------------
  // The app's list is only the first paint; a fresh copy replaces it on open.
  const [fresh, setFresh] = useState<PipelineInfo[] | null>(null);
  const allPipelines = fresh ?? pipelines;
  const oppPipelines = allPipelines.filter(isOpportunityPipeline);
  const [choice, setChoice] = useState(() => choosePipelineStage(oppPipelines, { pipelineId: "", stage: "" }, pipelineId));
  // Whenever the list changes (fresh copy, app reload), re-check the choice:
  // a pipeline or stage that no longer exists is never sent.
  const oppSig = pipelineSig(oppPipelines);
  useEffect(() => { setChoice((cur) => choosePipelineStage(oppPipelines, cur, pipelineId)); }, [oppSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const refreshPipelines = () =>
    api.get<PipelineInfo[]>("/pipeline/pipelines").then((ps) => {
      setFresh(ps);
      if (pipelineSig(ps) !== pipelineSig(pipelines)) onPipelinesChanged?.();
      return ps.filter(isOpportunityPipeline);
    });
  useEffect(() => { if (!editing) void refreshPipelines().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pipeline = editing ? allPipelines.find((p) => p.id === opp!.pipelineId) : oppPipelines.find((p) => p.id === choice.pipelineId);
  const activeStages = pipeline?.stages.filter((s) => !s.isTerminal) ?? [];
  const stageKey = editing ? opp!.stage : choice.stage;
  const stageLabel = pipeline?.stages.find((s) => s.key === stageKey)?.label ?? (stageKey ? prettyStage(stageKey) : "");

  // --- people -------------------------------------------------------------
  const [users, setUsers] = useState<UserLite[]>([]);
  useEffect(() => { api.get<UserLite[]>("/users").then(setUsers).catch(() => {}); }, []);
  // The saved owner shows by name before (or without) the list (edit mode).
  const ownerList: UserRef[] = opp?.owner && !users.some((u) => u.id === opp.owner!.id) ? [opp.owner, ...users] : users;
  const ownerOptions = userOptions(ownerList);

  // --- property -----------------------------------------------------------
  const { byId } = useAbstractIndex();
  // A GIS abstract brings its survey along — unless a survey was typed.
  function pickAbstract(ids: string[]) {
    const id = ids[0] ?? "";
    setF((p) => {
      const was = surveyLabel(byId.get(p.abstract)?.survey);
      const next = surveyLabel(byId.get(id)?.survey);
      return { ...p, abstract: id, survey: next && (!p.survey.trim() || p.survey === was) ? next : p.survey };
    });
  }

  // --- validation, rail, submit ---------------------------------------------
  const check = checkOppForm(f, { editing, pipelineId: choice.pipelineId, stage: choice.stage });
  // The seller is required (a name or an entity name, or an existing contact).
  check.missing.push(...sellerInfoMissing(seller));
  check.invalid.push(...sellerInfoInvalid(seller));
  const changes = oppPatchBody(initial, f);
  const dirty = Object.keys(changes).length > 0 || sellerChanged;
  const { sec, goSec, formRef, railRef, onFormScroll } = useSectionRail<OppFormSection>(initialSection ?? "basics");
  useEffect(() => { if (initialSection && initialSection !== "basics") goSec(initialSection, "auto"); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    if (opp && !dirty) { onClose(); return; }
    if (check.missing.length) { setError(`Required: ${check.missing.join(", ")}`); goSec(check.missing.some((m) => m.startsWith("Seller")) && !checkOppForm(f, { editing, pipelineId: choice.pipelineId, stage: choice.stage }).missing.length ? "seller" : "basics"); return; }
    if (check.invalid.length) { setError(check.invalid.join(" · ")); return; }
    setBusy(true); setError(null);
    try {
      // The seller block travels as `seller`; the server resolves it to a Contact
      // and fills the opportunity's own seller columns from it.
      const sellerBody = sellerInfoBody(seller);
      if (opp) {
        onSaved?.(await api.patch<Opp>(`/opportunities/${opp.id}`, { ...changes, ...(sellerChanged ? { seller: sellerBody } : {}) }));
      } else {
        const { sellerName: _sn, companyName: _cn, phone: _ph, email: _em, contactId: _ci, ...rest } = oppBody(f);
        const o = await api.post<Opp>("/opportunities", { ...rest, seller: sellerBody, pipelineId: choice.pipelineId, stage: choice.stage });
        onCreated?.(o, { pipelineName: pipeline?.name ?? "", stageLabel: pipeline?.stages.find((s) => s.key === o.stage)?.label ?? prettyStage(o.stage) });
      }
    } catch (err) {
      // The pipeline or stage no longer exists (deleted, or changed in another
      // tab): reload the list — the choice re-resolves to a valid one — and say so.
      if (!opp && err instanceof ApiError && err.status === 400 && /unknown pipeline|holds deals/i.test(err.message)) {
        const left = await refreshPipelines().catch(() => null);
        setError(left && left.length === 0
          ? "There is no Opportunities pipeline any more. Create one in Pipeline settings."
          : "That pipeline or stage was changed or removed. The list is up to date now — check the pipeline and stage, then try again.");
        goSec("basics");
      } else {
        setError(err instanceof ApiError ? err.message : opp ? "Could not save the opportunity" : "Could not create the opportunity");
      }
      setBusy(false);
    }
  }

  const req = <Req />;
  const fieldsLeft = check.missing.length;
  const nma = f.estNma.trim() === "" || !Number.isFinite(Number(f.estNma)) ? null : Number(f.estNma);
  const where = [pipeline?.name, stageLabel].filter(Boolean).join(" · ");
  const isDone = (k: OppFormSection) =>
    (k === "basics" && !check.missing.some((m) => !m.startsWith("Seller"))) || (k === "seller" && !sellerInfoMissing(seller).length);
  const enterSubmits = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } };

  return (
    <Modal
      title={editing ? "Edit opportunity" : "New opportunity"}
      subtitle={editing
        ? <>In <strong>{pipeline?.name ?? "its pipeline"}</strong> · <strong>{stageLabel}</strong> — change the stage with Move stage</>
        : <>{stageLabel ? <>Starts in <strong>{stageLabel}</strong> · </> : null}a name and the seller are required — the rest can wait</>}
      onClose={onClose}
      wide
      dirty={dirty}
      footer={
        <>
          <div className="nd-sum">
            <div className="nd-sum-item op-sum-where"><span>{editing ? "Pipeline · stage" : "Starts in"}</span><b className={where ? undefined : "empty"} title={where || undefined}>{where || "—"}</b></div>
            <div className="nd-sum-item"><span>Est. NMA</span><b className={nma == null ? "empty" : undefined}>{acres(nma)}</b></div>
          </div>
          <div className="nd-foot-actions">
            <span className="nd-left">
              <span className="modal-req-note"><Req /> Required</span>
              {fieldsLeft > 0 && <span>{fieldsLeft} required field{fieldsLeft === 1 ? "" : "s"} left</span>}
            </span>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={() => void submit()} disabled={busy || fieldsLeft > 0 || (editing && !dirty)}
              title={fieldsLeft ? "Enabled once required fields are filled" : editing && !dirty ? "Nothing has changed yet" : undefined}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create opportunity"}
            </button>
          </div>
        </>
      }
    >
      <div className="nd-shell">
        <SectionRail sections={SECTIONS} active={sec} isDone={isDone} onPick={goSec} railRef={railRef} />

        <div className="nd-form" ref={formRef} onScroll={onFormScroll}>
          <div data-sec="basics">
            <FormSection title="Basics">
              <div className="nd-basics">
                <div className="field" style={{ gridColumn: "1 / -1" }}>
                  <label>Opportunity name {req}</label>
                  <input value={f.name} onChange={(e) => set("name")(e.target.value)} autoFocus={!initialSection || initialSection === "basics"}
                    placeholder="e.g. Hernandez minerals · Leon Co." onKeyDown={enterSubmits} aria-label="Opportunity name" />
                </div>
                <div className="field">
                  <label>Pipeline {editing ? null : req}</label>
                  {!editing && oppPipelines.length > 1 ? (
                    <Select value={choice.pipelineId} onChange={(id) => setChoice((cur) => choosePipelineStage(oppPipelines, { pipelineId: id, stage: cur.pipelineId === id ? cur.stage : "" }, pipelineId))}
                      ariaLabel="Pipeline" options={oppPipelines.map((p) => ({ value: p.id, label: p.name }))} />
                  ) : (
                    <div className="nd-derived">
                      {pipeline ? <strong>{pipeline.name}</strong> : <span className="muted">{editing ? "—" : "No Opportunities pipeline yet — create one in Pipeline settings"}</span>}
                    </div>
                  )}
                </div>
                <div className="field">
                  <label>{editing ? "Stage" : <>Starting stage {req}</>}</label>
                  {editing ? (
                    <div className="nd-derived"><strong>{stageLabel || "—"}</strong><span className="muted"> · change it with Move stage</span></div>
                  ) : (
                    <Select value={choice.stage} onChange={(stage) => setChoice((cur) => ({ ...cur, stage }))} ariaLabel="Starting stage"
                      placeholder={pipeline ? "This pipeline has no stages yet" : "Pick a pipeline first"} disabled={!activeStages.length}
                      options={activeStages.map((s) => ({ value: s.key, label: s.label }))} />
                  )}
                </div>
                <div className="field">
                  <label>Owner</label>
                  <Select value={f.ownerId} onChange={set("ownerId")} ariaLabel="Owner" clearable searchable placeholder="Unassigned"
                    options={ownerOptions} />
                </div>
              </div>
            </FormSection>
          </div>

          <div data-sec="seller">
            <FormSection title="Seller" hint="Who owns the minerals. Pick an existing contact, or enter the seller and a contact is created and linked — one contact per seller, however many prospects and deals.">
              <SellerInformation value={seller} onChange={setSeller} req={req} />
            </FormSection>
          </div>

          <div data-sec="property">
            <FormSection title="Property" hint="One state, county and abstract. Pick the abstract from the county's list, or type it as written when it isn't listed.">
              <div className="nd-grid3">
                <GeoFields single
                  states={f.state ? [f.state] : []} onStatesChange={(v) => set("state")(v[0] ?? "")}
                  counties={f.county ? [f.county] : []} onCountiesChange={(v) => set("county")(v[0] ?? "")}
                  abstractIds={f.abstract ? [f.abstract] : []} onAbstractsChange={pickAbstract}
                />
                <div className="field"><label>Survey</label><input value={f.survey} onChange={(e) => set("survey")(e.target.value)} placeholder="Filled in from the abstract" /></div>
                {/* Basin / Formation from the abstract's footprint or the county (filled in while untouched). */}
                <GeoTagFields autoFill basins={f.basins} onBasinsChange={(v) => setF((p) => ({ ...p, basins: v }))} formations={f.formations} onFormationsChange={(v) => setF((p) => ({ ...p, formations: v }))}
                  abstractIds={f.abstract && isAbstractId(f.abstract) ? [f.abstract] : []} counties={f.county ? [f.county] : []} states={f.state ? [f.state] : []} />
              </div>
            </FormSection>
          </div>

          <div data-sec="acreage">
            <FormSection title="Acreage" hint="Estimates — refine them as you learn more. Est. NMA is what the board totals per stage.">
              <div className="nd-grid3">
                <div className="field"><label title="Estimated gross acres of the tract">Est. gross acres</label>
                  <input type="number" min={0} step="any" value={f.estAcres} onChange={(e) => set("estAcres")(e.target.value)} placeholder="0.00" aria-label="Estimated gross acres" />
                </div>
                <div className="field"><label title="Estimated net mineral acres">Est. NMA</label>
                  <input type="number" min={0} step="any" value={f.estNma} onChange={(e) => set("estNma")(e.target.value)} placeholder="0.00" aria-label="Estimated NMA" />
                </div>
                <div className="field"><label title="Estimated net royalty acres">Est. NRA</label>
                  <input type="number" min={0} step="any" value={f.estNra} onChange={(e) => set("estNra")(e.target.value)} placeholder="0.00" aria-label="Estimated NRA" />
                </div>
              </div>
            </FormSection>
          </div>

          <div data-sec="followup">
            <FormSection title="Follow-up & notes">
              <div className="nd-grid3">
                <div className="field"><label>Source</label><input value={f.source} onChange={(e) => set("source")(e.target.value)} placeholder="Referral, mailer, courthouse…" /></div>
                <div className="field"><label>Next follow-up</label><DateField value={f.nextFollowUpDate} onChange={set("nextFollowUpDate")} ariaLabel="Next follow-up" /></div>
              </div>
              <div className="field nd-notes"><label>Notes</label><textarea rows={3} value={f.notes} onChange={(e) => set("notes")(e.target.value)} placeholder="Anything worth remembering about this prospect…" /></div>
            </FormSection>
          </div>
        </div>
      </div>
      {error && <div className="error-text nd-error" role="alert">{error}</div>}
    </Modal>
  );
}

/** The seller block's starting values: the linked contact (the shared record)
 *  when there is one, else the opportunity's own seller fields; blank for a new one. */
function sellerSeed(opp: Opp | undefined): SellerInfoForm {
  if (!opp) return emptySellerInfo();
  if (opp.contact) {
    const c = opp.contact;
    return sellerInfoFromContact({
      id: c.id, firstName: c.firstName, lastName: c.lastName, entityName: c.entityName, phone: c.phone, email: c.email,
      mailingStreet: c.mailingStreet ?? null, mailingCity: c.mailingCity ?? null, mailingState: c.mailingState ?? null, mailingZip: c.mailingZip ?? null,
    });
  }
  const name = (opp.sellerName ?? "").trim();
  const i = name.lastIndexOf(" ");
  const entity = !!opp.companyName && !name;
  return {
    ...emptySellerInfo(), kind: entity ? "ENTITY" : "INDIVIDUAL", entityType: "OTHER",
    firstName: i < 0 ? name : name.slice(0, i), lastName: i < 0 ? "" : name.slice(i + 1),
    companyName: opp.companyName ?? "", phone: opp.phone ?? "", email: opp.email ?? "",
  };
}
