import type { Close, Llm } from "./assistant.js";
import type { CloseCall, CloseLead, CloseTask, LeadEmail } from "./close.js";
import { customFields, DEMO_USER_ID, roddaCall, roddaLead, statuses } from "./fixtures.js";
import { AfterCallExtrasSchema, AfterCallSchema, BriefSchema, ChatSchema, FollowUpSchema, type Proposals } from "./schemas.js";
import { PurchasingSchema } from "./purchasing.js";
import { isoWithOffset, nextWeekdayAt, suggestCallback } from "./rules.js";
import { EmailReviewSchema } from "./validate.js";

/**
 * In-memory stand-in for Close. Used by DEMO=1 and the tests. Writes are
 * recorded in `writes` instead of going anywhere.
 */
export class FakeClose implements Close {
  static ids = 0;
  writes: Array<{ op: string; body: unknown; id?: string }> = [];
  lead_: CloseLead;
  calls_: CloseCall[];
  /** Demo mode only: simulate a dial a few seconds after the panel starts watching. */
  simulateDial: boolean;
  private firstWatch: number | null = null;

  constructor(opts: { lead?: CloseLead; calls?: CloseCall[]; simulateDial?: boolean } = {}) {
    this.lead_ = opts.lead ?? roddaLead();
    this.calls_ = opts.calls ?? [];
    this.simulateDial = opts.simulateDial ?? false;
  }

  /** Tests can set a list of lead ids for the Smart View; every id resolves to the demo lead. */
  list: string[] | null = null;
  async smartViewLeads() {
    return (this.list ?? [this.lead_.id]).map((id) => ({ id, display_name: this.lead_.display_name }));
  }
  async me() {
    return {
      id: DEMO_USER_ID, first_name: "Walt", last_name: "Boxwell", email: "walt@westgatesupply.com", last_used_timezone: "America/Los_Angeles",
      email_accounts: [{ id: "emailacct_demo", email: "walt@westgatesupply.com", send_status: "ok", sender: { name: "Walt Boxwell", email: "walt@westgatesupply.com" } }],
    };
  }
  /** Other demo leads' names (the line card board). */
  names = new Map<string, string>();
  /** A lead's status once something changed it (Shot down, the funnel sync), so it reads back like Close. */
  leadStatus = new Map<string, string>();
  async lead(id?: string) { return { ...structuredClone(this.lead_), ...(id ? { id } : {}), ...(id && this.names.has(id) ? { display_name: this.names.get(id)! } : {}), ...(id && this.leadStatus.has(id) ? { status_label: this.leadStatus.get(id)! } : {}) }; }
  async callOutcomes() { return new Map<string, string>(); }
  async leadName(id: string) { return this.names.get(id) ?? this.lead_.display_name; }
  async leadStatuses() { return statuses; }
  async leadCustomFields() { return [...customFields, ...this.customFields_]; }
  async notes() { return []; }
  async openTasks(): Promise<CloseTask[]> { return []; }
  /** The simulated call: dialing 6s after the panel first polls, ends at 14s, transcript arrives at 20s. */
  private liveCall(): CloseCall | null {
    if (!this.simulateDial || this.firstWatch === null) return null;
    const t = (Date.now() - this.firstWatch) / 1000;
    if (t <= 6) return null;
    const call = roddaCall({ id: "acti_demoLiveCall000001", date_created: new Date(this.firstWatch + 6000).toISOString() });
    if (t < 14) return { ...call, status: "in-progress", disposition: null, recording_transcript: null };
    if (t < 20) return { ...call, recording_transcript: null };
    return call;
  }

  async call(id: string) {
    const c = [this.liveCall(), ...this.calls_].find((x) => x?.id === id);
    if (!c) throw new Error("not found");
    return c;
  }

  async calls(q: { leadId?: string; since: string }) {
    if (this.simulateDial && q.leadId) this.firstWatch ??= Date.now();
    const live = this.liveCall();
    const calls = live ? [live, ...this.calls_] : this.calls_;
    return calls.filter((c) => !q.leadId || c.lead_id === q.leadId).filter((c) => c.date_created >= q.since);
  }

  private record(op: string, body: unknown) {
    const id = `demo_${op}_${++FakeClose.ids}`; // unique across instances, like real Close ids
    this.writes.push({ op, body, id });
    return { id };
  }
  async createNote(leadId: string, note: string, pinned: boolean) { return this.record("note", { leadId, note, pinned }); }
  async createContact(leadId: string, c: unknown) { return this.record("contact", { leadId, ...(c as object) }); }
  async updateContact(contactId: string, patch: unknown) { return this.record("contact-update", { contactId, ...(patch as object) }); }
  private tasks_ = new Map<string, CloseTask & { lead_id: string; assigned_to: string }>();
  async createTask(leadId: string, text: string, dueAt: string, assignedTo: string) {
    const r = this.record("task", { leadId, text, dueAt, assignedTo });
    this.tasks_.set(r.id, { id: r.id, lead_id: leadId, assigned_to: assignedTo, text, date: dueAt, is_complete: false });
    return r;
  }
  async openTasksFor(userId: string) {
    return [...this.tasks_.values(), ...this.extraTasks].filter((t) => !t.is_complete && t.assigned_to === userId).map((t) => structuredClone(t));
  }
  /** Tasks on other demo leads (the accounts board). */
  extraTasks: Array<CloseTask & { lead_id: string; assigned_to: string }> = [];
  /** Tests make a fetch fail (Close timing out) for these ids. */
  emailFetchFails = new Set<string>();
  async email(id: string) {
    if (this.emailFetchFails.has(id)) throw new Error("The operation was aborted due to timeout");
    const w = this.writes.find((x) => x.op === "email" && x.id === id);
    if (!w) throw new Error("not found");
    const b = w.body as { leadId: string; to: string[]; subject: string; body: string; scheduleAt?: string | null };
    const status = this.statusOf.get(id) ?? (b.scheduleAt ? "scheduled" : "draft");
    return { id, lead_id: b.leadId, user_id: DEMO_USER_ID, status, to: b.to, subject: b.subject, body_text: b.body, date_scheduled: b.scheduleAt ?? null, date_sent: status === "sent" ? b.scheduleAt ?? null : null };
  }
  /** Tests move emails along (e.g. Close sent a scheduled one). */
  statusOf = new Map<string, string>();
  async sendDraft(id: string) {
    this.statusOf.set(id, "sent");
    this.writes.push({ op: "send", body: { id } });
    return { id, status: "outbox" };
  }
  async unschedule(id: string) {
    this.statusOf.set(id, "draft");
    this.writes.push({ op: "unschedule", body: { id } });
    return { id, status: "draft" };
  }
  customFields_: Array<{ id: string; name: string }> = [];
  leadFields_: Record<string, Record<string, unknown>> = {};
  async createLeadCustomField(body: { name: string; type: string }) { const f = { id: `cf_demo${this.customFields_.length + 1}`, name: body.name }; this.customFields_.push(f); this.record("custom-field", body); return f; }
  async updateLead(leadId: string, body: Record<string, unknown>) { this.leadFields_[leadId] = { ...(this.leadFields_[leadId] ?? {}), ...body }; this.record("lead-update", { leadId, ...body }); return { id: leadId }; }
  savedSearches_: Array<{ id: string; name: string; s_query: unknown }> = [];
  async savedSearches() { return this.savedSearches_.map(({ id, name }) => ({ id, name })); }
  async createSavedSearch(body: { name: string; s_query: unknown }) { const id = `save_demo${this.savedSearches_.length + 1}`; this.savedSearches_.push({ id, name: body.name, s_query: body.s_query }); this.record("saved-search", body); return { id }; }
  async updateSavedSearch(id: string, body: { name?: string; s_query: unknown }) { const v = this.savedSearches_.find((x) => x.id === id); if (v) { v.s_query = body.s_query; if (body.name) v.name = body.name; } this.record("saved-search-update", { id, ...body }); return { id }; }

  async deleteEmail(id: string) {
    this.statusOf.set(id, "deleted");
    this.writes.push({ op: "delete", body: { id } });
  }
  async task(id: string) {
    const t = this.tasks_.get(id);
    if (!t) throw new Error("not found");
    return structuredClone(t);
  }
  templateAttachments: Array<{ url: string; filename: string; content_type: string; size: number }> = [
    { url: "https://example.test/Westgate_Supply_Line_Card.pdf", filename: "Westgate_Supply_Line_Card.pdf", content_type: "application/pdf", size: 41014 },
  ];
  async emailTemplateAttachments() { return this.templateAttachments; }
  sentWithOpens: LeadEmail[] = [];
  async leadEmails(leadId?: string) { return this.sentWithOpens.length ? this.sentWithOpens : (this.sentEmails.filter((e) => e.lead_id === leadId) as unknown as LeadEmail[]); }
  async phoneNumbers() { return [{ number: "+17372582165", user_id: DEMO_USER_ID, label: null }, { number: "+17372349440", user_id: "user_someoneelse", label: "Berni" }]; }
  statusChanges: Array<{ lead_id: string; date_created: string; old_status_label: string | null; new_status_label: string }> = [];
  async statusChangesSince(since: string) { return this.statusChanges.filter((s) => s.date_created >= since); }
  async findLeads(_query: string) { return [] as Array<{ id: string; display_name: string }>; }
  async completeTask(taskId: string) {
    const t = this.tasks_.get(taskId) ?? this.extraTasks.find((x) => x.id === taskId);
    if (t) t.is_complete = true;
    return this.record("task-complete", { taskId });
  }
  async updateTask(taskId: string, patch: { date: string; text?: string }) {
    const t = this.tasks_.get(taskId);
    if (t) Object.assign(t, { date: patch.date }, patch.text ? { text: patch.text } : {});
    return this.record("task-update", { taskId, ...patch });
  }
  async createDraftEmail(leadId: string, e: unknown) { return this.record("email", { leadId, ...(e as object) }); }
  async updateLeadStatus(leadId: string, statusId: string) {
    const s = statuses.find((x) => x.id === statusId);
    if (s) this.leadStatus.set(leadId, s.label);
    return this.record("status", { leadId, statusId });
  }
  /** Sent and received emails for the stats (drafts are never sent here, so tests add these directly). */
  sentEmails: Array<Record<string, unknown>> = [];
  /** Notes from earlier days, for the stats. */
  olderNotes: Array<Record<string, unknown>> = [];
  private stamps = new WeakMap<object, string>();
  clock: () => Date = () => new Date();
  async listSince<T>(kind: "email" | "note" | "task", q: { since: string }): Promise<T[]> {
    if (kind === "email") return this.sentEmails.filter((e) => String(e.date_created ?? e.date_sent) >= q.since) as T[];
    const stamp = (w: object) => { if (!this.stamps.has(w)) this.stamps.set(w, this.clock().toISOString()); return this.stamps.get(w)!; };
    const older = kind === "note" ? this.olderNotes.filter((n) => String(n.date_created) >= q.since) as T[] : [];
    return [...older, ...this.writes.filter((w) => w.op === kind).map((w) => {
      const b = w.body as Record<string, unknown>;
      return { id: `demo_${kind}`, lead_id: b.leadId, note: b.note, user_id: DEMO_USER_ID, created_by: DEMO_USER_ID, date_created: stamp(w) } as T;
    })];
  }
}

const tz = "America/Los_Angeles";

export function demoProposals(): Proposals {
  return {
    note: {
      text: "Reached Renee, who's covering purchasing while Rob Roy (Purchasing Manager) is on leave until Oct 12. They buy threaded rod, anchors, fasteners, enclosures daily. Renee will check tomorrow's orders. Ask for Renee until Rob is back.",
      pinned: true,
    },
    contact_updates: [],
    contacts: [
      { name: "Renee", title: "Covering purchasing while Rob is out", email: null, phone: null, verify_email: false },
      { name: "Rob Roy", title: "Purchasing Manager", email: "rob@roddaelectric.com", phone: null, verify_email: true },
    ],
    tasks: [
      {
        due_at: isoWithOffset(suggestCallback(tz), tz),
        title: "Follow up with Renee on today's orders",
        ask_for: "Renee",
        phone: null,
        email: null,
        why: "She said she'd check today's orders",
        deadline: null,
        pitch: "Ask what came in that she can send over.",
        details: null,
      },
      {
        due_at: isoWithOffset(nextWeekdayAt(tz, new Date("2026-10-12T19:00:00Z"), 9, 30), tz),
        title: "Intro call with Rob Roy when he's back",
        ask_for: "Rob Roy (Purchasing Manager)",
        phone: null,
        email: "rob@roddaelectric.com",
        why: "Rob's on leave until Oct 12",
        deadline: null,
        pitch: "Introduce yourself; mention you've been working with Renee.",
        details: null,
      },
    ],
    email: {
      to: [{ name: "Rob Roy", email: "rob@roddaelectric.com" }],
      subject: "Great talking with you – Westgate Supply line card",
      body: "Hi Rob,\n\nI spoke with Renee this afternoon while you're out, and she suggested I send this your way. I've attached our line card so you and Renee both have it handy.\n\nFor an electrical contractor like Rodda we cover the hardware your crews go through every day: threaded rod, anchors, beam clamps, U-bolts and pipe supports, and hot-dip galvanized bolting, plus plate and angle for supports. We're a national supplier, and we're opening a local warehouse in your area, so you'll get fast quotes and quick turnaround.\n\nSend over any list in whatever format is easiest and I'll price it.\n\nRenee mentioned she gets orders in daily, so send over any list whenever it's easiest.\n\nHave a great rest of your day!\n\nWalt Boxwell",
      attach_line_card: true,
      address_as_heard: "Rob. Rob. At Roda R O D Dalectric",
    },
    status: { label: "Sent Line Card", reason: "Line card promised and drafted; Renee buys daily." },
  };
}

/** Canned Claude responses so the panel can be tried without an API key. */
export const demoLlm: Llm = async (opts) => {
  await new Promise((r) => setTimeout(r, 700));
  // Canned answers go through the real schema, so the fixtures can't drift from it.
  return { data: opts.schema.parse(canned(opts.schema, opts.task)), usage: {} as never };
};

function canned(schema: unknown, task: string): unknown {
  if (schema === EmailReviewSchema) return { failures: [] };
  // The purchasing cycle, as Renee says it on the Rodda demo call.
  if (schema === PurchasingSchema) return {
    rfq_volume: { value: "~5/week", quote: "we send out maybe five a week" }, rfq_timing: null, buying_mode: { value: "project", quote: "it's all job by job for us" },
    vendor_policy: { value: "open bid", quote: "we'll send it to whoever can turn it around" }, how_to_get_on_list: null, works_through: null, buyer_count: { value: "2", quote: "it's me and Dave" },
    incumbent: null, cycle_notes: null,
  };
  if (schema === FollowUpSchema) {
    // Greets whoever the task says to (Renee on the Rodda demo lead).
    const name = task.match(/greet them as ([A-Z][a-zA-Z'-]+)/)?.[1] ?? "Renee";
    return {
      situation: "line_card_no_reply",
      last_touch: "tried you by phone this morning",
      body: `Hi ${name},\n\nI wanted to check in on this. I tried you by phone this morning too. Reply here with your RFQ or list and I'll price it.\n\nWalt Boxwell`,
    };
  }
  if (schema === BriefSchema) {
    return {
      rating: "B",
      fit_summary: "Self-performing electrical contractor. Buys threaded rod, anchors, beam clamps and HDG hardware on daily orders.",
      company_type: "Commercial electrical contractor",
      ask_for: { name: "Renee", role: "covering purchasing for Rob Roy (back Oct 12)" },
      // PVF first (10/5). Rodda is an electrical contractor, so the card flags it and keeps the pitch for their trade ready.
      opener: "Hi Renee, this is Walt with Westgate Supply. We talked yesterday. We supply pipe, valves, fittings and flanges, and the bolting that goes with them.",
      ask: "You mentioned you'd look at today's orders. Anything on there you can shoot over? A list, a photo, a PDF, and I'll turn pricing around quick.",
      objection: "We already have a supplier",
      objection_response: "Totally fine, I'm not asking you to switch anyone. Just put us on the list for the next one. With a local warehouse opening near you, if something's hot you won't be waiting on a truck from out of state.",
      buys: ["Pipe", "Valves", "Fittings", "Flanges", "Gaskets", "Stud bolts"],
      pvf_fit: "likely_not",
      pvf_reason: "Electrical contractor: conduit and supports, little process piping.",
      alt_opener: "Hi Renee, this is Walt with Westgate Supply. We talked yesterday. We're a national supplier opening a local warehouse in your area, so threaded rod, anchors and bolting will be close by.",
      alt_buys: ["Threaded rod", "Anchors", "Beam clamps", "U-bolts & pipe supports", "HDG bolting", "Plate & angle"],
      heads_ups: [
        "Rob's email came through the transcript as \"Roda R O D Dalectric\". Confirm rob@roddaelectric.com.",
        "Renee has no direct line or email on file. Ask for both.",
      ],
      what_they_do: "Commercial and industrial electrical contractor since 1998. Distribution centers, office TI, critical facilities across California.",
      capture: ["Renee's direct email", "Her direct line", "When the next order list goes out"],
      hometown: { event: "Brentwood CornFest", opener: "Quick one before we start: I've got a made-up childhood memory about Brentwood, want it?", story: "My mom took me to CornFest when I was eight and it was about a hundred degrees out. I ate two ears of corn on a stick and then got talked into the kiddie tractor pull and lost to a girl half my size. I still think about that tractor pull more than I should." },
    };
  }
  if (schema === AfterCallSchema) {
    return {
      outcome: "conversation", outcome_label: "Reached purchasing", rfq_promised: true, no_current_rfq: false, benchmark_agreed: false, asked_specific_callback: false, soft_yes: false, next_one_promised: false, referral_gatekeeper: "", referral_recipient: "", referral_said: "", referral_back_when: "",
      summary: "Rob Roy is on leave until Oct 12. Renee is covering purchasing, reads his inbox, and gets orders daily. She said \"we always need that stuff\" and will look at tomorrow's orders for us.",
      proposals: demoProposals(),
    };
  }
  if (schema === AfterCallExtrasSchema) {
    return {
      email: demoProposals().email,
      coaching: {
        nice: "When Rob was out, you asked \"Is there another purchasing manager?\" instead of hanging up.",
        next: "Get Renee's own email before you hang up, so follow-ups don't depend on Rob's inbox.",
      },
    };
  }
  if (schema === ChatSchema) {
    const current = JSON.parse(task.match(/\(not yet saved to Close\):\n([\s\S]*?)\n\nThe rep says:/)?.[1] ?? "null") as Proposals | null;
    return {
      reply: "Demo mode: I kept the proposals as they were. With a Claude API key I'd make that change.",
      proposals: current ?? { note: null, contacts: [], contact_updates: [], tasks: [], email: null, status: null },
    };
  }
  throw new Error("demoLlm: unknown schema");
}

/** Made-up line card emails for the demo web app: one of each situation. */
export function demoLineCards(fake: FakeClose, now = new Date()) {
  const at = (days: number, mins = 0) => new Date(now.getTime() - days * 86400000 + mins * 60000).toISOString();
  const scanner = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  const outlook = "Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)";
  const card = [{ filename: "Westgate_Supply_Line_Card.pdf" }];
  const leads: Array<[string, string, string, number, Array<{ opened_at: string; opened_by: string; user_agent: string }>, number | null]> = [
    // 4 days, not 3: unopened cards become a rescue call after 2 business days (10/5), and 4 calendar days always hold 2.
    ["lead_demoHarborFab000001", "Harbor Fabrication", "Dana Ruiz <dana@harborfab.test>", 4, [], null],
    ["lead_demoMesaPipe0000001", "Mesa Pipe & Supply", "Luis Ortega <luis@mesapipe.test>", 4, [{ opened_at: at(4, 1), opened_by: "luis@mesapipe.test", user_agent: scanner }], null],
    ["lead_demoCrestMech000001", "Crest Mechanical", "Amy Chen <amy@crestmech.test>", 9, [{ opened_at: at(8), opened_by: "amy@crestmech.test", user_agent: outlook }, { opened_at: at(6), opened_by: "amy@crestmech.test", user_agent: outlook }, { opened_at: at(5), opened_by: "amy@crestmech.test", user_agent: outlook }], null],
    ["lead_demoNorthline000001", "Northline Controls", "Pat Kim <pat@northline.test>", 5, [{ opened_at: at(4), opened_by: "pat@northline.test", user_agent: outlook }], 3],
    ["lead_demoValleyWeld00001", "Valley Welding", "Sam Price <sam@valleyweld.test>", 1, [], null],
    ["lead_demoIronGate0000001", "Iron Gate Structures", "Jo Allen <jo@irongate.test>", 3, [{ opened_at: at(2), opened_by: "jo@irongate.test", user_agent: outlook }], null],
  ];
  const task = (lead_id: string, text: string, inDays: number) => fake.extraTasks.push({ id: `task_${lead_id}`, lead_id, assigned_to: DEMO_USER_ID, text, date: at(-inDays), is_complete: false });
  task("lead_demoMesaPipe0000001", "[B] Call back Luis Ortega (Purchasing) at Mesa Pipe & Supply", 0);
  task("lead_demoIronGate0000001", "[B] Check in with Jo Allen (Purchasing) at Iron Gate Structures", 12);
  for (const [id, name, to, days, opens, repliedDaysAgo] of leads) {
    fake.names.set(id, name);
    fake.sentEmails.push({ id: `acti_${id}`, lead_id: id, user_id: DEMO_USER_ID, status: "sent", direction: "outgoing", subject: "Westgate Supply – line card", date_sent: at(days), date_created: at(days), opens, to: [to], attachments: card });
    if (repliedDaysAgo !== null) fake.sentEmails.push({ id: `acti_r_${id}`, lead_id: id, user_id: DEMO_USER_ID, status: "inbox", direction: "incoming", subject: "RE: Westgate Supply – line card", date_sent: at(repliedDaysAgo), date_created: at(repliedDaysAgo), sender: to, opens: [] });
  }
}
