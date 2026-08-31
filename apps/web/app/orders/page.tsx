import { OperationsPage } from "../page";

export const dynamic = "force-dynamic";

export default function OrdersPage({ searchParams }: { searchParams: Promise<{ date?: string; employee?: string }> }) {
  return OperationsPage({ searchParams, view: "orders" });
}
