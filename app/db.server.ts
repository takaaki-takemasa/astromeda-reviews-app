// NOTE (Phase A-08b, 2026-05-14): Prisma SQLite is incompatible with Vercel serverless.
// This stub exists so webhooks.app.uninstalled.tsx and webhooks.app.scopes_update.tsx
// can still import db without crashing at module load.
// Session cleanup for these webhooks is handled by MemorySessionStorage automatically
// on app restart, and the webhooks now no-op their session.deleteMany calls.
// TODO (Phase A+): wire this to Upstash Redis once that's set up, OR refactor
// webhooks to call sessionStorage.deleteSessions() from shopify.server.ts directly.

const noopDb = {
  session: {
    deleteMany: async (_args?: unknown) => ({ count: 0 }),
    findMany: async (_args?: unknown) => [],
    findUnique: async (_args?: unknown) => null,
    create: async (_args?: unknown) => null,
    update: async (_args?: unknown) => null,
    upsert: async (_args?: unknown) => null,
    delete: async (_args?: unknown) => null,
  },
};

export default noopDb;
