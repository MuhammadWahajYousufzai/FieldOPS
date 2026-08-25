import assert from "node:assert/strict";
import test from "node:test";

import { authorizeCreatedSession } from "./created-session-authorization.ts";

test("a created session is retained only after employee authorization succeeds", async () => {
  let revocations = 0;
  const employee = { id: "employee-1" };
  const result = await authorizeCreatedSession(
    async () => employee,
    async () => { revocations += 1; },
  );
  assert.equal(result, employee);
  assert.equal(revocations, 0);
});

test("an unassigned account's newly created session is revoked", async () => {
  let revocations = 0;
  const result = await authorizeCreatedSession(
    async () => null,
    async () => { revocations += 1; },
  );
  assert.equal(result, null);
  assert.equal(revocations, 1);
});

test("a post-create authorization error still revokes the new session", async () => {
  const authorizationError = new Error("employee lookup failed");
  let revocations = 0;
  await assert.rejects(
    authorizeCreatedSession(
      async () => { throw authorizationError; },
      async () => { revocations += 1; },
    ),
    (error) => error === authorizationError,
  );
  assert.equal(revocations, 1);
});

test("a revocation failure is surfaced instead of claiming the session was closed", async () => {
  const revocationError = new Error("revocation failed");
  await assert.rejects(
    authorizeCreatedSession(
      async () => null,
      async () => { throw revocationError; },
    ),
    (error) => error === revocationError,
  );
});
