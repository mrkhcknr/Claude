/**
 * Keeps contact details out of the seating chart. Imported files are filtered as soon as they are
 * parsed: columns that hold emails, phone numbers, addresses and similar are dropped entirely, and
 * any such details typed into free-text fields (notes, names, meals…) are blanked out.
 */

/** Column headers that are always dropped. */
const PII_HEADER =
  /e-?mail|phone|mobile|\bcell(ular)?\b|\btel\b|telephone|\bfax\b|whats ?app|address|street|\bapt\b|^(city|town|state|province|region|county|country)\b|state ?\/ ?region|\bzip\b|postal|post ?code|envelope|mailing|birth|\bdob\b|\bssn\b|social security|passport|licen[cs]e|instagram|facebook|twitter|tiktok|linkedin|website|\burl\b|venmo|paypal|card ?number|\biban\b/i;

export const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// 7+ digits, allowing spaces, dots, dashes, brackets and a leading +
// standalone only, so IDs like 01309169-a176-… are left alone
export const PHONE = /(?<![\w-])(?:\+?\d[\s().-]*){7,}\d(?![\w-])/g;
// "123 Main St", "4013 W Sunset Blvd", "PO Box 12"
export const STREET =
  /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Za-z0-9.'-]+\s+){0,4}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|ter|terrace|pkwy|parkway|hwy|highway|cir|circle|sq|square)\b\.?|\bp\.?\s?o\.?\s+box\s+\d+/gi;
const ZIP_ONLY = /^\d{5}(-\d{4})?$/;

const looksPII = (v: string) => {
  const s = v.trim();
  if (!s) return false;
  EMAIL.lastIndex = PHONE.lastIndex = STREET.lastIndex = 0;
  return EMAIL.test(s) || PHONE.test(s) || STREET.test(s) || ZIP_ONLY.test(s);
};

/** Blank out emails, phone numbers and street addresses inside free text. */
export function scrubText(s: string): string {
  if (!s) return s;
  return s
    .replace(EMAIL, '')
    .replace(STREET, '')
    .replace(PHONE, (m) => (/^\d{4}$/.test(m.trim()) ? m : ''))
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:|·-]+|[\s,;:|·-]+$/g, '')
    .trim();
}

export interface Stripped {
  headers: string[];
  rows: Record<string, string>[];
  /** Columns that were dropped, with the reason. */
  removed: { header: string; why: string }[];
}

/**
 * Drop contact-detail columns from parsed rows. A column goes if its header names contact data,
 * or if at least 30% of its filled cells look like emails, phones, street addresses or ZIP codes.
 */
export function stripPII(headers: string[], rows: Record<string, string>[]): Stripped {
  const removed: Stripped['removed'] = [];
  const keep: string[] = [];
  for (const h of headers) {
    if (PII_HEADER.test(h)) {
      removed.push({ header: h, why: 'contact or personal details' });
      continue;
    }
    const vals = rows.map((r) => (r[h] ?? '').toString()).filter((v) => v.trim());
    const hits = vals.filter(looksPII).length;
    if (vals.length && hits / vals.length >= 0.3) {
      removed.push({ header: h, why: 'values look like emails, phones or addresses' });
      continue;
    }
    keep.push(h);
  }
  const out = rows.map((r) => {
    const o: Record<string, string> = {};
    for (const h of keep) o[h] = scrubText((r[h] ?? '').toString());
    return o;
  });
  return { headers: keep, rows: out, removed };
}
