import { config } from "./config.js";

// Thin Close REST client. Each rep uses their own Close API key, so every read
// and write is logged in Close under that rep.

export class CloseError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export type CloseLead = {
  id: string;
  display_name: string;
  name: string;
  url: string | null;
  description: string | null;
  status_id: string;
  status_label: string;
  addresses: Array<{ city?: string; state?: string; country?: string }>;
  contacts: CloseContact[];
  [key: `custom.${string}`]: unknown;
};

export type CloseContact = {
  id: string;
  name: string;
  title: string | null;
  emails: Array<{ email: string; type: string }>;
  phones: Array<{ phone: string; type: string }>;
};

export type CloseCall = {
  id: string;
  lead_id: string;
  user_id: string;
  contact_id: string | null;
  direction: "inbound" | "outbound";
  status: string;
  disposition: string | null;
  duration: number;
  remote_phone: string | null;
  note: string | null;
  date_created: string;
  /** The outcome the rep picked in Close ("Answered - Send Line Card"). */
  outcome_id?: string | null;
  recording_transcript?: CloseTranscript | null;
  voicemail_transcript?: CloseTranscript | null;
};

export type CloseTranscript = {
  summary_text?: string | null;
  utterances?: Array<{ speaker_label?: string; speaker_side?: string; start?: number; text: string }>;
};

export type CloseNote = { id: string; note: string; date_created: string; user_name?: string; pinned?: boolean };
export type CloseTask = { id: string; text: string; date: string; is_complete: boolean; assigned_to_name?: string };
export type CloseStatus = { id: string; label: string };
export type CloseAttachment = { url: string; filename: string; content_type: string; size: number; content_id?: string | null; inline_only?: boolean };
export type CloseMe = {
  id: string; first_name: string; last_name: string; email: string; last_used_timezone?: string | null;
  email_accounts?: Array<{ id: string; email: string; send_status?: string; sender?: { name?: string; email?: string } | null }>;
};

const CALL_FIELDS = [
  "id", "lead_id", "user_id", "contact_id", "direction", "status", "disposition", "duration",
  "remote_phone", "note", "date_created", "outcome_id", "recording_transcript", "voicemail_transcript",
].join(",");

/** An email on a lead, with what threading and open tracking need. */
export type LeadEmail = {
  id: string;
  status: string; // sent | inbox | draft | scheduled | outbox | error
  direction: string; // outgoing | incoming
  subject: string | null;
  date_sent: string | null;
  date_created?: string | null;
  opens: Array<{ opened_at: string; opened_by: string | null; user_agent?: string | null }> | null;
  thread_id?: string | null;
  sender?: string | null;
  to?: string[] | null;
  contact_id?: string | null;
  body_text?: string | null;
  attachments?: Array<{ filename?: string; content_type?: string }> | null;
};

/** A simple counting gate: at most `max` callers inside at once, the rest wait their turn. */
class Gate {
  private inside = 0;
  private waiting: Array<() => void> = [];
  constructor(private max: number) {}
  async enter() {
    if (this.inside < this.max) { this.inside++; return; }
    await new Promise<void>((r) => this.waiting.push(r));
  }
  leave() {
    const next = this.waiting.shift();
    if (next) next(); else this.inside--;
  }
}
const gates = new Map<string, Gate>();

export class CloseClient {
  constructor(private apiKey: string) {}

  private async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    // At most a few calls in flight per API key (10/8): a page load, the morning run and the checks all share one
    // Close rate limit, and firing 30 at once got 429s ("Couldn't load everything").
    const gate = gates.get(this.apiKey) ?? new Gate(5);
    gates.set(this.apiKey, gate);
    await gate.enter();
    let res: Response;
    try {
      res = await this.fetchOnce(method, path, body);
    } finally {
      gate.leave();
    }
    if (res.status === 429 && attempt < 6) {
      // Close says how long to wait (Retry-After, or rate_reset in the body); else back off 1, 2, 4… seconds.
      const said = Number(res.headers.get("retry-after") ?? NaN);
      const reset = Number(((await res.json().catch(() => null)) as { error?: { rate_reset?: number } } | null)?.error?.rate_reset ?? NaN);
      const wait = [said, reset].find((x) => Number.isFinite(x) && x > 0) ?? 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, 0.5), 15) * 1000 + Math.random() * 300));
      return this.request(method, path, body, attempt + 1);
    }
    return this.read<T>(method, path, res);
  }

  private fetchOnce(method: string, path: string, body?: unknown) {
    return fetch(`${config.closeBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  }

  private async read<T>(method: string, path: string, res: Response): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CloseError(`Close ${method} ${path.split("?")[0]} failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  me() {
    return this.request<CloseMe>("GET", "/me/?_fields=id,first_name,last_name,email,last_used_timezone,email_accounts");
  }

  /** Emails on one lead with their open tracking (who opened, when). */
  async leadEmails(leadId: string): Promise<LeadEmail[]> {
    const p = new URLSearchParams({ lead_id: leadId, _limit: "100", _fields: "id,status,direction,subject,date_sent,date_created,opens,thread_id,sender,to,contact_id,body_text,attachments" });
    return (await this.request<{ data: never[] }>("GET", `/activity/email/?${p}`)).data;
  }

  /** The org's Close phone numbers (E.164 plus the owner), so each rep can see their own line. */
  async phoneNumbers(): Promise<Array<{ number: string; user_id: string | null; label: string | null }>> {
    const r = await this.request<{ data: Array<{ number: string; user_id: string | null; label: string | null }> }>("GET", "/phone_number/?_limit=100&_fields=number,user_id,label");
    return r.data;
  }

  lead(id: string) {
    return this.request<CloseLead>("GET", `/lead/${encodeURIComponent(id)}/`);
  }

  /** The call outcomes set up in Close (id → name), e.g. "Answered - Send Line Card". */
  async callOutcomes(): Promise<Map<string, string>> {
    const r = await this.request<{ data: Array<{ id: string; name: string }> }>("GET", "/outcome/?_limit=100");
    return new Map(r.data.map((o) => [o.id, o.name]));
  }

  /** Just the company name (the stats tables). */
  leadName(id: string) {
    return this.request<{ display_name: string }>("GET", `/lead/${encodeURIComponent(id)}/?_fields=id,display_name`).then((l) => l.display_name);
  }

  leadCustomFields() {
    return this.request<{ data: Array<{ id: string; name: string }> }>("GET", "/custom_field/lead/?_fields=id,name&_limit=100").then((r) => r.data);
  }

  /** Lead ids in a Smart View, in the view's own sort order. */
  async smartViewLeads(id: string, limit: number): Promise<Array<{ id: string; display_name: string }>> {
    const sv = await this.request<{ s_query?: { query?: unknown; sort?: unknown } }>("GET", `/saved_search/${encodeURIComponent(id)}/?_fields=s_query`);
    if (!sv.s_query?.query) return [];
    const r = await this.request<{ data: Array<{ id: string; display_name: string }> }>("POST", "/data/search/", {
      query: sv.s_query.query,
      ...(sv.s_query.sort ? { sort: sv.s_query.sort } : {}),
      results_limit: limit,
      _limit: limit,
      _fields: { lead: ["id", "display_name"] },
    });
    return r.data;
  }

  leadStatuses() {
    return this.request<{ data: CloseStatus[] }>("GET", "/status/lead/").then((r) => r.data);
  }

  /**
   * Calls, newest first. Close doesn't document sorting on this endpoint, so we
   * page through the (date-bounded) results and sort here. Transcripts are
   * only returned when asked for in _fields.
   */
  async calls(q: { leadId?: string; since: string; withTranscripts?: boolean; max?: number }): Promise<CloseCall[]> {
    const fields = q.withTranscripts === false ? CALL_FIELDS.replace(/,recording_transcript,voicemail_transcript$/, "") : CALL_FIELDS;
    const out: CloseCall[] = [];
    const max = q.max ?? 500;
    for (let skip = 0; skip < max; skip += 100) {
      const p = new URLSearchParams({ _fields: fields, _limit: "100", _skip: String(skip), date_created__gte: q.since });
      if (q.leadId) p.set("lead_id", q.leadId);
      const page = await this.request<{ data: CloseCall[]; has_more: boolean }>("GET", `/activity/call/?${p}`);
      out.push(...page.data);
      if (!page.has_more) break;
    }
    return out.sort((a, b) => b.date_created.localeCompare(a.date_created));
  }

  /** Every email, note, or task created since a date (org-wide unless userId is given). Bounds are re-checked by the caller. */
  async listSince<T = Record<string, unknown>>(kind: "email" | "note" | "task", q: { since: string; userId?: string; fields: string; max?: number }): Promise<T[]> {
    const base = { email: "/activity/email/", note: "/activity/note/", task: "/task/" }[kind];
    const out: T[] = [];
    for (let skip = 0; skip < (q.max ?? 1000); skip += 100) {
      const p = new URLSearchParams({ _fields: q.fields, _limit: "100", _skip: String(skip), date_created__gte: q.since });
      if (kind === "task") p.set("_type", "all");
      if (q.userId && kind !== "task") p.set("user_id", q.userId);
      const page = await this.request<{ data: T[]; has_more: boolean }>("GET", `${base}?${p}`);
      out.push(...page.data);
      if (!page.has_more) break;
    }
    return out;
  }

  call(id: string) {
    return this.request<CloseCall>("GET", `/activity/call/${encodeURIComponent(id)}/?_fields=${CALL_FIELDS}`);
  }

  notes(leadId: string, limit = 10) {
    const p = new URLSearchParams({ lead_id: leadId, _limit: "100", _fields: "id,note,date_created,user_name,pinned" });
    return this.request<{ data: CloseNote[] }>("GET", `/activity/note/?${p}`).then((r) =>
      r.data.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.date_created.localeCompare(a.date_created)).slice(0, limit),
    );
  }

  openTasks(leadId: string) {
    const p = new URLSearchParams({ lead_id: leadId, is_complete: "false", _limit: "20" });
    return this.request<{ data: CloseTask[] }>("GET", `/task/?${p}`).then((r) => r.data);
  }

  // ---------- writes (only ever called from /apply, after the rep approves) ----------

  createNote(leadId: string, note: string, pinned: boolean) {
    return this.request<{ id: string }>("POST", "/activity/note/", { lead_id: leadId, note, ...(pinned ? { pinned: true } : {}) });
  }

  createContact(leadId: string, c: { name: string; title: string | null; email: string | null; phone: string | null }) {
    return this.request<{ id: string }>("POST", "/contact/", {
      lead_id: leadId,
      name: c.name,
      ...(c.title ? { title: c.title } : {}),
      emails: c.email ? [{ email: c.email, type: "office" }] : [],
      phones: c.phone ? [{ phone: c.phone, type: "office" }] : [],
    });
  }

  updateContact(contactId: string, patch: { name?: string; title?: string; emails?: Array<{ email: string; type: string }>; phones?: Array<{ phone: string; type: string }> }) {
    return this.request<{ id: string }>("PUT", `/contact/${encodeURIComponent(contactId)}/`, patch);
  }

  createTask(leadId: string, text: string, dueAt: string, assignedTo: string) {
    return this.request<{ id: string }>("POST", "/task/", { _type: "lead", lead_id: leadId, text, date: dueAt, assigned_to: assignedTo });
  }

  /** Every open task assigned to a user, across all leads (the accounts board). */
  async openTasksFor(userId: string, max = 1000): Promise<Array<CloseTask & { lead_id: string }>> {
    const out: Array<CloseTask & { lead_id: string }> = [];
    for (let skip = 0; skip < max; skip += 100) {
      const p = new URLSearchParams({ _type: "lead", is_complete: "false", assigned_to: userId, _limit: "100", _skip: String(skip), _fields: "id,lead_id,text,date,is_complete,date_created" });
      const page = await this.request<{ data: Array<CloseTask & { lead_id: string }>; has_more: boolean }>("GET", `/task/?${p}`);
      out.push(...page.data);
      if (!page.has_more) break;
    }
    return out;
  }

  /** One email: whose it is and whether it's still a draft (checked before sending). */
  email(id: string) {
    return this.request<{ id: string; lead_id: string; user_id: string; status: string; to: string[]; subject: string; body_text?: string; date_scheduled?: string | null; date_sent?: string | null }>(
      "GET", `/activity/email/${encodeURIComponent(id)}/?_fields=id,lead_id,user_id,status,to,subject,body_text,date_scheduled,date_sent`);
  }

  /** Rewrite a draft's body (text and HTML) and attachments. Drafts only; never sends. */
  updateDraft(id: string, patch: { body: string; attachments: CloseAttachment[]; subject?: string }) {
    const html = patch.body.split(/\n\s*\n/).map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`).join("");
    return this.request<{ id: string; status: string }>("PUT", `/activity/email/${encodeURIComponent(id)}/`, { body_text: patch.body, body_html: html, attachments: patch.attachments, ...(patch.subject ? { subject: patch.subject } : {}) });
  }

  /** Send a draft now. Only when the rep clicks Send in the side panel during the rescue call. */
  sendDraft(id: string) {
    return this.request<{ id: string; status: string }>("PUT", `/activity/email/${encodeURIComponent(id)}/`, { status: "outbox" });
  }

  /** Delete a draft: a rescue draft that a scheduled bump has made redundant (Walt 10/2: never two emails). */
  /** Smart Views (saved searches), for the call lists the assistant keeps in Close (10/6). */
  savedSearches() {
    return this.request<{ data: Array<{ id: string; name: string }> }>("GET", "/saved_search/?_fields=id,name&_limit=100").then((r) => r.data);
  }
  createSavedSearch(body: { name: string; type: "lead"; is_shared: boolean; s_query: unknown }) {
    return this.request<{ id: string }>("POST", "/saved_search/", body);
  }
  updateSavedSearch(id: string, body: { name?: string; s_query: unknown }) {
    return this.request<{ id: string }>("PUT", `/saved_search/${encodeURIComponent(id)}/`, body);
  }

  deleteEmail(id: string) {
    return this.request<void>("DELETE", `/activity/email/${encodeURIComponent(id)}/`);
  }

  /** Pull a scheduled email back to a draft (Skip, or they replied before it went out). */
  unschedule(id: string) {
    return this.request<{ id: string; status: string }>("PUT", `/activity/email/${encodeURIComponent(id)}/`, { status: "draft" });
  }


  /** One task, to check whose it is and read back what the tap wrote. */
  task(taskId: string) {
    return this.request<CloseTask & { lead_id: string; assigned_to: string }>("GET", `/task/${encodeURIComponent(taskId)}/?_fields=id,lead_id,assigned_to,text,date,is_complete`);
  }

  /** A rep's lead status changes since a date (e.g. to "RFQ Received"), oldest first. */
  async statusChangesSince(since: string, userId: string, max = 3000): Promise<Array<{ lead_id: string; date_created: string; old_status_label: string | null; new_status_label: string }>> {
    const out: Array<{ lead_id: string; date_created: string; old_status_label: string | null; new_status_label: string }> = [];
    for (let skip = 0; skip < max; skip += 100) {
      const p = new URLSearchParams({ user_id: userId, date_created__gte: since, _limit: "100", _skip: String(skip), _fields: "lead_id,date_created,old_status_label,new_status_label" });
      const r = await this.request<{ data: typeof out; has_more?: boolean }>("GET", `/activity/status_change/lead/?${p}`);
      out.push(...r.data);
      if (!r.has_more || r.data.length < 100) break;
    }
    return out.sort((a, b) => a.date_created.localeCompare(b.date_created));
  }

  /** Leads matching a Close search query (e.g. name:"Test Lead Fabrication"). */
  async findLeads(query: string) {
    const p = new URLSearchParams({ query, _fields: "id,display_name", _limit: "25" });
    return (await this.request<{ data: Array<{ id: string; display_name: string }> }>("GET", `/lead/?${p}`)).data;
  }

  /** Mark done (it stays in Close's history; nothing is deleted). */
  completeTask(taskId: string) {
    return this.request<{ id: string }>("PUT", `/task/${encodeURIComponent(taskId)}/`, { is_complete: true });
  }

  updateTask(taskId: string, patch: { date: string; text?: string }) {
    return this.request<{ id: string }>("PUT", `/task/${encodeURIComponent(taskId)}/`, patch);
  }

  emailTemplateAttachments(templateId: string) {
    return this.request<{ attachments?: CloseAttachment[] }>("GET", `/email_template/${encodeURIComponent(templateId)}/?_fields=attachments`).then((t) => t.attachments ?? []);
  }

  // status "draft" is never sent; the rep reviews and sends it from Close.
  createDraftEmail(leadId: string, e: { contactId: string | null; to: string[]; subject: string; body: string; html?: string | null; attachments?: CloseAttachment[]; sender?: string | null; emailAccountId?: string | null; inReplyToId?: string | null; threadId?: string | null; scheduleAt?: string | null }) {
    return this.request<{ id: string }>("POST", "/activity/email/", {
      lead_id: leadId,
      ...(e.contactId ? { contact_id: e.contactId } : {}),
      // Automatic bumps are scheduled in Close, which sends them at that time; everything else is a draft.
      ...(e.scheduleAt ? { status: "scheduled", date_scheduled: e.scheduleAt } : { status: "draft" }),
      // Without a sender and account, Close shows an empty "From" and can drop the draft when it's changed.
      ...(e.sender ? { sender: e.sender } : {}),
      ...(e.emailAccountId ? { email_account_id: e.emailAccountId } : {}),
      to: e.to,
      subject: e.subject,
      body_text: e.body,
      // An HTML version too when there's something to show inline (a meme in a bump, 9/30).
      ...(e.html ? { body_html: e.html } : {}),
      ...(e.attachments?.length ? { attachments: e.attachments } : {}),
      // A reply stays in the existing thread: same thread, under the email it answers.
      ...(e.inReplyToId ? { in_reply_to_id: e.inReplyToId } : {}),
      ...(e.threadId ? { thread_id: e.threadId } : {}),
    });
  }

  /** Any lead fields, including custom ones ({ "custom.cf_x": value }). */
  updateLead(leadId: string, body: Record<string, unknown>) {
    return this.request<{ id: string }>("PUT", `/lead/${encodeURIComponent(leadId)}/`, body);
  }
  createLeadCustomField(body: { name: string; type: "date" | "text" | "number" }) {
    return this.request<{ id: string; name: string }>("POST", "/custom_field/lead/", body);
  }
  updateLeadStatus(leadId: string, statusId: string) {
    return this.request<{ id: string }>("PUT", `/lead/${encodeURIComponent(leadId)}/`, { status_id: statusId });
  }
}

/** Plain-text transcript in the same "Speaker @ m:ss: text" shape Close shows in the app. */
export function transcriptText(t: CloseTranscript | null | undefined): string | null {
  if (!t?.utterances?.length) return null;
  // When both sides carry the same name (a test call to the rep's own phone, or a mislabel), name them by side:
  // the rep is "close-user", the prospect "contact". The extraction reads the full transcript either way.
  const bySide = new Map<string, Set<string>>();
  for (const u of t.utterances) if (u.speaker_side && u.speaker_label) bySide.set(u.speaker_label, (bySide.get(u.speaker_label) ?? new Set()).add(u.speaker_side));
  const collide = [...bySide.values()].some((sides) => sides.size > 1);
  const who = (u: { speaker_label?: string; speaker_side?: string }) =>
    collide && u.speaker_side ? (u.speaker_side === "close-user" ? `Rep (${u.speaker_label ?? "rep"})` : "Prospect") : (u.speaker_label ?? u.speaker_side ?? "Speaker");
  return t.utterances
    .map((u) => {
      const s = Math.floor(u.start ?? 0);
      return `${who(u)} @ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}: ${u.text}`;
    })
    .join("\n");
}

export function customField(lead: CloseLead, id: string): unknown {
  return lead[`custom.${id}`];
}
