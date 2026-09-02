# FieldOPS live data model

The self-hosted Appwrite 1.9.6 project uses TablesDB with server-only access. Every table has row security enabled and no table-wide client permissions. The Next.js Appwrite Site is the policy boundary for both the management dashboard and mobile API.

This deployment is intentionally single-organization and operated through one manager control room. The `organizations` table supplies company-wide configuration; it is not a tenant selector, and no user can switch between organizations.

## Live resources

| Table | Purpose and essential columns |
|---|---|
| `organizations` | company identity, timezone, currency, active state, and operational policy |
| `regions` | organization hierarchy |
| `areas` | region hierarchy |
| `territories` | area, code, name, native `boundary` polygon, active state |
| `roles` | manager and salesperson role definitions |
| `employees` | Appwrite user link, display name, phone, manager, status |
| `employee_assignments` | effective-dated role and optional territory assignment |
| `audit_logs` | immutable management/security mutations |
| `outlets` | territory, official name/address, immutable latitude/longitude and native `coordinates` point, optional source visit |
| `route_assignments` | salesperson, outlet, work date, sequence, completion state |
| `route_sequence_counters` | atomic per-salesperson/day sequence allocator for repeated or overlapping planning requests |
| `attendance_records` | daily check-in/check-out and GPS evidence |
| `visits` | assigned or salesperson-added visit, evidence and place-approval state, required native `coordinates` point |
| `visit_evidence` | photo/audio metadata linked to Storage files |
| `location_points` | policy-filtered route points, native coordinates, accuracy, and foreground/background source |
| `orders` | salesperson/customer/order totals and native coordinates |
| `team_messages` | legacy retained records; no current app or dashboard chat surface reads or writes this table |
| `sales_deals` | salesperson-owned opportunity, working value, stage, next action, follow-up, and notes |
| `auth_attempt_windows` | private HMAC-derived login-attempt windows; no raw email, IP address, or password |

The active `organizations` row also stores guarded route-quality and automatic-sync controls. Management can tune capture cadence, movement threshold, weak-fix cutoff, stationary jitter radius, route-gap segmentation, plausible speed, and phone sync cadence from the web dashboard. Mobile and route rendering normalize every value against safe bounds and fall back to production defaults when an older cached context has no policy.

Storage uses the single private `visit-evidence` bucket. There are no public customer, employee, location, order, or evidence resources. Photo and audio files, together with their `visit_evidence` metadata rows, have a strict seven-day window measured from `captured_at`. The scheduled `evidence-retention` function removes expired files and rows hourly, while `/api/evidence/[fileId]` refuses playback as soon as the seven-day boundary is reached. Managers can delete a retained item sooner from the Media retention dashboard. Automatic and manager-initiated deletions write immutable audit records; visit outcomes, GPS checks, orders, and audit history remain.

Visit check-in remains a persisted mobile draft and is not sent to the server. When the salesperson explicitly submits, `POST /api/v1/visits/submit` validates both GPS points plus the required photo and audio note, stores both evidence records with stable retry IDs, and only then creates or marks the visit `completed`. The phone deletes its protected local copies after explicit server confirmation. The retired check-in endpoint rejects partial visits, and reporting only reads completed visits.

## Salesperson-marked places

A salesperson-added visit follows `pending_review → approved` or `pending_review → rejected`. The first accurate point captured when the salesperson starts the report is the candidate place and never moves during review or later edits. The app requests a high-accuracy fix and preserves the device's actual uncertainty reading (for example, ±8 m); 50 m is only the hard rejection ceiling for an unusably weak mark, not the target accuracy or geofence radius. Submission also requires the completed sales report, a photo, a voice note, and a finish point inside the configured visit radius.

Management reviews the evidence and may supply the official place name, address, and containing territory. Approval creates one permanent `outlets` row linked by `origin_visit_id`; that outlet keeps the submitted coordinates. Management may later correct only its official name through the place directory. The original salesperson-entered name remains on the visit and in the audit trail.

The mobile Activity screen combines confirmed visits, place-review decisions, and sales events from `GET /api/v1/context` with the local upload outbox. A local item is removed only after an explicit server confirmation. Location batches use stable row IDs, drain more than one page, retain partial failures, and are coalesced into one active upload. Non-retryable corrupt points are quarantined so valid points continue, then shown for explicit removal in Activity. The durable outbox can recover independently if the main UI-state record is damaged. Live dashboard polling advances by server `received_at` and continues saturated pages with a row cursor, so older points uploaded after reconnecting still appear.

Route display never treats every raw fix as travelled road. The phone captures high-fidelity updates during active work, rejects weak or physically impossible fixes before queueing, and keeps stationary heartbeats without recording normal GPS scribble. Foreground recording is the default. A salesperson may separately enable background permission for screen-lock continuity; that task has its own persisted active-session scope and stops at Finish session or sign out. The dashboard preserves all server-received points in the audit log but draws quality-checked segments, breaking the solid line across long gaps or implausible jumps and showing only a clearly dashed direction estimate across moderate gaps. Migration 008 adds employee-scoped indexes for recent cross-day place-review activity; migration 009 adds the organization-level operational controls; migration 010 adds atomic daily route-sequence counters so double taps, retries, and overlapping tabs cannot create duplicate positions.

The Sales pipeline is deliberately not a separate CRM or tenant layer. A salesperson can keep a customer opportunity at `lead`, `qualified`, `proposal`, `negotiation`, `won`, or `lost`, while management can update its stage, next action, and follow-up. FieldOPS exposes no chat, manager contact, calling, or WhatsApp feature. Deal mutations are idempotent and record changes use optimistic version checks. Deal values are salesperson-entered working estimates—not booked revenue or a forecast. Migration 011 originally added contact/message storage alongside `sales_deals`; those legacy fields and rows may remain for non-destructive deployment compatibility but are not part of the current product.

Dashboard access uses a named Appwrite user account, never a shared password-only bypass. Appwrite verifies the email and password, and the dashboard then authorizes solely from the exact server-managed `admin` user label returned for that session. No employee record, role row, manager role, or effective assignment is required for dashboard entry. Mobile field access remains separate and requires a currently effective `sales_person` assignment. Migration 012 uses the installation's existing single-manager records only to identify the initial account that should receive `admin`; those records are not consulted during runtime dashboard authorization. Labels remain server-managed; the migration does not revoke or recreate sessions.

Both credential endpoints consume durable attempt counters before asking Appwrite to create a session. Migration 013 creates a private row-secured table keyed only by HMAC digests of the normalized email, client network, and fixed 15-minute window. It permits up to six attempts per email/network and twenty per email across networks, returns `429` with `Retry-After` when blocked, and fails closed if counter storage is unavailable. The production project enables only email/password authentication, limits users to ten sessions of at most 90 days, invalidates sessions on password change, and applies common-password, personal-data, and five-password history checks to future password changes.

The empty, unreferenced `permissions`, `role_permissions`, `permission_overrides`, and `integration_events` tables and the empty legacy `boundary_geojson` column were removed on 2026-08-11 after their row counts and runtime references were rechecked. Roles and effective assignments are the active authorization model.

## Territory rules

- Zero effective territory assignments means visits and orders are unrestricted by territory.
- One or more assignments means a fresh GPS point must fall inside at least one assigned, active polygon.
- A territory assignment without a saved polygon blocks visits and orders until management draws the boundary.
- Mobile disabled states provide immediate feedback; every visit and order API repeats the check server-side.
- Assigned outlet completion remains separate from salesperson-added visits.
- Visits and orders fail closed until the current day’s cached or freshly downloaded territory policy is available.

`scripts/migrate-006-territory-spatial.mjs` adds/backfills native point columns and their spatial indexes. The territory polygon stays optional while a legacy territory is unmapped; after every territory has a real boundary, rerunning the migration makes the polygon required and creates its spatial index.

`scripts/migrate-007-place-approvals.mjs` adds the approval/source fields and review indexes, initializes existing visit states, and adds receipt-time location indexes used by the lossless live feed. Run it after migration 006 and before deploying the matching web/mobile release. It is additive and idempotent; rehearse it against a scrubbed snapshot before production.

## Environment

The uncommitted root `.env` needs only `APPWRITE_API_KEY` for administrative migrations. `appwrite.config.json` provides the endpoint and project ID to local commands. Appwrite Sites retains its server runtime variables; the mobile build receives only `EXPO_PUBLIC_API_BASE_URL`.
