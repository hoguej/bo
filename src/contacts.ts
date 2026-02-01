import { dbGetContactsList, dbGetContactsNameToNumber, dbGetContactsNumberToName } from "./db";

/** Load contacts from DB (users table). Returns number → name for display (proper casing). */
export async function getNumberToName(): Promise<Map<string, string>> {
  return await dbGetContactsNumberToName();
}

/** List of contacts with display names in proper casing (e.g. "Cara Hogue") for prompts and UI. */
export async function getContactsList(): Promise<Array<{ name: string; number: string }>> {
  return await dbGetContactsList();
}

/** Load contacts from DB (users table). Returns name (lowercase) → canonical 10-digit number for send_to_contact. */
export async function getNameToNumber(): Promise<Map<string, string>> {
  return await dbGetContactsNameToNumber();
}

/** Resolve a contact name (e.g. "Cara" or "Cara Hogue") to canonical 10-digit number. Case-insensitive. Tries exact full-name match, then first-name match (contact's first name must equal input first word exactly—so "Cara" matches "Cara Hogue" but not "Carrie"). */
export async function resolveContactToNumber(contactName: string): Promise<string | undefined> {
  const nameToNumber = await dbGetContactsNameToNumber();
  const trimmed = contactName.trim();
  if (!trimmed) return undefined;
  const exact = nameToNumber.get(trimmed.toLowerCase());
  if (exact) return exact;
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase();
  if (!firstWord) return undefined;
  for (const [name, num] of nameToNumber) {
    const contactFirstName = name.split(/\s+/)[0];
    if (contactFirstName === firstWord) return num;
  }
  return undefined;
}
