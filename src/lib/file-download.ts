// ─────────────────────────────────────────────────────────────────────────────
// File-download helpers — pure browser-side blob → anchor → click utility.
//
// Centralises the "create anchor, click it, revoke the URL" ritual so each
// caller doesn't reinvent it. Pure function — no React, no closures over
// app state — so it imports cleanly into any client component.
// ─────────────────────────────────────────────────────────────────────────────

/** Trigger a browser file-save for an in-memory Blob. */
export function downloadBlobAs(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
