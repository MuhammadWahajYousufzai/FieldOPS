# Architecture audit

Status: baseline audit · 2026-08-04

## Executive finding

The supplied workspace was an initialized Git worktree with no commits, remote, source files, schema exports, or production configuration. Therefore no existing Yousuf Rice implementation could be verified or reused. This repository is a new, non-destructive foundation. Claims about a prior Next.js, Expo, Appwrite, products, customers, orders, MCP tools, or production data remain **unverified** until those sources and an Appwrite schema export are supplied.

## Current package boundaries

| Path | Responsibility | Status |
|---|---|---|
| `apps/web` | Next.js management interface | Foundation implemented |
| `apps/mobile` | Expo Router field interface | Foundation implemented |
| `packages/domain` | Pure authorization, geography, sync and future business rules | Foundation implemented and tested |
| `packages/appwrite` | Browser, session and admin Appwrite adapters | Foundation implemented; not connected |
| `docs/field-operations` | Product, data and delivery decisions | Implemented |

## Capability audit

| Area | State | Evidence / action |
|---|---|---|
| Web application | Partially implemented | Responsive operations dashboard shell in `apps/web` |
| Mobile application | Partially implemented | Offline-aware daily route shell in `apps/mobile` |
| Appwrite client access | Partially implemented | Public browser adapter uses public endpoint/project only |
| Appwrite server access | Partially implemented | API key isolated behind `server-only`; infrastructure absent |
| TablesDB schema | Missing | No endpoint access or schema export; proposal in `DATA_MODEL.md` |
| Authentication/sessions | Missing | Session client factory exists; login/API enforcement not yet built |
| Roles and permissions | Partially implemented | Permission vocabulary and territory check exist; persistence missing |
| Products/pricing/customers/orders | Missing/unverified | Must reconcile before creating tables or compatibility adapters |
| Admin dashboards | Partially implemented | Read-only shell with operational information architecture |
| Sales/employee/delivery | Missing | Phase 1 focuses field sales; delivery deferred |
| Maps/location | Partially implemented | Provider-neutral coordinates/geofence rule; no SDK/provider |
| Offline/sync | Partially implemented | Operation contract and retry rule; persistent store/outbox missing |
| Notifications/push | Missing | Provider abstraction planned after core visits |
| Analytics/reporting | Partially implemented | UI information architecture only; query layer missing |
| APIs/MCP/domain services | Partially implemented | Pure domain package exists; APIs and MCP absent |
| Tests/lint/CI | Partially implemented | Unit tests configured; integration/E2E/CI missing |
| Duplicated/abandoned code | None found | Workspace was empty |

## Security review

- API keys are read only in `packages/appwrite/src/server.ts`, which imports `server-only`.
- The web adapter accepts only public Appwrite configuration.
- Authorization is modeled as a permission **and** an assigned territory; role names alone grant nothing.
- No tables or buckets are created, so no production data or permissions were changed.
- Before connection: inventory Appwrite keys, table/bucket permissions, team memberships, public rows, session-cookie settings, logs, and secret history.
- Required controls still missing: authenticated middleware, scoped repositories, row permissions, audit writer, rate limiting, secure upload URLs, export controls, retention enforcement, and distributor isolation tests.

## Production conflict risks

Highest risk is creating parallel `customers`, `products`, `orders`, or user identities. These names are reserved proposals only. Import the live schema and map legacy IDs before migration authoring. Never auto-run schema creation from application startup. All changes must be additive, versioned, rehearsed against a scrubbed snapshot, and separately approved.

## Reuse decision

There were no legacy files to reuse. Exact new reuse points are `packages/domain/src/index.ts` for rules, `packages/appwrite/src/server.ts` for server repositories, `packages/appwrite/src/web.ts` for browser sessions, and the two app roots for interfaces. When legacy source becomes available, reconcile rather than copy it blindly.

