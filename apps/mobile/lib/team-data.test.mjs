import assert from "node:assert/strict";
import test from "node:test";

import {
  dealFollowUpStatus,
  normalizeDeals,
} from "./team-data.ts";

test("deals normalize amounts and sort by the next follow-up", () => {
  const deals = normalizeDeals([
    { id: "later", customerName: "B", title: "Restock", stage: "proposal", amount: "5000", followUpAt: "2026-09-02T08:00:00.000Z" },
    { id: "first", customerName: "A", title: "New listing", stage: "unknown", amount: null, followUpAt: "2026-08-26T08:00:00.000Z" },
  ]);
  assert.deepEqual(deals.map((deal) => deal.id), ["first", "later"]);
  assert.equal(deals[0].stage, "lead");
  assert.equal(deals[0].amount, null);
  assert.equal(deals[1].amount, 5_000);
});

test("active deal follow-ups expose overdue and due-today status in Pakistan", () => {
  const now = new Date("2026-08-25T07:00:00.000Z").valueOf();
  assert.equal(dealFollowUpStatus("2026-08-24T04:00:00.000Z", "proposal", now), "Overdue");
  assert.equal(dealFollowUpStatus("2026-08-25T18:30:00.000Z", "lead", now), "Due today");
  assert.equal(dealFollowUpStatus("2026-08-26T04:00:00.000Z", "negotiation", now), "");
  assert.equal(dealFollowUpStatus("2026-08-24T04:00:00.000Z", "won", now), "");
});
