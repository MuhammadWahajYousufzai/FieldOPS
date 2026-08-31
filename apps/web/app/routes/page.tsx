import { OperationsPage } from "../page";

export const dynamic = "force-dynamic";

export default function RoutesPage({ searchParams }: { searchParams: Promise<{ date?: string; employee?: string }> }) {
  return OperationsPage({ searchParams, view: "routes" });
}
