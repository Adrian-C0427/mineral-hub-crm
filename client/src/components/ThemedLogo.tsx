import { memo, useEffect, useReducer, useState } from "react";
import { useTheme } from "../theme";
import { adaptLogoToTheme, cachedLogoVariant } from "../lib/logoTheme";

/**
 * An <img> for uploaded logos that automatically adapts to the active theme:
 * near-black elements turn white in dark mode, near-white elements turn black
 * in light mode, and brand colors pass through untouched (see lib/logoTheme,
 * which also leaves artwork alone when re-toning would erase it).
 *
 * Stability contract (the logo must NEVER disappear or flash):
 * - What renders is derived SYNCHRONOUSLY on every render: the cached themed
 *   variant when available, otherwise the original source. There is no state
 *   that can lag a prop/theme change by a frame, and never a null/empty frame.
 * - Processing happens once per (src, theme) in a module-level cache
 *   (lib/logoTheme), shared across mounts — remounts render instantly from
 *   cache with zero network or canvas work.
 * - The swap from original → themed variant waits for the new image to be
 *   fully decoded, so the <img> never paints an in-between empty frame.
 * - A variant that fails to load falls back to the original; an original that
 *   fails is reported through onError so the caller can show its default mark
 *   (see lib/branding) instead of a broken-image icon.
 * - The component is memoized; parent re-renders don't touch it unless the
 *   logo itself changes.
 */
export const ThemedLogo = memo(function ThemedLogo({ src, alt, className, style, variant, onError }: {
  src: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  /** Force a variant regardless of theme (the sidebar is always dark). */
  variant?: "dark" | "light";
  /** The ORIGINAL source could not be displayed. */
  onError?: (src: string) => void;
}) {
  // Logos have two variants; every theme except Light sits on a dark ground.
  const { theme: appTheme } = useTheme();
  const theme = variant ?? (appTheme === "light" ? "light" : "dark");
  // Re-render trigger for when background processing completes; the displayed
  // value itself always comes straight from the cache at render time.
  const [, bump] = useReducer((c: number) => c + 1, 0);
  // A processed variant the browser refused (never expected) — show the original.
  const [badVariant, setBadVariant] = useState<string | null>(null);
  const cached = cachedLogoVariant(src, theme);
  const shown = cached && cached !== badVariant ? cached : src;

  useEffect(() => {
    if (cachedLogoVariant(src, theme)) return; // already resolved — nothing to do
    let alive = true;
    adaptLogoToTheme(src, theme).then(async (out) => {
      if (out === src) return; // shown as uploaded — already on screen
      // Decode before revealing, so the swap never paints an empty frame.
      try {
        const img = new Image();
        img.src = out;
        if (img.decode) await img.decode();
      } catch { /* decode unsupported/failed — swap anyway */ }
      if (alive) bump();
    });
    return () => { alive = false; };
  }, [src, theme]);

  const handleError = () => {
    if (shown !== src) setBadVariant(shown);
    else onError?.(src);
  };

  return <img className={className} style={style} src={shown} alt={alt} draggable={false} onError={handleError} />;
});
