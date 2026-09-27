import type { CloseCall, CloseLead, CloseStatus } from "./close.js";

// A real 9/23 call (Rodda Electric), used by demo mode and the tests.

export const DEMO_LEAD_ID = "lead_demoRoddaElectric0001";
export const DEMO_USER_ID = "user_demoWaltBoxwell000001";

export const statuses: CloseStatus[] = [
  "Potential", "Bad Fit", "Qualified", "Customer", "Not Interested", "Disqualified", "Quoted",
  "Vendor Onboarding", "Sent Line Card", "Called", "RFQ Received", "Vendor",
].map((label, i) => ({ id: `stat_demo${i}`, label }));

export const customFields = [
  { id: "cf_leadtype", name: "lead_type" },
  { id: "cf_sitekey", name: "site_key" },
  { id: "cf_whcity", name: "Warehouse City" },
];

export function roddaLead(overrides: Partial<CloseLead> = {}): CloseLead {
  return {
    id: DEMO_LEAD_ID,
    display_name: "Rodda Electric, Inc.",
    name: "Rodda Electric, Inc.",
    url: "https://roddaelectric.com",
    description: "Company type: Privately Held | Timezone: Pacific Time | Likely products: electrical enclosures/junction boxes and conduit-related items, tools, general MRO supplies | Top competitors: Morrow-Meadows Corporation, Rosendin, Cupertino Electric, Inc.",
    status_id: "stat_demo0",
    status_label: "Potential",
    addresses: [{ city: "Brentwood", state: "CA", country: "US" }],
    contacts: [
      { id: "cont_mainoffice", name: "Main Office", title: null, emails: [], phones: [{ phone: "+19252406024", type: "office" }] },
      { id: "cont_robroy", name: "Rob Roy", title: "Purchasing Manager", emails: [], phones: [] },
    ],
    "custom.cf_sitekey": "roddaelectric.com",
    "custom.cf_whcity": "Pittsburg",
    ...overrides,
  };
}

const lines: Array<[string, "contact" | "close-user", number, string]> = [
  ["Main Office", "contact", 0, "Rodda Electric. Have my direct your call."],
  ["Walt Boxwell", "close-user", 2, "Hey, this is walt. I was calling for rob roy."],
  ["Main Office", "contact", 5, "Rob's on a leave right now. He'll be back October 12th."],
  ["Walt Boxwell", "close-user", 9, "Got it. Is there another purchasing manager I could speak to?"],
  ["Main Office", "contact", 12, "Yes, I'm actually doing the purchasing for the business. What is this regarding?"],
  ["Walt Boxwell", "close-user", 18, "Oh, cool. Yeah, so I'm calling with Westgate Supply. We're local here in the Bay Area, but we supply threaded rod and anchors, fasteners and enclosures to electrical contractors."],
  ["Main Office", "contact", 28, "Okay, okay."],
  ["Walt Boxwell", "close-user", 32, "I was just going to see if you all had any, like, RFQs open right now that we could take a look at and possibly get you a quote back."],
  ["Main Office", "contact", 42, "Do you mind emailing it to Rob? I do go through his emails. If you could just email it to me or email Rob and I'll get it and I'll look at it. We always. We always need that stuff, so."],
  ["Walt Boxwell", "close-user", 53, "Yeah, that'd be awesome. Do you have any open right now that we could look at?"],
  ["Main Office", "contact", 58, "Not on the top of my head, but we do get daily orders so."],
  ["Main Office", "contact", 62, "I can see what the orders are like tomorrow."],
  ["Walt Boxwell", "close-user", 65, "That sounds good. Yeah. So I'll send you the line card. That sound good?"],
  ["Main Office", "contact", 68, "Okay, sounds good. All right, thank you."],
  ["Walt Boxwell", "close-user", 70, "Perfect. Could I get Rob's email before you."],
  ["Main Office", "contact", 72, "Yeah, it's Rob. Rob."],
  ["Main Office", "contact", 75, "At Roda R O D Dalectric."],
  ["Walt Boxwell", "close-user", 81, "Perfect. All right, I will send you an email and then. I'm sorry, what was your name?"],
  ["Main Office", "contact", 84, "All right. My name is renee. R e n e e. Yes."],
  ["Walt Boxwell", "close-user", 89, "Perfect. Thanks, Renee. Talk to you later. Bye."],
];

export function roddaCall(overrides: Partial<CloseCall> = {}): CloseCall {
  return {
    id: "acti_demoRoddaCall0001",
    lead_id: DEMO_LEAD_ID,
    user_id: DEMO_USER_ID,
    contact_id: "cont_mainoffice",
    direction: "outbound",
    status: "completed",
    disposition: "answered",
    duration: 96,
    remote_phone: "+19252406024",
    note: "renee",
    date_created: "2026-09-23T21:28:51.136000+00:00",
    recording_transcript: {
      summary_text: "Spoke with Renee, who handles purchasing while Rob Roy is on leave until Oct 12. Asked for the line card by email.",
      utterances: lines.map(([speaker_label, speaker_side, start, text]) => ({ speaker_label, speaker_side, start, text })),
    },
    voicemail_transcript: null,
    ...overrides,
  };
}
