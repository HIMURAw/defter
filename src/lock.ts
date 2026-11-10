// Private notebooks: the whole notebook is encrypted with AES-GCM. A random
// notebook key encrypts the text; that key is stored twice, wrapped once with
// the password and once with a recovery key shown when the lock is set up.
// Forgetting the password is not the end: the recovery key sets a new one.
// Uses only WebCrypto, so it runs in Obsidian and in Node tests alike.

export const LOCK_KEY = "defter-lock";
const OPEN = "<!-- defter:locked";
const CLOSE = "-->";
const ITERATIONS = 600_000;
/** Iteration counts read from a file are kept in a sane range (a huge one would freeze Obsidian). */
const MIN_ITER = 1_000;
const MAX_ITER = 5_000_000;

interface Wrapped {
  salt: string;
  iv: string;
  ct: string;
}

export interface LockedData {
  v: 1;
  /** Notebook key wrapped with the password. */
  wp: Wrapped;
  /** Notebook key wrapped with the recovery key. */
  wr: Wrapped;
  iv: string;
  ct: string;
  hint?: string;
  iter: number;
}

/** What an open private notebook keeps in memory while unlocked. */
export interface LockSession {
  key: Uint8Array;
  data: LockedData;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function deriveKey(secret: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", enc.encode(secret.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function wrap(secret: string, key: Uint8Array<ArrayBuffer>, iter: number): Promise<Wrapped> {
  const salt = random(16);
  const iv = random(12);
  const k = await deriveKey(secret, salt, iter);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, k, key));
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

async function unwrap(secret: string, w: Wrapped, iter: number): Promise<Uint8Array<ArrayBuffer>> {
  const k = await deriveKey(secret, unb64(w.salt), iter);
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: unb64(w.iv) }, k, unb64(w.ct)));
  } catch {
    throw new WrongSecretError();
  }
}

export class WrongSecretError extends Error {
  constructor() {
    super("Wrong password or recovery key.");
  }
}

/** A recovery key: 24 easy-to-read characters (120 bits), in groups of four. */
export function newRecoveryKey(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U
  const bytes = random(24);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s.match(/.{4}/g)!.join("-");
}

/** Recovery keys are accepted with any case, spaces or dashes. */
export const normalizeRecovery = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function encryptText(key: Uint8Array<ArrayBuffer>, text: string): Promise<{ iv: string; ct: string }> {
  const iv = random(12);
  const k = await subtle().importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, k, enc.encode(text)));
  return { iv: b64(iv), ct: b64(ct) };
}

async function decryptText(key: Uint8Array<ArrayBuffer>, data: LockedData): Promise<string> {
  const k = await subtle().importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  try {
    return dec.decode(await subtle().decrypt({ name: "AES-GCM", iv: unb64(data.iv) }, k, unb64(data.ct)));
  } catch {
    throw new Error("The private notebook is damaged and cannot be decrypted.");
  }
}

/** Sets up a lock. The recovery key is returned once; it is never stored. */
export async function createLock(password: string, hint?: string, iter = ITERATIONS): Promise<{ session: LockSession; recovery: string }> {
  const key = random(32);
  const recovery = newRecoveryKey();
  const data: LockedData = {
    v: 1,
    iter,
    wp: await wrap(password, key, iter),
    wr: await wrap(normalizeRecovery(recovery), key, iter),
    iv: "",
    ct: "",
  };
  if (hint) data.hint = hint;
  return { session: { key, data }, recovery };
}

export async function unlockWithPassword(data: LockedData, password: string): Promise<{ session: LockSession; text: string }> {
  const key = await unwrap(password, data.wp, data.iter);
  return { session: { key, data }, text: await decryptText(key, data) };
}

export async function unlockWithRecovery(data: LockedData, recovery: string): Promise<{ session: LockSession; text: string }> {
  const key = await unwrap(normalizeRecovery(recovery), data.wr, data.iter);
  return { session: { key, data }, text: await decryptText(key, data) };
}

/** New password: only the wrapped key changes, the notebook stays as it is. */
export async function changePassword(session: LockSession, password: string, hint?: string): Promise<void> {
  session.data.wp = await wrap(password, session.key as Uint8Array<ArrayBuffer>, session.data.iter);
  if (hint) session.data.hint = hint;
  else delete session.data.hint;
}

/** A new recovery key replaces the old one (the old one stops working). */
export async function renewRecovery(session: LockSession): Promise<string> {
  const recovery = newRecoveryKey();
  session.data.wr = await wrap(normalizeRecovery(recovery), session.key as Uint8Array<ArrayBuffer>, session.data.iter);
  return recovery;
}

// ---- File layout -----------------------------------------------------------------

export function isLockedText(md: string): boolean {
  return md.includes("\n" + OPEN + "\n") || md.startsWith(OPEN + "\n");
}

/** Splits a locked file into its (plain) frontmatter and the locked block. */
export function parseLocked(md: string): { frontmatter: string; data: LockedData } {
  const text = md.replace(/\r\n/g, "\n");
  let frontmatter = "";
  let body = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      frontmatter = text.slice(4, end);
      body = text.slice(text.indexOf("\n", end + 4) + 1);
    }
  }
  const start = body.indexOf(OPEN);
  const close = body.indexOf("\n" + CLOSE, start);
  if (start === -1 || close === -1) throw new Error("The private notebook block is missing or not closed.");
  let data: LockedData;
  try {
    data = JSON.parse(body.slice(start + OPEN.length, close));
  } catch {
    throw new Error("The private notebook block is damaged.");
  }
  if (data?.v !== 1 || !data.wp || !data.wr || !data.ct) throw new Error("The private notebook block is damaged.");
  if (!Number.isInteger(data.iter) || data.iter < MIN_ITER || data.iter > MAX_ITER) throw new Error("The private notebook block is damaged.");
  return { frontmatter, data };
}

/** Encrypts the notebook text and lays out the file. */
export async function sealNotebook(session: LockSession, frontmatter: string, plain: string): Promise<string> {
  const { iv, ct } = await encryptText(session.key as Uint8Array<ArrayBuffer>, plain);
  session.data.iv = iv;
  session.data.ct = ct;
  let fm = frontmatter.replace(new RegExp(`^${LOCK_KEY}:.*\\n?`, "m"), "").replace(/\n$/, "");
  fm = fm ? `${fm}\n${LOCK_KEY}: v1` : `${LOCK_KEY}: v1`;
  const note =
    "This is a private Defter notebook. Its pages are encrypted; open it in Obsidian with the Defter plugin and enter the password.";
  return `---\n${fm}\n---\n\n${note}\n\n${OPEN}\n${JSON.stringify(session.data)}\n${CLOSE}\n`;
}

export async function openNotebookText(session: LockSession): Promise<string> {
  return decryptText(session.key as Uint8Array<ArrayBuffer>, session.data);
}
