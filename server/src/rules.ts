// Deterministic playbook rules. Anything involving clocks, time zones, or hard
// "never do this" constraints lives here instead of in the prompt, so it is
// testable and identical for every rep.

export const BUSINESS_START_MIN = 8 * 60; // 8:00 AM local
export const LAST_CALL_MIN = 16 * 60 + 30; // 4:30 PM local

const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
};

const TZ_NAMES: Array<[RegExp, string]> = [
  [/pacific/i, "America/Los_Angeles"],
  [/mountain.*arizona|arizona/i, "America/Phoenix"],
  [/mountain/i, "America/Denver"],
  [/central/i, "America/Chicago"],
  [/eastern/i, "America/New_York"],
  [/alaska/i, "America/Anchorage"],
  [/hawaii/i, "Pacific/Honolulu"],
];

/** Prospect time zone: the "Timezone: X" hint in the Close description wins, then the address state. */
export function prospectTimeZone(description: string | null | undefined, state: string | null | undefined): string | null {
  const hint = description?.match(/Timezone:\s*([^|\n]+)/i)?.[1];
  if (hint) {
    for (const [re, tz] of TZ_NAMES) if (re.test(hint)) return tz;
  }
  if (state) return STATE_TZ[state.trim().toUpperCase()] ?? null;
  return null;
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

export function localParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, weekday };
}

/** The UTC instant at which the wall clock in `timeZone` reads the given local time. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes converge across DST boundaries.
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += Date.UTC(year, month - 1, day, hour, minute) - asUtc;
  }
  return new Date(guess);
}

export function tzLabel(timeZone: string, at = new Date()): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "long" })
    .formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  return name.replace(/ (Standard|Daylight) Time$/, "");
}

export function formatLocal(date: Date, timeZone: string, withDay = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "numeric", minute: "2-digit",
    ...(withDay ? { weekday: "short", month: "short", day: "numeric" } : {}),
  }).format(date);
}

export type LocalTime = { timeZone: string; label: string; localTime: string; afterHours: boolean; reason: string | null };

export function localTimeInfo(timeZone: string, now = new Date()): LocalTime {
  const p = localParts(now, timeZone);
  const mins = p.hour * 60 + p.minute;
  let reason: string | null = null;
  if (p.weekday === 0 || p.weekday === 6) reason = "weekend";
  else if (mins < BUSINESS_START_MIN) reason = "before 8:00 AM their time";
  else if (mins >= LAST_CALL_MIN) reason = "after 4:30 PM their time";
  return { timeZone, label: tzLabel(timeZone, now), localTime: formatLocal(now, timeZone, true), afterHours: reason !== null, reason };
}

/**
 * A good callback slot in the prospect's business hours:
 * - weekday morning before 11:00 → 2:00 PM the same day
 * - otherwise → 9:30 AM the next weekday
 */
export function suggestCallback(timeZone: string, now = new Date()): Date {
  const p = localParts(now, timeZone);
  const mins = p.hour * 60 + p.minute;
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  if (weekday && mins < 11 * 60) return zonedTime(p.year, p.month, p.day, 14, 0, timeZone);
  // Walk forward day by day (at local noon, to stay clear of DST edges) to the next weekday.
  let d = zonedTime(p.year, p.month, p.day, 12, 0, timeZone);
  do {
    d = new Date(d.getTime() + 24 * 3600 * 1000);
  } while ([0, 6].includes(localParts(d, timeZone).weekday));
  const n = localParts(d, timeZone);
  return zonedTime(n.year, n.month, n.day, 9, 30, timeZone);
}

/** ISO 8601 with the zone's offset, e.g. 2026-09-24T09:30:00-07:00 (what the model and Close both read well). */
export function isoWithOffset(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  const offsetMin = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(date.getTime() / 60000) * 60000) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ---------- phone ----------

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  const d = digits.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return `+${d}`;
}

export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function phoneFlags(phone: string | null | undefined): string[] {
  const e164 = normalizePhone(phone);
  if (!e164) return ["No phone number on the lead."];
  if (!e164.startsWith("+1")) return [`International number (${e164}). Find a US purchasing contact before dialing.`];
  return [];
}

// ---------- relationship checks ----------

export const VENDOR_STATUSES = ["vendor", "vendor onboarding"];

export function isVendor(statusLabel: string | null | undefined, leadTypes: string[]): boolean {
  return VENDOR_STATUSES.includes((statusLabel ?? "").trim().toLowerCase()) || leadTypes.map((t) => t.toLowerCase()).includes("vendor");
}

/** Name matches against the competitor list. Heads-up only: common words like "Harrington" can false-positive. */
export function competitorMatches(name: string, competitors: string[]): string[] {
  const n = ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return competitors.filter((c) => n.includes(` ${c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `));
}

export function siteDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function emailMatchesDomain(email: string, domain: string | null): boolean {
  if (!domain) return false;
  const at = email.toLowerCase().split("@")[1] ?? "";
  return at === domain || at.endsWith(`.${domain}`);
}

// ---------- status ladder ----------

// Pipeline order for "never move a lead backwards". Statuses not listed
// (Bad Fit, Not Interested, Disqualified, Vendor...) are side exits.
// Qualified sits before Sent Line Card (Walt 9/30): a qualified lead that got the line card is "Sent Line Card".
const LADDER = ["potential", "good lead", "called", "qualified", "sent line card", "rfq received", "quoted", "customer"];

export function isBackwardsMove(fromLabel: string | null | undefined, toLabel: string): boolean {
  const from = LADDER.indexOf((fromLabel ?? "").toLowerCase());
  const to = LADDER.indexOf(toLabel.toLowerCase());
  return from >= 0 && to >= 0 && to < from;
}

/** h:mm on the next weekday after today, in the prospect's time zone. */
export function nextWeekdayAt(timeZone: string, now: Date, hour: number, minute: number): Date {
  const p = localParts(now, timeZone);
  let d = zonedTime(p.year, p.month, p.day, 12, 0, timeZone);
  do {
    d = new Date(d.getTime() + 24 * 3600 * 1000);
  } while ([0, 6].includes(localParts(d, timeZone).weekday));
  const n = localParts(d, timeZone);
  return zonedTime(n.year, n.month, n.day, hour, minute, timeZone);
}

/** "Matt M." and "Matt Michon" are the same person; "Matt Smith" is not. */
export function samePerson(a: string, b: string): boolean {
  const parts = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  const [af, ...ar] = parts(a);
  const [bf, ...br] = parts(b);
  if (!af || af !== bf) return false;
  const al = ar.at(-1);
  const bl = br.at(-1);
  if (!al || !bl) return ar.length === 0 && br.length === 0;
  return al === bl || (al.length === 1 && bl.startsWith(al)) || (bl.length === 1 && al.startsWith(bl));
}

// ---------- closest Westgate warehouse (Email & Product Playbook §1) ----------

const WEST = "AK AZ CA CO HI ID MT NV NM OR UT WA WY";
const GULF_SOUTHEAST = "AL AR FL GA LA MS NC OK SC TN TX";
const MIDWEST_NORTHEAST = "CT DC DE IA IL IN KS KY MA MD ME MI MN MO ND NE NH NJ NY OH PA RI SD VA VT WI WV";

export function closestWarehouse(state: string | null | undefined): "Oakland" | "Houston" | "Chicago" | null {
  const s = (state ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return null;
  if (WEST.split(" ").includes(s)) return "Oakland";
  if (GULF_SOUTHEAST.split(" ").includes(s)) return "Houston";
  if (MIDWEST_NORTHEAST.split(" ").includes(s)) return "Chicago";
  return null;
}

/** h:mm their time, `n` business days after today. */
export function businessDaysAt(timeZone: string, now: Date, n: number, hour: number, minute: number): Date {
  let d = now;
  for (let i = 0; i < n; i++) d = nextWeekdayAt(timeZone, d, 12, 0);
  const p = localParts(d, timeZone);
  return zonedTime(p.year, p.month, p.day, hour, minute, timeZone);
}

/** Weekdays between two instants in a time zone, counted by calendar date (0 = same business day). */
export function businessDaysBetween(from: Date, to: Date, tz: string): number {
  const day = (d: Date) => { const p = localParts(d, tz); return Date.UTC(p.year, p.month - 1, p.day); };
  let n = 0;
  for (let t = day(from) + 864e5; t <= day(to); t += 864e5) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}

/**
 * Lead statuses that mean "stop working this account": the rep's call in Close, or Shot down in the side panel
 * (Walt 10/5). They come off the accounts board and out of the automatic emails.
 */
export const OUT_STATUSES = ["not interested", "bad fit", "disqualified"];
export const isOutStatus = (label: string | null | undefined) => OUT_STATUSES.includes((label ?? "").trim().toLowerCase());

/** A fuller version of an existing name: same last name, and the old first name is missing or a prefix/initial of the new one. */
export function fillsInName(existing: string, fuller: string): boolean {
  const parts = (x: string) => x.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  const e = parts(existing);
  const f = parts(fuller);
  if (!e.length || f.length < 2 || e.at(-1) !== f.at(-1)) return false;
  if (e.length === 1) return true; // "Ramirez" → "Carlos Ramirez"
  // "C." / "Car" → "Carlos"; also short abbreviations like "Co." with the same first letter.
  return e[0] !== f[0] && (f[0].startsWith(e[0]) || (e[0].length <= 3 && e[0][0] === f[0][0]));
}
