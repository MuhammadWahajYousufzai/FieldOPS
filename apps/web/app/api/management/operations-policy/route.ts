import { Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";
import {
  isAppwriteConflict,
  managementAuditIdentity,
  managementOperationKey,
  optimisticWriteDecision,
} from "../../../../lib/management-write";
import {
  operationalPolicyFromRow,
  operationalPolicyMatches,
  validateOperationalPolicy,
} from "../../../../lib/operational-policy";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function PATCH(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const policy = validateOperationalPolicy(body);
  if (!policy) {
    return NextResponse.json({
      error: "Use the allowed route and sync ranges shown beside each control.",
    }, { status: 400 });
  }

  const db = createAdminTablesDb();
  const expectedUpdatedAt = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : "";
  const transaction = await db.createTransaction({ ttl: 60 });
  try {
    const organization = await getActiveOrganization(db, transaction.$id);
    if (!organization) {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      return NextResponse.json({ error: "The active organization was not found." }, { status: 409 });
    }
    const decision = optimisticWriteDecision(
      expectedUpdatedAt,
      organization.$updatedAt,
      operationalPolicyMatches(organization, policy),
    );
    if (decision !== "write") {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      if (decision === "replay") {
        return NextResponse.json({
          ok: true,
          policy: operationalPolicyFromRow(organization),
          changed: false,
          replayed: true,
        });
      }
      return policyConflictResponse();
    }

    const now = new Date().toISOString();
    const data = {
      route_sample_seconds: policy.sampleIntervalSeconds,
      route_distance_meters: policy.distanceIntervalMeters,
      route_max_accuracy_meters: policy.maxAcceptedAccuracyMeters,
      route_stationary_jitter_meters: policy.stationaryJitterMeters,
      route_segment_gap_minutes: policy.segmentGapMinutes,
      route_max_speed_mps: policy.maxPlausibleSpeedMps,
      mobile_sync_interval_seconds: policy.syncIntervalSeconds,
      field_policy_updated_at: now,
      field_policy_updated_by: actor.user.$id,
    };
    const operationKey = managementOperationKey(body.operationId, "operations.policy", organization.$id, expectedUpdatedAt, policy);
    const { auditId, correlationId } = managementAuditIdentity("operations.policy_updated", organization.$id, operationKey);
    await db.updateRow({
      databaseId,
      tableId: "organizations",
      rowId: organization.$id,
      transactionId: transaction.$id,
      data,
    });
    await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId: transaction.$id, data: {
      actor_user_id: actor.user.$id,
      action: "operations.policy_updated",
      entity_type: "organization",
      entity_id: organization.$id,
      occurred_at: now,
      before_json: JSON.stringify({
        routeSampleSeconds: organization.route_sample_seconds,
        routeDistanceMeters: organization.route_distance_meters,
        routeMaxAccuracyMeters: organization.route_max_accuracy_meters,
        routeStationaryJitterMeters: organization.route_stationary_jitter_meters,
        routeSegmentGapMinutes: organization.route_segment_gap_minutes,
        routeMaxSpeedMps: organization.route_max_speed_mps,
        mobileSyncIntervalSeconds: organization.mobile_sync_interval_seconds,
      }),
      after_json: JSON.stringify(policy),
      reason: "Management changed route quality and mobile sync controls",
      correlation_id: correlationId,
    }, permissions: [] });
    await db.updateTransaction({ transactionId: transaction.$id, commit: true });
    const updated = await db.getRow({ databaseId, tableId: "organizations", rowId: organization.$id });
    return NextResponse.json({
      ok: true,
      policy: operationalPolicyFromRow(updated),
      changed: true,
      replayed: false,
    });
  } catch (error) {
    await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
    if (isAppwriteConflict(error)) {
      const current = await getActiveOrganization(db).catch(() => null);
      if (current && operationalPolicyMatches(current, policy)) {
        return NextResponse.json({
          ok: true,
          policy: operationalPolicyFromRow(current),
          changed: false,
          replayed: true,
        });
      }
      return policyConflictResponse();
    }
    return NextResponse.json({
      error: "Tracking and sync controls could not be saved. No partial change was applied; retrying is safe.",
    }, { status: 500 });
  }
}

async function getActiveOrganization(
  db: ReturnType<typeof createAdminTablesDb>,
  transactionId?: string,
) {
  return (await db.listRows({
    databaseId,
    tableId: "organizations",
    queries: [Query.equal("active", true), Query.orderAsc("$createdAt"), Query.limit(1)],
    ...(transactionId ? { transactionId } : {}),
    total: false,
    ttl: 0,
  })).rows[0] ?? null;
}

function policyConflictResponse() {
  return NextResponse.json({
    error: "These controls changed in another tab or request. Refresh before saving again.",
    code: "operations_policy_changed",
  }, { status: 409 });
}
