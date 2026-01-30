import { dbGetContactsNameToNumber, dbGetContactsNumberToName } from "./db";

/** Load contacts from DB (migrated from config/contacts.json). Returns number → name for display. */
export function getNumberToName(): Map<string, string> {
  return dbGetContactsNumberToName();
}

/** Load contacts from DB (migrated from config/contacts.json). Returns name (lowercase) → canonical 10-digit number for send_to_contact. */
export function getNameToNumber(): Map<string, string> {
  return dbGetContactsNameToNumber();
}
