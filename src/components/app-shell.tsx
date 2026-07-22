"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CloudOff, Cloud, RefreshCw, Mountain, LogOut } from "lucide-react";
import { useOfflineSync } from "@/offline/use-offline-sync";
import { logoutAction } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface ShellUser {
  name: string;
  role: string;
  siteName: string | null;
}

/**
 * App chrome: top nav, offline/sync indicator, global keyboard shortcuts.
 *  M -> Meeting (War Room)   N -> New Project   D -> Dashboard
 */
export function AppShell({
  user,
  children,
}: {
  user: ShellUser;
  children: React.ReactNode;
}): JSX.Element {
  const router = useRouter();
  const sync = useOfflineSync();

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
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="glass sticky top-0 z-40 flex h-12 items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Mountain className="h-5 w-5 text-primary" aria-hidden />
          <span>OpsPM360</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link href="/" className="rounded px-2 py-1 hover:bg-secondary">
            Dashboard <kbd className="ml-1 text-[10px] text-muted-foreground">D</kbd>
          </Link>
          <Link href="/meeting" className="rounded px-2 py-1 hover:bg-secondary">
            War Room <kbd className="ml-1 text-[10px] text-muted-foreground">M</kbd>
          </Link>
          <Link href="/projects/new" className="rounded px-2 py-1 hover:bg-secondary">
            New Project <kbd className="ml-1 text-[10px] text-muted-foreground">N</kbd>
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => void sync.flushNow()}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            title={
              sync.online
                ? "Connected — click to sync now"
                : "Offline — changes queue locally and sync on reconnect"
            }
          >
            {sync.online ? (
              <Cloud className="h-4 w-4 text-rag-green" aria-hidden />
            ) : (
              <CloudOff className="h-4 w-4 text-rag-amber" aria-hidden />
            )}
            {sync.syncing ? <RefreshCw className="h-3 w-3 animate-spin" aria-hidden /> : null}
            {sync.pendingOps > 0 ? <Badge variant="amber">{sync.pendingOps} queued</Badge> : null}
            {sync.conflictOps > 0 ? (
              <Badge variant="red">{sync.conflictOps} conflicts</Badge>
            ) : null}
          </button>
          <div className="text-right text-xs">
            <div className="font-medium">{user.name}</div>
            <div className="text-muted-foreground">
              {user.role.replaceAll("_", " ")}
              {user.siteName ? ` · ${user.siteName}` : " · Group"}
            </div>
          </div>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost" size="icon" title="Sign out">
              <LogOut className="h-4 w-4" aria-hidden />
            </Button>
          </form>
        </div>
      </header>
      <main className="flex-1 p-4">{children}</main>
    </div>
  );
}
