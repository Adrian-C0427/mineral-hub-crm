import { useCallback, useState } from "react";
import { pickLogo, type BrandingSource, type LogoKind } from "./branding";

/**
 * Logo sources that failed to decode in this component. Keyed by the source
 * itself, so uploading a replacement (a new data URL) is tried immediately,
 * while the same broken artwork arriving again on a profile refresh stays
 * skipped instead of flashing a broken image.
 */
export function useLogoFailures(): { failed: ReadonlySet<string>; markFailed: (src: string) => void } {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const markFailed = useCallback((src: string) => {
    setFailed((s) => (s.has(src) ? s : new Set(s).add(src)));
  }, []);
  return { failed, markFailed };
}

/**
 * The logo a branding slot should render right now (see lib/branding pickLogo),
 * plus the onError handler to wire to its <img>. `src` null → render the
 * default Mineral Hub mark.
 */
export function useBrandLogo(org: BrandingSource | null | undefined, kind: LogoKind): { src: string | null; onError: (src: string) => void } {
  const { failed, markFailed } = useLogoFailures();
  return { src: pickLogo(org, kind, failed), onError: markFailed };
}
