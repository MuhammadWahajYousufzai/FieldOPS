import { cookies, headers } from "next/headers";
import { createSessionAccount } from "@fieldops/appwrite/server";
import { dashboardAdminForUser } from "./management-authorization";

export { dashboardAdminForUser } from "./management-authorization";

export const SESSION_COOKIE = `a_session_${process.env.APPWRITE_PROJECT_ID}`;

export async function currentUser() {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (!session) return null;
  try {
    const headerStore = await headers();
    return await createSessionAccount(session, headerStore.get("user-agent") ?? undefined).get();
  } catch {
    return null;
  }
}

export async function requireDashboardAdmin() {
  const user = await currentUser();
  if (!user) return null;
  return dashboardAdminForUser(user);
}
