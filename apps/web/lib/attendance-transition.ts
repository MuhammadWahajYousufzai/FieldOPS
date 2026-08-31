export type AttendanceAction = "check_in" | "check_out";

export type AttendanceSession = {
  $id: string;
  status?: unknown;
  check_in_at?: unknown;
  check_out_at?: unknown;
};

export type AttendanceTransition<Session extends AttendanceSession> =
  | { kind: "create" }
  | { kind: "update"; session: Session }
  | { kind: "confirm"; session: Session }
  | { kind: "reject"; error: string };

/**
 * Attendance actions describe a desired shift state. A delayed replay should
 * confirm when that state was already reached, and must never let an old
 * checkout close a newer shift that started after the saved action.
 */
export function attendanceTransition<Session extends AttendanceSession>(
  action: AttendanceAction,
  capturedAt: string,
  sessions: readonly Session[],
): AttendanceTransition<Session> {
  const active = sessions.find((session) => session.status === "checked_in" && !session.check_out_at);
  if (action === "check_in") return active ? { kind: "confirm", session: active } : { kind: "create" };

  const completed = sessions
    .filter((session) => session.status === "checked_out" && Boolean(session.check_out_at))
    .sort((left, right) => timestamp(right.check_out_at) - timestamp(left.check_out_at));

  if (!active) {
    return completed[0]
      ? { kind: "confirm", session: completed[0] }
      : { kind: "reject", error: "Start work before finishing the session." };
  }

  if (timestamp(capturedAt) >= timestamp(active.check_in_at)) return { kind: "update", session: active };

  const historical = completed.find((session) => (
    timestamp(session.check_in_at) <= timestamp(capturedAt)
    && timestamp(session.check_out_at) >= timestamp(capturedAt)
  ));
  return historical
    ? { kind: "confirm", session: historical }
    : { kind: "reject", error: "This saved finish belongs to an earlier work session." };
}

function timestamp(value: unknown) {
  const parsed = new Date(typeof value === "string" ? value : "").valueOf();
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
