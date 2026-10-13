import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The section rail of the large create/edit forms (New deal, New / Edit
 * opportunity): the form's sections down the left — a sideways step strip on
 * phones — each with a done / required / optional ring, click-to-jump, a
 * scroll-spy that follows the form pane, and an "N of M required sections"
 * progress bar. Styles: styles/deals.css (.nd-rail, .nd-form).
 */
export interface RailSection<K extends string> {
  key: K;
  label: string;
  /** Holds required fields: a required ring and a slot in the progress bar. */
  required?: boolean;
}

const CheckIcon = ({ size = 9 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

/**
 * Rail state for a form pane: the active section, jump-to-section, and the
 * scroll-spy. Put `formRef` + `onFormScroll` on the scrolling `.nd-form` (its
 * sections carry `data-sec="<key>"`) and `railRef` on the rail.
 */
export function useSectionRail<K extends string>(first: K) {
  const [sec, setSec] = useState<K>(first);
  const formRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const spyLock = useRef(0);
  const goSec = (k: K, behavior: ScrollBehavior = "smooth") => {
    const pane = formRef.current;
    const el = pane?.querySelector<HTMLElement>(`[data-sec="${k}"]`);
    spyLock.current = Date.now() + 700;
    if (pane && el) pane.scrollTo({ top: Math.max(0, el.offsetTop - 4), behavior });
    setSec(k);
  };
  const onFormScroll = () => {
    const pane = formRef.current;
    if (!pane || Date.now() < spyLock.current) return;
    const els = [...pane.querySelectorAll<HTMLElement>("[data-sec]")];
    let cur = els[0]?.dataset.sec;
    for (const el of els) if (el.offsetTop - 80 <= pane.scrollTop) cur = el.dataset.sec;
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4) cur = els[els.length - 1]?.dataset.sec;
    if (cur && cur !== sec) setSec(cur as K);
  };
  // On phones the rail is a sideways strip: keep the active step in view.
  useEffect(() => {
    const list = railRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-rail="${sec}"]`);
    if (!list || !item || list.scrollWidth <= list.clientWidth) return;
    list.scrollTo({ left: item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2, behavior: "smooth" });
  }, [sec]);
  return { sec, goSec, formRef, railRef, onFormScroll };
}

export function SectionRail<K extends string>({ sections, active, isDone, onPick, railRef }: {
  sections: RailSection<K>[];
  active: K;
  /** A required section with nothing left to fill. */
  isDone: (k: K) => boolean;
  onPick: (k: K) => void;
  railRef: RefObject<HTMLDivElement>;
}) {
  const requiredSecs = sections.filter((x) => x.required);
  const reqDone = requiredSecs.filter((x) => isDone(x.key)).length;
  return (
    <nav className="nd-rail" aria-label="Form sections">
      <div className="nd-rail-list" ref={railRef}>
        {sections.map((x) => {
          const done = isDone(x.key);
          const on = active === x.key;
          return (
            <button type="button" key={x.key} data-rail={x.key} onClick={() => onPick(x.key)}
              className={`nd-rail-item${on ? " active" : ""}`} aria-current={on ? "step" : undefined}>
              <span className={`nd-ring ${done ? "done" : x.required ? "req" : "opt"}`} aria-hidden="true">{done && <CheckIcon />}</span>
              <span className="nd-rail-label">{x.label}</span>
              {!x.required && <span className="nd-rail-opt">Optional</span>}
            </button>
          );
        })}
      </div>
      <div className="nd-progress">
        <div className="nd-progress-bar" aria-hidden="true">
          {requiredSecs.map((x, i) => <span key={x.key} className={i < reqDone ? "done" : undefined} />)}
        </div>
        <span>{reqDone} of {requiredSecs.length} required section{requiredSecs.length === 1 ? "" : "s"}</span>
      </div>
    </nav>
  );
}
