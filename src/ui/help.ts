/**
 * The "Need help connecting?" dialog.
 *
 * An empty device chooser is the single most common way this page fails, and it
 * fails silently: WebUSB reports a chooser nobody picked from exactly the same
 * way it reports one that had nothing in it, so the page cannot tell the student
 * which happened. The remedy is to make the answer reachable rather than to
 * guess.
 *
 * Three of the four platforms need nothing at all, so showing one set of
 * instructions to everybody buries the one audience with real work to do. The
 * dialog opens on the reader's own operating system and keeps the rest a click
 * away.
 */

export type Platform = 'windows' | 'macos' | 'chromeos' | 'linux' | 'other';

export interface PlatformHints {
  /** `navigator.userAgentData.platform`, where the browser offers it. */
  uaPlatform?: string | undefined;
  /** `navigator.userAgent`, the fallback for browsers that do not. */
  userAgent?: string | undefined;
}

function classify(text: string): Platform | null {
  const value = text.toLowerCase();
  // ChromeOS and Android are both tested before Linux, because a Chromebook's
  // user agent carries an X11 token and Android's carries "Linux" outright -
  // the Linux test below would swallow either one given the chance.
  if (value.includes('cros') || value.includes('chrome os')) return 'chromeos';
  if (value.includes('android')) return 'other';
  if (value.includes('win')) return 'windows';
  if (value.includes('mac')) return 'macos';
  if (value.includes('linux') || value.includes('x11')) return 'linux';
  return null;
}

/**
 * Work out which set of instructions to open on.
 *
 * Takes its inputs rather than reading `navigator`, so the interesting cases -
 * a Chromebook claiming X11, an Android device claiming Linux - are testable
 * without a browser.
 */
export function detectPlatform(hints: PlatformHints): Platform {
  const fromUaData = hints.uaPlatform ? classify(hints.uaPlatform) : null;
  if (fromUaData) return fromUaData;
  const fromUserAgent = hints.userAgent ? classify(hints.userAgent) : null;
  return fromUserAgent ?? 'other';
}

/** `navigator.userAgentData` is Chromium-only and absent from the DOM types. */
interface UserAgentDataCarrier {
  userAgentData?: { platform?: string };
}

export function currentPlatform(): Platform {
  const carrier = navigator as Navigator & UserAgentDataCarrier;
  return detectPlatform({
    uaPlatform: carrier.userAgentData?.platform,
    userAgent: navigator.userAgent,
  });
}

export class HelpDialog {
  private readonly tabs: HTMLButtonElement[];
  private readonly panels: HTMLElement[];

  constructor(private readonly dialog: HTMLDialogElement) {
    this.tabs = [...dialog.querySelectorAll<HTMLButtonElement>('[data-platform]')];
    this.panels = [...dialog.querySelectorAll<HTMLElement>('[data-platform-panel]')];

    for (const tab of this.tabs) {
      tab.addEventListener('click', () => {
        const platform = tab.dataset['platform'];
        if (platform) this.select(platform);
      });
    }
  }

  /** Show the dialog with `platform`'s section already open. */
  open(platform: Platform): void {
    this.select(platform);
    this.dialog.showModal();
  }

  private select(platform: string): void {
    // 'other' has no section of its own. Windows is the only platform with real
    // work in it, so an unrecognised system lands there rather than on a blank
    // panel - being told about a driver you did not need beats being told
    // nothing at all.
    const known = this.panels.some((panel) => panel.dataset['platformPanel'] === platform);
    const wanted = known ? platform : 'windows';

    for (const tab of this.tabs) {
      const active = tab.dataset['platform'] === wanted;
      tab.setAttribute('aria-selected', String(active));
      tab.classList.toggle('is-active', active);
    }
    for (const panel of this.panels) {
      panel.hidden = panel.dataset['platformPanel'] !== wanted;
    }
  }
}
