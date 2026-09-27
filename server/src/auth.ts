import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config, ROOT } from "./config.js";

// Sign-in with email + password (Walt 9/26: "just have them sign up with email").
// Passwords are stored as scrypt hashes. A session is a signed token the web app
// and the side panel send as a bearer token; nothing about it is stored.

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const COMPANY_DOMAIN = "westgatesupply.com";
const SESSION_DAYS = 30;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
export const isCompanyEmail = (e: string) => new RegExp(`^[^@\\s]+@${COMPANY_DOMAIN.replace(".", "\\.")}$`).test(e);

export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That password is too long.";
  return null;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length);
  return timingSafeEqual(want, got);
}

// The signing key: SESSION_SECRET when hosted; locally, a random one kept in .cache.
let secret: Buffer | null = null;
function key(): Buffer {
  if (secret) return secret;
  if (config.sessionSecret) return (secret = Buffer.from(config.sessionSecret));
  if (config.supabaseUrl) throw new Error("SESSION_SECRET must be set when hosted.");
  const file = path.join(ROOT, ".cache", "session-secret");
  try {
    secret = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  } catch {
    secret = randomBytes(32);
    if (!config.demo && config.storeFile) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, secret.toString("hex"), { mode: 0o600 });
    }
  }
  return secret;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (body: string) => createHmac("sha256", key()).update(body).digest("base64url");

export function issueSession(email: string, now = Date.now()): string {
  const body = b64(JSON.stringify({ e: email, x: now + SESSION_DAYS * 86400000 }));
  return `s1.${body}.${sign(body)}`;
}

/** The email a session token belongs to, or null if it's forged or expired. */
export function readSession(token: string, now = Date.now()): string | null {
  const [v, body, mac] = token.split(".");
  if (v !== "s1" || !body || !mac) return null;
  const want = sign(body);
  if (want.length !== mac.length || !timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(body, "base64url").toString()) as { e: string; x: number };
    return typeof e === "string" && x > now ? e : null;
  } catch {
    return null;
  }
}

// Slow down password guessing: 8 wrong tries per email per 15 minutes.
const tries = new Map<string, { n: number; since: number }>();
export function tooManyTries(email: string): boolean {
  const t = tries.get(email);
  return !!t && Date.now() - t.since < 15 * 60 * 1000 && t.n >= 8;
}
export function recordTry(email: string, ok: boolean) {
  if (ok) return void tries.delete(email);
  const t = tries.get(email);
  if (!t || Date.now() - t.since > 15 * 60 * 1000) tries.set(email, { n: 1, since: Date.now() });
  else t.n++;
}
