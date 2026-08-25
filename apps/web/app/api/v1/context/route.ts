import { Query, type Models } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, workDate } from "../../../../lib/mobile-auth";
import { operationalPolicyFromRow } from "../../../../lib/operational-policy";
import { ACTIVE_DEAL_STAGES } from "../../../../lib/team-desk";
import { territoryAccessForEmployee } from "../../../../lib/territory-access";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const MAX_ROWS_PER_TYPE = 100;
const MAX_RECENT_ACTIVITY = 50;
const RECENT_PLACE_DAYS = 14;
const RECENT_CLOSED_DEAL_DAYS = 90;
type DataRow = Models.Row & Record<string, unknown>;
type PlaceApprovalStatus = "pending_review" | "approved" | "rejected";
type ActivityStatus = "recorded" | PlaceApprovalStatus;
type RecentActivity = {
  id: string;
  entityId: string;
  kind: "work" | "visit" | "order" | "place";
  title: string;
  detail: string;
  status: ActivityStatus;
  occurredAt: string;
  amount?: number;
};

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function timestamp(value: unknown, fallback: unknown) {
  for (const candidate of [value, fallback]) {
    const parsed = new Date(stringValue(candidate));
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return "";
}

function placeApprovalStatus(value: unknown): PlaceApprovalStatus {
  return value === "approved" || value === "rejected" ? value : "pending_review";
}

function approvedOutletId(visit: DataRow, status: PlaceApprovalStatus) {
  if (status !== "approved") return "";
  return stringValue(visit.approved_outlet_id) || visit.$id;
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function outletsById(db: ReturnType<typeof createAdminTablesDb>, rawIds: string[]) {
  const ids = [...new Set(rawIds.filter(Boolean))];
  if (ids.length === 0) return new Map<string, DataRow>();
  const pages = await Promise.all(chunks(ids, MAX_ROWS_PER_TYPE).map((idChunk) => db.listRows({
    databaseId,
    tableId: "outlets",
    queries: [Query.equal("$id", idChunk), Query.limit(idChunk.length)],
  })));
  return new Map(pages.flatMap((page) => page.rows as DataRow[]).map((outlet) => [outlet.$id, outlet]));
}

async function evidenceTypesByVisit(db: ReturnType<typeof createAdminTablesDb>, rawVisitIds: string[]) {
  const visitIds = [...new Set(rawVisitIds.filter(Boolean))];
  const result = new Map<string, Set<string>>();
  if (visitIds.length === 0) return result;
  const pages = await Promise.all(chunks(visitIds, 40).map((visitChunk) => db.listRows({
    databaseId,
    tableId: "visit_evidence",
    queries: [Query.equal("visit_id", visitChunk), Query.limit(100)],
  })));
  for (const evidence of pages.flatMap((page) => page.rows as DataRow[])) {
    const visitId = stringValue(evidence.visit_id);
    const types = result.get(visitId) ?? new Set<string>();
    types.add(stringValue(evidence.type));
    result.set(visitId, types);
  }
  return result;
}

function visitName(visit: DataRow, outlets: Map<string, DataRow>, status?: PlaceApprovalStatus) {
  const officialId = status ? approvedOutletId(visit, status) : "";
  const outlet = outlets.get(officialId || stringValue(visit.outlet_id));
  return stringValue(outlet?.name) || stringValue(visit.customer_name) || "Customer visit";
}

function visitAddress(visit: DataRow, outlets: Map<string, DataRow>, status: PlaceApprovalStatus) {
  const outlet = outlets.get(approvedOutletId(visit, status));
  return stringValue(outlet?.address) || stringValue(visit.customer_address) || "GPS location saved";
}

function buildRecentActivity(
  attendanceRows: DataRow[],
  visitRows: DataRow[],
  orderRows: DataRow[],
  outlets: Map<string, DataRow>,
  evidenceTypes: Map<string, Set<string>>,
): RecentActivity[] {
  const activity: RecentActivity[] = [];

  for (const attendance of attendanceRows) {
    const checkInAt = timestamp(attendance.check_in_at, attendance.$createdAt);
    if (checkInAt) activity.push({
      id: `work:${attendance.$id}:check-in`,
      entityId: attendance.$id,
      kind: "work",
      title: "Work started",
      detail: "GPS attendance recorded",
      status: "recorded",
      occurredAt: checkInAt,
    });
    const checkOutAt = timestamp(attendance.check_out_at, "");
    if (checkOutAt) activity.push({
      id: `work:${attendance.$id}:check-out`,
      entityId: attendance.$id,
      kind: "work",
      title: "Work finished",
      detail: "Work session completed",
      status: "recorded",
      occurredAt: checkOutAt,
    });
  }

  for (const visit of visitRows) {
    const selfInitiated = visit.visit_type === "self_initiated" || !visit.route_assignment_id;
    const status: ActivityStatus = selfInitiated ? placeApprovalStatus(visit.place_approval_status) : "recorded";
    const name = visitName(visit, outlets, selfInitiated ? status as PlaceApprovalStatus : undefined);
    const reviewNote = stringValue(visit.review_note);
    const outcome = stringValue(visit.outcome) || "Visit completed";
    const types = evidenceTypes.get(visit.$id);
    const evidenceComplete = Boolean(types?.has("photo") && types.has("audio"));
    activity.push({
      id: `${selfInitiated ? "place" : "visit"}:${visit.$id}`,
      entityId: visit.$id,
      kind: selfInitiated ? "place" : "visit",
      title: selfInitiated ? `Place marked · ${name}` : `Visit · ${name}`,
      detail: selfInitiated
        ? status === "approved"
          ? "Approved as a permanent customer place"
          : status === "rejected"
            ? reviewNote || "Management did not approve this place"
            : evidenceComplete
              ? "Photo and voice received · awaiting management review"
              : "A new photo and voice report are needed before admin can approve"
        : outcome,
      status,
      occurredAt: timestamp(selfInitiated ? visit.reviewed_at : visit.check_out_at, visit.check_out_at || visit.$createdAt),
    });
  }

  for (const order of orderRows) {
    const linkedOutlet = outlets.get(stringValue(order.outlet_id));
    const customerName = stringValue(linkedOutlet?.name) || stringValue(order.customer_name) || "Customer";
    const productName = stringValue(order.product_name) || "Order";
    const amount = Number(order.total_amount);
    activity.push({
      id: `order:${order.$id}`,
      entityId: order.$id,
      kind: "order",
      title: `Order · ${customerName}`,
      detail: productName,
      status: "recorded",
      occurredAt: timestamp(order.captured_at, order.$createdAt),
      ...(Number.isFinite(amount) ? { amount } : {}),
    });
  }

  return activity
    .filter((item) => item.occurredAt)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, MAX_RECENT_ACTIVITY);
}

export async function GET(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const db = createAdminTablesDb();
  const requestedDate = new URL(request.url).searchParams.get("date") ?? "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : workDate();
  const employeeId = actor.employee.$id;
  const recentDate = new Date();
  recentDate.setDate(recentDate.getDate() - RECENT_PLACE_DAYS);
  const recentWorkDate = workDate(recentDate);
  const reviewedSince = recentDate.toISOString();
  const [
    routes,
    territoryAccess,
    attendanceResult,
    completedVisitResult,
    orderResult,
    reviewedPlaceResult,
    pendingPlaceResult,
    organizationResult,
    teamMessageResult,
    activeDealResult,
    closedDealResult,
  ] = await Promise.all([
    db.listRows({
      databaseId,
      tableId: "route_assignments",
      queries: [Query.equal("employee_id", employeeId), Query.equal("work_date", date), Query.orderAsc("sequence"), Query.limit(MAX_ROWS_PER_TYPE)],
    }),
    territoryAccessForEmployee(db, employeeId),
    db.listRows({
      databaseId,
      tableId: "attendance_records",
      queries: [Query.equal("employee_id", employeeId), Query.equal("work_date", date), Query.orderDesc("$createdAt"), Query.limit(MAX_ROWS_PER_TYPE)],
    }),
    db.listRows({
      databaseId,
      tableId: "visits",
      queries: [Query.equal("employee_id", employeeId), Query.equal("work_date", date), Query.equal("status", "completed"), Query.orderDesc("$createdAt"), Query.limit(MAX_ROWS_PER_TYPE)],
    }),
    db.listRows({
      databaseId,
      tableId: "orders",
      queries: [Query.equal("employee_id", employeeId), Query.equal("work_date", date), Query.orderDesc("$createdAt"), Query.limit(MAX_ROWS_PER_TYPE)],
    }),
    db.listRows({
      databaseId,
      tableId: "visits",
      queries: [Query.equal("employee_id", employeeId), Query.greaterThanEqual("reviewed_at", reviewedSince), Query.orderDesc("reviewed_at"), Query.limit(MAX_ROWS_PER_TYPE)],
    }).catch(() => ({ rows: [] })),
    db.listRows({
      databaseId,
      tableId: "visits",
      queries: [Query.equal("employee_id", employeeId), Query.equal("place_approval_status", "pending_review"), Query.greaterThanEqual("work_date", recentWorkDate), Query.orderDesc("work_date"), Query.limit(MAX_ROWS_PER_TYPE)],
    }).catch(() => ({ rows: [] })),
    db.listRows({
      databaseId,
      tableId: "organizations",
      queries: [Query.equal("active", true), Query.orderAsc("$createdAt"), Query.limit(1)],
    }),
    db.listRows({
      databaseId,
      tableId: "team_messages",
      queries: [Query.equal("employee_id", employeeId), Query.orderDesc("sent_at"), Query.limit(MAX_ROWS_PER_TYPE)],
    }),
    db.listRows({
      databaseId,
      tableId: "sales_deals",
      queries: [
        Query.equal("employee_id", employeeId),
        Query.equal("stage", [...ACTIVE_DEAL_STAGES]),
        Query.orderDesc("$updatedAt"),
        Query.limit(MAX_ROWS_PER_TYPE),
      ],
    }),
    db.listRows({
      databaseId,
      tableId: "sales_deals",
      queries: [
        Query.equal("employee_id", employeeId),
        Query.equal("stage", ["won", "lost"]),
        Query.orderDesc("$updatedAt"),
        Query.limit(MAX_ROWS_PER_TYPE),
      ],
    }),
  ]);
  const routeRows = routes.rows as DataRow[];
  const attendanceRows = attendanceResult.rows as DataRow[];
  const completedVisits = completedVisitResult.rows as DataRow[];
  const recentPlaceVisits = dedupeRows([
    ...completedVisits,
    ...(reviewedPlaceResult.rows as DataRow[]),
    ...(pendingPlaceResult.rows as DataRow[]),
  ]).filter((visit) => visit.status === "completed");
  const orderRows = orderResult.rows as DataRow[];
  const organization = organizationResult.rows[0] as DataRow | undefined;
  const operationsPolicy = operationalPolicyFromRow(organization);
  const teamMessageRows = teamMessageResult.rows as DataRow[];
  const closedDealCutoff = new Date();
  closedDealCutoff.setDate(closedDealCutoff.getDate() - RECENT_CLOSED_DEAL_DAYS);
  const dealRows = dedupeRows([
    ...(activeDealResult.rows as DataRow[]),
    ...(closedDealResult.rows as DataRow[]).filter((deal) => new Date(deal.$updatedAt).valueOf() >= closedDealCutoff.valueOf()),
  ]).sort((left, right) => right.$updatedAt.localeCompare(left.$updatedAt)).slice(0, MAX_ROWS_PER_TYPE);
  const outletIds = [
    ...routeRows.map((route) => stringValue(route.outlet_id)),
    ...recentPlaceVisits.flatMap((visit) => {
      const status = placeApprovalStatus(visit.place_approval_status);
      return [stringValue(visit.outlet_id), approvedOutletId(visit, status)];
    }),
    ...orderRows.map((order) => stringValue(order.outlet_id)),
    ...dealRows.map((deal) => stringValue(deal.outlet_id)),
  ];
  const selfVisitIds = recentPlaceVisits
    .filter((visit) => visit.visit_type === "self_initiated" || !visit.route_assignment_id)
    .map((visit) => visit.$id);
  const [outlets, evidenceTypes] = await Promise.all([
    outletsById(db, outletIds),
    evidenceTypesByVisit(db, selfVisitIds),
  ]);

  const assignedVisits = routeRows.flatMap((route) => {
    const outlet = outlets.get(stringValue(route.outlet_id));
    if (!outlet || outlet.status !== "active") return [];
    return [{
      routeId: route.$id,
      id: outlet.$id,
      code: outlet.code,
      name: outlet.name,
      address: outlet.address,
      latitude: outlet.latitude,
      longitude: outlet.longitude,
      sequence: route.sequence,
      status: route.status,
      notes: outlet.notes ?? "",
      territoryId: outlet.territory_id,
      kind: "assigned",
      workDate: date,
    }];
  });
  const selfVisits = completedVisits
    .filter((visit) => visit.visit_type === "self_initiated" || !visit.route_assignment_id)
    .sort((left, right) => stringValue(left.check_in_at).localeCompare(stringValue(right.check_in_at)))
    .map((visit, index) => {
      const status = placeApprovalStatus(visit.place_approval_status);
      const outletId = approvedOutletId(visit, status);
      const officialOutlet = outlets.get(outletId);
      const territoryId = stringValue(officialOutlet?.territory_id) || stringValue(visit.candidate_territory_id);
      return {
        routeId: "",
        id: visit.$id,
        code: stringValue(officialOutlet?.code) || "SELF",
        name: visitName(visit, outlets, status),
        address: visitAddress(visit, outlets, status),
        latitude: Number(visit.latitude),
        longitude: Number(visit.longitude),
        sequence: index + 1,
        status: "completed",
        notes: stringValue(visit.notes),
        ...(territoryId ? { territoryId } : {}),
        kind: "self",
        workDate: date,
        placeApprovalStatus: status,
        ...(outletId ? { approvedOutletId: outletId } : {}),
      };
    });

  attendanceRows.sort((left, right) => stringValue(right.check_in_at).localeCompare(stringValue(left.check_in_at)));
  const activeAttendance = attendanceRows.find((row) => row.status === "checked_in" && !row.check_out_at);
  const workState = activeAttendance ? "active" : attendanceRows.length > 0 ? "finished" : "not_started";
  return NextResponse.json({
    date,
    employee: { id: employeeId, name: actor.employee.display_name },
    shiftActive: Boolean(activeAttendance),
    workState,
    route: [...assignedVisits, ...selfVisits],
    recentActivity: buildRecentActivity(attendanceRows, recentPlaceVisits, orderRows, outlets, evidenceTypes),
    teamContact: {
      name: stringValue(organization?.manager_contact_name),
      phone: stringValue(organization?.manager_contact_phone),
      whatsapp: stringValue(organization?.manager_contact_whatsapp),
      updatedAt: organization?.$updatedAt ?? "",
    },
    teamMessages: teamMessageRows.map((message) => ({
      id: message.$id,
      employeeId: stringValue(message.employee_id),
      senderRole: stringValue(message.sender_role),
      senderEmployeeId: stringValue(message.sender_employee_id) || null,
      body: stringValue(message.body),
      sentAt: stringValue(message.sent_at),
      readAt: stringValue(message.read_at) || null,
    })),
    deals: dealRows.map((deal) => ({
      id: deal.$id,
      employeeId: stringValue(deal.employee_id),
      outletId: stringValue(deal.outlet_id) || null,
      outletName: stringValue(outlets.get(stringValue(deal.outlet_id))?.name),
      customerName: stringValue(deal.customer_name),
      title: stringValue(deal.title),
      stage: stringValue(deal.stage),
      amount: deal.amount === null || deal.amount === undefined ? null : Number(deal.amount),
      nextAction: stringValue(deal.next_action),
      followUpAt: stringValue(deal.follow_up_at) || null,
      notes: stringValue(deal.notes),
      updatedAt: deal.$updatedAt,
    })),
    operationsPolicy,
    territoryPolicy: {
      mode: territoryAccess.restricted ? "restricted" : "unrestricted",
      assignedCount: territoryAccess.assignedCount,
      territories: territoryAccess.territories.map((territory) => ({
        id: territory.id, code: territory.code, name: territory.name, boundary: territory.boundary,
      })),
    },
    map: { styleUrl: "https://tiles.openfreemap.org/styles/liberty", attribution: "© OpenStreetMap contributors" },
  });
}

function dedupeRows(rows: DataRow[]) {
  return [...new Map(rows.map((row) => [row.$id, row])).values()];
}
