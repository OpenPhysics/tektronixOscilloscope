/**
 * Handing a file to the browser. The only module in src/export that touches the DOM.
 *
 * Kept apart from csv.ts so the serialisers stay pure and testable; this half is
 * three lines of unavoidable anchor-clicking that no test can meaningfully cover.
 */

/** Trigger a save, then release the object URL on the next turn of the event loop. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately races the download in Safari and older Chrome; a turn
  // of the event loop is enough and costs nothing.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(text: string, filename: string, type = 'text/csv'): void {
  saveBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename);
}

/**
 * Save a canvas as a PNG.
 *
 * `toBlob` is used rather than `toDataURL` because a full-width plot encodes to
 * a few megabytes, and a data URL that size is slow to build and can exceed what
 * the anchor will accept.
 */
export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (blob) saveBlob(blob, filename);
  }, 'image/png');
}

export function downloadBytes(bytes: Uint8Array, filename: string, type: string): void {
  saveBlob(new Blob([bytes as BlobPart], { type }), filename);
}
