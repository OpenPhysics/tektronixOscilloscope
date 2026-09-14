/**
 * The on-screen record of everything exchanged with the instrument.
 *
 * Capped, because a live measurement poll produces a few rows a second and an
 * unbounded log would eventually be the largest thing on the page.
 */

export type LogKind = 'tx' | 'rx' | 'info' | 'error';

const MAX_ROWS = 300;

export class CommandLog {
  readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  add(kind: LogKind, text: string): void {
    const row = document.createElement('div');
    row.className = `log-row log-${kind}`;

    const marker = document.createElement('span');
    marker.className = 'log-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = { tx: '>', rx: '<', info: 'i', error: '!' }[kind];

    const body = document.createElement('span');
    body.className = 'log-text';
    body.textContent = text;

    row.append(marker, body);
    this.root.append(row);

    while (this.root.childElementCount > MAX_ROWS) {
      this.root.firstElementChild?.remove();
    }
    // Follow the tail, which is where anything interesting just happened.
    this.root.scrollTop = this.root.scrollHeight;
  }

  clear(): void {
    this.root.replaceChildren();
  }
}
