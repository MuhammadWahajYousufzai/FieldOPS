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

For an existing installation, run the versioned migrations in order. The salesperson-marked place approval release requires `scripts/migrate-007-place-approvals.mjs` before the matching server code is deployed; rehearse migrations on a scrubbed snapshot first.
