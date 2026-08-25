import assert from "node:assert/strict";
import test from "node:test";

import {
  dealFollowUpStatus,
  normalizeDeals,
  normalizeTeamContact,
  normalizeTeamMessages,
  teamContactUrl,
} from "./team-data.ts";

test("team context normalization drops malformed records and orders the thread", () => {
  assert.deepEqual(normalizeTeamContact({ name: " Manager ", phone: "+92 300 1234567", whatsapp: "" }), {
    name: "Manager",
    phone: "+92 300 1234567",
    whatsapp: "",
  });
  assert.deepEqual(normalizeTeamMessages([
    { id: "later", body: "Second", senderRole: "manager", sentAt: "2026-08-25T09:00:00.000Z", readAt: null },
    { id: "bad", body: "", senderRole: "manager", sentAt: "not-a-date" },
    { id: "first", body: "First", senderRole: "salesperson", sentAt: "2026-08-25T08:00:00.000Z" },
  ]).map((message) => message.id), ["first", "later"]);
});

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

test("contact links are emitted only for configured phone-like values", () => {
  assert.equal(teamContactUrl("phone", "+92 300-1234567"), "tel:+923001234567");
  assert.equal(teamContactUrl("whatsapp", "+92 300-1234567"), "https://wa.me/923001234567");
  assert.equal(teamContactUrl("phone", "not configured"), null);
  assert.equal(teamContactUrl("whatsapp", "123"), null);
});

test("active deal follow-ups expose overdue and due-today status in Pakistan", () => {
  const now = new Date("2026-08-25T07:00:00.000Z").valueOf();
  assert.equal(dealFollowUpStatus("2026-08-24T04:00:00.000Z", "proposal", now), "Overdue");
  assert.equal(dealFollowUpStatus("2026-08-25T18:30:00.000Z", "lead", now), "Due today");
  assert.equal(dealFollowUpStatus("2026-08-26T04:00:00.000Z", "negotiation", now), "");
  assert.equal(dealFollowUpStatus("2026-08-24T04:00:00.000Z", "won", now), "");
});
