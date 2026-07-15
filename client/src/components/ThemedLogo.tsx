import { useEffect, useState } from "react";
import { useTheme } from "../theme";
import { adaptLogoToTheme, cachedLogoVariant } from "../lib/logoTheme";

/**
 * An <img> for uploaded logos that automatically adapts to the active theme:
 * near-black elements turn white in dark mode, near-white elements turn black
 * in light mode, and brand colors pass through untouched (see lib/logoTheme).
 *
 * Both theme variants are precomputed and cached on first render, so toggling
 * the theme swaps the image synchronously — no refetch, flicker, or delay.
 * While the very first computation is in flight the original renders, and any
 * processing failure falls back to the original permanently.
 */
export function ThemedLogo({ src, alt, className, style }: {
  src: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { theme } = useTheme();
  const [display, setDisplay] = useState<string>(() => cachedLogoVariant(src, theme) ?? src);

  useEffect(() => {
    const cached = cachedLogoVariant(src, theme);
    if (cached) { setDisplay(cached); return; }
    let alive = true;
    setDisplay(src); // new logo while processing — show the original, never blank
    adaptLogoToTheme(src, theme).then((out) => { if (alive) setDisplay(out); });
    return () => { alive = false; };
  }, [src, theme]);

  return <img className={className} style={style} src={display} alt={alt} />;
}
