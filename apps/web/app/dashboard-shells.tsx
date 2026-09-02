"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BrandMark } from "./brand-mark";
import { LogoutButton } from "./logout-button";
import { ui } from "./ui";

type IconName = "today" | "routes" | "visits" | "orders" | "control" | "plan" | "reviews" | "sales" | "places" | "territories" | "team" | "settings" | "media";
type NavigationItem = { href: string; label: string; icon: IconName };

const navigation: { label: string; items: NavigationItem[] }[] = [
  { label: "Monitor", items: [
    { href: "/", label: "Today", icon: "today" },
    { href: "/routes", label: "Routes", icon: "routes" },
    { href: "/visits", label: "Visits & evidence", icon: "visits" },
    { href: "/orders", label: "Orders", icon: "orders" },
  ] },
  { label: "Manage", items: [
    { href: "/management", label: "Control room", icon: "control" },
    { href: "/management/plan", label: "Daily plan", icon: "plan" },
    { href: "/management/reviews", label: "Place reviews", icon: "reviews" },
    { href: "/management/sales", label: "Sales pipeline", icon: "sales" },
    { href: "/management/places", label: "Outlets", icon: "places" },
    { href: "/management/territories", label: "Sales areas", icon: "territories" },
    { href: "/management/team", label: "Team & access", icon: "team" },
  ] },
  { label: "System", items: [
    { href: "/management/settings", label: "Tracking & sync", icon: "settings" },
    { href: "/management/media", label: "Media retention", icon: "media" },
  ] },
];

export function OperationsDashboardShell({ actorName, queryString = "", children }: {
  actorName: string;
  queryString?: string;
  children: ReactNode;
}) {
  return <AppShell actorName={actorName} queryString={queryString}>{children}</AppShell>;
}

export function ManagementDashboardShell({ actorName, children }: { actorName: string; children: ReactNode }) {
  return <AppShell actorName={actorName}>{children}</AppShell>;
}

function AppShell({ actorName, queryString = "", children }: { actorName: string; queryString?: string; children: ReactNode }) {
  const pathname = usePathname();
  const filterSuffix = queryString ? `?${queryString}` : "";
  return <main className={ui.shell}>
    <aside className={ui.rail}>
      <div className={ui.brand}>
        <span className={ui.logo}><BrandMark className="h-full w-full" priority /></span>
        <div className="min-w-0"><strong className="font-display block truncate text-[15px] tracking-[-0.025em]">Yousuf Rice FieldOPS</strong><small className="mt-1 flex items-center gap-1.5 text-[#BDCAE1]"><span className="h-1.5 w-1.5 rounded-full bg-[#55E6C1] shadow-[0_0_0_3px_rgba(85,230,193,0.13)]" />Operations live</small></div>
      </div>
      <nav className={ui.nav} aria-label="Primary navigation">
        {navigation.map((group) => <div className="contents lg:block" key={group.label}>
          <p className="font-utility hidden px-3 pb-2 pt-4 text-[9px] font-black uppercase tracking-[0.18em] text-[#8194B7] first:pt-0 lg:block">{group.label}</p>
          <div className="contents lg:grid lg:gap-1">
            {group.items.map((item) => {
              const active = pathname === item.href;
              const preserveFilter = ["/", "/routes", "/visits", "/orders"].includes(item.href);
              return <Link key={item.href} href={`${item.href}${preserveFilter ? filterSuffix : ""}`} className={`${ui.navLink} ${active ? ui.navSelected : ""}`} aria-current={active ? "page" : undefined}>
                <NavIcon name={item.icon} /><span className="whitespace-nowrap">{item.label}</span>
              </Link>;
            })}
          </div>
        </div>)}
      </nav>
      <div className="hidden rounded-2xl border border-white/10 bg-[#071D49]/35 px-4 py-3 lg:mt-auto lg:block">
        <small className="font-utility mb-1 block text-[9px] uppercase tracking-[0.12em] text-[#8EA0C1]">Command access</small><strong className="block truncate text-sm">{actorName}</strong><LogoutButton />
      </div>
    </aside>
    <section className={ui.workspace}>{children}</section>
  </main>;
}

function NavIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    today: <><path d="M4 13h6V3H4v10Zm0 8h6v-4H4v4Zm10 0h6V11h-6v10Zm0-18v4h6V3h-6Z" /></>,
    routes: <><path d="M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M8.5 14.5 16 9.5" /></>,
    visits: <><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Z" /><path d="m7 16 3-3 2 2 2.5-3 2.5 4M9 9h.01" /></>,
    orders: <><path d="M6 3h12l1 18-7-3-7 3L6 3Z" /><path d="M9 8h6M9 12h6" /></>,
    control: <><path d="M12 3v18M3 12h18" /><circle cx="12" cy="12" r="4" /></>,
    plan: <><path d="M5 4h14v17H5V4Z" /><path d="M8 2v4M16 2v4M8 10h8M8 14h5" /></>,
    reviews: <><path d="M4 4h12v16H4V4Z" /><path d="m8 12 2 2 5-6M18 8h2v12H8" /></>,
    sales: <><path d="m4 18 5-6 4 3 7-9" /><path d="M15 6h5v5" /></>,
    places: <><path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z" /><circle cx="12" cy="10" r="2" /></>,
    territories: <><path d="m4 6 5-3 6 3 5-3v15l-5 3-6-3-5 3V6Z" /><path d="M9 3v15M15 6v15" /></>,
    team: <><circle cx="9" cy="8" r="3" /><path d="M3 20c.4-4 2.4-6 6-6s5.6 2 6 6M16 5a3 3 0 0 1 0 6M17 14c2.4.5 3.7 2.5 4 6" /></>,
    settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
    media: <><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Z" /><path d="m7 16 3-3 2 2 2.5-3 2.5 4M15 8h3M16.5 6.5v3" /></>,
  };
  return <svg className="h-[18px] w-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
