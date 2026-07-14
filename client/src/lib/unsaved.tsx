/**
 * App-wide unsaved-changes protection.
 *
 * Any inline editor (a section in edit mode with modified fields) registers
 * itself while dirty via useUnsavedSection / useUnsavedRegistration. A single
 * <UnsavedChangesGuard/> mounted in the app shell then:
 *  - intercepts EVERY in-app navigation (sidebar links, row clicks, back
 *    buttons — anything going through react-router) while something is dirty,
 *  - warns on tab close / hard reload via beforeunload,
 *  - and shows the standard three-way dialog: Save Changes / Discard Changes /
 *    Cancel. Save runs each dirty section's own save handler, then continues
 *    the navigation; Discard reverts them; Cancel stays put.
 *
 * In-page actions that bypass the router (e.g. switching which section is
 * being edited) opt in with guarded(() => …).
 */
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { UNSAFE_NavigationContext } from "react-router-dom";
import { Modal } from "../components/ui";

export interface DirtyEntry {
  save: () => Promise<void>;
  discard: () => void;
}

const entries = new Map<symbol, DirtyEntry>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const hasUnsaved = (): boolean => entries.size > 0;

/** Register/unregister a dirty editor. Handlers always call the latest closure. */
export function useUnsavedRegistration(dirty: boolean, entry: DirtyEntry): void {
  const keyRef = useRef<symbol | null>(null);
  if (!keyRef.current) keyRef.current = Symbol("unsaved");
  const latest = useRef(entry);
  latest.current = entry;
  useEffect(() => {
    const key = keyRef.current!;
    if (dirty) {
      entries.set(key, { save: () => latest.current.save(), discard: () => latest.current.discard() });
      emit();
      return () => { if (entries.delete(key)) emit(); };
    }
    if (entries.delete(key)) emit();
    return undefined;
  }, [dirty]);
}

/**
 * Convenience for the common section-editor shape: dirty when editing AND the
 * draft differs from what editing started from (deep compare via JSON, fine at
 * form size). Untouched forms never prompt.
 */
export function useUnsavedSection(
  editing: boolean,
  draft: unknown,
  seed: unknown,
  save: () => Promise<void>,
  discard: () => void,
): void {
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(seed);
  useUnsavedRegistration(dirty, { save, discard });
}

// The mounted guard exposes its dialog to non-router actions through here.
let openDialog: ((proceed: () => void) => void) | null = null;

/** Run an action through the unsaved-changes gate (no-op passthrough when clean). */
export function guarded(proceed: () => void): void {
  if (!hasUnsaved() || !openDialog) proceed();
  else openDialog(proceed);
}

interface RouterNavigator {
  push: (...args: unknown[]) => void;
  replace: (...args: unknown[]) => void;
  go: (delta: number) => void;
}

/** Mount ONCE inside the router (app shell). Renders nothing until needed. */
export function UnsavedChangesGuard() {
  const { navigator } = useContext(UNSAFE_NavigationContext) as unknown as { navigator: RouterNavigator };
  const dirtyCount = useSyncExternalStore(subscribe, () => entries.size);
  const anyDirty = dirtyCount > 0;
  const [pending, setPending] = useState<{ run: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    openDialog = (proceed) => { setError(null); setPending({ run: proceed }); };
    return () => { openDialog = null; };
  }, []);

  // While dirty, wrap the router's navigation methods so ANY in-app navigation
  // (links, programmatic nav(), back via nav(-1)) lands in the dialog first.
  useEffect(() => {
    if (!anyDirty) return;
    const push = navigator.push.bind(navigator);
    const replace = navigator.replace.bind(navigator);
    const go = navigator.go.bind(navigator);
    navigator.push = (...args) => { setError(null); setPending({ run: () => push(...args) }); };
    navigator.replace = (...args) => { setError(null); setPending({ run: () => replace(...args) }); };
    navigator.go = (delta) => { setError(null); setPending({ run: () => go(delta) }); };
    return () => { navigator.push = push; navigator.replace = replace; navigator.go = go; };
  }, [anyDirty, navigator]);

  // Tab close / reload: the browser's native prompt is the only option here.
  useEffect(() => {
    if (!anyDirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [anyDirty]);

  if (!pending) return null;

  const finish = (run: () => void) => { setPending(null); setBusy(false); run(); };

  async function saveAndGo() {
    setBusy(true); setError(null);
    try {
      for (const entry of [...entries.values()]) await entry.save();
      finish(pending!.run);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Save failed — fix the highlighted fields or discard the changes.");
    }
  }

  function discardAndGo() {
    for (const entry of [...entries.values()]) entry.discard();
    finish(pending!.run);
  }

  return (
    <Modal title="Unsaved changes" onClose={() => setPending(null)}
      footer={
        <>
          <button onClick={() => setPending(null)} disabled={busy}>Cancel</button>
          <button className="danger" onClick={discardAndGo} disabled={busy}>Discard Changes</button>
          <button className="primary" onClick={saveAndGo} disabled={busy}>{busy ? "Saving…" : "Save Changes"}</button>
        </>
      }>
      <p style={{ marginTop: 0 }}>
        You're in the middle of editing and your changes haven't been saved. If you leave now without saving,
        those changes will be lost.
      </p>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
