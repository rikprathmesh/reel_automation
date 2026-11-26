"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import {
  Activity, BarChart3, Clapperboard, Film, LayoutDashboard, Library, LogOut, Menu, Moon, Send, Settings as SettingsIcon, ShieldCheck, Sun, Users, Wand2, WifiOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { errMsg } from "@/lib/api";
import { useHealth, useLiveEvents, useLogin, useLogout, useSession } from "@/lib/queries";
import { useUi } from "@/store/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export const NAV_GROUPS = [
  { caption: "Navigation", items: [{ href: "/", label: "Overview", icon: LayoutDashboard }] },
  {
    caption: "Production",
    items: [
      { href: "/content", label: "Content Studio", icon: Film },
      { href: "/references", label: "Reference Library", icon: Library },
      { href: "/characters", label: "Character Studio", icon: Users },
      { href: "/prompts", label: "Prompt Studio", icon: Wand2 },
      { href: "/progress", label: "Generation Progress", icon: Activity },
      { href: "/review", label: "Review Studio", icon: Clapperboard },
    ],
  },
  {
    caption: "Distribution",
    items: [
      { href: "/publishing", label: "Publishing Center", icon: Send },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  { caption: "System", items: [{ href: "/settings", label: "Settings", icon: SettingsIcon }] },
];
export const NAV = NAV_GROUPS.flatMap((g) => g.items);

const isActive = (href: string, path: string) => (href === "/" ? path === "/" : path.startsWith(href));

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2 text-[17px] font-semibold tracking-tight">
      <div className="grid size-8 place-items-center rounded-lg bg-primary text-sm text-primary-foreground shadow-md shadow-primary/30">▶</div>
      <span>ReelForge <span className="text-primary">AI</span></span>
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-5">
      {NAV_GROUPS.map((g) => (
        <div key={g.caption} className="flex flex-col gap-0.5">
          <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">{g.caption}</div>
          {g.items.map(({ href, label, icon: Icon }) => {
            const active = isActive(href, path);
            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:bg-muted hover:text-sidebar-foreground",
                  active && "text-sidebar-accent-foreground hover:bg-transparent hover:text-sidebar-accent-foreground",
                )}
              >
                {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-lg bg-sidebar-accent" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}
                <Icon className="relative size-[18px]" />
                <span className="relative">{label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Light / dark switch (next-themes remembers the choice in this browser). */
function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <Button variant="ghost" size="icon" className="size-9" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setTheme(dark ? "light" : "dark")}>
      <Sun className="hidden size-[18px] dark:block" />
      <Moon className="size-[18px] dark:hidden" />
    </Button>
  );
}

/** Live status of the core services; links to the Overview, which shows the details. */
function HealthPill() {
  const health = useHealth();
  if (!health.data) return null;
  const down = Object.values(health.data.checks).filter((c) => !c.ok).length;
  const ok = health.data.status === "ok" && down === 0;
  return (
    <Link
      href="/"
      className={cn(
        "hidden items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium sm:flex",
        ok ? "border-success/30 bg-success/10 text-success" : "border-warning/30 bg-warning/10 text-warning",
      )}
    >
      <span className={cn("size-1.5 rounded-full", ok ? "bg-success" : "bg-warning")} />
      {ok ? "All services up" : `${down} service${down === 1 ? "" : "s"} down`}
    </Link>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "U";
}

function UserMenu({ name, email, onLogout }: { name: string; email: string; onLogout: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" aria-label="Account menu" className="flex items-center gap-2.5 rounded-full p-0.5 transition-colors hover:bg-muted md:pr-3" />}>
        <span className="grid size-9 place-items-center rounded-full bg-primary/12 text-sm font-semibold text-primary">{initials(name)}</span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-sm font-medium">{name}</span>
          <span className="block max-w-44 truncate text-xs text-muted-foreground">{email}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          <div className="truncate font-medium text-foreground">{name}</div>
          <div className="truncate">{email}</div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/settings" />}><SettingsIcon /> Settings</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onLogout}><LogOut /> Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
    <div className="grid min-h-screen place-items-center bg-[radial-gradient(ellipse_at_top,var(--color-primary)/0.12,transparent_60%)] p-4">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <Brand />
            <CardTitle className="pt-4 text-lg font-semibold">Sign in</CardTitle>
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
  const current = NAV.find((n) => isActive(n.href, path));
  const CurrentIcon = current?.icon;
  const sidebarNote = (
    <div className="mt-auto rounded-xl border border-primary/15 bg-primary/5 p-3.5 text-xs">
      <div className="flex items-center gap-2 font-semibold text-foreground"><ShieldCheck className="size-4 text-primary" /> Approval gate on</div>
      <p className="mt-1 leading-relaxed text-muted-foreground">Nothing is published until you approve it in the Review Studio.</p>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[264px] shrink-0 flex-col gap-7 overflow-y-auto border-r border-sidebar-border bg-sidebar px-4 py-5 lg:flex">
        <Brand />
        <NavLinks />
        {sidebarNote}
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="flex w-72 flex-col gap-7 overflow-y-auto px-4 py-5">
          <SheetHeader className="p-0"><SheetTitle><Brand /></SheetTitle></SheetHeader>
          <NavLinks onNavigate={() => setMobileNavOpen(false)} />
          {sidebarNote}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-card/85 px-4 backdrop-blur sm:px-6 lg:px-8">
          <Button variant="ghost" size="icon" className="size-9 lg:hidden" aria-label="Open menu" onClick={() => setMobileNavOpen(true)}><Menu /></Button>
          <div className="lg:hidden"><Brand /></div>
          <div className="hidden min-w-0 items-center gap-2 text-sm lg:flex">
            {CurrentIcon && <CurrentIcon className="size-4 text-muted-foreground" />}
            <span className="font-medium">{current?.label ?? "ReelForge"}</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <HealthPill />
            <ThemeToggle />
            <UserMenu name={user.displayName} email={user.email} onLogout={() => logout.mutate()} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
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
