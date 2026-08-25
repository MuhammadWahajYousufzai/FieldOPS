import * as SecureStore from "expo-secure-store";

const MOBILE_SESSION_KEY = "fieldops-mobile-session-v1";

export type SecureMobileSession = {
  employeeId: string;
  token: string;
};

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function saveSecureMobileSession(value: SecureMobileSession) {
  if (!value.employeeId.trim() || !value.token.trim()) throw new Error("A valid signed-in session is required.");
  await SecureStore.setItemAsync(MOBILE_SESSION_KEY, JSON.stringify(value), secureOptions);
}

export async function readSecureMobileSession(): Promise<SecureMobileSession | null> {
  try {
    const saved = await SecureStore.getItemAsync(MOBILE_SESSION_KEY, secureOptions);
    if (!saved) return null;
    const value = JSON.parse(saved) as Partial<SecureMobileSession>;
    return typeof value.employeeId === "string" && value.employeeId.trim()
      && typeof value.token === "string" && value.token.trim()
      ? { employeeId: value.employeeId, token: value.token }
      : null;
  } catch {
    return null;
  }
}

export function clearSecureMobileSession() {
  return SecureStore.deleteItemAsync(MOBILE_SESSION_KEY, secureOptions);
}
