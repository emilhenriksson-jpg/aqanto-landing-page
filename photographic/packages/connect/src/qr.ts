/**
 * The laptop-to-phone bridge.
 *
 * Claude has to be connected from web or desktop, but most people then use it on their
 * phone. Rather than explaining that, we put a QR code on the connect screen: scan it,
 * finish on the phone, done.
 */

import QRCode from 'qrcode';

export interface QrOptions {
  /** Pixel width. 240 is large enough to scan from a laptop screen at arm's length. */
  width?: number;
  dark?: string;
  light?: string;
}

/** PNG data URL, safe to drop straight into an `img` tag. */
export async function qrDataUrl(url: string, options: QrOptions = {}): Promise<string> {
  return QRCode.toDataURL(url, {
    width: options.width ?? 240,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: {
      dark: options.dark ?? '#111111',
      light: options.light ?? '#ffffff',
    },
  });
}

/** SVG, for when the page needs it to scale or to survive a print stylesheet. */
export async function qrSvg(url: string, options: QrOptions = {}): Promise<string> {
  return QRCode.toString(url, {
    type: 'svg',
    width: options.width ?? 240,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: {
      dark: options.dark ?? '#111111',
      light: options.light ?? '#ffffff',
    },
  });
}

/**
 * The URL the code points at. Carries the client so the phone opens on the right card,
 * and a handoff id so the desktop page can notice when the phone finishes.
 */
export function connectHandoffUrl(input: {
  connectPageUrl: string;
  clientId?: string;
  handoffId?: string;
}): string {
  const url = new URL(input.connectPageUrl);
  if (input.clientId) url.searchParams.set('client', input.clientId);
  if (input.handoffId) url.searchParams.set('handoff', input.handoffId);
  return url.toString();
}
