import type { LeadEmail } from "./close.js";
import type { LeadContext } from "./context.js";

// Lead history on the call card (Walt 10/11: "I call and forget what happened, then call back and ask the same
// questions"). Straight from Close, no AI: the counts, every real conversation with what was said (the call note),
// and the emails both ways, newest first.

export type History = {
  counts: { calls: number; connected: number; voicemails: number; noAnswer: number; emailsOut: number; replies: number };
  lineCard: { at: string; to: string | null } | null;
  /** Real conversations, newest first, with who picked up (the contact the call was logged to, when Close knows). */
  talked: Array<{ at: string; minutes: number; note: string | null; who: string | null }>;
  events: Array<{ at: string; kind: "call" | "voicemail" | "no_answer" | "email" | "reply" | "note"; text: string }>;
};

const LINE_CARD = /line.?card/i;
const BOUNCE = /delivery status notification|undeliverable|undelivered mail|mail delivery (failed|subsystem)|returned mail|mailer-daemon|postmaster/i;
const SKIP_NOTE = /^(Opener:|\[Said on the call\])/;
const oneLine = (s: string | null | undefined, n = 160) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** Their own words in an email: above the quoted thread and the signature. */
const ownWords = (body: string | null | undefined) => oneLine((body ?? "").split(/\n\s*On .{5,120}wrote:|\n-{2,}\s*Original Message|\nFrom: .+\n(Sent|Date): /i)[0].split(/\n\s*(Regards|Thanks|Thank you|Best|Cheers),?\s*\n/i)[0]);

export function buildHistory(ctx: LeadContext, emails: LeadEmail[]): History {
  const calls = ctx.calls.filter((c) => c.direction === "outbound").sort((a, b) => b.date_created.localeCompare(a.date_created));
  const isVm = (c: (typeof calls)[number]) => c.disposition === "vm-left" || c.disposition === "vm-answer" || /voicemail/i.test(c.note ?? "");
  const talkedCall = (c: (typeof calls)[number]) => c.disposition === "answered" && (c.duration ?? 0) >= 20 && !isVm(c);
  const notes = (ctx.notes ?? []).filter((n) => !SKIP_NOTE.test(n.note));
  // The note written for a call: the one saved within 90 minutes after it started (the after-call note).
  const used = new Set<string>();
  const noteFor = (at: string) => {
    const t = Date.parse(at);
    const n = notes.find((x) => !used.has(x.id) && Date.parse(x.date_created) >= t && Date.parse(x.date_created) - t < 90 * 60_000);
    if (n) used.add(n.id);
    return n ? oneLine(n.note.replace(/\[(RFQ promised|RFQ asked|Purchasing)\]\s*/g, ""), 260) : null;
  };
  const sent = emails.filter((e) => e.direction === "outgoing" && ["sent", "outbox"].includes(e.status));
  const replies = emails.filter((e) => e.direction === "incoming" && e.status === "inbox" && !BOUNCE.test(`${e.sender ?? ""} ${e.subject ?? ""}`) && !/@westgatesupply\.com/i.test(e.sender ?? ""));
  const card = [...sent].reverse().find((e) => (e.attachments ?? []).some((a) => LINE_CARD.test(a.filename ?? "")));
  const when = (e: LeadEmail) => e.date_sent ?? e.date_created ?? "";

  const events: History["events"] = [];
  const talked: History["talked"] = [];
  for (const c of calls) {
    const minutes = Math.max(1, Math.round((c.duration ?? 0) / 60));
    if (talkedCall(c)) {
      const note = noteFor(c.date_created) ?? (c.note ? oneLine(c.note, 260) : null);
      const who = (ctx.contacts ?? []).find((x) => x.id === c.contact_id)?.name ?? null;
      talked.push({ at: c.date_created, minutes, note, who: who && !/main|office|front desk|reception/i.test(who) ? who : null });
      events.push({ at: c.date_created, kind: "call", text: `Call, ${minutes} min${note ? `: ${note}` : ""}` }); // "answered" includes the front desk and voicemail transfers: the note says what happened
    } else if (isVm(c)) events.push({ at: c.date_created, kind: "voicemail", text: "Left a voicemail" });
    else events.push({ at: c.date_created, kind: "no_answer", text: (c.duration ?? 0) > 0 ? `Called, ${c.duration}s, no conversation` : "Called, no answer" });
  }
  for (const e of sent) events.push({ at: when(e), kind: "email", text: `${e === card ? "Line card" : "Email"} to ${(e.to ?? []).join(", ") || "them"}${e === card ? "" : `: ${ownWords(e.body_text) || e.subject || ""}`}` });
  for (const e of replies) events.push({ at: when(e), kind: "reply", text: `${oneLine((e.sender ?? "").replace(/<.*$/, "").replace(/"/g, ""), 40) || "They"} wrote: ${ownWords(e.body_text) || e.subject || "(no text)"}` });
  for (const n of notes) if (!used.has(n.id)) events.push({ at: n.date_created, kind: "note", text: oneLine(n.note, 220) });
  events.sort((a, b) => b.at.localeCompare(a.at));

  return {
    counts: {
      calls: calls.length, connected: calls.filter(talkedCall).length, voicemails: calls.filter(isVm).length,
      noAnswer: calls.filter((c) => !talkedCall(c) && !isVm(c)).length, emailsOut: sent.length, replies: replies.length,
    },
    lineCard: card ? { at: when(card), to: (card.to ?? [])[0] ?? null } : null,
    talked, events: events.slice(0, 25),
  };
}
