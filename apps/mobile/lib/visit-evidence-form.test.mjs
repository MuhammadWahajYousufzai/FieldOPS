import assert from "node:assert/strict";
import test from "node:test";

import { createVisitEvidenceFormData } from "./visit-evidence-form.ts";

test("visit evidence uses real Blob/File multipart parts instead of URI descriptors", () => {
  const files = new Map([
    ["file:///photo.jpg", new Blob(["photo-bytes"], { type: "image/jpeg" })],
    ["file:///voice.m4a", new Blob(["audio-bytes"], { type: "audio/mp4" })],
  ]);
  const form = createVisitEvidenceFormData(
    { visitId: "visit-1", notes: "Shelf checked" },
    { uri: "file:///photo.jpg", name: "photo.jpg", type: "image/jpeg" },
    { uri: "file:///voice.m4a", name: "voice.m4a", type: "audio/mp4" },
    (uri) => files.get(uri),
  );

  assert.equal(form.get("visitId"), "visit-1");
  assert.equal(form.get("notes"), "Shelf checked");
  assert.ok(form.get("photo") instanceof Blob);
  assert.ok(form.get("audio") instanceof Blob);
  assert.equal(form.get("photo").name, "photo.jpg");
  assert.equal(form.get("audio").name, "voice.m4a");
});
