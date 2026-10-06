import { z } from "zod";
import type { Account } from "./accounts.js";
import type { Deps } from "./assistant.js";
import { config } from "./config.js";
import { untrusted } from "./claude.js";
import { store } from "./store.js";
import { fetchSitePages } from "./website.js";
import { askNext, heardLines, mergePurchasing, purchasingNote, tierFromPurchasing, type Purchasing } from "./purchasing.js";

/**
 * RFQ potential (Walt 10/5): how much PVF buying a company does at all, apart from how they're responding to us.
 * A fab shop that quotes every job is worth more calls than a one-off, even when both are cold.
 * Read once from their website, refreshed monthly; what the rep hears on the phone overrides it.
 */
export type CompanyType = "fab shop" | "mechanical contractor" | "plant" | "utility" | "EPC" | "other" | "unknown";
export type Tier = "steady" | "project" | "occasional" | "unknown";
export type RepSaid = "weekly" | "monthly" | "projects" | "contract-elsewhere";

export type Profile = {
  website: string | null;
  type: CompanyType;
  /** What they make or do, in their words ("ASME pressure vessels and skids"). */
  makes: string | null;
  /** Grades, pressures, service conditions their site names: duplex, Inconel, sour service, 2500#. */
  specs: string[];
  /** Stamps and certifications: ASME U, R, S; API; ISO 9001. */
  certs: string[];
  industries: string[];
  /** Every claim above points at a page and a date. */
  evidence: Array<{ fact: string; source: string; at: string }>;
  /** The purchasing cycle as heard on calls (transcript + the rep's confirmation); a [Purchasing] note in Close holds the record. */
  heard?: Purchasing | null;
  /** What the rep heard on the phone (stored as a Close note too); beats anything read from the site. */
  repSaid: RepSaid | null;
  repSaidAt: string | null;
  checkedAt: string | null;
  /** Why the read failed, when it did ("site didn't load"). */
  problem: string | null;
};

export type Potential = { tier: Tier; type: CompanyType; why: string[]; unknown: string | null; ask: { field: string; question: string } | null; profile: Profile };

const PROFILES_KEY = "profiles";
/** Re-read a site after this long. */
export const REFRESH_AFTER_DAYS = 30;
const DAY = 86_400_000;

export const TIER_LABEL: Record<Tier, string> = { steady: "Steady", project: "Project", occasional: "Occasional", unknown: "Unknown" };
/** How much a tier multiplies the account's place in line: a Steady account outranks an Occasional one at the same warmth. */
export const TIER_WEIGHT: Record<Tier, number> = { steady: 1.5, project: 1.2, occasional: 1, unknown: 1 };

/**
 * The tier rule (Walt 10/5): fab shops and mechanical contractors that name pressure or alloy work are Steady (they quote
 * job by job and shop every RFQ); plants, utilities and EPCs are Project (contracts day to day, floods at turnarounds);
 * everyone else Occasional until a fact says otherwise. The rep's own answer wins.
 */
export function tierFor(p: Pick<Profile, "type" | "specs" | "certs" | "repSaid"> & { heard?: Purchasing | null }): Tier {
  // What the buyer said on a call settles it before anything else.
  const heard = tierFromPurchasing(p.heard);
  if (heard) return heard;
  if (p.repSaid === "weekly" || p.repSaid === "monthly") return "steady";
  if (p.repSaid === "projects") return "project";
  if (p.repSaid === "contract-elsewhere") return "occasional";
  if (p.type === "fab shop" || p.type === "mechanical contractor") return p.specs.length || p.certs.length ? "steady" : "project";
  if (p.type === "plant" || p.type === "utility" || p.type === "EPC") return "project";
  if (p.type === "other") return "occasional";
  return "unknown";
}

const SAID_TEXT: Record<RepSaid, string> = {
  weekly: "they send RFQs weekly", monthly: "they send RFQs about monthly", projects: "they buy by the project", "contract-elsewhere": "they buy on contract elsewhere",
};

/** The tier plus the facts behind it, for the drawer. Never a claim without a source. */
export function potentialFor(p: Profile | null | undefined): Potential | null {
  if (!p) return null;
  const tier = tierFor(p);
  const why: string[] = [];
  for (const line of heardLines(p.heard)) why.push(line);
  if (p.repSaid) why.push(`You said ${SAID_TEXT[p.repSaid]}${p.repSaidAt ? ` (${short(p.repSaidAt)})` : ""}`);
  if (p.type !== "unknown") why.push(`${cap(p.type)}${p.makes ? `: ${p.makes}` : ""}`);
  if (p.specs.length) why.push(`Specs on their site: ${p.specs.slice(0, 5).join(", ")}`);
  if (p.certs.length) why.push(`Certs: ${p.certs.slice(0, 4).join(", ")}`);
  let unknown: string | null = null;
  if (p.type === "unknown") unknown = p.problem ? `Couldn't read their site (${p.problem}). Ask on the call: what do you make, and how often do you send RFQs out?` : "Their site doesn't say what they do. Ask on the call.";
  else if (!p.specs.length && !p.certs.length && !p.repSaid) unknown = "No idea what specs they run. Ask what grades and pressure classes they buy.";
  return { tier, type: p.type, why, unknown, ask: askNext(p.heard), profile: p };
}

const short = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- storage: one setting per rep, lead id -> profile ----------

export async function loadProfiles(repId: string): Promise<Record<string, Profile>> {
  return (await store.getSetting<Record<string, Profile>>(repId, PROFILES_KEY).catch(() => null)) ?? {};
}

export async function saveProfile(repId: string, leadId: string, profile: Profile) {
  const all = await loadProfiles(repId);
  all[leadId] = profile;
  await store.putSetting(repId, PROFILES_KEY, all);
}

/** The rep's answer after a call: "How often do they RFQ?" Saved on the lead in Close as well, so it isn't only ours. */
export async function recordRepSaid(d: Deps, leadId: string, said: RepSaid | null, profiles?: Record<string, Profile>) {
  const all = profiles ?? await loadProfiles(d.rep.closeUserId);
  const now = (d.now?.() ?? new Date()).toISOString();
  const p: Profile = all[leadId] ?? emptyProfile(null);
  p.repSaid = said;
  p.repSaidAt = said ? now : null;
  all[leadId] = p;
  await store.putSetting(d.rep.closeUserId, PROFILES_KEY, all);
  if (said) await d.close.createNote(leadId, `[RFQ potential] ${SAID_TEXT[said]}`, false).catch(() => undefined);
  return potentialFor(p)!;
}

/** New answers about their purchasing cycle land on the profile; the rep's confirmed ones write a [Purchasing] note in Close. */
export async function recordPurchasing(d: Deps, leadId: string, next: Purchasing, opts: { note?: boolean; replace?: boolean } = {}): Promise<Potential> {
  const all = await loadProfiles(d.rep.closeUserId);
  const p: Profile = all[leadId] ?? emptyProfile(null);
  // The rep's edit is the whole picture (a cleared field stays cleared); a transcript read merges in.
  p.heard = opts.replace ? next : mergePurchasing(p.heard, next);
  all[leadId] = p;
  await store.putSetting(d.rep.closeUserId, PROFILES_KEY, all);
  if (opts.note && Object.keys(p.heard).length) await d.close.createNote(leadId, purchasingNote(p.heard), false).catch(() => undefined);
  return potentialFor(p)!;
}

export function emptyProfile(website: string | null): Profile {
  return { website, type: "unknown", makes: null, specs: [], certs: [], industries: [], evidence: [], heard: null, repSaid: null, repSaidAt: null, checkedAt: null, problem: null };
}

// ---------- reading the site ----------

const ReadSchema = z.object({
  type: z.enum(["fab shop", "mechanical contractor", "plant", "utility", "EPC", "other", "unknown"])
    .describe("fab shop: fabricates pipe, vessels, skids, structural steel. mechanical contractor: installs piping/HVAC/process on job sites. plant: refinery, chemical, power, mill. utility: water, wastewater, municipal. EPC: engineering/construction firm. other: anything else. unknown: the pages don't say."),
  makes: z.string().nullable().describe("What they make or do, one short phrase in their own words. null if the pages don't say."),
  specs: z.array(z.string()).describe("Material grades, pressure classes, and service conditions the pages name (e.g. 'duplex', 'Inconel', 'sour service', '2500#', 'ASME B31.3'). Only what's actually on the page."),
  certs: z.array(z.string()).describe("Stamps and certifications the pages name (ASME U, R, S, PP; API; ISO 9001; AWS). Only what's on the page."),
  industries: z.array(z.string()).describe("Industries they say they serve."),
  evidence: z.array(z.object({ fact: z.string(), source: z.string() }))
    .describe("Up to 4 short facts that back the answers above, each with the URL of the page it came from. Nothing that isn't on a page."),
});

/** Read one account's site and say what it states. Never throws: a dead site is a profile with a problem. Doesn't save. */
export async function classifyAccount(d: Deps, a: Pick<Account, "leadId" | "company" | "website" | "contact">, prev: Profile | null | undefined): Promise<Profile> {
  const now = (d.now?.() ?? new Date()).toISOString();
  const keep = { repSaid: prev?.repSaid ?? null, repSaidAt: prev?.repSaidAt ?? null, heard: prev?.heard ?? null };
  const website = a.website ?? siteFromEmail(a.contact.email);
  let p: Profile = { ...emptyProfile(website), ...keep, checkedAt: now };
  if (!website) {
    p.problem = "no website on the lead";
  } else {
    const pages = await (d.sitePages ?? fetchSitePages)(website).catch(() => []);
    if (!pages.length) {
      p.problem = "site didn't load";
    } else {
      try {
        const context = pages.map((pg) => untrusted(`PAGE ${pg.url}`, pg.text)).join("\n\n");
        const { data } = await d.llm({
          schema: ReadSchema, effort: "low", model: config.briefModel, context,
          task: `These are pages from ${a.company}'s website. Westgate sells pipe, valves, fittings, flanges, plate and fasteners to industrial buyers. Say what kind of company this is and what the pages state about what they make, the material grades and pressure classes they work with, and their certifications. Only report what the pages say; leave fields empty when they don't. Cite the page for each fact.`,
        });
        const urls = new Set(pages.map((pg) => pg.url));
        p = {
          ...p, type: data.type, makes: data.makes, specs: dedupe(data.specs), certs: dedupe(data.certs), industries: dedupe(data.industries),
          // A cited page we didn't fetch is a made-up source: drop the fact.
          evidence: data.evidence.filter((e) => urls.has(e.source)).slice(0, 4).map((e) => ({ ...e, at: now })),
        };
      } catch (err) {
        p.problem = `read failed: ${(err as Error).message.slice(0, 80)}`;
      }
    }
  }
  return p;
}

const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|comcast|att|sbcglobal|verizon|proton|protonmail)\./i;
/** Their domain from the buyer's address, unless it's a personal mailbox. */
export function siteFromEmail(email: string | null | undefined): string | null {
  const domain = (email ?? "").split("@")[1]?.toLowerCase().trim();
  if (!domain || !domain.includes(".") || FREE_MAIL.test(domain)) return null;
  return `https://${domain}`;
}

const dedupe = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** Accounts with no profile, or one older than a month, a few at a time. Returns how many were read. */
export async function refreshProfiles(d: Deps, accounts: Array<Pick<Account, "leadId" | "company" | "website" | "contact">>, opts: { max?: number; force?: boolean } = {}): Promise<number> {
  const profiles = await loadProfiles(d.rep.closeUserId);
  const now = d.now?.() ?? new Date();
  const due = accounts.filter((a) => {
    const p = profiles[a.leadId];
    return opts.force || !p?.checkedAt || now.getTime() - new Date(p.checkedAt).getTime() > REFRESH_AFTER_DAYS * DAY;
  }).slice(0, opts.max ?? 10);
  let n = 0;
  for (let i = 0; i < due.length; i += 3) {
    const batch = due.slice(i, i + 3);
    const read = await Promise.all(batch.map((a) => classifyAccount(d, a, profiles[a.leadId])));
    // One save per batch, on top of whatever's there now (a rep's answer may have landed meanwhile).
    const all = await loadProfiles(d.rep.closeUserId);
    batch.forEach((a, j) => { all[a.leadId] = { ...read[j], repSaid: all[a.leadId]?.repSaid ?? read[j].repSaid, repSaidAt: all[a.leadId]?.repSaidAt ?? read[j].repSaidAt, heard: all[a.leadId]?.heard ?? read[j].heard ?? null }; });
    await store.putSetting(d.rep.closeUserId, PROFILES_KEY, all);
    n += batch.length;
  }
  return n;
}
