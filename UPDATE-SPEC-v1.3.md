# Westgate Sales Assistant — Update Spec v1.3

Context for Claude Code: this repo is a Chrome side panel (`extension/`, Manifest V3, plain JS) plus a Node/TypeScript backend (`server/`) that calls the Claude API and the Close CRM API. The playbook (the model's standing instructions) is `server/playbook/westgate-playbook.md`. Nothing is written to Close until the rep taps **Approve** (`POST /api/leads/:id/apply`). Run tests with `cd server && npm test` (uses `BRIEF_CACHE_FILE=off`).

Part A is **new work to implement**. Part B documents **changes already made** in v1.1–v1.3, so the code and this spec agree; verify them and fix anything that doesn't match.

---

## Part A — NEW: callback tasks name the person from the transcript

### Problem
After a call, the callback task often says "call whoever handles purchasing" or the old contact on file, even when the transcript names exactly who to call next, e.g. the receptionist transfers to "Matt Michon, ext 743", or "Kenny in procurement, his direct line is 925-555-0142". The rep then has to dig through the transcript to find the name and extension.

### Requirement
When a follow-up task is created (by the after-call quick part or by Lead Chat), and the transcript identifies the person the rep should reach next, the task must name that person and include any direct line, extension, or email they gave.

**Who to call next, in priority order:**
1. The person the transcript says to call or who is handling the next step, e.g. "Matt will send the list", "call Kenny tomorrow", or "Rob's back Oct 12, reach out then" (a task dated for that day).
2. The person named in an open task on the lead.
3. A Close contact whose title is purchasing, buyer, or procurement.
4. "whoever handles purchasing"

**Contact details, taken only when actually said on the call:**
- Extension, e.g. "ext 743", "extension seven four three"
- Direct phone number, e.g. "my direct is 925-555-0142"
- Email, spelled out or said

Normalize them: phone as `(925) 555-0142`, extension as `x743`. Speech-to-text is messy ("seven four three", "Roda R O D Dalectric"), so reconstruct the best reading. If the model had to reconstruct an email, set `verify_email` on the matching contact, as contacts already do.

### Changes

1. **Schema** (`server/src/schemas.ts`, `TaskProposal`): add
   ```ts
   phone: z.string().nullable().describe("Direct line and/or extension for this person if said on the call, e.g. '(925) 331-0573 x743'; null if not given"),
   ```
   Keep `ask_for`, but it must be the person's name plus role when known, e.g. `"Matt Michon (purchasing)"`, not "whoever handles purchasing" when a name is available.

2. **Task text** (`taskText()` in `server/src/assistant.ts`): if `t.phone` is set, put it in the first line in place of the company main line, e.g.
   `[A] Call Matt Michon (purchasing) at AqueoUS Vets — (925) 331-0573 x743 (2:00 PM Pacific)`.
   Fall back to the main line when `t.phone` is null.

3. **Contacts:** if the transcript names that person and they are not already a contact on the lead, the after-call quick part must also propose them as a new contact with the same phone/extension and email. `sanitizeProposals()` already de-duplicates by name/email; also de-duplicate when an existing contact has the same first name and last initial, e.g. "Matt M." vs "Matt Michon".

4. **Playbook** (`westgate-playbook.md`, "Tasks" section), add:
   > Name the exact person to call next when the call gave one — whoever the receptionist transferred to, who promised to send the list, or who owns the next step — with their direct line, extension, or email if they said it. Put the direct line/extension in the task's `phone`. Only fall back to "whoever handles purchasing" when nobody was named.

5. **No-answer path** (the instant, no-AI path in `afterCall()`): unchanged. Keep using `facts.askForDefault`, but make `askForDefault` follow the same priority order above, using open tasks and purchasing-titled contacts. The transcript isn't available on this path.

6. **Panel** (`extension/sidepanel.js`, `renderReview()`): the task summary line shows `Matt Michon (purchasing) · x743 · Thu 2:00 PM their time`, and the Edit form gets a "Direct line / ext" field bound to `t.phone`.

7. **Lead Chat:** when the rep says "Kenny is in procurement, ext 212, call him tomorrow morning his time", the returned task uses `ask_for: "Kenny (procurement)"` and `phone: "x212"`. This needs no code beyond the schema field and the playbook line; add a test.

### Acceptance criteria
- For the AqueoUS Vets call (receptionist Brenda transferred to Matt Michon, ext 743), the proposed task has `ask_for` containing "Matt Michon" and `phone` containing "743". The task text written to Close contains both.
- For the Rodda Electric call (Renee covering until Rob returns Oct 12), there is a task for Renee now, and, if proposed, a task for Rob dated on or after Oct 12. Both are named.
- When no one is named, the task falls back as today and `phone` is null.
- New unit tests in `server/test/assistant.test.ts`:
  - The stubbed LLM returns a task with `phone: "(925) 331-0573 x743"`, and `taskText` contains it instead of the main line.
  - De-duplication of "Matt M." against "Matt Michon".
  - `askForDefault` prefers a purchasing-titled contact over "Main Office".
- Existing tests keep passing.

---

## Part B — already shipped in v1.1–v1.3 (verify, don't rebuild)

### B1. Call card (Lead Brief) is now minimal
- **Schema** (`BriefSchema`): `{ rating: string (normalized to A–D in code), does: string, buys: string[], note: string | null, opener: string }`. Removed: `ask_for`, `heads_ups`, `ask`, `objection`, `objection_response`, `rating_reason`.
- **Playbook "Lead Brief" section:**
  - The card is the rating, three fit lines (`does` under 10 words; `buys` is 2–4 items of 2–4 words each; `note` is one sentence only when it changes the approach, and never mentions time of day), and the opener.
  - The opener is 2–3 spoken sentences under 55 words that end with the ask.
  - If we've talked to them before, the opener picks up from the last conversation.
- **Code rules** (`enforceBriefRules`):
  - The rating is normalized to A–D (default C).
  - Vendors are forced to D with a "don't pitch" opener.
- **Warnings** (`briefFlags`): come from code, not the model, and cover vendor, competitor watchlist, international number, and no phone. They're shown as red rows.
- **Panel card, top to bottom:**
  1. White header with the company name. There is no letter badge.
  2. Fit line: colored dot plus words (A "Great lead", B "Good lead", C "Weak lead", D "Skip"), then **Does / Buys (chips) / Note** rows.
  3. **Their time**: live clock in the prospect's time zone, refreshed every 30 s, with a tag: "Good time to call" (green), "Closing soon" after 4 PM (amber), "After hours · call tomorrow", "Too early · call after 8 AM", or "Weekend · call Monday" (red).
  4. The opener in large text (19 px).
  5. A "Rewrite" link.
- The on-call view shows just the opener, larger.

### B2. Speed
- **Per-feature models** (env-overridable in `server/.env`):
  - `BRIEF_MODEL`, `CHAT_MODEL`, `AFTER_CALL_MODEL`, `EMAIL_MODEL` all default to `claude-sonnet-5`.
  - Effort: `EFFORT_FAST=low` (brief, chat), `EFFORT_AFTER_CALL=low`, `EFFORT_EMAIL=medium`.
  - Opus-only request params (server-side refusal fallback) are sent only to Opus/Fable models. Haiku gets no thinking/effort params.
- **Brief input is trimmed:**
  - Call summaries only, no full transcripts.
  - Last 5 calls.
  - Website text capped at 5,000 characters, with a single 4-second budget across all redirects.
- **Disk cache for briefs:**
  - Stored at `server/.cache/briefs-v5.json`, 7-day TTL.
  - Bump the file name whenever `BriefSchema` changes.
  - A lead's cached brief is deleted when follow-ups are approved on it.
- **In-flight de-duplication:** two requests for the same brief share one Claude call.
- **Warm-ahead on the rep's Smart View:**
  - When the panel sees a Smart View URL (`app.close.com/...save_xxx`), it calls `POST /api/smart-views/:id/warm`. The panel remembers the view in `chrome.storage.local.listView`.
  - Opening any lead calls `warmAfterLead`, which queues briefs for the **next 5 leads** after it (3 concurrent). Leads the rep skipped past are dropped from the queue.
  - `GET /api/smart-views/:id/status?lead_id=` returns `{ position, size, ahead, readyAhead }`. The panel shows "Lead 3 of 48 · next 5 ready".
  - Smart View leads come from `GET /saved_search/:id/` (`s_query`) plus `POST /data/search/`, capped at 200.

### B3. After-call split (instant / quick / parallel)
- **No answer, busy, voicemail** (Close disposition `no-answer`, `busy`, `blocked`, `error`, `abandoned`, `vm-left`, `vm-answer`) with no rep summary:
  - No AI call.
  - Instantly proposes one callback task at the suggested slot, with no note (Close already logs the dial).
  - Skip-rated leads and vendors get no task.
- **Conversation:** two requests fire in parallel from the panel.
  - `POST /api/leads/:id/after-call` is the quick part: note, contacts, tasks, status (`AfterCallSchema`, email omitted). It returns `extras: true` when an email/coaching pass is expected.
  - `POST /api/leads/:id/after-call/extras` returns `{ email, coaching, warnings }` (`AfterCallExtrasSchema`).
  - The panel shows the quick part first, with "Writing the email draft…" underneath. When the email arrives, it's added to the list. If the rep already approved, the email appears as its own item to approve.
- **Measured on a real call:** 17.8 s before, about 8 s after the transcript is available now. Both halves finish together.
- **Transcript wait:** Close takes 1–2 min to produce one.
  - The panel says so and offers **Build now**, with an optional one-line summary.
  - The rep can move to the next lead. Leads left in "waiting" keep polling in the background, and a "Follow-ups ready: Company →" link navigates the Close tab back.
  - After 3 minutes with no transcript, follow-ups are built from what Close has.
  - On an error the panel does **not** auto-retry, so it can't loop Claude calls.

### B4. Panel UI
- **Look:** compact and flat. White background, hairline dividers, Geist font (Google Fonts), Westgate blue `#064a8f` for accents. No navy header bar, no grid background, no boxed cards.
- **Follow-ups:** each item (note, new contact, callback task, email draft, status) is one summary line with a checkbox and an **Edit** toggle; the form opens only on Edit. Status has no Edit. Coaching sits below the Approve button.
- **Theme:** Light (default), Dark, or "Match my computer". Set by the header button or the options page, stored in `chrome.storage.local.theme`.
- **Website tab:** the lead's site in an iframe.
  - `background.js` adds a `declarativeNetRequest` session rule removing `x-frame-options` and `content-security-policy` for `sub_frame` requests with `tabIds: [-1]` (the side panel only).
  - It needs the `declarativeNetRequestWithHostAccess` permission plus a one-time optional grant of `https://*/*` and `http://*/*` ("Enable website view").
  - The frame resets to `about:blank` when the lead changes, shows "Loading…", and shows "This website isn't responding" after 10 s.
- **Manifest version** is `1.3.0`. Reload it in `chrome://extensions` and reopen the panel after every change.

### B5. Config and ops
- `server/.env` holds:
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_WORKSPACE_ID`, required when the key isn't scoped to a workspace. It's sent as the `anthropic-workspace-id` header.
  - Optional model/effort overrides.
- npm scripts load `.env` via `--env-file-if-exists`.
- `server/reps.json` holds each rep's token, name, email, Close API key, and time zone.
- Demo mode (`DEMO=1`) always uses the built-in demo rep and fake Close. Preview it at `/preview/sidepanel.html?lead=lead_demoRoddaElectric0001&token=demo-token-demo-token-demo-token`.
- Scripts:
  - `npm run smoke -- <lead_id> [call_id]`: read-only real run.
  - `npm run bench -- <lead ids…>`: times models (`MODELS=`, `SKIP_AFTER_CALL=1`).

### Known gaps (not in scope unless asked)
- "Their time" uses the company's location in Close, so it's wrong when the purchasing contact is in another office, e.g. a Florida buyer at an Anchorage company. It could fall back to the named contact's area code.
- Close transcript latency (1–2 min) is outside our control. The only way to go faster is Close webhooks (`activity.call` `completed`) plus polling for the transcript.
- The fastest remaining after-call option is Opus 5 fast mode (about 2.5× output speed at about 2× the Opus price). It hasn't been benchmarked on these calls.
