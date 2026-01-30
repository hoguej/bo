/**
 * Central phone number normalization and format conversion.
 * - Store and compare using canonical form (10-digit US: "7407777090").
 * - Convert to E.164 ("+17407777090") or 11-digit ("17407777090") when talking to other systems.
 */

/** Non-digit characters stripped for parsing. */
function digitsOnly(s: string): string {
  return (s ?? "").replace(/\D/g, "");
}

/**
 * Normalize any phone input to canonical form for storage and comparison.
 * - "7407777090" | "17407777090" | "+17407777090" | "(740) 777-7090" → "7407777090"
 * - "default" or empty → "default" (passthrough for non-phone owners)
 * - Other non-numeric or short strings → returned as digits only (may be empty or short)
 */
export function canonicalPhone(s: string): string {
  const trimmed = (s ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return "default";
  const digits = digitsOnly(trimmed);
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/**
 * Convert canonical (10-digit) to E.164 for iMessage / APIs: "+17407777090".
 * If input is not 10 digits, returns it with + prefix if it looks like a number.
 */
export function toE164(phone: string): string {
  const canonical = canonicalPhone(phone);
  if (canonical === "default" || canonical.length < 10) return phone; // passthrough
  if (canonical.length === 10) return `+1${canonical}`;
  if (canonical.length === 11 && canonical.startsWith("1")) return `+${canonical}`;
  return phone.startsWith("+") ? phone : `+${phone}`;
}

/**
 * Convert canonical to 11-digit US form: "17407777090".
 */
export function to11Digit(phone: string): string {
  const canonical = canonicalPhone(phone);
  if (canonical === "default" || canonical.length < 10) return phone;
  if (canonical.length === 10) return `1${canonical}`;
  return canonical.length === 11 && canonical.startsWith("1") ? canonical : `1${canonical}`;
}

/** True if string is a 10-digit US number (after normalization). */
export function isUs10Digit(phone: string): boolean {
  const c = canonicalPhone(phone);
  return c !== "default" && c.length === 10 && /^\d{10}$/.test(c);
}
