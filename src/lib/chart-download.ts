// ─────────────────────────────────────────────────────────────────────────────
// chart-download — tiny helper used by the per-chart hover Download chip.
//
// Why split this out of file-download.ts:
//   `file-download.ts` houses Blob / Markdown / TXT helpers. Chart
//   exports are simpler — echarts already hands us a base64 data URL
//   from `getDataURL()`, so we don't need a Blob round-trip; the
//   anchor's `download` attribute on a data: URL is enough.
// ─────────────────────────────────────────────────────────────────────────────

/** Download a base64 PNG data URL as a file. Idempotent w.r.t. the
 *  `.png` suffix: if the caller already added one, we don't double it. */
export function downloadChartAsPng(dataUrl: string, baseFilename: string): void {
  if (typeof document === "undefined") return;
  if (!dataUrl) return;
  const filename = baseFilename.toLowerCase().endsWith(".png")
    ? baseFilename
    : `${baseFilename}.png`;
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Turn a chart title into a safe file basename. CJK / accented
 *  characters survive; Windows-reserved characters become `-`; ASCII
 *  control bytes are dropped. */
export function sanitizeChartFilename(title: string): string {
  const noControlChars = Array.from(title || "chart").filter((c) => {
    const code = c.charCodeAt(0);
    return code >= 32 && code !== 127;
  }).join("");
  const cleaned = noControlChars
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const capped = cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned;
  return capped || "chart";
}
