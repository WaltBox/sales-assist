import { advanceStatus } from "./accounts.js";
import { RFQ_TAG, type Deps } from "./assistant.js";
import { markReachedByHand } from "./dialviews.js";
import { buyerOf } from "./ladder.js";
import { sendLineCard } from "./linecard.js";
import { LINE_CARD, rememberAutoCard } from "./stats.js";

/**
 * The one control under the objective (Walt 11/11: "there needs to be like a Do this. Mark it's done"): the rep types
 * the buyer's name and email and saves, or marks the buyer reached. Both land in Close, where the points are paid
 * from (a contact on the lead, a status change), never in the app alone.
 */
export type BuyerIn = { contactId?: string | null; name: string; title?: string | null; email?: string | null; phone?: string | null };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (s: string | null | undefined) => (s ?? "").trim() || null;

export async function saveBuyer(d: Deps, leadId: string, b: BuyerIn): Promise<{ contactId: string; status: string | null }> {
  const name = clean(b.name);
  if (!name) throw new Error("A name is needed.");
  const email = clean(b.email)?.toLowerCase() ?? null;
  if (email && !EMAIL.test(email)) throw new Error("That email doesn't look right.");
  const title = clean(b.title), phone = clean(b.phone);
  let contactId = b.contactId ?? null;
  if (contactId) {
    // Adding to a person already on the lead (an email for a named buyer): Close replaces the lists it's sent, so
    // the ones already there come along.
    const have = (await d.close.lead(leadId)).contacts.find((c) => c.id === contactId);
    const patch: { name?: string; title?: string; emails?: Array<{ email: string; type: string }>; phones?: Array<{ phone: string; type: string }> } = {};
    if (title && title !== have?.title) patch.title = title;
    if (email && !(have?.emails ?? []).some((e) => e.email.toLowerCase() === email)) patch.emails = [...(have?.emails ?? []), { email, type: "office" }];
    if (phone && !(have?.phones ?? []).some((p) => p.phone === phone)) patch.phones = [...(have?.phones ?? []), { phone, type: "direct" }];
    if (Object.keys(patch).length) await d.close.updateContact(contactId, patch);
  } else {
    // Only the name is required (Walt 11/11: "i dont like having to enter the 'Purchasing' etc"). The ladder knows the
    // buyer by a buying title or their own email, so a name saved with neither is titled "Buyer": the card is the rep
    // saying who buys.
    contactId = (await d.close.createContact(leadId, { name, title: title ?? (email ? null : "Buyer"), email, phone })).id;
  }
  // Named buyer in Close (paid once there), never backwards; an org without the status keeps the one it has.
  const status = await advanceStatus(d, leadId, "Named buyer").catch(() => null);
  return { contactId, status };
}

/**
 * "RFQ incoming" (Walt 11/11): they said they'd send one. A promise note on the lead, the same tag the after-call
 * review writes, so the heat map's Expecting band, the automatic bump and the stats all see it. No points.
 */
export async function markRfqIncoming(d: Deps, leadId: string, o: { name?: string | null; when?: string | null }): Promise<{ noteId: string }> {
  const who = (o.name ?? "").trim() || "They";
  const when = (o.when ?? "").trim().slice(0, 80);
  const r = await d.close.createNote(leadId, `${RFQ_TAG} ${who} said they'll send one${when ? `, ${when}` : ""} (tapped on the call card).`, false);
  return { noteId: r.id };
}

/**
 * The card goes the moment the buyer is reached (Walt 11/12: "maybe we should have a line card sent out when we reach
 * that person"): the named buyer has an address and no card has gone to it yet, so it goes now, not with tomorrow's
 * follow-up. No address, nothing to send: the card asks for one.
 */
export async function cardOnReach(d: Deps, leadId: string): Promise<{ sent: string | null; again: boolean; why: string | null }> {
  const lead = await d.close.lead(leadId).catch(() => null);
  const buyer = buyerOf(lead?.contacts);
  if (!buyer) return { sent: null, again: false, why: "nobody named" };
  if (!buyer.email) return { sent: null, again: false, why: `no email for ${buyer.name}` };
  const emails = await d.close.leadEmails(leadId).catch(() => []);
  const had = emails.some((e) => e.direction === "outgoing" && ["sent", "outbox"].includes(e.status) && (e.attachments ?? []).some((a) => a.filename === LINE_CARD) && (e.to ?? []).some((t) => t.toLowerCase().includes(buyer.email!.toLowerCase())));
  // Already had it: it goes again, in the same thread, so it's at the top of their inbox while they're on the phone
  // (Walt 11/12: "I'll go ahead and send it again to get it to the top of their inbox"). A resend never paid anyway.
  const sent = await sendLineCard(d, leadId, { to: buyer.email, name: buyer.name, cold: false });
  // The reach paid its 5; a card the app sent on its own pays nothing (Walt 11/12: "that shouldn't reward additional
  // points"). Recorded like the sequence's sends, which the hand-card count leaves out.
  await rememberAutoCard(d.rep.closeUserId, sent.id, sent.at).catch(() => undefined);
  return { sent: buyer.email, again: had, why: null };
}

/** The rep says they reached the buyer: Reached buyer in Close (what pays), today's reach for the dial views, and the card to them. */
export async function markBuyerReached(d: Deps, leadId: string): Promise<{ status: string | null; reached: boolean; card: { sent: string | null; again: boolean; why: string | null } }> {
  const status = await advanceStatus(d, leadId, "Reached buyer").catch(() => null);
  const reached = await markReachedByHand(d, leadId).catch(() => false);
  const card = await cardOnReach(d, leadId).catch((err) => ({ sent: null, again: false, why: (err as Error).message }));
  return { status, reached, card };
}
