"use client";
import { useRouter } from "next/navigation";
import { ui } from "./ui";
export function LogoutButton() {
  const router = useRouter();
  return <button className={`${ui.quietButton} mt-3 border-white/20 bg-transparent text-slate-200 hover:bg-white/10`} onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); router.replace("/login"); router.refresh(); }}>Sign out</button>;
}
