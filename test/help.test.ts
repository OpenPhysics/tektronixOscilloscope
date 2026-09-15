/**
 * Which set of instructions the dialog opens on.
 *
 * The ordering inside `classify` is the whole point: a Chromebook and an Android
 * phone both advertise themselves in ways that match a naive Linux test, and
 * sending a Chromebook user to the Linux panel would tell them to write a udev
 * rule on a system that has no shell to write it from.
 */

import { describe, expect, it } from 'vitest';

import { detectPlatform } from '../src/ui/help.ts';

const CHROME_OS_UA =
  'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

describe('detectPlatform', () => {
  it('reads the userAgentData platform when the browser offers one', () => {
    expect(detectPlatform({ uaPlatform: 'Windows' })).toBe('windows');
    expect(detectPlatform({ uaPlatform: 'macOS' })).toBe('macos');
    expect(detectPlatform({ uaPlatform: 'Chrome OS' })).toBe('chromeos');
    expect(detectPlatform({ uaPlatform: 'Linux' })).toBe('linux');
  });

  it('falls back to the user agent string', () => {
    expect(detectPlatform({ userAgent: WINDOWS_UA })).toBe('windows');
    expect(detectPlatform({ userAgent: MAC_UA })).toBe('macos');
    expect(detectPlatform({ userAgent: LINUX_UA })).toBe('linux');
  });

  it('does not mistake a Chromebook for Linux, despite the X11 token', () => {
    expect(detectPlatform({ userAgent: CHROME_OS_UA })).toBe('chromeos');
    expect(detectPlatform({ uaPlatform: 'Chrome OS', userAgent: CHROME_OS_UA })).toBe('chromeos');
  });

  it('does not mistake Android for Linux, despite the Linux token', () => {
    expect(detectPlatform({ userAgent: ANDROID_UA })).not.toBe('linux');
  });

  it('prefers userAgentData over a user agent that disagrees', () => {
    // Chromium freezes the user agent string but keeps userAgentData accurate,
    // so where the two differ the structured one is the one to believe.
    expect(detectPlatform({ uaPlatform: 'Chrome OS', userAgent: LINUX_UA })).toBe('chromeos');
  });

  it('gives up rather than guessing when it recognises nothing', () => {
    expect(detectPlatform({})).toBe('other');
    expect(detectPlatform({ uaPlatform: '', userAgent: '' })).toBe('other');
    expect(detectPlatform({ userAgent: 'SomeFutureOS/1.0' })).toBe('other');
  });
});
