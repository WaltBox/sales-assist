import { z } from "zod/v4";

// Shapes Claude returns (enforced with structured outputs) and the panel edits.
// Proposals are grouped by kind so the panel can render one section per kind
// and chat edits can return the whole set.

export const Rating = z.enum(["A", "B", "C", "D"]);

export const BriefSchema = z.object({
  rating: z.string().describe("One letter: A, B, C, or D"),
  fit_summary: z.string().describe("Why this rating, 1–2 short sentences, under 25 words"),
  company_type: z.string().describe("Under 5 words, e.g. 'Commercial electrical contractor'"),
  ask_for: z.object({
    name: z.string().describe("First name (or full name) of the purchasing person to ask for; 'Purchasing' if unknown"),
    role: z.string().nullable().describe("Under 10 words, e.g. 'covering purchasing for Rob Roy (back Oct 12)'"),
  }),
  opener: z.string().describe("The PVF pitch. 2 short spoken sentences: who we are, then 3–4 specific PVF products from `buys` in one run and what work they're for (\"Hi, this is Walt with Westgate Supply. We supply pipe, valves, fittings and flanges for commercial plumbing work.\"). When pvf_fit isn't yes, leave off the \"for [their work]\" tie rather than force it. No \"[crews] use for\" clauses. Follow-ups too: pick up from the last conversation and still name the products."),
  ask: z.string().describe("1–2 spoken sentences: the ask for a list or RFQ, any format"),
  objection: z.string().describe("The most likely pushback, a few words, e.g. 'We already have a supplier'"),
  objection_response: z.string().describe("1–2 spoken sentences"),
  buys: z.array(z.string()).describe("3–7 things they'd buy from Westgate, 2–4 words each, PVF first: the pipe, valves, fittings, flanges, gaskets, stud bolts and pipe supports that fit their work. Valves are allowed; otherwise only products inside the 12 product lines in §2 of the Email & Product Knowledge Playbook. Never strut or strut channel, tools, electrical, or anything the lines don't list."),
  pvf_fit: z.enum(["yes", "likely_not", "no"]).describe("Do they work with piping (pipe, valves, fittings)? yes: they build, install, run or maintain piping. likely_not: piping is a small or uncertain part of their work. no: nothing touches piping."),
  pvf_reason: z.string().describe("Why that pvf_fit, under 12 words, e.g. 'Electrical contractor: conduit and supports, no process piping.'"),
  alt_opener: z.string().nullable().describe("Only when pvf_fit is likely_not or no: the pitch for their own trade, 2 short spoken sentences, who we are then 3–4 products from alt_buys in one run and what work they're for (\"Hi, this is Walt with Westgate Supply. We supply threaded rod, anchors, beam clamps and HDG hardware for commercial electrical work.\"). null when pvf_fit is yes."),
  alt_buys: z.array(z.string()).describe("Only when pvf_fit is likely_not or no: 3–7 products for their own trade from the persona table, 2–4 words each, inside the 12 product lines. Empty when pvf_fit is yes."),
  heads_ups: z.array(z.string()).describe("0–3 short lines the rep would miss in Close; never time of day"),
  what_they_do: z.string().describe("2 short sentences, specific, from their website"),
  capture: z.array(z.string()).describe("2–3 short things to get before hanging up, e.g. \"Renee's direct email\""),
  // A made-up childhood memory at a real local event (Walt 10/5): told for fun, disclosed as made up on the call.
  hometown: z.object({
    event: z.string().describe("A real, well-known recurring event in or near their city: a festival, fair, parade, race, rodeo, air show, or the home team's game (e.g. 'Three Rivers Festival, Fort Wayne', 'Brentwood CornFest', 'Houston Livestock Show and Rodeo'). Must actually exist. If nothing specific is known for that town, use the county fair or the nearest big city's event and say which."),
    opener: z.string().describe("One spoken sentence that says up front the story is invented and asks if they want to hear it, e.g. 'Quick one before we start: I've got a made-up childhood memory about Fort Wayne, want it?' Must say it's made up."),
    story: z.string().describe("3 short spoken sentences, first person, the rep as a kid (age 6 to 10) at that real event: ordinary, believable details a local would nod at (the heat, the line for the funnel cake, what they could see from a parent's shoulders), one small vivid moment, no magic, no celebrities, nothing that could be checked and found false about the event itself. e.g. 'My dad took me to the Three Rivers Festival when I was seven and we sat on the bank for the raft race. Somebody's raft came apart right in front of us and the whole crowd cheered them on anyway. I thought that was the greatest thing I had ever seen.'"),
  }).nullable().describe("null when the location isn't known."),
});
export type Brief = z.infer<typeof BriefSchema>;

export const NoteProposal = z.object({
  text: z.string(),
  pinned: z.boolean().describe("True when it says who to ask for next time"),
});

export const ContactProposal = z.object({
  name: z.string().describe("As said on the call or in Close. Never work out a last name from the email address or its domain (jacob@mcturk.net is \"Jacob\", not \"Jacob McTurk\")."),
  title: z.string().nullable().describe("Only if said on the call or in Close; never guessed"),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  verify_email: z.boolean().describe("True when the email came from speech on the call or is otherwise uncertain"),
});

export const ContactUpdate = z.object({
  contact: z.string().describe("The existing Close contact's name exactly as listed, e.g. 'Co. Ramirez'"),
  name: z.string().nullable().describe("Full/corrected name if the call revealed it, e.g. 'Carlos Ramirez'; else null"),
  title: z.string().nullable().describe("Only if said on the call; else null"),
  email: z.string().nullable().describe("A new email for them from the call; else null"),
  phone: z.string().nullable().describe("A new direct line/extension from the call; else null"),
  verify_email: z.boolean(),
});

export const TaskProposal = z.object({
  due_at: z.string().describe("ISO 8601 with offset, inside the prospect's business hours"),
  title: z.string().describe("Verb + who, e.g. 'Check in with Damon (Purchasing)' or 'Call Corbin'"),
  ask_for: z.string().describe("The exact person to call next with role, e.g. 'Matt Michon (purchasing)'; only 'whoever handles purchasing' if no one was named"),
  phone: z.string().nullable().describe("That person's direct line and/or extension if said on the call, e.g. '(925) 331-0573 x743'; else null"),
  email: z.string().nullable().describe("That person's email if known; else null"),
  pitch: z.string().describe("One line: what to say or ask on the callback"),
  details: z.string().nullable().describe("One line of context from the call, with the date; use names, never guessed roles like 'receptionist'"),
  why: z.string().nullable().describe("What set this date and person: a short quote from the call, or the §6 rule used"),
  deadline: z.string().nullable().describe("ISO 8601 with offset, their time, if the call gave a latest time to reach them ('he leaves at 2:30', 'in until 3'); else null"),
});

export const EmailProposal = z.object({
  to: z.array(z.object({ name: z.string().describe("The name as said on the call or in Close. Never work out a last name from the email address or its domain."), email: z.string() })),
  subject: z.string().describe("Use the subject lines from the Email & Product Knowledge Playbook §4"),
  body: z.string().describe("Plain text, 120–180 words, in short paragraphs separated by a blank line: the greeting on its own line, then 2–4 short paragraphs, the thanks line, and the rep's full name on its own line. No em dashes or en dashes."),
  attach_line_card: z.boolean().describe("True when the prospect asked for the line card or the body says it's attached"),
  address_as_heard: z.string().nullable().describe("If a recipient address came from the call, exactly how it sounded in the transcript; else null"),
});

export const StatusProposal = z.object({
  label: z.string().describe("Exactly one of the status labels the app lists"),
  reason: z.string(),
});

export const ProposalsSchema = z.object({
  note: NoteProposal.nullable(),
  contacts: z.array(ContactProposal).describe("Only people who aren't already contacts on the lead"),
  contact_updates: z.array(ContactUpdate).describe("New details about people who are already contacts: full name, title, email, direct line"),
  tasks: z.array(TaskProposal),
  email: EmailProposal.nullable(),
  status: StatusProposal.nullable(),
});
export type Proposals = z.infer<typeof ProposalsSchema>;

// After a call, the quick part (note, contacts, task, status) and the slow part
// (email draft, coaching) are written in parallel so the rep can approve the
// quick part without waiting on the email.
export const Outcome = z.enum(["conversation", "gatekeeper", "voicemail", "no_answer", "wrong_number", "other"]);

export const FollowUpSchema = z.object({
  situation: z.enum(["line_card_no_reply", "gatekeeper_buyer_out", "quote_sent", "nothing_right_now", "other"]).describe("What happened last: line card sent with no reply; reached a gatekeeper while the buyer was out; a quote was sent; the buyer said nothing right now; or other"),
  last_touch: z.string().describe("The last real touch in a few words, from the transcripts, notes, or emails (e.g. 'tried you by phone this morning', 'great talking Tuesday'). Only something that actually happened."),
  body: z.string().describe("The whole email body: greeting, 2 to 4 short sentences, a short thanks line, then the rep's full name on its own line. No em or en dashes."),
});
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const AfterCallSchema = z.object({
  outcome: Outcome,
  outcome_label: z.string().describe("3–4 words, e.g. 'Reached purchasing', 'Gatekeeper, got a name'"),
  summary: z.string().describe("What happened, 2–3 plain sentences"),
  no_current_rfq: z.boolean().describe("True if the buyer said they have nothing open right now: 'nothing right now', 'no open RFQs', 'bought for the year', 'nothing going on', 'not at the moment', 'maybe in a couple months', 'here and there', or the same idea in other words"),
  benchmark_agreed: z.boolean().describe("True only if the buyer agreed on the call to send a PAST RFQ, PO, or bid tab for us to price as a benchmark"),
  asked_specific_callback: z.boolean().describe("True if the buyer asked to be called back at a specific time or day ('call me at 2', 'try me Thursday')"),
  referral_gatekeeper: z.string().describe("Gatekeeper referral: Walt did NOT get the person he's following up with, and a receptionist or colleague on the call named that person (and usually gave or confirmed their email, or said to reach out or get in touch with them). Put that gatekeeper's first name (e.g. 'Hannah'; 'the receptionist' if they never said their name). Empty string only if Walt spoke directly to the buyer, or nobody was named."),
  referral_recipient: z.string().describe("For that referral: the full name of the person they referred Walt to. Otherwise empty."),
  referral_said: z.string().describe("For that referral: the one useful thing the gatekeeper said about the recipient, close to their words (e.g. 'she's helping the project teams with vendors and pricing right now'). Otherwise empty."),
  referral_back_when: z.string().describe("For that referral: when the recipient is back, if the gatekeeper said (e.g. 'next week', 'Monday'). Otherwise empty."),
  next_one_promised: z.boolean().describe("True if they have nothing now but said they'll send the NEXT one when it comes up ('I'll send you the next one', 'next time something comes up I'll shoot it your way'). False if they're sending something that exists now."),
  soft_yes: z.boolean().describe("True if the buyer already signaled they'd bring us work: 'send your info and we'll consider you', 'we'll keep you in mind for the next one', 'we'll add you to our bid list', 'maybe next week' about an upcoming quote. Just agreeing to receive the line card or info ('sure, send it', 'if you'd like to, you can') is NOT a soft yes."),
  rfq_promised: z.boolean().describe("True only if someone on the call said they will send a list, RFQ, drawing, or takeoff (or 'send it over'). An offer to maybe look isn't a promise."),
  proposals: ProposalsSchema.omit({ email: true }),
});
export type AfterCall = z.infer<typeof AfterCallSchema>;

export const AfterCallExtrasSchema = z.object({
  email: EmailProposal.nullable().describe("Null unless the rep promised to send something or the prospect asked for info"),
  coaching: z.object({
    nice: z.string().nullable().describe("One thing the rep did well, quoting the moment"),
    next: z.string().nullable().describe("One concrete thing to do better next time"),
  }),
});
export type AfterCallExtras = z.infer<typeof AfterCallExtrasSchema>;

export const ChatSchema = z.object({
  reply: z.string().describe("One or two sentences to the rep"),
  proposals: ProposalsSchema.describe("The complete updated set; unchanged items kept as-is"),
});
export type ChatResult = z.infer<typeof ChatSchema>;

// ---------- request bodies from the panel ----------

export const ChatTurn = z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) });

export const AfterCallRequest = z.object({
  call_id: z.string().nullable().optional(),
  rep_summary: z.string().max(2000).nullable().optional(), // one-liner when there's no transcript
  rating: Rating.nullable().optional(),
});

export const ChatRequest = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(ChatTurn).max(40).default([]),
  proposals: ProposalsSchema.nullable().optional(),
  rating: Rating.nullable().optional(),
});

export const QuickOutcome = z.enum(["reached_buyer", "got_name", "voicemail", "no_answer"]);
export type QuickOutcome = z.infer<typeof QuickOutcome>;

export const QuickOutcomeRequest = z.object({
  outcome: QuickOutcome,
  note: z.string().max(1000).nullable().optional(),
  call_id: z.string().nullable().optional(),
  rating: Rating.nullable().optional(),
  /** Changing a tap made by mistake (Walt 9/29): what the first tap saved, so it's replaced, not added to. */
  change: z.object({
    task_id: z.string().max(100).nullable().optional(),
    queued_id: z.string().max(100).nullable().optional(),
    prev_status: z.string().max(80).nullable().optional(),
    set_status: z.string().max(80).nullable().optional(),
  }).nullable().optional(),
});

export const QueueChatRequest = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(ChatTurn).max(40).default([]),
});

export const QueueApproveRequest = z.object({ proposals: ProposalsSchema.optional() });

export const ApplyRequest = z.object({
  proposals: ProposalsSchema,
  rating: Rating.nullable().optional(),
});

export const LineCardFormatRequest = z.object({ format: z.enum(["standard", "full_text", "niche", "contact_card", "vendor_row", "gatekeeper", "setup_packet", "pdf_only"]) });
