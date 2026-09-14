/**
 * Displaying the oscilloscope's own screen.
 *
 * `HARDCopy STARt` sends whatever image format SAVe:IMAGe:FILEFormat was last
 * set to. Rather than trusting the format we asked for, the bytes are sniffed:
 * firmware that does not support a format sometimes answers in its default one
 * instead of raising an error, and a mislabelled blob renders as a broken image
 * with no explanation.
 *
 * No decoder is needed here. Chrome and Edge decode BMP and JPEG natively as
 * well as PNG, which covers everything this instrument is known to emit.
 */

export interface SniffedImage {
  mimeType: string;
  extension: string;
}

/**
 * Identify an image by its magic bytes.
 *
 * Returns null for a format browsers cannot display - PCX and TIFF, both of
 * which the TBS1000B manual lists - so the caller can say so plainly rather than
 * showing an empty frame.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const starts = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47)) return { mimeType: 'image/png', extension: 'png' };
  if (starts(0xff, 0xd8, 0xff)) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (starts(0x42, 0x4d)) return { mimeType: 'image/bmp', extension: 'bmp' };
  if (starts(0x0a)) return null; // PCX
  if (starts(0x49, 0x49, 0x2a) || starts(0x4d, 0x4d, 0x00)) return null; // TIFF
  return null;
}

export class ScreenshotView {
  readonly root: HTMLElement;
  private readonly image: HTMLImageElement;
  private readonly note: HTMLElement;
  private objectUrl: string | null = null;
  private current: { bytes: Uint8Array; extension: string } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.image = document.createElement('img');
    this.image.className = 'screenshot-image';
    this.image.alt = 'Captured oscilloscope screen';
    this.image.hidden = true;

    this.note = document.createElement('p');
    this.note.className = 'section-note';
    this.note.textContent = 'No screen captured yet.';

    root.append(this.image, this.note);
  }

  /** True once there is an image worth saving. */
  get hasImage(): boolean {
    return this.current !== null;
  }

  get extension(): string {
    return this.current?.extension ?? 'png';
  }

  get bytes(): Uint8Array | null {
    return this.current?.bytes ?? null;
  }

  show(bytes: Uint8Array): void {
    const sniffed = sniffImage(bytes);
    if (!sniffed) {
      this.setNote(
        'The instrument answered in a format the browser cannot display ' +
          '(PCX or TIFF). Choose PNG or BMP as the hardcopy format.',
      );
      return;
    }

    this.release();
    this.objectUrl = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: sniffed.mimeType }),
    );
    this.image.src = this.objectUrl;
    this.image.hidden = false;
    this.note.hidden = true;
    this.current = { bytes, extension: sniffed.extension };
  }

  private setNote(text: string): void {
    this.note.textContent = text;
    this.note.hidden = false;
    this.image.hidden = true;
  }

  /** Object URLs are not garbage collected; each new capture must free the last. */
  private release(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
