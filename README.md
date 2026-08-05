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

