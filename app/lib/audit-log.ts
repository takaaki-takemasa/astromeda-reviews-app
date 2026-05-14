/**
 * Append-only audit log helper.
 * Writes to astromeda_audit_log Metaobject (gid 20809089316).
 *
 * Threat Model T-06 / PIA 6章 対応。
 * 全 admin action は必ず本 helper を経由して記録する。
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { AstromedaAuditLogFields, AuditAction } from "./metaobject-definitions";

interface AppendArgs {
  admin: AdminApiContext;
  actor: string;
  action: AuditAction | string;
  resource_id: string;
  resource_type?: string;
  request?: Request;
  metadata?: Record<string, unknown>;
}

const MUTATION = `#graphql
  mutation AppendAuditLog($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id type handle }
      userErrors { field message code }
    }
  }
`;

function extractIp(request?: Request): string {
  if (!request) return "";
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "";
}

function extractUa(request?: Request): string {
  return request?.headers.get("user-agent") ?? "";
}

function extractRequestId(request?: Request): string {
  if (!request) return "";
  // Vercel automatically injects x-vercel-id; fall back to anything sentry-like
  return (
    request.headers.get("x-vercel-id") ??
    request.headers.get("x-request-id") ??
    request.headers.get("sentry-trace") ??
    ""
  );
}

/**
 * Write an audit log entry.
 * Throws on failure (audit-log MUST persist - silent failure is a security hole).
 */
export async function appendAuditLog(args: AppendArgs): Promise<{ id: string }> {
  const fields: AstromedaAuditLogFields = {
    actor: args.actor,
    action: args.action,
    resource_id: args.resource_id,
    resource_type: args.resource_type as never,
    timestamp: new Date().toISOString(),
    ip: extractIp(args.request),
    user_agent: extractUa(args.request),
    request_id: extractRequestId(args.request),
    metadata_json: args.metadata ? JSON.stringify(args.metadata) : undefined,
  };

  const fieldEntries = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([key, value]) => ({ key, value: String(value) }));

  const response = await args.admin.graphql(MUTATION, {
    variables: {
      metaobject: {
        type: "astromeda_audit_log",
        fields: fieldEntries,
      },
    },
  });
  const data = (await response.json()) as {
    data?: {
      metaobjectCreate?: {
        metaobject?: { id: string };
        userErrors: Array<{ field: string[]; message: string; code: string }>;
      };
    };
  };

  const userErrors = data.data?.metaobjectCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `Audit log write failed: ${userErrors.map((e) => `${e.field.join(".")}=${e.message}`).join("; ")}`,
    );
  }
  const id = data.data?.metaobjectCreate?.metaobject?.id;
  if (!id) throw new Error("Audit log write returned no metaobject id");
  return { id };
}

/**
 * Wrapper for "best-effort" audit logging (logs error but doesn't throw).
 * Use in non-critical paths.
 */
export async function appendAuditLogSafe(args: AppendArgs): Promise<void> {
  try {
    await appendAuditLog(args);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[audit-log] failed", { actor: args.actor, action: args.action, err });
  }
}
