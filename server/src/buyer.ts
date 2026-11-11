import { advanceStatus } from "./accounts.js";
import { RFQ_TAG, type Deps } from "./assistant.js";
import { markReachedByHand } from "./dialviews.js";

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

/** The rep says they reached the buyer: Reached buyer in Close (what pays), and today's reach for the dial views. */
export async function markBuyerReached(d: Deps, leadId: string): Promise<{ status: string | null; reached: boolean }> {
  const status = await advanceStatus(d, leadId, "Reached buyer").catch(() => null);
  const reached = await markReachedByHand(d, leadId).catch(() => false);
  return { status, reached };
}
