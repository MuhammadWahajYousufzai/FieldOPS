import type { Metadata } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./tailwind.css";

export const metadata: Metadata = { title: "Yousuf Rice FieldOps", description: "Karachi field operations control room" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className="m-0 bg-slate-50 font-sans text-[#14213D]">{children}</body></html>;
}
