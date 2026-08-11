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
| `outlets` | territory, address, latitude/longitude, required native `coordinates` point |
| `route_assignments` | salesperson, outlet, work date, sequence, completion state |
| `attendance_records` | daily check-in/check-out and GPS evidence |
| `visits` | assigned or salesperson-added visit, evidence state, required native `coordinates` point |
| `visit_evidence` | photo/audio metadata linked to Storage files |
| `location_points` | minute-by-minute route points and native coordinates |
| `orders` | salesperson/customer/order totals and native coordinates |

Storage uses the single private `visit-evidence` bucket. There are no public customer, employee, location, order, or evidence resources.

Visit check-in remains a persisted mobile draft and is not sent to the server. When the salesperson explicitly submits, `POST /api/v1/visits/submit` validates both GPS points plus the required photo and audio note, stores both evidence records with stable retry IDs, and only then creates or marks the visit `completed`. The retired check-in endpoint rejects partial visits, and reporting only reads completed visits.

The empty, unreferenced `permissions`, `role_permissions`, `permission_overrides`, and `integration_events` tables and the empty legacy `boundary_geojson` column were removed on 2026-08-11 after their row counts and runtime references were rechecked. Roles and effective assignments are the active authorization model.

## Territory rules

- Zero effective territory assignments means visits and orders are unrestricted by territory.
- One or more assignments means a fresh GPS point must fall inside at least one assigned, active polygon.
- A territory assignment without a saved polygon blocks visits and orders until management draws the boundary.
- Mobile disabled states provide immediate feedback; every visit and order API repeats the check server-side.
- Assigned outlet completion remains separate from salesperson-added visits.

`scripts/migrate-006-territory-spatial.mjs` adds/backfills native point columns and their spatial indexes. The territory polygon stays optional while a legacy territory is unmapped; after every territory has a real boundary, rerunning the migration makes the polygon required and creates its spatial index.

## Environment

The uncommitted root `.env` needs only `APPWRITE_API_KEY` for administrative migrations. `appwrite.config.json` provides the endpoint and project ID to local commands. Appwrite Sites retains its server runtime variables; the mobile build receives only `EXPO_PUBLIC_API_BASE_URL`.
