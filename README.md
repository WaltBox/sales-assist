# Westgate Sales Assistant (v1)

A Chrome side panel next to Close with three features: **Lead Brief**, **After-Call**, and **Lead Chat**. It builds on the 9/23 spec. Close is the memory, the playbook is built in, and nothing is written to Close until the rep taps **Approve**.

```
extension/   Chrome side panel (Manifest V3, plain JS, no build step)
server/      Node + TypeScript backend: Claude API + Close API; holds all keys
  playbook/westgate-playbook.md   ← the standing instructions every rep gets (edit this to change behavior)
  playbook/competitors.json       ← names that trigger a competitor/vendor heads-up
```

## How it works

1. **Rep opens a lead in Close.** The panel reads the lead ID from the URL. The server pulls the lead, its contacts, recent calls and transcripts, notes, open tasks, and the company homepage, then asks Claude for the brief.
2. **Rep dials from Close.** The panel polls the server every 4 seconds, and the server asks Close for this rep's latest call on the lead. It doesn't read Close's page, so a Close UI change can't break it. The panel switches to a large "on call" view while the call is live.
3. **Call ends.**
   - Answered: the panel waits for Close's transcript. If none arrives within 90 seconds, it asks the rep for a one-line summary.
   - No answer or voicemail: it goes straight to a callback proposal.
   - The rep can always tap **I just hung up**.
4. **Review.** The panel shows the proposed note, contacts, task, draft email, and status change, plus coaching tips that only the rep sees. The rep edits any of it inline or in the chat ("make that Thursday at 9") and taps **Approve**.
5. **Write-back.** Only `/apply` writes to Close, using the rep's own Close API key, so every action is logged under that rep.

### Look and settings

- **Theme:** Light (default), Dark, or "Match my computer". Change it with the ☀ button in the panel header or on the options page. The colors and the Geist font come from westgatesupply.com.
- **Website tab:** shows the lead's company website inside the panel, so reps don't switch tabs. The first time a rep opens it, the panel asks for Chrome permission once. Most sites refuse to load inside another page, so the extension removes the `X-Frame-Options` and `Content-Security-Policy` headers. It does this only for frames inside the assistant panel (requests outside any browser tab), never for normal browsing. "Open in new tab ↗" is always available.

### Rules enforced in code (not just in the prompt)

| Rule | Where |
|---|---|
| Vendors (status Vendor or Vendor Onboarding, or `lead_type` includes vendor) are rated D, get no pitch, and get no sales email | `enforceBriefRules`, `sanitizeProposals` |
| D leads get no callback task; no-answer or voicemail on A–C leads always gets one | `afterCall` |
| Prospect local time and after-hours check (8:00 AM–4:30 PM, weekdays); callback slots land in business hours | `rules.ts` |
| Status must exist in Close and never moves backwards (e.g. Qualified → Called) | `sanitizeProposals` |
| Contacts already on the lead aren't duplicated; emails not on the company's domain are flagged for checking | `sanitizeProposals` |
| Emails are saved as **drafts only** (Close `status: "draft"` is never sent) | `close.ts` |
| Task text: rating, phone, prospect time zone, who to ask for, and pitch | `taskText` |
| Close notes, transcripts, and website text are wrapped as untrusted data; model output only becomes proposals; the model can't write | `claude.ts`, `context.ts` |
| Double-clicking Approve can't create duplicates | `applyProposals` |

## Try it now (no keys needed)

```bash
cd server && DEMO=1 ../.node/bin/node node_modules/tsx/dist/cli.mjs src/index.ts
```

Then open http://localhost:3001/preview/sidepanel.html?lead=lead_demoRoddaElectric0001&token=demo-token-demo-token-demo-token

Demo mode replays the real Rodda Electric call from 9/23. The call starts about 6 seconds in and ends at 14 seconds, and the transcript arrives at 20 seconds, followed by the follow-up proposals. Nothing is sent anywhere.

This machine uses a portable Node in `.node/`. To have `npm` on your PATH, run `export PATH="$HOME/Desktop/westgate-sales-assistant/.node/bin:$PATH"` first.

## Set up for real

1. **Keys.** Copy `server/.env.example` to `server/.env` and put your Anthropic API key there (`ANTHROPIC_API_KEY=sk-ant-…`). On a hosted server, set it as an environment variable instead. Each rep needs their own Close API key (Close → Settings → API Keys).
2. **Reps file.** Copy `server/reps.example.json` to `server/reps.json`. Add one entry per rep with a long random `token` (e.g. `openssl rand -hex 24`). The token is what the rep pastes into the extension. Close keys never leave the server.
3. **Smoke test (read-only).** This prints the brief and after-call proposals for a real lead without writing anything:
   ```bash
   cd server && npm run smoke -- lead_DIMcdrOfcpXBgTdEouRXo0YAO1DlNhbAKLdWHNVhk5X
   ```
4. **Run the server.** Use `npm start` with `PORT` and `ALLOWED_ORIGINS=chrome-extension://<extension id>`. For reps, host it on HTTPS (a small VM, Render, or Fly.io all work). It's a single stateless Node process.
5. **Install the extension.** Go to `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick `extension/`. Then enter the server address and rep token in the options page that opens. For a wider rollout, IT can publish it privately to your Google Workspace and force-install it.

### Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required |
| `CLAUDE_MODEL` | `claude-opus-5` | |
| `EFFORT_FAST` | `medium` | brief and chat, which reps wait on before a dial |
| `EFFORT_AFTER_CALL` | `high` | transcript reading |
| `PORT` | `8787` | |
| `ALLOWED_ORIGINS` | — | comma-separated `chrome-extension://…` origins |
| `REPS_FILE` | `server/reps.json` | |

## Development

```bash
cd server
npm test           # 26 tests: time zones/DST, callback slots, vendor/D rules, status ladder, dedupe, apply, HTTP layer
npm run typecheck
```

## Known limits and next steps

- **Not yet run against the live Claude API.** No API key was available while building. The request shape follows the current SDK (structured outputs, adaptive thinking, and server-side refusal fallback), but run `npm run smoke` first.
- **Close details to confirm on the pilot:**
  - how long transcripts take to appear after a call (the panel waits 90 seconds)
  - whether pinned notes show as pinned in your Close plan
- **Stats in chat** ("how many dials today?") count outbound calls since midnight in the rep's time zone. A connect is any call with `disposition = answered`.
- **In-memory caches** (briefs for 30 minutes, websites for 24 hours) reset when the server restarts. That's fine for a pilot; add Redis if you run several servers.
- **v2 items from the spec**: coaching report, overnight rating to `icp_tier`, training mode, Close webhooks for automatic triggers, and Slack/Gmail.

## Daily stats

The strip under the top bar (`60 dials · 32 reached · 14 emails · 0 RFQs`) is counted from Close: your outbound calls since your local midnight, emails sent today, notes tagged `[RFQ promised]`, and tasks you created today. Tap it for the breakdown (companies, voicemails, line cards, best call, pace to 5 PM), then **This week** for Mon–Fri bars.

- The panel adds a dial the moment a call ends (once per call id) and re-syncs from Close every 10 minutes and whenever it opens. If the two disagree, Close wins and the server logs `[stats] … panel showed N dials, Close has M`.
- A leading `~` on reached, voicemails, or RFQs means a call from the last 3 minutes has no transcript yet. It clears on its own.
- Reached means the call ran 45 seconds or more with both sides talking, or you tapped Reached buyer or Got a name. Tapping Voicemail overrides the transcript.
- RFQs promised come from the after-call step. When someone says they'll send a list, RFQ, or drawing, the Close note gets `[RFQ promised]`. Counting starts with calls made after 2026-09-24 (this version).
- **RFQ asked** counts leads whose follow-up email carried the benchmark ask for a past RFQ or PO (the note gets `[RFQ asked]`). **RFQ promised → received** shows leads that promised today, then leads we asked or that promised in the last 30 days that sent an email with a real attachment today. Signature images don't count.
