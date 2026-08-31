export type EvidenceAttachment = {
  uri: string;
  name: string;
  type: string;
};

/**
 * Expo's native fetch implementation accepts Blob/File form parts, but rejects
 * React Native's legacy `{ uri, name, type }` descriptor objects. Keep the
 * conversion explicit so saved evidence is always uploaded as real file data.
 */
export function createVisitEvidenceFormData(
  fields: Record<string, string>,
  photo: EvidenceAttachment,
  audio: EvidenceAttachment,
  fileFromUri: (uri: string) => Blob,
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("photo", fileFromUri(photo.uri), photo.name);
  form.append("audio", fileFromUri(audio.uri), audio.name);
  return form;
}
