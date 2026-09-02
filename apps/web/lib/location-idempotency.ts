type LocationIdentity = {
  employee_id: unknown;
  idempotency_key: unknown;
  captured_at: unknown;
  latitude: unknown;
  longitude: unknown;
};

/** Match the GPS fix identity used by the mobile deterministic location key. */
export function isSameLocationFix(stored: LocationIdentity, submitted: LocationIdentity) {
  const timestamp = (value: unknown) => new Date(String(value)).valueOf();
  const coordinate = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(7) : null;
  };
  return String(stored.employee_id) === String(submitted.employee_id)
    && String(stored.idempotency_key) === String(submitted.idempotency_key)
    && Number.isFinite(timestamp(stored.captured_at))
    && timestamp(stored.captured_at) === timestamp(submitted.captured_at)
    && coordinate(stored.latitude) !== null
    && coordinate(stored.longitude) !== null
    && coordinate(stored.latitude) === coordinate(submitted.latitude)
    && coordinate(stored.longitude) === coordinate(submitted.longitude);
}
