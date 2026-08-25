/**
 * Runs the authorization step that follows credential verification. Appwrite
 * has already created a session at this point, so every non-success path must
 * revoke that exact session before the caller returns an error response.
 */
export async function authorizeCreatedSession<Result>(
  authorize: () => Promise<Result | null>,
  revokeCreatedSession: () => Promise<unknown>,
): Promise<Result | null> {
  let authorized = false;
  try {
    const result = await authorize();
    if (result === null) return null;
    authorized = true;
    return result;
  } finally {
    if (!authorized) await revokeCreatedSession();
  }
}
