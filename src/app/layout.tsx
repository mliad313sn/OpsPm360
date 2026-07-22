import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpsPM360 — Endeavour Mining IT PPM",
  description:
    "Endeavour Mining Group IT project portfolio management: stage-gate governance, RAG health, steering war room, offline-first for remote sites.",
};

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
