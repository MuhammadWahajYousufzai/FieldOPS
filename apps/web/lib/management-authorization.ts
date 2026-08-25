export const DASHBOARD_ADMIN_LABEL = "admin";

export function hasDashboardAdminLabel(user: { labels?: unknown }): boolean {
  return Array.isArray(user.labels)
    && user.labels.some((label) => typeof label === "string" && label === DASHBOARD_ADMIN_LABEL);
}

export function dashboardAdminForUser<User extends { labels?: unknown }>(user: User) {
  return hasDashboardAdminLabel(user) ? { user } : null;
}
