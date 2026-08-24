# FieldOPS live data model

The self-hosted Appwrite 1.9.6 project uses TablesDB with server-only access. Every table has row security enabled and no table-wide client permissions. The Next.js Appwrite Site is the policy boundary for both the management dashboard and mobile API.

## Live resources

| Table | Purpose and essential columns |
|---|---|
| `organizations` | company identity, timezone, currency, active state |
| `regions` | organization hierarchy |
| `areas` | region hierarchy |
| `territories` | area, code, name, native `boundary` polygon, active state |
| `roles` | manager and salesperson role definitions |
| `employees` | Appwrite user link, display name, manager, status |
| `employee_assignments` | effective-dated role and optional territory assignment |
| `audit_logs` | immutable management/security mutations |
| `outlets` | territory, official name/address, immutable latitude/longitude and native `coordinates` point, optional source visit |
| `route_assignments` | salesperson, outlet, work date, sequence, completion state |
| `attendance_records` | daily check-in/check-out and GPS evidence |
| `visits` | assigned or salesperson-added visit, evidence and place-approval state, required native `coordinates` point |
| `visit_evidence` | photo/audio metadata linked to Storage files |
| `location_points` | minute-by-minute route points and native coordinates |
| `orders` | salesperson/customer/order totals and native coordinates |

Storage uses the single private `visit-evidence` bucket. There are no public customer, employee, location, order, or evidence resources.

Visit check-in remains a persisted mobile draft and is not sent to the server. When the salesperson explicitly submits, `POST /api/v1/visits/submit` validates both GPS points plus the required photo and audio note, stores both evidence records with stable retry IDs, and only then creates or marks the visit `completed`. The retired check-in endpoint rejects partial visits, and reporting only reads completed visits.

## Salesperson-marked places

A salesperson-added visit follows `pending_review → approved` or `pending_review → rejected`. The first accurate point captured when the salesperson starts the report is the candidate place and never moves during review or later edits. The app requests a high-accuracy fix and preserves the device's actual uncertainty reading (for example, ±8 m); 50 m is only the hard rejection ceiling for an unusably weak mark, not the target accuracy or geofence radius. Submission also requires the completed sales report, a photo, a voice note, and a finish point inside the configured visit radius.

Management reviews the evidence and may supply the official place name, address, and containing territory. Approval creates one permanent `outlets` row linked by `origin_visit_id`; that outlet keeps the submitted coordinates. Management may later correct only its official name through the place directory. The original salesperson-entered name remains on the visit and in the audit trail.

The mobile Activity screen combines confirmed visits, place-review decisions, and sales events from `GET /api/v1/context` with the local upload outbox. A local item is removed only after an explicit server confirmation. Location batches use stable row IDs, drain more than one page, retain partial failures, and are coalesced into one active upload. Non-retryable corrupt points are quarantined so valid points continue, then shown for explicit removal in Activity. The durable outbox can recover independently if the main UI-state record is damaged. Live dashboard polling advances by server `received_at` and continues saturated pages with a row cursor, so older points uploaded after reconnecting still appear.

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
