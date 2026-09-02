import type { Metadata } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./tailwind.css";

export const metadata: Metadata = {
  title: "Yousuf Rice FieldOPS",
  description: "Karachi field operations control room",
  icons: { icon: "/fieldops-mark.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className="m-0 bg-[#F5F7FF] text-[#102A58]">{children}</body></html>;
}
