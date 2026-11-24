"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  BarChart3, Clapperboard, Film, LayoutDashboard, Library, LogOut, Menu, Send, Settings as SettingsIcon, Users, WifiOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { errMsg } from "@/lib/api";
import { useLiveEvents, useLogin, useLogout, useSession } from "@/lib/queries";
import { useUi } from "@/store/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/content", label: "Content Studio", icon: Film },
  { href: "/references", label: "Reference Library", icon: Library },
  { href: "/characters", label: "Character Studio", icon: Users },
  { href: "/review", label: "Review Studio", icon: Clapperboard },
  { href: "/publishing", label: "Publishing Center", icon: Send },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2 text-base font-semibold tracking-tight">
      <div className="grid size-8 place-items-center rounded-lg bg-linear-to-br from-primary to-pink-500 text-sm text-white shadow-lg shadow-primary/30">▶</div>
      ReelForge AI
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
              active && "text-foreground",
            )}
          >
            {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-lg bg-primary/15 ring-1 ring-primary/30" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}
            <Icon className="relative size-4" />
            <span className="relative">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function LoginScreen() {
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onError: (err) => toast.error(errMsg(err)) });
  };
  return (
    <div className="grid min-h-screen place-items-center bg-[radial-gradient(ellipse_at_top,var(--color-primary)/0.15,transparent_60%)] p-4">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <Brand />
            <CardTitle className="pt-4">Sign in</CardTitle>
            <CardDescription>Your personal AI reel studio.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <Button type="submit" size="lg" disabled={login.isPending}>{login.isPending ? "Signing in…" : "Sign in"}</Button>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

function BackendDown({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <WifiOff className="size-6 text-destructive" />
          <CardTitle className="pt-2">Backend not reachable</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>Start it in a terminal:</p>
          <pre className="rounded-md bg-muted p-3 font-mono text-xs text-foreground">cd D:\reel-creator-automation\backend{"\n"}npm start</pre>
          <Button variant="outline" onClick={retry}>Try again</Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const logout = useLogout();
  const path = usePathname();
  const { mobileNavOpen, setMobileNavOpen } = useUi();
  useLiveEvents(Boolean(session.data));

  if (session.isPending) {
    return <div className="grid min-h-screen place-items-center"><Skeleton className="h-40 w-80" /></div>;
  }
  if (session.isError) return <BackendDown message={errMsg(session.error)} retry={() => session.refetch()} />;
  if (!session.data) return <LoginScreen />;

  const user = session.data;
  const footer = (
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 px-2 pt-4 text-xs">
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">{user.displayName}</div>
        <div className="truncate text-muted-foreground">{user.email}</div>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={() => logout.mutate()}>
        <LogOut />
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-6 border-r border-border/60 bg-sidebar p-4 lg:flex">
        <Brand />
        <NavLinks />
        {footer}
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="flex w-64 flex-col gap-6 p-4">
          <SheetHeader className="p-0"><SheetTitle><Brand /></SheetTitle></SheetHeader>
          <NavLinks onNavigate={() => setMobileNavOpen(false)} />
          {footer}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border/60 bg-background/80 px-4 py-3 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon-sm" aria-label="Open menu" onClick={() => setMobileNavOpen(true)}><Menu /></Button>
          <Brand />
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <AnimatePresence mode="wait">
            <motion.div key={path} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
