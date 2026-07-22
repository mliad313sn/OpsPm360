"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Mountain,
  LogOut,
  LayoutGrid,
  Columns3,
  Radio,
  Plus,
  MapPin,
  Settings,
  LifeBuoy,
} from "lucide-react";
import { useOfflineSync } from "@/offline/use-offline-sync";
import { logoutAction } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { SyncTray } from "@/components/sync-tray";
import { cn } from "@/lib/utils";

export interface ShellUser {
  name: string;
  role: string;
  siteName: string | null;
}

const NAV = [
  { href: "/", label: "Portfolio", key: "D", icon: LayoutGrid },
  { href: "/board", label: "Board", key: "B", icon: Columns3 },
  { href: "/meeting", label: "War Room", key: "M", icon: Radio },
] as const;

/**
 * Slate & Indigo shell: fixed sidebar (brand, primary CTA, nav, settings) +
 * top bar (site context, sync indicator, identity).
 * Shortcuts: D dashboard · B board · M war room · N new project.
 */
export function AppShell({
  user,
  children,
}: {
  user: ShellUser;
  children: React.ReactNode;
}): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const sync = useOfflineSync();

  // Cold-start offline: precache the app shell so a page reload on a downed
  // WAN still boots the UI (the Dexie cache + outbox take it from there).
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration failure (unsupported/private mode) — online mode unaffected.
      });
    }
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case "m":
          router.push("/meeting");
          break;
        case "n":
          router.push("/projects/new");
          break;
        case "d":
          router.push("/");
          break;
        case "b":
          router.push("/board");
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <div className="flex min-h-screen">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      {/* Sidebar */}
      <aside
        aria-label="Primary navigation"
        className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r bg-card md:flex"
      >
        <div className="flex items-center gap-2.5 px-5 pb-2 pt-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Mountain className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <p className="font-display text-base font-bold leading-tight">OpsPM360</p>
            <p className="stat-label">{user.siteName ? "Site level" : "Group level"}</p>
          </div>
        </div>
        <div className="px-4 py-3">
          <Link
            href="/projects/new"
            className="meta flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-indigo-deep"
          >
            <Plus className="h-4 w-4" aria-hidden /> New Project
          </Link>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "meta flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                  active
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <item.icon className="h-4 w-4" aria-hidden />
                {item.label}
                <kbd className="ml-auto text-[10px] opacity-60">{item.key}</kbd>
              </Link>
            );
          })}
        </nav>
        <div className="space-y-1 border-t px-3 py-4">
          <p className="meta flex items-center gap-3 px-3 py-1.5 text-sm text-muted-foreground">
            <Settings className="h-4 w-4" aria-hidden /> Settings
          </p>
          <p className="meta flex items-center gap-3 px-3 py-1.5 text-sm text-muted-foreground">
            <LifeBuoy className="h-4 w-4" aria-hidden /> Support
          </p>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-60">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card px-4 md:px-6">
          {/* Mobile nav */}
          <nav className="flex items-center gap-1 md:hidden">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded px-2 py-1 text-sm hover:bg-secondary"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <span className="meta hidden items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground md:flex">
            <MapPin className="h-3.5 w-3.5" aria-hidden />
            Site: {user.siteName ?? "All regions"}
          </span>

          <div className="ml-auto">
            <SyncTray sync={sync} />
          </div>

          <div className="text-right text-xs">
            <div className="font-medium">{user.name}</div>
            <div className="stat-label">{user.role.replaceAll("_", " ")}</div>
          </div>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost" size="icon" title="Sign out">
              <LogOut className="h-4 w-4" aria-hidden />
            </Button>
          </form>
        </header>
        <main id="main-content" className="mx-auto w-full max-w-content flex-1 p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
