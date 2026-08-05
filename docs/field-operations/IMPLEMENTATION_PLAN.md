# Implementation plan

## Architecture decisions

- Keep business rules in `@fieldops/domain`; UI and HTTP handlers only orchestrate.
- Use Appwrite TablesDB object-parameter APIs. No Appwrite Functions without measured need.
- Use Next.js server routes as the policy boundary. Create an Appwrite session client per request; reserve API-key clients for narrowly reviewed administration.
- Represent roles as bundles of granular permissions. Effective-dated assignments constrain region/territory visibility.
- Use an operation outbox on mobile. Idempotency keys are generated once and survive retries/restarts.
- Treat provider integrations as ports: route optimization, maps, messaging, storage and legacy orders.
- Keep “Yousuf Rice FieldOps” in one domain constant and localization catalogs later.

## Phase 1 API surface

All routes are versioned under `/api/v1`, validate shared schemas, authorize scope, accept correlation IDs, and return stable error codes.

| Method/path | Domain service |
|---|---|
| `GET /me/field-context` | `GetFieldContext` |
| `POST /attendance/check-in` / `check-out` | `AttendanceService` |
| `GET /daily-plans/:date` | `VisitPlanningService` |
| `POST /visits/check-in` / `:id/check-out` | `VisitExecutionService` |
| `POST /sync/batch` / `GET /sync/operations/:key` | `SyncService` |
| `GET/POST /customers` / `POST /customers/:id/approve` | `CustomerService` |
| `GET/POST /beats` / `POST /daily-plans/publish` | `BeatPlanningService` |
| `POST /location-points/batch` | `LocationTrackingService` |
| `GET /catalog` / `POST /orders/drafts` / `:id/submit` | legacy ports + `OrderCaptureService` |
| `GET /management/live-status` / `reports/visits` / `reports/sales` | `ReportingQueryService` |

## Screens

Mobile: sign in; permission/tracking disclosure; today dashboard; attendance; route map/list; outlet detail; visit check-in; visit outcome; fast order entry; sync queue; task errors; profile/tracking status.

Web: sign in; operations overview; organization hierarchy; employees/assignments; territories/markets; outlets/approval; beats; daily planner; live field status; visit detail; audit log; visit and sales reports.

## Delivery slices

1. **Current foundation:** workspace, UI direction, domain authorization/geofence/retry rules, Appwrite boundaries, planning documents.
2. **Identity and scope:** schema reconciliation, SSR session, effective permissions, assignment repositories, denial/audit tests.
3. **Attendance vertical:** shifts → mobile check-in → server geofence/idempotency → manager status → audit.
4. **Outlet and beat vertical:** scoped CRM, duplicate candidates, approval, beat editor and published plan download.
5. **Visit vertical:** offline check-in/out, attachments, outcomes, sync/conflicts, route adherence and report.
6. **Order vertical:** legacy catalogue/pricing adapter, server totals, draft/submit, existing-order compatibility.
7. **Hardening:** retention jobs in existing server architecture, exports, rate limits, integration/E2E, low-end Android profiling and rollout flags.

## Quality gates

- Unit: permissions, assignment dates, attendance windows, geofence, duplicate matching, state machines, pricing adapter contracts and retry/conflicts.
- Integration: Appwrite permissions/repositories, idempotency, audit/outbox atomic behavior, distributor isolation.
- Component: offline state, financial confirmation, filters and empty/error states.
- E2E: manager assignment through confirmed visit/order and audit visibility.
- CI: install lockfile, typecheck, unit/integration test, web build; E2E against disposable Appwrite only.

## Immediate next step

Obtain the live Appwrite schema/permission export and legacy domain source. Then implement the **identity and territory scope** slice before attendance; every later workflow depends on it. No migration should run until reconciliation and a scrubbed rehearsal succeed.

