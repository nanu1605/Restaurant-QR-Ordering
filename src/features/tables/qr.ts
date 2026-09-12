import QRCode from 'qrcode';

/** What a table's QR code opens (spec §8.3). */
export function tableUrl(appUrl: string, qrToken: string): string {
  return `${appUrl.replace(/\/$/, '')}/t/${qrToken}`;
}

// Medium error correction survives scuffs and lamination glare; tokens are short.
const OPTIONS = { errorCorrectionLevel: 'M', margin: 2 } as const;

/** PNG for downloading one table's code. */
export function qrPng(url: string, width = 1024): Promise<Buffer> {
  return QRCode.toBuffer(url, { ...OPTIONS, type: 'png', width });
}

/** Inline SVG for the printable cards (sharp at any print size). */
export function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { ...OPTIONS, type: 'svg' });
}

/** Codes pointing at a developer machine won't work on customers' phones. */
export function isLocalAppUrl(appUrl: string): boolean {
  try {
    const { hostname } = new URL(appUrl);
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      /^127\./.test(hostname) ||
      /^(10|192\.168)\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return true;
  }
}

/** Safe file name for a download, e.g. "table-terrace-2-qr.png". */
export function qrFileName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `table-${slug || 'qr'}-qr.png`;
}
