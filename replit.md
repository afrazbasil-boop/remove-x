# RemoveX AI

RemoveX AI is a professional image workspace for removing backgrounds, changing scenes, and enhancing image clarity.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/removex-ai` — responsive React/Vite product experience and tool workflows
- `artifacts/api-server/src/routes/tools.ts` — image processing contract implementation and development-mode usage tracking
- `lib/api-spec/openapi.yaml` — source of truth for dashboard, activity, and image processing APIs
- `lib/api-client-react/src/generated` — generated frontend API hooks
- `artifacts/removex-ai/src/index.css` — RemoveX visual theme and motion utilities

## Architecture decisions

- AI processing is provider-agnostic and reports `development_mode` until a provider is configured.
- The first release keeps the upload → process → compare → download loop focused around three tools.
- Credit usage is deducted only after the server accepts a valid processing request.
- The frontend uses generated OpenAPI hooks rather than hand-written API types.

## Product

The app includes a public workspace landing page, background remover, background changer, image enhancer, usage dashboard, pricing, and branded supporting auth screens. Uploads are validated client-side and server-side, previews are local, and the API returns explicit provider status.

## User preferences

No preferences recorded.

## Gotchas

- Run API codegen after changing `lib/api-spec/openapi.yaml`.
- Image results remain transparent about development mode; do not replace this with a fake processed image.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
