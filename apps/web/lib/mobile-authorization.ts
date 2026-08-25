export const FIELD_SALESPERSON_ROLE = "sales_person";

export function hasEffectiveRoleAssignment(
  assignments: readonly Record<string, unknown>[],
  roleId: string,
  now: number,
): boolean {
  return assignments.some((assignment) => {
    if (String(assignment.role_id ?? "") !== roleId) return false;

    const startsAt = new Date(String(assignment.effective_from ?? "")).valueOf();
    if (!Number.isFinite(startsAt) || startsAt > now) return false;

    if (!assignment.effective_to) return true;
    const endsAt = new Date(String(assignment.effective_to)).valueOf();
    return Number.isFinite(endsAt) && endsAt > now;
  });
}
