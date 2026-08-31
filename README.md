# Yousuf Rice FieldOps

Offline-capable field sales and distribution operations for Yousuf Rice. This repository is a new foundation because no legacy source was present in the supplied workspace.

## Workspaces

- `apps/web`: Next.js management dashboard
- `apps/mobile`: Expo Router field application
- `packages/domain`: framework-free business rules
- `packages/appwrite`: Appwrite client/server boundaries
- `docs/field-operations`: architecture and delivery plan

## Start

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm dev
```

Copy `.env.example` to `.env.local` only after Appwrite infrastructure is available. No migration is automatically executed.

For an existing installation, run the versioned migrations in order. The current route, control-room, sales-pipeline, and identity-login release requires `scripts/migrate-008-activity-sync.mjs` through `scripts/migrate-013-auth-rate-limit.mjs` after migration 007 and before the matching server code is deployed; rehearse migrations on a scrubbed snapshot first. Migration 012 is fail-closed: it uses the installation's existing single-manager records only to provision the initial `admin` label. Runtime dashboard authorization uses the valid Appwrite session and exact `admin` label only; it does not query employee roles or assignments. Migration 013 adds private, pseudonymous credential-attempt counters used by both admin and salesperson login.
