import type { Metadata } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./tailwind.css";
import ribbonHeart from "../../mobile/assets/brand/ribbon-heart-master.png";

export const metadata: Metadata = {
  title: "Yousuf Rice FieldOPS",
  description: "Karachi field operations control room",
  icons: { icon: ribbonHeart.src, apple: ribbonHeart.src },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className="m-0 bg-[var(--canvas)] text-[var(--ink)]">{children}</body></html>;
}
