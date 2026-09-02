import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { salesAreasAtPoint, effectiveSalespeople, googleMapsUrl } from "./outlet-location.ts";

// Real handlers and transaction logic; no production services or records.
const mobileAuth = await readFile(new URL("./mobile-auth.ts", import.meta.url), "utf8");
const bundle = await build({
  stdin: { contents: 'export { POST } from "./app/api/management/outlets/route"; export { syncOutletAssignments } from "./lib/outlet-auto-assignment"; export { runManagementTransactionWithRetry } from "./lib/management-write";', resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "esm",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json");' },
  plugins: [{ name: "local-api-fixture", setup(plugin) {
    plugin.onResolve({ filter: /^(next\/server|@fieldops\/appwrite\/server)$|\/auth$|\/mobile-auth$/ }, ({ path }) => ({ path, namespace: "fixture" }));
    plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents:
      path === "next/server" ? 'export const NextResponse = { json: (value, init) => Response.json(value, init) };'
      : path === "@fieldops/appwrite/server" ? 'export const createAdminTablesDb = () => globalThis.outletFixture.db;'
      : path.endsWith("/mobile-auth") ? mobileAuth.slice(mobileAuth.indexOf("export function workDate"))
      : 'export const requireDashboardAdmin = async () => globalThis.outletFixture.actor;', loader: "ts" }));
  } }],
});
const { POST, syncOutletAssignments, runManagementTransactionWithRetry } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const boundary = { type: "Polygon", coordinates: [[[67, 24], [68, 24], [68, 25], [67, 25], [67, 24]]] };
const point = { latitude: 24.5, longitude: 67.5 };
const at = new Date("2026-09-02T10:00:00Z");
const assignment = (employee, territory = "area") => ({ $id: `assign-${employee}-${territory}`, employee_id: employee, territory_id: territory, role_id: "sales", effective_from: "2020-01-01T00:00:00Z" });
function fixture({ covered = true, assigned = true } = {}) {
  let rows = {
    outlets: [], territories: covered ? [{ $id: "area", active: true, boundary }] : [],
    employees: [{ $id: "alice", status: "active" }, { $id: "bob", status: "active" }],
    roles: [{ $id: "sales", code: "sales_person", active: true }],
    employee_assignments: assigned ? [assignment("alice")] : [],
    route_assignments: [], route_sequence_counters: [], audit_logs: [],
  };
  const transactions = new Map();
  const table = ({ tableId, transactionId }) => (transactionId ? transactions.get(transactionId) : rows)[tableId];
  let failTable = "";
  const db = {
    createTransaction: async () => { const id = `tx-${transactions.size}`; transactions.set(id, structuredClone(rows)); return { $id: id }; },
    updateTransaction: async ({ transactionId, commit }) => { if (commit) rows = transactions.get(transactionId); transactions.delete(transactionId); },
    listRows: async (input) => {
      let result = [...table(input)];
      for (const encoded of input.queries ?? []) {
        const { method, attribute, values } = JSON.parse(encoded);
        if (method === "equal") result = result.filter((row) => values.includes(row[attribute]));
        if (method === "greaterThanEqual") result = result.filter((row) => row[attribute] >= values[0]);
        if (method === "orderDesc") result.sort((a, b) => a[attribute] < b[attribute] ? 1 : -1);
        if (method === "cursorAfter") result = result.slice(result.findIndex((row) => row.$id === values[0]) + 1);
        if (method === "limit") result = result.slice(0, values[0]);
      }
      return { rows: structuredClone(result) };
    },
    getRow: async (input) => { const row = table(input).find((row) => row.$id === input.rowId); if (!row) throw { code: 404 }; return structuredClone(row); },
    createRow: async (input) => {
      if (input.tableId === failTable) throw new Error("Simulated write failure");
      if (table(input).some((row) => row.$id === input.rowId)) throw { code: 409 };
      const row = { ...input.data, $id: input.rowId }; table(input).push(row); return structuredClone(row);
    },
    updateRow: async (input) => { const row = table(input).find((row) => row.$id === input.rowId); Object.assign(row, input.data); return structuredClone(row); },
    deleteRow: async (input) => { const target = table(input); target.splice(target.findIndex((row) => row.$id === input.rowId), 1); },
    incrementRowColumn: async (input) => { const row = table(input).find((row) => row.$id === input.rowId); row[input.column] += input.value; return structuredClone(row); },
  };
  globalThis.outletFixture = { db, actor: { user: { $id: "admin" } } };
  return { db, get rows() { return rows; }, fail: (tableId) => { failTable = tableId; } };
}
const create = (body = {}) => POST(new Request("http://localhost/api/management/outlets", { method: "POST", body: JSON.stringify({ name: "Corner shop", ...point, ...body }), headers: { "content-type": "application/json" } }));
const reconcile = (f, area) => runManagementTransactionWithRetry(f.db, (transactionId) => syncOutletAssignments(f.db, "fieldops", "admin", transactionId, undefined, area));

test("map matching includes edges and overlaps, excluding holes and invalid points", () => {
  const hole = [[67.4, 24.4], [67.6, 24.4], [67.6, 24.6], [67.4, 24.6], [67.4, 24.4]];
  const areas = [{ id: "b", boundary }, { id: "a", boundary }, { id: "hole", boundary: { ...boundary, coordinates: [...boundary.coordinates, hole] } }, { id: "unmapped", boundary: null }];
  assert.deepEqual(salesAreasAtPoint(point, areas).map((area) => area.id), ["a", "b"]);
  assert.equal(salesAreasAtPoint({ latitude: 24, longitude: 67 }, areas).length, 3);
  assert.deepEqual(salesAreasAtPoint({ latitude: NaN, longitude: 67 }, areas), []);
  assert.deepEqual(salesAreasAtPoint({ latitude: 26, longitude: 67 }, areas), []);
});

test("only current active salespeople receive automatic assignments, without duplicates", () => {
  const assignments = [assignment("alice"), assignment("alice", "overlap"), assignment("bob"), { ...assignment("manager"), role_id: "manager" }, { ...assignment("expired"), effective_to: at.toISOString() }, { ...assignment("future"), effective_from: "2099-01-01" }, assignment("inactive")];
  assert.deepEqual(effectiveSalespeople(["area", "overlap"], assignments, new Set(["alice", "bob", "manager", "expired", "future"]), new Set(["sales"]), at), ["alice", "bob"]);
});

test("Google Maps URLs preserve latitude-longitude order and encode coordinates", () => {
  const url = new URL(googleMapsUrl(-33.8569, 151.2152));
  assert.equal(url.origin + url.pathname, "https://www.google.com/maps/search/");
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("query"), "-33.8569,151.2152");
  assert.ok(url.href.includes("%2C"));
});

test("name and map pin generate details and publish the matching salesperson's visit once", async () => {
  const f = fixture();
  const response = await create({ territoryId: "wrong-area", employeeId: "bob", code: "USER-CODE" });
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).employeeIds, ["alice"]);
  assert.match(f.rows.outlets[0].code, /^OUT-[A-F0-9]{24}$/);
  assert.deepEqual(f.rows.outlets[0].coordinates, [67.5, 24.5]);
  assert.equal(f.rows.outlets[0].territory_id, "area");
  assert.equal(f.rows.outlets[0].assigned_employee_id, "alice");
  assert.match(f.rows.outlets[0].address, /^Map pin:/);
  assert.equal(f.rows.route_assignments.length, 1);
  assert.equal((await create()).status, 200);
  assert.equal(f.rows.outlets.length, 1);
  assert.equal(f.rows.route_assignments.length, 1);
});

test("an outlet saved before its area or salesperson is assigned is picked up later", async () => {
  const f = fixture({ covered: false, assigned: false });
  assert.equal((await create()).status, 201);
  assert.equal(f.rows.route_assignments.length, 0);
  f.rows.territories.push({ $id: "area", active: true, boundary });
  await reconcile(f, { id: "area" });
  assert.equal(f.rows.outlets[0].territory_id, "area");
  assert.equal(f.rows.route_assignments.length, 0);
  f.rows.employee_assignments.push(assignment("alice"));
  await reconcile(f, { id: "area" });
  assert.equal(f.rows.route_assignments[0].employee_id, "alice");
});

test("overlaps assign every covering salesperson once and preserve manual/completed routes", async () => {
  const f = fixture();
  f.rows.territories.push({ $id: "overlap", active: true, boundary });
  f.rows.employee_assignments.push(assignment("alice", "overlap"), assignment("bob", "overlap"));
  await create();
  assert.deepEqual(f.rows.route_assignments.map((route) => route.employee_id).sort(), ["alice", "bob"]);
  f.rows.route_assignments[0].status = "completed";
  f.rows.route_assignments.push({ ...f.rows.route_assignments[1], $id: "manual-route" });
  f.rows.employee_assignments = [];
  await reconcile(f);
  assert.equal(f.rows.route_assignments.length, 2);
  assert.ok(f.rows.route_assignments.some((route) => route.status === "completed"));
  assert.ok(f.rows.route_assignments.some((route) => route.$id === "manual-route"));
});

test("boundary edits retain outlets and withdraw old unstarted automatic visits", async () => {
  const f = fixture();
  await create();
  f.rows.territories[0].boundary = { type: "Polygon", coordinates: [[[70, 24], [71, 24], [71, 25], [70, 25], [70, 24]]] };
  await reconcile(f, { id: "area", previousBoundary: boundary });
  assert.equal(f.rows.outlets.length, 1);
  assert.equal(f.rows.outlets[0].territory_id, null);
  assert.equal(f.rows.outlets[0].assigned_employee_id, null);
  assert.equal(f.rows.route_assignments.length, 0);
});

test("failed assignment rolls back the outlet and its audit records", async () => {
  const f = fixture();
  f.fail("route_assignments");
  assert.equal((await create()).status, 500);
  assert.equal(f.rows.outlets.length, 0);
  assert.equal(f.rows.audit_logs.length, 0);
  f.fail("");
  assert.equal((await create()).status, 201);
});

test("outlet creation rejects missing coordinates and unauthenticated callers", async () => {
  const f = fixture();
  assert.equal((await create({ latitude: "" })).status, 400);
  assert.equal((await create({ longitude: 181 })).status, 400);
  globalThis.outletFixture.actor = null;
  assert.equal((await create()).status, 403);
  assert.equal(f.rows.outlets.length, 0);
});
