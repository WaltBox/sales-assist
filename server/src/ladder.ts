import type { Deps } from "./assistant.js";
import type { CloseContact, CloseLead } from "./close.js";
import { ICP_FIELD_NAMES, type IcpIds } from "./heat.js";
import { store } from "./store.js";

/**
 * The ladder (Walt 11/11): one objective per lead, paid once per rung. The BDR's job is new business, worked as
 * a pipeline in Close instead of "hella discovery": find the buyer, get them the card, reach them, get the last
 * thing they sent out. Discovery (a fit with no name yet) runs alongside, never as the whole block.
 *
 *   potential → fit → named buyer → card sent → reached buyer → RFQ received → quoted → customer
 *
 * Close holds the rung as the lead status; the side panel shows the objective for that rung and what it pays; the
 * West Game pays it when the status moves. Each rung pays once per company: naming Ron again earns nothing, and
 * the objective on his lead is already the next rung.
 */
export const RUNGS = ["potential", "fit", "named", "card", "reached", "rfq", "quoted", "customer"] as const;
export type Rung = (typeof RUNGS)[number];
export type Stage = Rung | "out";

/** The lead status in Close for each rung. "Sent Line Card" keeps its old name: too much reads it. */
export const RUNG_STATUS: Record<Rung, string> = {
  potential: "Potential", fit: "Fit", named: "Named buyer", card: "Sent Line Card", reached: "Reached buyer", rfq: "RFQ Received", quoted: "Quoted", customer: "Customer",
};
/** Side exits: not on the ladder, never dialed from it. */
export const OUT_STATUS = ["Not a fit", "Not Interested", "Vendor", "Vendor Onboarding", "duplicate"] as const;
/** Statuses from before the ladder, read as the rung they meant. */
const LEGACY: Record<string, Rung | "out"> = {
  "good lead": "fit", called: "fit", qualified: "reached", "bad fit": "out", disqualified: "out", "project managers": "out",
};
export const rungOfStatus = (label: string | null | undefined): Stage | null => {
  const l = (label ?? "").trim().toLowerCase();
  if (!l) return null;
  for (const r of RUNGS) if (RUNG_STATUS[r].toLowerCase() === l) return r;
  if (OUT_STATUS.some((s) => s.toLowerCase() === l)) return "out";
  return LEGACY[l] ?? null;
};
export const rungIndex = (s: Stage | null) => (s && s !== "out" ? RUNGS.indexOf(s) : -1);
export const isOnOrPast = (s: Stage | null, r: Rung) => rungIndex(s) >= RUNGS.indexOf(r);

/** What a rung pays, once per company. A dial still pays 1 so the car always moves. */
export const RUNG_POINTS = { dial: 1, named: 3, card: 2, reached: 5, rfq: 30, firstRfq: 10 } as const;
/**
 * The finish (Walt 11/11: "should actually be quite hard"): a full morning with no RFQ is ~130, three new RFQs on top
 * of it 250. Finishing takes a monster day: 120 dials, a dozen names and cards, ten buyers reached and three new
 * RFQs, which is Chase's best day so far (10/27: 119 calls, 4 RFQs) and nothing less.
 */
export const LADDER_GOAL = 350;

// ---------- the named buyer: a person with a buying title and a way to reach them directly ----------

const BUYER_TITLE = /purchas|buyer|procure|supply chain|material|sourcing|estimat|owner|president|vp|general manager|operations manager|plant manager|shop manager/i;
const NOT_A_PERSON = /^(main office|front desk|office|reception|general|info|sales|purchasing|accounting)$/i;
/** A mailbox nobody owns: the part before the @ is a department word. */
const GENERIC = /^(info|sales|accounting|accounts|ap|ar|office|main|admin|purchasing|procurement|contact|hello|support|front ?desk|billing|estimating|reception|general|service|orders|shop|quotes?|bids?|inquiries|mail|team|dispatch|hr|careers)@/i;
export type Buyer = { id: string; name: string; title: string | null; email: string | null; phone: string | null; direct: boolean;
  /** A line that reaches them (a direct, mobile or extension number), not the main office line. */
  line: string | null };

/** The best buyer on the lead: a named person with a buying title or a non-generic email; `direct` when there's a line or address that reaches them. */
export function buyerOf(contacts: CloseContact[] | null | undefined): Buyer | null {
  const people = (contacts ?? []).filter((c) => c.name && !NOT_A_PERSON.test(c.name.trim()));
  const scored = people.map((c) => {
    const email = (c.emails ?? []).map((e) => e.email).find((e) => !GENERIC.test(e)) ?? null;
    const phone = (c.phones ?? []).find((p) => p.type && p.type !== "office")?.phone ?? (c.phones ?? [])[0]?.phone ?? null;
    const titled = BUYER_TITLE.test(c.title ?? "");
    const line = (c.phones ?? []).find((p) => p.type && p.type !== "office")?.phone ?? null;
    const direct = !!email || !!line;
    const score = (titled ? 4 : 0) + (email ? 2 : 0) + (direct ? 1 : 0);
    return { buyer: { id: c.id, name: c.name, title: c.title ?? null, email, phone, direct, line }, score, titled };
  }).filter((x) => x.titled || x.buyer.email).sort((a, b) => b.score - a.score);
  return scored[0]?.buyer ?? null;
}

// ---------- where a lead is, and what to do about it ----------

export type LadderIn = {
  lead: Pick<CloseLead, "status_label" | "contacts" | "display_name">;
  /** The ICP tier from Close, when the pass has read them. */
  tier: string | null;
  /** The line card went to the buyer (any outgoing sent email with the card, to a non-generic address). */
  cardSentAt?: string | null;
  /** The last real conversation with the buyer. */
  reachedAt?: string | null;
  /** The last RFQ in (file, forward, or tapped). */
  rfqAt?: string | null;
  /** First name of the rep, for the line to say. */
  repFirst?: string | null;
};
export type Ladder = {
  stage: Stage;
  label: string;
  /** The objective for this lead, in plain words. */
  objective: string;
  /** The one line to say, when there is one. */
  say: string | null;
  /** What the next rung pays, and what for. */
  next: { rung: Rung; points: number; label: string } | null;
  buyer: Buyer | null;
  /** The rung Close's status says, when the lead's facts say further along (a buyer on the lead, but the status still "Fit"). */
  statusLags: boolean;
  /** The checklist (Walt 11/11): what this call is for, ticked as Close reports it, with what each pays. */
  boxes: Box[];
};
export type Box = { key: "name" | "line" | "email" | "card" | "reached" | "rfq"; label: string; done: boolean; points: number | null; hint: string | null };
/** The boxes, by rung: the ones to do on this call come after the ones already ticked. */
function boxesFor(stage: Stage, buyer: Buyer | null, x: LadderIn): Box[] {
  if (stage === "out") return [];
  const past = (r: Rung) => isOnOrPast(stage, r);
  const first = buyer?.name.split(/\s+/)[0] ?? "the buyer";
  return [
    { key: "name", label: "Name", done: !!buyer, points: RUNG_POINTS.named, hint: buyer ? `${buyer.name}${buyer.title ? `, ${buyer.title}` : ""}` : "who buys pipe and fittings; a first name is fine" },
    { key: "line", label: "Direct line", done: !!buyer?.line, points: null, hint: buyer?.line ?? "their extension or cell" },
    { key: "email", label: "Email", done: !!buyer?.email, points: null, hint: buyer?.email ?? "theirs, not purchasing@" },
    { key: "card", label: "Line card sent", done: !!x.cardSentAt || past("card"), points: RUNG_POINTS.card, hint: x.cardSentAt ? `sent ${new Date(x.cardSentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : `to ${first}, not a shared inbox` },
    { key: "reached", label: "Reached the buyer", done: past("reached"), points: RUNG_POINTS.reached, hint: past("reached") ? null : `${first} on the phone, a real conversation` },
    { key: "rfq", label: "RFQ in", done: past("rfq"), points: RUNG_POINTS.rfq, hint: past("rfq") ? null : "the last one they sent out, or three items on the phone" },
  ];
}
const RUNG_LABEL: Record<Stage, string> = {
  potential: "Not tiered yet", fit: "Discovery: find the buyer", named: "Named buyer", card: "Card sent", reached: "Reached the buyer", rfq: "RFQ received", quoted: "Quoted", customer: "Customer", out: "Not for dialing",
};
const first = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || null;
const co = (name: string | null | undefined) => (name ?? "them").split(/[,(]| - /)[0].replace(/\s+(Inc|LLC|Co|Corp|Company)\.?$/i, "").trim() || "them";

/**
 * The stage, from the status and the facts, whichever is further along: a buyer contact on a "Fit" lead is a named
 * buyer; a card to that buyer is card sent; a conversation with them is reached; an RFQ is an RFQ. Out stays out,
 * and an Avoid tier that isn't out yet reads as out too.
 */
export function ladderFor(x: LadderIn): Ladder {
  const status = rungOfStatus(x.lead.status_label);
  const buyer = buyerOf(x.lead.contacts);
  let stage: Stage = status ?? "potential";
  // The website read never overrides a person (Walt 11/11: "Qualified → Not a fit?"): an Avoid tier takes a lead off
  // the ladder only while nobody has reached anyone there or sent them the card. Once a rep has, the tier shows on
  // the card and the rep calls it on the next touch.
  if (stage !== "out" && x.tier === "Avoid" && !isOnOrPast(stage, "card")) stage = "out";
  if (stage !== "out") {
    const facts: Rung = x.rfqAt ? "rfq" : x.reachedAt && buyer ? "reached" : x.cardSentAt && buyer ? "card" : buyer ? "named" : x.tier && x.tier !== "Unknown" ? "fit" : "potential";
    if (rungIndex(facts) > rungIndex(stage)) stage = facts;
  }
  const statusLags = stage !== "out" && status !== null && rungIndex(stage) > rungIndex(status);
  const name = first(buyer?.name);
  const company = co(x.lead.display_name);
  const me = x.repFirst ?? "me";
  const next = (rung: Rung, points: number, label: string) => ({ rung, points, label });
  const base = { buyer, statusLags, label: RUNG_LABEL[stage], boxes: boxesFor(stage, buyer, x) };
  switch (stage) {
    case "out":
      return { ...base, stage, objective: "Don't dial. If that's wrong, change the status in Close.", say: null, next: null };
    case "potential":
      return { ...base, stage, objective: "Not tiered yet. The ICP pass reads their site; if you know what they are, set the tier.", say: null, next: next("named", RUNG_POINTS.named, "the buyer's name and a direct line or email") };
    case "fit":
      return { ...base, stage, objective: `Get the buyer's name and a direct line or email. Ask the front desk who handles pipe and fittings purchasing; take the name off the voicemail greeting if you get one.`, say: `Hi, this is ${me} with Westgate Supply. Who handles your pipe, fittings and bolting purchasing? A first name is fine.`, next: next("named", RUNG_POINTS.named, "the buyer's name and a direct line or email") };
    case "named":
      return { ...base, stage, objective: `Send ${name ?? "the buyer"} the card, then call ${name ? "them" : "the buyer"} by name: you've got our card, forward me the last one you sent out.`, say: `Hi ${name ?? ""}, it's ${me} with Westgate Supply. I sent you our line card. What's the last RFQ you sent out for fittings or flanges? Forward me that and I'll price the same list today.`.replace("Hi , ", "Hi, "), next: next("card", RUNG_POINTS.card, `the card to ${name ?? "the buyer"}`) };
    case "card":
      return { ...base, stage, objective: `${name ?? "The buyer"} has the card. Reach ${name ? "them" : "the buyer"} by name and ask for the last one they sent out.`, say: `Hi ${name ?? ""}, it's ${me} with Westgate Supply. You've got our card. What's the last RFQ you sent out for fittings or flanges? Forward me that and I'll price the same list today.`.replace("Hi , ", "Hi, "), next: next("reached", RUNG_POINTS.reached, `a real conversation with ${name ?? "the buyer"}`) };
    case "reached":
      return { ...base, stage, objective: `Get the last RFQ, the quote they got, a PO, or three items on the phone. If ${name ?? "they"}'ll send it, stay on until it lands or set a day and hour.`, say: `${name ?? "Hey"}, it's ${me}. Forward me the last one you sent out, or give me three items with size, material and quantity, and I'll have pricing back today.`, next: next("rfq", RUNG_POINTS.rfq, `an RFQ from ${company}`) };
    case "rfq":
      return { ...base, stage, objective: `Their RFQ is in: pricing owes them a quote today. Then ask ${name ?? "them"} what else they buy that we haven't quoted.`, say: null, next: next("quoted", 0, "the quote back to them") };
    case "quoted":
      return { ...base, stage, objective: `Quoted. Follow up on it in three business days, and ask ${name ?? "them"} what else they buy.`, say: `${name ?? "Hey"}, it's ${me}. Did our pricing land where you needed? What else do you buy that we haven't quoted yet?`, next: next("rfq", RUNG_POINTS.rfq, "the next RFQ") };
    case "customer":
      return { ...base, stage, objective: `A customer. Every RFQ still counts; ask what else they buy.`, say: null, next: next("rfq", RUNG_POINTS.rfq, "the next RFQ") };
  }
}

/** The ICP pass's custom field ids in Close (found by name: icp_tier, segment, buys_through, icp_why); the names live in heat.ts. */
export { ICP_FIELD_NAMES, type IcpIds };
const icpLooked = new Map<string, number>();
/**
 * The ICP pass's custom fields, found once by name and kept in the team settings. Nothing found (the pass hasn't run
 * in this Close org) is checked again after an hour, not on every card.
 */
export async function icpFieldIds(d: Deps): Promise<IcpIds | null> {
  const saved = await store.getSetting<IcpIds>("team", "icpFieldIds").catch(() => null);
  if (saved?.tier) return saved;
  if (Date.now() - (icpLooked.get(d.rep.closeUserId) ?? 0) < 60 * 60_000) return null;
  icpLooked.set(d.rep.closeUserId, Date.now());
  const fields = await d.close.leadCustomFields().catch(() => []);
  const id = (name: string) => fields.find((f) => f.name.trim().toLowerCase() === name)?.id ?? null;
  const tier = id(ICP_FIELD_NAMES.tier);
  if (!tier) return null;
  const ids: IcpIds = { tier, segment: id(ICP_FIELD_NAMES.segment), buys: id(ICP_FIELD_NAMES.buys), why: id(ICP_FIELD_NAMES.why) };
  await store.putSetting("team", "icpFieldIds", ids).catch(() => undefined);
  return ids;
}

/** The status a lead should move to when something happened on the call, by the ladder; never backwards. */
export const statusForOutcome = (outcome: string): string | null =>
  outcome === "reached_buyer" || outcome === "pms_buy" ? RUNG_STATUS.reached : outcome === "got_name" ? RUNG_STATUS.named : null;
