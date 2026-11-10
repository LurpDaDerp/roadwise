/**
 * Emergency contacts: up to 5 people the driver can call from the driving screen's emergency
 * panel, each a name and a phone number. Stored only on this phone, under `emergency.contacts`,
 * like the saved places; a sign-out removes them.
 */
import type { SettingsRepo } from '@/data/db/settings';

export const EMERGENCY_CONTACTS_KEY = 'emergency.contacts';

export const MAX_CONTACTS = 5;
export const CONTACT_NAME_MAX = 20;
/** Digits in a number, after the leading + (E.164 allows 15). */
export const PHONE_DIGITS_MIN = 3;
export const PHONE_DIGITS_MAX = 15;

/** The number the panel's first button always calls. */
export const EMERGENCY_NUMBER = '911';

export interface EmergencyContact {
  /** `contact-…`. */
  id: string;
  /** What the driver calls them: "Mom", "Coach Lee". */
  name: string;
  /** As typed, cleaned to digits with an optional leading + and any extension after a pause, e.g. "+15551234567", "5551234567" or "5551234567,89". */
  phone: string;
}

export type ContactProblem = 'name_empty' | 'name_long' | 'phone' | 'too_many';

/** An extension written out after the number ("x89", "ext. 89"), up to its first digit. */
const EXTENSION_MARKER = /(\d)[\s.-]*(?:extension|ext\.?|x)[\s.:-]*(?=\d)/gi;

/**
 * The number as the dialer takes it: digits, a leading +, and the keypad's pause (,) and wait (;)
 * before an extension, everything else dropped. An extension written out ("x89", "ext. 89") becomes
 * a pause, so its digits are not dialed as part of the number. iOS ignores tel: links with * or #.
 */
export function cleanPhone(raw: string): string {
  const trimmed = raw.trim();
  const dialed = trimmed
    .replace(EXTENSION_MARKER, '$1,')
    .replace(/[^\d,;]/g, '')
    .replace(/^[,;]+|[,;]+$/g, '');
  return trimmed.startsWith('+') ? `+${dialed}` : dialed;
}

/** The cleaned number split at its first pause or wait: the number itself and the extension part. */
function splitPhone(clean: string): { main: string; extension: string } {
  const at = clean.search(/[,;]/);
  return at === -1 ? { main: clean, extension: '' } : { main: clean.slice(0, at), extension: clean.slice(at) };
}

/** What is wrong with one contact, or null. */
export function contactProblem(c: Pick<EmergencyContact, 'name' | 'phone'>): ContactProblem | null {
  const name = c.name.trim();
  if (name.length === 0) return 'name_empty';
  if (name.length > CONTACT_NAME_MAX) return 'name_long';
  // The 3 to 15 digits are the number's own; an extension's digits don't count.
  const digits = splitPhone(cleanPhone(c.phone)).main.replace('+', '').length;
  if (digits < PHONE_DIGITS_MIN || digits > PHONE_DIGITS_MAX) return 'phone';
  return null;
}

function isContact(v: unknown): v is EmergencyContact {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    typeof c.phone === 'string' &&
    contactProblem({ name: c.name, phone: c.phone }) === null
  );
}

/** The stored contacts in the order added; anything malformed and anything past the cap is skipped. */
export async function readContacts(settings: Pick<SettingsRepo, 'get'>): Promise<EmergencyContact[]> {
  const raw = await settings.get<unknown>(EMERGENCY_CONTACTS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isContact).slice(0, MAX_CONTACTS).map((c) => ({ id: c.id, name: c.name, phone: c.phone }));
}

/** What is wrong with the whole list, or null. */
export function contactsProblem(contacts: readonly EmergencyContact[]): ContactProblem | null {
  if (contacts.length > MAX_CONTACTS) return 'too_many';
  for (const c of contacts) {
    const problem = contactProblem(c);
    if (problem) return problem;
  }
  return null;
}

/** Saves the list, names trimmed and numbers cleaned. Rejects (writing nothing) when it breaks a rule. */
export async function writeContacts(settings: Pick<SettingsRepo, 'set'>, contacts: readonly EmergencyContact[]): Promise<void> {
  const problem = contactsProblem(contacts);
  if (problem) throw new Error(`emergency: ${problem}`);
  await settings.set(
    EMERGENCY_CONTACTS_KEY,
    contacts.map((c) => ({ id: c.id, name: c.name.trim(), phone: cleanPhone(c.phone) }))
  );
}

/** The list with `contact` in it: replacing the one with its id, or added at the end. */
export function withContact(contacts: readonly EmergencyContact[], contact: EmergencyContact): EmergencyContact[] {
  return contacts.some((c) => c.id === contact.id)
    ? contacts.map((c) => (c.id === contact.id ? contact : c))
    : [...contacts, contact];
}

/** A new contact id. */
export function newContactId(now: number = Date.now()): string {
  return `contact-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The dialer link for a number (cleaned first). */
export const telUrl = (phone: string): string => `tel:${cleanPhone(phone)}`;

/**
 * A number laid out for reading, its digits as stored: 10 digits as "(555) 123-4567", +1 and 10
 * digits as "+1 (555) 123-4567", 1 and 10 digits as "1 (555) 123-4567", 7 digits as "123-4567";
 * anything else as it is stored. An extension follows as stored: "(555) 123-4567,89".
 */
export function formatPhone(phone: string): string {
  const { main: clean, extension } = splitPhone(cleanPhone(phone));
  const digits = clean.replace('+', '');
  const us = (d: string) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (!clean.startsWith('+') && digits.length === 10) return us(digits) + extension;
  if (digits.length === 11 && digits.startsWith('1')) return `${clean.startsWith('+') ? '+' : ''}1 ${us(digits.slice(1))}${extension}`;
  if (!clean.startsWith('+') && digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}${extension}`;
  return clean + extension;
}
