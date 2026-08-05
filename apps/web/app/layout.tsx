import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = { title: "Yousuf Rice FieldOps", description: "Karachi field operations control room" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
