import { Component, type ReactNode } from "react";

/**
 * Route-level error boundary. Two jobs:
 *
 * 1. Stale-chunk recovery: after a redeploy, an already-open tab can request a
 *    hashed lazy chunk that no longer exists. React.lazy surfaces that as a
 *    thrown error, and without a boundary React unmounts the entire root — a
 *    completely blank page (and the sidebar logo vanishing with it). We detect
 *    chunk-load failures and reload the page once (one-shot, guarded via
 *    sessionStorage) to pick up the fresh build.
 * 2. Everything else: render an inline recovery panel inside the content area
 *    instead of letting the whole shell go blank. The sidebar and navigation
 *    stay mounted, and navigating away (resetKey change) clears the error.
 */

const RELOAD_FLAG = "mh-chunk-reloaded";
const isChunkError = (e: unknown): boolean =>
  e instanceof Error && /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i.test(e.message);

interface Props { resetKey?: string; children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (isChunkError(error)) {
      let reloaded = false;
      try { reloaded = sessionStorage.getItem(RELOAD_FLAG) === "1"; } catch { /* storage off */ }
      if (!reloaded) {
        try { sessionStorage.setItem(RELOAD_FLAG, "1"); } catch { /* storage off */ }
        window.location.reload();
      }
    }
  }

  componentDidUpdate(prev: Props) {
    // A successful render clears the one-shot reload guard; a navigation away
    // from the failed route clears the error so the next page renders normally.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
    if (!this.state.error) {
      try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* storage off */ }
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel" style={{ margin: 24, maxWidth: 520 }}>
          <h3 style={{ marginTop: 0 }}>Something went wrong loading this page</h3>
          <p className="muted">
            {isChunkError(this.state.error)
              ? "The app was updated since this tab was opened. Reload to get the latest version."
              : "An unexpected error occurred. Reloading usually fixes it — if it keeps happening, let us know."}
          </p>
          <button className="primary" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      );
    }
    return this.props.children;
  }
}
