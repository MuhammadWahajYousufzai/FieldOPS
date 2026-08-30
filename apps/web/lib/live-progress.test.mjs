import assert from "node:assert/strict";
import test from "node:test";

import { liveProgressRevision } from "./live-progress.ts";

const row = ($id, $updatedAt) => ({ $id, $updatedAt });

test("live progress revision is order-independent and tracks the newest row", () => {
  const oldRow = row("visit-old", "2026-08-30T10:00:00.000Z");
  const newRow = row("visit-new", "2026-08-30T11:00:00.000Z");
  assert.equal(
    liveProgressRevision([{ name: "visits", rows: [oldRow, newRow] }]),
    liveProgressRevision([{ name: "visits", rows: [newRow, oldRow] }]),
  );
  assert.match(liveProgressRevision([{ name: "visits", rows: [oldRow, newRow] }]), /visit-new$/);
});

test("live progress revision changes when count or latest update changes", () => {
  const original = liveProgressRevision([{ name: "orders", rows: [row("one", "2026-08-30T10:00:00.000Z")], total: 1 }]);
  const added = liveProgressRevision([{ name: "orders", rows: [row("two", "2026-08-30T11:00:00.000Z")], total: 2 }]);
  const removed = liveProgressRevision([{ name: "orders", rows: [row("one", "2026-08-30T10:00:00.000Z")], total: 0 }]);
  assert.notEqual(original, added);
  assert.notEqual(original, removed);
});
