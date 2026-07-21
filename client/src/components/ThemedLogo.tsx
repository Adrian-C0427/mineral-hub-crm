import { memo, useEffect, useReducer } from "react";
import { useTheme } from "../theme";
import { adaptLogoToTheme, cachedLogoVariant } from "../lib/logoTheme";

/**
 * An <img> for uploaded logos that automatically adapts to the active theme:
 * near-black elements turn white in dark mode, near-white elements turn black
 * in light mode, and brand colors pass through untouched (see lib/logoTheme).
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
 * - The component is memoized; parent re-renders don't touch it unless the
 *   logo itself changes.
 */
export const ThemedLogo = memo(function ThemedLogo({ src, alt, className, style }: {
  src: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { theme } = useTheme();
  // Re-render trigger for when background processing completes; the displayed
  // value itself always comes straight from the cache at render time.
  const [, bump] = useReducer((c: number) => c + 1, 0);
  const shown = cachedLogoVariant(src, theme) ?? src;

  useEffect(() => {
    if (cachedLogoVariant(src, theme)) return; // already resolved — nothing to do
    let alive = true;
    adaptLogoToTheme(src, theme).then(async (out) => {
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

  return <img className={className} style={style} src={shown} alt={alt} draggable={false} />;
});
