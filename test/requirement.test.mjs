// Pure draft helpers (Node 24 strips TypeScript types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftValid, emptyDraft, toRequirement } from "../src/requirement.ts";

test("toRequirement sends only filled fields; draftValid needs specs or a link", () => {
  const d = { ...emptyDraft(), title: " Bottle ", quantity: 500, specs: "steel" };
  assert.deepEqual(toRequirement(d), { title: "Bottle", quantity: 500, unit: "pcs", destination: "Germany", specs: "steel", target_currency: "USD" });
  assert.equal(draftValid(d), true);
  assert.equal(draftValid({ ...d, specs: "" }), false);
  assert.equal(draftValid({ ...d, specs: "", reference_url: "https://x.test" }), true);
  assert.equal(draftValid({ ...d, quantity: 0 }), false);
});
