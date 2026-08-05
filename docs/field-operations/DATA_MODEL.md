# Phase 1 data model

Migration 001 was applied additively to the empty Appwrite project on 2026-08-04. It provisions the identity-and-scope subset described below; later Phase 1 tables remain proposals. IDs are stable `varchar`; timestamps are ISO datetimes; sensitive mutations append audit rows.

Applied by `scripts/migrate-001-identity-scope.mjs`: `organizations`, `regions`, `areas`, `territories`, `roles`, `permissions`, `role_permissions`, `employees`, `employee_assignments`, `permission_overrides`, `audit_logs`, and `integration_events`. Every table has row security enabled and no client table permissions, so only scoped server APIs can currently access it.

## Tables and essential columns

| Table | Essential columns | Indexes |
|---|---|---|
| `organizations` | name, legal_name, timezone, currency, active | active |
| `regions` | organization_id, code, name, active | unique(org,code), active |
| `areas` | region_id, code, name, active | unique(region,code) |
| `territories` | area_id, code, name, boundary_geojson?, active | unique(area,code), area_id+active |
| `markets` | territory_id, name, active | territory_id+active |
| `roles` | code, name, system, active | unique(code) |
| `permissions` | code, description | unique(code) |
| `role_permissions` | role_id, permission_id | unique(role,permission) |
| `employees` | user_id, employee_code, manager_employee_id?, status, joining_date | unique(user_id), unique(employee_code), manager+status |
| `employee_assignments` | employee_id, role_id, territory_id?, effective_from, effective_to?, assigned_by | employee+dates, territory+dates |
| `user_permission_overrides` | user_id, permission_id, effect, scope_json, dates, reason | user+dates |
| `devices` | employee_id, installation_id, platform, status, last_seen_at | unique(installation_id), employee+status |
| `shifts` | territory_id?, name, start_time, end_time, tracking_enabled | territory_id |
| `attendance_records` | employee_id, shift_id, work_date, in/out points, accuracy, times, status, idempotency_key | unique(idempotency_key), unique(employee,work_date), work_date+status |
| `customers` | legacy_id?, business_name, type, channel, status, territory_id, assigned_employee_id?, phone_normalized?, verification_status | unique(legacy_id), territory+status, phone, assigned+status |
| `customer_addresses` | customer_id, label, address_text, lat, lng, geofence_radius_m, primary | customer_id, lat+lng |
| `customer_assignments` | customer_id, employee_id, distributor_id?, effective dates | customer+dates, employee+dates |
| `beats` | territory_id, code, name, recurrence_json, active | unique(territory,code) |
| `beat_outlets` | beat_id, customer_id, sequence, preferred_days | unique(beat,customer), beat+sequence |
| `visit_plans` | work_date, employee_id, beat_id?, status, published_at | employee+date, date+status |
| `visits` | plan_id?, customer_id, employee_id, purpose, status, in/out times/points, accuracies, geofence distances, outcome, idempotency_key, version | unique(idempotency_key), employee+time, customer+time, plan_id |
| `location_points` | employee_id, route_session_id, captured_at, received_at, lat, lng, accuracy, speed?, heading?, battery?, risk_flags | employee+captured_at, route_session+captured_at |
| `route_sessions` | employee_id, attendance_id, started_at, ended_at, state | employee+started_at, attendance_id |
| `sync_operations` | user_id, device_id, idempotency_key, entity_type, entity_id, operation, state, attempts, error_code?, payload_hash, received_at | unique(idempotency_key), device+state |
| `audit_logs` | actor_user_id, action, entity_type, entity_id, occurred_at, before_json?, after_json?, reason?, session_id?, correlation_id | entity+time, actor+time, action+time |
| `integration_events` | event_type, entity_type, entity_id, payload_json, occurred_at, published_at?, attempts | published_at+occurred_at, entity+time |

## Existing-domain adapters

Do not create `products`, `price_lists`, `orders` or `order_items` until live equivalents are inspected. Phase 1 defines `ProductCatalog`, `PricingEngine`, and `OrderRepository` ports in the domain layer; legacy implementations map stable IDs and statuses. The server is authoritative for prices, promotions, credit and totals.

## Permissions

Clients receive no table-wide write access for sensitive tables. Next.js APIs use a per-request Appwrite session plus explicit domain authorization. Admin credentials are limited to narrow server repositories. Files use owner/scoped-team reads, no `Role.any()` on customer, employee, finance, location or proof data. Distributor scope is a mandatory repository predicate and test case.

## Migration sequence (not executed)

1. Export live databases/tables/columns/indexes/permissions/buckets and record counts.
2. Build a legacy-to-canonical mapping and collision report.
3. Create additive organization/RBAC tables under versioned migration `fieldops_001`.
4. Backfill references in rehearsal environment; do not rewrite legacy IDs.
5. Add employee/territory/customer assignment tables (`fieldops_002`).
6. Add attendance/visits/location/sync/audit/outbox (`fieldops_003`) with restrictive permissions.
7. Deploy read adapters, compare counts and sampled results, then enable writes per workflow behind flags.
8. Define rollback as disabling new writes and adapters; never drop production tables during rollout.
