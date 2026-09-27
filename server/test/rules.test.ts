import assert from "node:assert/strict";
import { test } from "node:test";
import {
  competitorMatches, emailMatchesDomain, formatPhone, isBackwardsMove, isVendor, isoWithOffset, localTimeInfo,
  normalizePhone, prospectTimeZone, siteDomain, suggestCallback, zonedTime,
} from "../src/rules.js";

const LA = "America/Los_Angeles";

test("prospect time zone: description hint wins, then state", () => {
  assert.equal(prospectTimeZone("Company type: Private | Timezone: Pacific Time | x", "TX"), LA);
  assert.equal(prospectTimeZone("Timezone: Central Time", null), "America/Chicago");
  assert.equal(prospectTimeZone("no hint here", "tx"), "America/Chicago");
  assert.equal(prospectTimeZone(null, null), null);
});

test("local time flags after 4:30 PM and weekends", () => {
  assert.equal(localTimeInfo(LA, new Date("2026-09-23T23:45:00Z")).afterHours, true); // 4:45 PM PDT Wed
  assert.equal(localTimeInfo(LA, new Date("2026-09-23T21:28:00Z")).afterHours, false); // 2:28 PM PDT Wed
  assert.equal(localTimeInfo(LA, new Date("2026-09-26T18:00:00Z")).reason, "weekend"); // Sat
  assert.equal(localTimeInfo("America/New_York", new Date("2026-09-23T21:28:00Z")).afterHours, true); // 5:28 PM EDT
});

test("callback slot: afternoon → next weekday 9:30; morning → same day 2 PM; Friday → Monday", () => {
  assert.equal(suggestCallback(LA, new Date("2026-09-23T21:28:00Z")).toISOString(), "2026-09-24T16:30:00.000Z");
  assert.equal(suggestCallback(LA, new Date("2026-09-23T16:00:00Z")).toISOString(), "2026-09-23T21:00:00.000Z");
  assert.equal(suggestCallback(LA, new Date("2026-09-26T00:00:00Z")).toISOString(), "2026-09-28T16:30:00.000Z"); // Fri 5 PM → Mon
});

test("zoned time handles DST change", () => {
  assert.equal(zonedTime(2026, 11, 2, 9, 30, LA).toISOString(), "2026-11-02T17:30:00.000Z"); // PST
  assert.equal(zonedTime(2026, 10, 30, 9, 30, LA).toISOString(), "2026-10-30T16:30:00.000Z"); // PDT
});

test("ISO with offset", () => {
  assert.equal(isoWithOffset(new Date("2026-09-24T16:30:00Z"), LA), "2026-09-24T09:30:00-07:00");
  assert.equal(isoWithOffset(new Date("2026-11-02T17:30:00Z"), LA), "2026-11-02T09:30:00-08:00");
  assert.equal(isoWithOffset(new Date("2026-09-24T16:30:00Z"), "Asia/Kolkata"), "2026-09-24T22:00:00+05:30");
});

test("phones", () => {
  assert.equal(normalizePhone("(925) 240-6024"), "+19252406024");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(formatPhone("+19252406024"), "(925) 240-6024");
});

test("vendor detection uses status or lead_type", () => {
  assert.equal(isVendor("Vendor", []), true);
  assert.equal(isVendor("Vendor Onboarding", []), true);
  assert.equal(isVendor("Qualified", ["sales", "vendor"]), true);
  assert.equal(isVendor("Qualified", ["sales"]), false);
});

test("competitor matching is whole-word and doesn't over-match", () => {
  const list = ["DNOW", "Harrington Industrial Plastics", "Core & Main"];
  assert.deepEqual(competitorMatches("DNOW L.P.", list), ["DNOW"]);
  assert.deepEqual(competitorMatches("Harrington Electric", list), []);
  assert.deepEqual(competitorMatches("Core & Main LP", list), ["Core & Main"]);
  assert.deepEqual(competitorMatches("Dnowak Fabrication", list), []);
});

test("email domain check", () => {
  assert.equal(siteDomain("https://www.roddaelectric.com/about"), "roddaelectric.com");
  assert.equal(emailMatchesDomain("rob@roddaelectric.com", "roddaelectric.com"), true);
  assert.equal(emailMatchesDomain("rob@rodalectric.com", "roddaelectric.com"), false);
});

test("status ladder never moves backwards", () => {
  assert.equal(isBackwardsMove("Qualified", "Called"), true);
  assert.equal(isBackwardsMove("Called", "Sent Line Card"), false);
  assert.equal(isBackwardsMove("Qualified", "Bad Fit"), false); // side exit
  assert.equal(isBackwardsMove("RFQ Received", "Quoted"), false);
});
