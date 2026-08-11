# Product requirements

## Product definition

**Yousuf Rice FieldOps** is the temporary centralized name. It serves Karachi field representatives and their managers first, remains ready for English/Urdu/Roman Urdu, formats money in PKR, and prioritizes low-cost Android devices and intermittent connectivity.

## Phase 1 outcome

A manager can define a scoped territory and beat, assign a representative, and publish a daily plan. The representative can check in during an authorized shift, use the downloaded plan offline, check into an outlet with GPS evidence, record an outcome, and create an order draft. The manager can see confirmed activity and audit-sensitive actions.

## Phase 1 feature gap matrix

| Capability | Current | Phase 1 acceptance |
|---|---|---|
| Organization hierarchy | Missing | Regions → areas → territories with active dates |
| Access control | Foundation | Server verifies granular permission and assignment at event time |
| Employee profiles | Missing | Work email, manager, status, role/territory history |
| Attendance | Missing | Idempotent check-in/out, accuracy, geofence, shift/privacy rules |
| Outlet CRM | Missing | Search, scoped assignment, duplicate hints, approval state |
| Beats/plans | Missing | Recurrence, ordered outlets, daily plan, missed/rescheduled status |
| Visits | Geofence rule | Offline-safe check-in/out and outcomes with authoritative sync state |
| Location | Foundation | Active-shift queue, last-known point, retention configuration |
| Field orders | Missing | Existing-product adapter, server totals, idempotent draft/submit |
| Manager dashboard | UI foundation | Permission-scoped live status and visit/sales filters |
| Reports | UI foundation | Reusable scoped query layer and CSV export audit event |
| Offline sync | Retry contract | Persistent outbox, attachments, visible errors, manual retry/conflicts |
| Audit logs | Missing | Immutable logs for listed sensitive actions |

## User-critical acceptance criteria

1. A user without the action permission receives 403 even if the UI exposes a stale control.
2. A manager cannot retrieve records outside current effective assignments.
3. Replaying a check-in or order request with the same idempotency key creates one result.
4. A visit records point, accuracy, device time, server receipt time, geofence distance and decision.
5. Tracking starts only inside an authorized checked-in shift and visibly stops on checkout.
6. Offline work displays pending/failed/confirmed states; “synced” appears only after server confirmation.
7. Order totals and discounts are recomputed on the server using effective pricing.
8. Existing product/customer/order IDs are preserved through adapters after legacy reconciliation.
9. Every permission change, reassignment, export and financial override produces an immutable audit event.
10. Low-end Android core flows remain usable without a network after daily data download.

## Deferred from Phase 1

Distribution inventory, fulfillment, van sales, receivables, returns, campaigns, merchandising, configurable forms, B2B self-service, gamification, AI recommendations and anomaly scoring. Phase 1 keeps extension points but does not ship empty pages for these modules.
