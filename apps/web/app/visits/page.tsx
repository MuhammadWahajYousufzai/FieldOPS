import { OperationsPage } from "../page";

export const dynamic = "force-dynamic";

export default function VisitsPage({ searchParams }: { searchParams: Promise<{ date?: string; employee?: string }> }) {
  return OperationsPage({ searchParams, view: "visits" });
}
