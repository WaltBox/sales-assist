# Line card email: setup notes (10/7)

## The signature line

Paste this into the Close email signature (Settings, then Email, then Signature) so it rides on every email, then set `SIGNATURE_KEYWORDS=0` on the server so the app stops adding it to line card emails:

```
Westgate Supply supplies fasteners, studs, nuts, gaskets, flanges, pipe, fittings, plate, bar and structural steel in carbon, stainless, alloy, duplex, nickel alloys and titanium. Warehouses: Oakland CA, Houston TX, Burbank IL. westgatesupply.com/linecard
```

Until then the app appends it under "Walt Boxwell" on line card emails only (not on the automatic bumps).

## The Close template (manual steps)

Template `blank template with line card attached`, id `tmpl_h0xbgrP8EjkmKlb5zMD8gKpHzfd8khSxYt2EpqoTeLA`. The app copies its `attachments` onto every line card email and writes its own subject and body. Subject and body on the template stay empty.

1. **Contact card.** Run `npm run vcf` in `server/` (it writes `server/assets/Westgate-Supply-Walt-Boxwell.vcf`; set `REP_PHONE="(xxx) xxx-xxxx"` first if the direct line should replace the main number). In Close, open the template and add that file as an attachment. The "Contact card" format then adds one sentence about it; with no .vcf on the template the sentence is left out and nothing is blocked.
2. **W-9.** Add the W-9 PDF to the same template for the "Vendor setup packet" format. Without it the email says "W-9: available on request".
3. Keep `Westgate_Supply_Line_Card.pdf` on the template; it rides on the first email and every bump.

The app caches the template's attachment list for 12 hours; restart the server (or wait) after changing it.

## What the app does on a call

1. After a connected call the transcript is read for "send me a line card" (or a yes to the offer), who's getting it, the address, how they keep track of vendors, the products they named, and whether anything is open now.
2. It recommends a format and says why ("Dana keeps a contact per vendor, so the whole card is written out"). The side panel shows the format in a dropdown on the post-call card; changing it recomposes the email from the opener already written, without re-reading the transcript, and updates the draft in Close.
3. The draft is checked before it's saved: every family named (10 of 12 at least; Niche must carry every family they buy), no em or en dashes, subject starts with "Westgate Supply:" and stays under 70 characters, no grade or coating that isn't on the card and wasn't said on the call, Westgate never phrased as someone Walt called, no hedging, no old-RFQ line, a gatekeeper never addressed as the buyer. A draft that fails is not saved; the panel shows the reason and the rep picks another format. The 120 to 180 word target for the personal part is a warning, not a block.
4. The "Send line card now" button on the call screen also carries the short text card, the keyword subject and the signature line.
5. The format each lead got is recorded (`lineCardSends` in the store) so replies and RFQs can be compared by format once there are enough sends.

## Formats

| Format | When | What's in the body |
|---|---|---|
| Standard | nothing said about filing, or they search their inbox | opener, "call us when", the short card, warehouses, the ask |
| Full text | they keep a contact per vendor, or asked for it written out | the whole card, one line per family |
| Niche | they named specific items and buy a few families | those families in full, "we also carry" line |
| Contact card | contact per vendor and the .vcf is on the template | full text plus the .vcf sentence |
| Vendor list row | spreadsheet or ERP vendor list | one pipe-separated line to paste, then the short card |
| Gatekeeper intro | a front desk or office manager who'll pass it on | asks them to forward it to whoever buys materials, with the short card |
| Vendor setup packet | "send your W-9", "we'll need to set you up" | the short card plus W-9, COI, quality, tax ID, terms lines |
| PDF only | they said just the PDF | opener, warehouses, the ask; keyword subject and signature line still carry the words |
