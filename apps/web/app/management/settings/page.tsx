import { ManagementPageView } from "../page";

export const dynamic = "force-dynamic";
export default function SettingsPage() { return ManagementPageView({ view: "operations" }); }
