"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { api, useAct } from "@/lib/api";
import { MeContext, atLeast, useMe, useMeQuery } from "@/lib/session";
import { t } from "@/lib/strings";
import type { Me, Member, Role } from "@/lib/types";
import { Button, Empty, ErrorAlert, Input, SkeletonRows, buttonClass } from "./ui";

const AUTH_ROUTES = ["/login", "/register", "/forgot", "/reset", "/verify"];

export function App({ children }: { children: ReactNode }) {
  // Polling (ARCHITECTURE.md §3): 30 s by default, paused while the tab is hidden.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchInterval: 30_000, refetchIntervalInBackground: false, staleTime: 5_000, retry: false },
        },
      }),
  );
  const isAuthRoute = AUTH_ROUTES.includes(usePathname());
  return (
    <QueryClientProvider client={client}>
      {isAuthRoute ? <Centered>{children}</Centered> : <Session>{children}</Session>}
    </QueryClientProvider>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-sm px-4 py-12">
      <p className="mb-8 text-lg font-semibold text-primary">{t.app.name}</p>
      {children}
    </main>
  );
}

function Session({ children }: { children: ReactNode }) {
  const q = useMeQuery();
  if (q.data === undefined) {
    return (
      <Centered>
        {q.isPending ? <SkeletonRows rows={3} /> : <ErrorAlert error={q.error} onRetry={() => q.refetch()} />}
      </Centered>
    );
  }
  if (q.data === null) return <NicknamePrompt />;
  return (
    <MeContext value={q.data}>
      <Layout>{children}</Layout>
    </MeContext>
  );
}

function NicknamePrompt() {
  const [nickname, setNickname] = useState("");
  const enter = useAct(() => api.post("/auth/guest", { nickname: nickname.trim() }));
  return (
    <Centered>
      <h1 className="mb-2">{t.guest.title}</h1>
      <p className="mb-6 text-muted">{t.guest.intro}</p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          enter.mutate();
        }}
      >
        <Input
          label={t.guest.nickname}
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          required
          minLength={2}
          maxLength={30}
          autoComplete="nickname"
        />
        {enter.isError && <ErrorAlert error={enter.error} />}
        <Button type="submit" variant="primary" className="w-full" disabled={enter.isPending}>
          {t.guest.enter}
        </Button>
      </form>
      <p className="mt-6 border-t border-border pt-4 text-muted">
        {t.guest.haveAccount}{" "}
        <Link href="/login" className="link">
          {t.auth.login}
        </Link>{" "}
        {t.common.or}{" "}
        <Link href="/register" className="link">
          {t.auth.register}
        </Link>
      </p>
    </Centered>
  );
}

// Functional icons only (DESIGN.md §7): 24 px stroke paths.
const icons = {
  calendar: "M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  requests: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  approvals: "M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  wallet: "M3 7a2 2 0 0 1 2-2h13v4M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14h.01",
  history: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  notifications: "M6 16v-5a6 6 0 1 1 12 0v5l2 2H4l2-2zM10 21a2 2 0 0 0 4 0",
  admin: "M4 20V10M10 20V4M16 20v-7M21 20H3",
  profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
};

type NavItem = { href: string; label: string; icon: string; tab: boolean; badge?: number };

/** Role-scoped navigation (DESIGN.md §10). `tab` marks what fits the phone tab bar; the rest sits under the profile. */
export function navItems(me: Me): NavItem[] {
  const member = me.kind === "member";
  const approver = atLeast(me, "host");
  const item = (key: keyof typeof icons, href: string, tab: boolean, badge?: number) => ({
    href,
    label: t.nav[key],
    icon: icons[key],
    tab,
    badge,
  });
  return [
    item("calendar", "/", true),
    item("requests", "/requests", true),
    ...(approver ? [item("approvals", "/approvals", true)] : []),
    ...(member
      ? [
          item("wallet", "/wallet", true),
          item("history", "/history", !approver),
          item("notifications", "/notifications", false, me.unread_notifications),
        ]
      : []),
    ...(atLeast(me, "admin") ? [item("admin", "/admin", false)] : []),
    item("profile", "/profile", true),
  ];
}

function NavIcon({ item }: { item: NavItem }) {
  return (
    <span className="relative">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="size-6 fill-none stroke-current"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={item.icon} />
      </svg>
      {!!item.badge && (
        <span className="absolute -top-1.5 -right-2 min-w-4 rounded-full bg-accent px-1 text-center font-mono text-[0.6875rem] leading-4 text-on-accent">
          {item.badge}
          <span className="sr-only"> {t.nav.unread}</span>
        </span>
      )}
    </span>
  );
}

function Layout({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const items = navItems(me);
  const bell = items.find((i) => i.href === "/notifications");
  const current = (href: string) =>
    (href === "/" ? pathname === "/" || pathname.startsWith("/matches") : pathname.startsWith(href))
      ? ("page" as const)
      : undefined;
  return (
    <div className="md:pl-16 lg:pl-56">
      <nav
        aria-label={t.nav.label}
        className="fixed inset-y-0 left-0 z-10 hidden w-16 flex-col border-r border-border bg-surface md:flex lg:w-56"
      >
        <p className="px-5 py-5 font-semibold text-primary lg:px-4">
          <span className="lg:hidden">{t.app.short}</span>
          <span className="max-lg:hidden">{t.app.name}</span>
        </p>
        {items.map((i) => (
          <Link
            key={i.href}
            href={i.href}
            aria-current={current(i.href)}
            title={i.label}
            className="flex min-h-11 items-center gap-3 border-l-2 border-transparent px-5 text-muted hover:bg-primary/6 aria-[current]:border-accent aria-[current]:bg-primary/6 aria-[current]:font-medium aria-[current]:text-primary last:mt-auto last:mb-4 lg:px-4"
          >
            <NavIcon item={i} />
            <span className="max-lg:sr-only">{i.label}</span>
          </Link>
        ))}
      </nav>

      <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
        <p className="font-semibold text-primary">{t.app.name}</p>
        {bell && (
          <Link href={bell.href} aria-label={bell.label} className="flex size-11 items-center justify-center">
            <NavIcon item={bell} />
          </Link>
        )}
      </header>

      <main className="mx-auto max-w-[1280px] px-4 py-6 max-md:pb-24 md:px-6">{children}</main>

      <nav
        aria-label={t.nav.label}
        className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {items
          .filter((i) => i.tab)
          .map((i) => (
            <Link
              key={i.href}
              href={i.href}
              aria-current={current(i.href)}
              className="flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[0.6875rem] text-muted aria-[current]:font-medium aria-[current]:text-primary"
            >
              <NavIcon item={i} />
              {i.label}
            </Link>
          ))}
      </nav>
    </div>
  );
}

/** Renders its children only for a member of at least `min`; otherwise says what is needed. */
export function Guard({ min, children }: { min: Role; children: (me: Member) => ReactNode }) {
  const me = useMe();
  if (me.kind === "member" && atLeast(me, min)) return children(me);
  return me.kind === "guest" ? (
    <Empty
      action={
        <span className="flex justify-center gap-2">
          <Link href="/register" className={buttonClass("primary")}>
            {t.auth.register}
          </Link>
          <Link href="/login" className={buttonClass()}>
            {t.auth.login}
          </Link>
        </span>
      }
    >
      {t.guard.needAccount}
    </Empty>
  ) : (
    <Empty
      action={
        <Link href="/" className={buttonClass()}>
          {t.common.toCalendar}
        </Link>
      }
    >
      {t.guard.forbidden}
    </Empty>
  );
}
