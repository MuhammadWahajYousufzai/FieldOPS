import type { ReactNode } from "react";
import { NavIcon } from "./dashboard-shells";

export function MetricCard({ label, value, detail, icon, featured = false }: {
  label: string;
  value: ReactNode;
  detail: string;
  icon: "today" | "routes" | "visits" | "orders";
  featured?: boolean;
}) {
  return <article className={`metric-card relative overflow-hidden rounded-[22px] p-5 sm:p-6 ${featured ? "bg-[#CB183D] text-white" : "border border-[var(--line)] bg-white text-[var(--ink)]"}`}>
    <div className="mb-5 flex items-center justify-between gap-2"><span className={`text-sm font-medium ${featured ? "text-[#FFE4EB]" : "text-[var(--muted)]"}`}>{label}</span><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${featured ? "bg-white/15" : "bg-[#FCE9EE] text-[#BD1C40]"}`}><NavIcon name={icon} /></span></div>
    <strong className="font-display block text-[38px] font-bold leading-none sm:text-[42px]">{value}</strong>
    <p className={`mt-3 text-xs leading-5 ${featured ? "text-[#FFE4EB]" : "text-[var(--muted)]"}`}>{detail}</p>
  </article>;
}

export function WorkspaceLink({ href, title, detail, icon }: { href: string; title: string; detail: string; icon: "routes" | "visits" | "orders" | "plan" | "places" | "team" | "reviews" }) {
  return <a href={href} className="group flex min-h-24 items-center gap-4 rounded-[20px] border border-[var(--line)] bg-white p-5 transition-colors hover:border-[#DDA9B5] hover:bg-[#FFF9FA]">
    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#F8ECE9] text-[#9E2541]"><NavIcon name={icon} /></span><div className="min-w-0 flex-1"><h3 className="font-semibold">{title}</h3><p className="mt-1 text-xs leading-5 text-[var(--muted)]">{detail}</p></div><span aria-hidden="true" className="text-lg text-[#A7959A] group-hover:text-[#CB183D]">↗</span>
  </a>;
}
