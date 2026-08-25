export const DASHBOARD_ADMIN_LABEL = "admin";

const MANAGEMENT_ROLE_CODES = new Set(["super_admin", "executive", "manager"]);

export function hasDashboardAdminLabel(user: { labels?: unknown }): boolean {
  return Array.isArray(user.labels)
    && user.labels.some((label) => typeof label === "string" && label === DASHBOARD_ADMIN_LABEL);
}

export function isManagementRoleCode(code: unknown): boolean {
  return typeof code === "string" && MANAGEMENT_ROLE_CODES.has(code);
}

export function assignmentIsEffective(assignment: Record<string, unknown>, now: number): boolean {
  const startsAt = new Date(String(assignment.effective_from ?? "")).valueOf();
  if (!Number.isFinite(startsAt) || startsAt > now) return false;
  if (!assignment.effective_to) return true;
  const endsAt = new Date(String(assignment.effective_to)).valueOf();
  return Number.isFinite(endsAt) && endsAt > now;
}
