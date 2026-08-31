import assert from "node:assert/strict";
import test from "node:test";

import { attendanceTransition } from "./attendance-transition.ts";

const completed = {
  $id: "old-shift",
  status: "checked_out",
  check_in_at: "2026-08-31T05:19:00.000Z",
  check_out_at: "2026-08-31T05:20:00.000Z",
};
const active = {
  $id: "current-shift",
  status: "checked_in",
  check_in_at: "2026-08-31T05:25:00.000Z",
};

test("an already active shift confirms a delayed check-in replay", () => {
  assert.deepEqual(attendanceTransition("check_in", "2026-08-31T05:22:00.000Z", [active]), {
    kind: "confirm",
    session: active,
  });
});

test("a delayed old checkout cannot close a newer active shift", () => {
  assert.deepEqual(attendanceTransition("check_out", "2026-08-31T05:20:00.000Z", [active, completed]), {
    kind: "confirm",
    session: completed,
  });
});

test("a current checkout updates the active shift", () => {
  assert.deepEqual(attendanceTransition("check_out", "2026-08-31T05:30:00.000Z", [active, completed]), {
    kind: "update",
    session: active,
  });
});

test("an already completed day confirms a delayed checkout replay", () => {
  assert.deepEqual(attendanceTransition("check_out", "2026-08-31T05:20:00.000Z", [completed]), {
    kind: "confirm",
    session: completed,
  });
});

test("checkout still rejects when the employee has no work session", () => {
  assert.deepEqual(attendanceTransition("check_out", "2026-08-31T05:20:00.000Z", []), {
    kind: "reject",
    error: "Start work before finishing the session.",
  });
});
