import { useRef, useState } from "react";

/**
 * Shared CSV pick-or-drop target — the same affordance the Buyers import has,
 * for every CSV import in the app. Click opens the picker; dragging a file in
 * highlights and drops. Selecting the same file twice in a row still fires
 * (the input clears itself after each pick).
 */
export function CsvDropzone({ onFile, label = "Drag & drop a CSV here, or click to choose a file", slim }: {
  onFile: (f: File) => void;
  label?: string;
  /** Compact single-line variant for config rows. */
  slim?: boolean;
}) {
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`dropzone ${slim ? "dropzone-slim" : ""} ${drag ? "drag" : ""}`}
      role="button"
      tabIndex={0}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      onClick={() => ref.current?.click()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ref.current?.click(); } }}
    >
      {label}
      <input
        ref={ref}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ""; }}
      />
    </div>
  );
}
