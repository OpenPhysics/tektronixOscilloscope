/**
 * Engineering notation for the UI. Pure, no DOM.
 *
 * Everything in the state is stored in SI base units, which is right for the
 * protocol and unreadable on screen - nobody wants to see a timebase of
 * 0.0000005 s/div. Converting in exactly one place keeps unit bugs out of
 * src/device, where they would corrupt measurements rather than merely look odd.
 */

/** Smallest prefix, used for anything below a picounit rather than giving up. */
const SMALLEST = { exponent: -12, symbol: 'p' } as const;

const PREFIXES = [
  { exponent: 9, symbol: 'G' },
  { exponent: 6, symbol: 'M' },
  { exponent: 3, symbol: 'k' },
  { exponent: 0, symbol: '' },
  { exponent: -3, symbol: 'm' },
  { exponent: -6, symbol: 'u' },
  { exponent: -9, symbol: 'n' },
  SMALLEST,
] as const;

/**
 * Format a value with an SI prefix, e.g. 5e-7 -> "500 ns".
 *
 * The micro prefix is written 'u' rather than the correct Greek mu: the same
 * strings go into CSV headers and filenames, where a non-ASCII character is a
 * portability problem in a teaching lab full of mixed machines.
 */
export function formatEngineering(value: number, unit: string, digits = 3): string {
  if (!Number.isFinite(value)) return `- ${unit}`;
  if (value === 0) return `0 ${unit}`;

  const magnitude = Math.abs(value);
  const chosen =
    PREFIXES.find((prefix) => magnitude >= 10 ** prefix.exponent) ?? SMALLEST;

  const scaled = value / 10 ** chosen.exponent;
  // Trim trailing zeros so "1.00 kHz" reads as "1 kHz", but keep real precision.
  const text = Number(scaled.toPrecision(digits)).toString();
  return `${text} ${chosen.symbol}${unit}`;
}

/** A timestamp safe to drop into a filename on any platform. */
export function timestampForFilename(when: number): string {
  const date = new Date(when);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
