import assert from "node:assert/strict";
import { test } from "node:test";
import { repLines, type Deps } from "../src/assistant.js";
import { demoLlm, FakeClose } from "../src/demo.js";
import { DEMO_USER_ID } from "../src/fixtures.js";

test("the rep's own Close line, formatted, and nobody else's", async () => {
  const close = new FakeClose();
  const d: Deps = { close, llm: demoLlm, rep: { name: "Walt Boxwell", email: "walt@westgatesupply.com", closeUserId: DEMO_USER_ID, timeZone: "America/Los_Angeles" } };
  assert.deepEqual(await repLines(d), ["(737) 258-2165"]);
});
