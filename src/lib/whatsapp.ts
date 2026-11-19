export interface CountryCodeOption {
  code: string;
  country: string;
  iso: string;
}

export const COUNTRY_CODES: CountryCodeOption[] = [
  { code: '52', country: 'México', iso: 'MX' },
  { code: '34', country: 'España', iso: 'ES' },
  { code: '57', country: 'Colombia', iso: 'CO' },
  { code: '54', country: 'Argentina', iso: 'AR' },
  { code: '56', country: 'Chile', iso: 'CL' },
  { code: '51', country: 'Perú', iso: 'PE' },
  { code: '1', country: 'EE. UU. / Canadá', iso: 'US' },
  { code: '58', country: 'Venezuela', iso: 'VE' },
  { code: '593', country: 'Ecuador', iso: 'EC' },
  { code: '502', country: 'Guatemala', iso: 'GT' },
  { code: '506', country: 'Costa Rica', iso: 'CR' },
  { code: '507', country: 'Panamá', iso: 'PA' },
  { code: '591', country: 'Bolivia', iso: 'BO' },
  { code: '595', country: 'Paraguay', iso: 'PY' },
  { code: '598', country: 'Uruguay', iso: 'UY' },
  { code: '503', country: 'El Salvador', iso: 'SV' },
  { code: '504', country: 'Honduras', iso: 'HN' },
  { code: '505', country: 'Nicaragua', iso: 'NI' },
  { code: '1809', country: 'Rep. Dominicana', iso: 'DO' },
  { code: '55', country: 'Brasil', iso: 'BR' },
];

const WORKSPACE_STORAGE_KEY = 'enlaceflow_workspace_id';

export function isValidWorkspaceId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{16,64}$/.test(id);
}

export function getOrCreateWorkspaceId(): string {
  try {
    const existing = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (existing && isValidWorkspaceId(existing)) {
      return existing;
    }
    const created = `ws_${generateShortCode(22)}`;
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, created);
    return created;
  } catch {
    return `ws_${generateShortCode(22)}`;
  }
}

export function saveWorkspaceId(id: string): boolean {
  const trimmed = id.trim();
  if (!isValidWorkspaceId(trimmed)) return false;
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, trimmed);
  } catch {
    // ignore storage quota errors
  }
  return true;
}

export function sanitizeDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export function buildWhatsAppUrl(countryCode: string, phone: string, message: string): string {
  const cleanCode = sanitizeDigits(countryCode);
  const cleanPhone = sanitizeDigits(phone);
  const fullNumber = `${cleanCode}${cleanPhone}`;
  if (!fullNumber) return '';
  const trimmedMsg = message.trim();
  if (!trimmedMsg) {
    return `https://wa.me/${fullNumber}`;
  }
  return `https://wa.me/${fullNumber}?text=${encodeURIComponent(trimmedMsg)}`;
}

export function generateShortCode(length = 6): string {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

export function isValidShortCode(code: string): boolean {
  return /^[a-zA-Z0-9_-]{3,32}$/.test(code);
}

export function detectClientTelemetry(): {
  deviceType: 'mobile' | 'desktop' | 'tablet';
  browser: string;
  os: string;
  referrer: string;
} {
  const ua = navigator.userAgent || '';
  const lower = ua.toLowerCase();

  let deviceType: 'mobile' | 'desktop' | 'tablet' = 'desktop';
  if (/ipad|tablet|playbook|silk|(android(?!.*mobi))/i.test(ua)) {
    deviceType = 'tablet';
  } else if (/mobile|iphone|ipod|android.*mobile|blackberry|iemobile|opera mini/i.test(lower)) {
    deviceType = 'mobile';
  }

  let browser = 'Navegador';
  if (lower.includes('whatsapp')) browser = 'WhatsApp WebView';
  else if (lower.includes('instagram')) browser = 'Instagram App';
  else if (lower.includes('fban') || lower.includes('fbav')) browser = 'Facebook App';
  else if (lower.includes('edg/')) browser = 'Microsoft Edge';
  else if (lower.includes('opr/') || lower.includes('opera')) browser = 'Opera';
  else if (lower.includes('chrome') && !lower.includes('edg')) browser = 'Google Chrome';
  else if (lower.includes('safari') && !lower.includes('chrome')) browser = 'Safari';
  else if (lower.includes('firefox')) browser = 'Firefox';

  let os = 'Otro';
  if (lower.includes('iphone') || lower.includes('ipad') || lower.includes('ios')) os = 'iOS';
  else if (lower.includes('android')) os = 'Android';
  else if (lower.includes('windows')) os = 'Windows';
  else if (lower.includes('mac os') || lower.includes('macintosh')) os = 'macOS';
  else if (lower.includes('linux')) os = 'Linux';

  let referrer = 'Directo';
  try {
    if (document.referrer) {
      const refUrl = new URL(document.referrer);
      referrer = refUrl.hostname.slice(0, 100) || 'Directo';
    }
  } catch {
    referrer = 'Directo';
  }

  return { deviceType, browser, os, referrer };
}

export interface FormattedSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}

export function parseWhatsAppFormatting(input: string): FormattedSegment[] {
  if (!input) return [];
  const regex = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;
  const parts: FormattedSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: input.slice(lastIndex, match.index) });
    }
    const token = match[0];
    const inner = token.slice(1, -1);
    if (token.startsWith('*')) parts.push({ text: inner, bold: true });
    else if (token.startsWith('_')) parts.push({ text: inner, italic: true });
    else if (token.startsWith('~')) parts.push({ text: inner, strike: true });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < input.length) {
    parts.push({ text: input.slice(lastIndex) });
  }
  return parts;
}
