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
      {isAuthRoute ? <Gateway>{children}</Gateway> : <Session>{children}</Session>}
    </QueryClientProvider>
  );
}

function Brand() {
  return (
    <span className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-emerald-400 to-lime-400 shadow-md shadow-emerald-500/20">
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="size-6 fill-none stroke-slate-900"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9.5 14.5 5 4l5 2 2-3 2 3 5-2-4.5 10.5M7.5 10h9" />
        </svg>
      </span>
      <span className="text-xl font-extrabold tracking-tight text-white">
        Shuttle<span className="text-lime">Circle</span>
      </span>
    </span>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <main className="mx-auto w-full max-w-sm px-4 py-12">{children}</main>;
}

/** Full-screen sign-in gateway (DESIGN.md §9): court backdrop, the form in a glass card, and the club guide. */
function Gateway({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const tabs = [
    { href: "/login", label: t.auth.login, on: pathname === "/login" },
    { href: "/register", label: t.auth.register, on: pathname === "/register" },
    { href: "/", label: t.common.guest, on: !AUTH_ROUTES.includes(pathname) },
  ];
  return (
    <div className="on-dark relative flex min-h-dvh flex-col overflow-hidden bg-linear-to-br from-emerald-950 via-slate-950 to-emerald-950">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <svg className="absolute inset-0 size-full opacity-20" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" fill="none">
          <g stroke="#fff" strokeWidth="2">
            <rect x="70" y="55" width="1060" height="690" strokeWidth="3" />
            <path d="M70 115h1060M70 685h1060M150 55v690M1050 55v690M460 55v690M740 55v690M70 400h390M740 400h390" />
          </g>
          <path d="M600 35v730" stroke="#a3e635" strokeWidth="4" strokeDasharray="12 8" />
          <path d="M180 580Q600 110 1020 490" stroke="#a3e635" strokeWidth="3" className="trajectory" />
        </svg>
        <div className="absolute -top-32 -left-32 size-[520px] rounded-full bg-emerald-500/15 blur-3xl" />
        <div className="absolute -right-32 -bottom-32 size-[520px] rounded-full bg-lime-400/10 blur-3xl" />
      </div>

      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-4 pt-6 sm:px-10">
        <Brand />
        <span className="hidden items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-lime-300 sm:inline-flex">
          <span className="size-2 rounded-full bg-lime" />
          {t.gateway.badge}
        </span>
      </header>

      <main className="relative mx-auto grid w-full max-w-6xl flex-1 items-start gap-8 px-4 py-8 sm:px-10 lg:grid-cols-12 lg:gap-10">
        <div className="space-y-4 lg:order-2 lg:col-span-5">
          <nav aria-label={t.gateway.modes} className="grid grid-cols-3 gap-1 rounded-2xl border border-white/15 bg-slate-900/80 p-1.5">
            {tabs.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={tab.on ? "page" : undefined}
                className="flex min-h-11 items-center justify-center rounded-xl px-2 text-center text-xs font-bold text-slate-300 hover:text-white aria-[current]:bg-emerald-700 aria-[current]:text-white aria-[current]:shadow-sm"
              >
                {tab.label}
              </Link>
            ))}
          </nav>
          <div className="rounded-3xl border border-white/15 bg-slate-900/85 p-6 shadow-2xl backdrop-blur-xl sm:p-7">{children}</div>
        </div>

        <div className="space-y-6 lg:order-1 lg:col-span-7">
          <div className="rounded-3xl border border-white/10 bg-white/5 p-5 sm:p-6">
            <p className="text-2xl leading-tight font-extrabold tracking-tight text-white sm:text-3xl">
              {t.gateway.headline}
              <br />
              <span className="text-lime">{t.gateway.headline2}</span>
            </p>
            <p className="mt-2 text-sm leading-relaxed text-emerald-100/85">{t.gateway.intro}</p>
          </div>
          <section className="rounded-3xl border border-white/15 bg-slate-900/75 p-5 shadow-2xl sm:p-6">
            <h2 className="mb-4 text-base">{t.gateway.faqTitle}</h2>
            <div className="space-y-2.5">
              {t.gateway.faq.map((item, i) => (
                <details key={item.q} open={i === 0} className="group rounded-2xl border border-white/10 bg-slate-950/70">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-bold text-white hover:bg-white/5 [&::-webkit-details-marker]:hidden">
                    {item.q}
                    <span aria-hidden className="text-lime transition-transform group-open:rotate-180">
                      ⌄
                    </span>
                  </summary>
                  <p className="border-t border-white/5 px-4 pt-2.5 pb-3.5 text-[0.8125rem] leading-relaxed text-slate-300">{item.a}</p>
                </details>
              ))}
            </div>
          </section>
        </div>
      </main>

      <footer className="relative mx-auto w-full max-w-6xl border-t border-white/10 px-4 py-4 text-[0.6875rem] text-emerald-200/70 sm:px-10">
        {t.app.description}
      </footer>
    </div>
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
    <Gateway>
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
    </Gateway>
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
        <span className="absolute -top-1.5 -right-2 min-w-4 rounded-full bg-rose-500 px-1 text-center text-[0.6875rem] leading-4 font-bold text-white ring-2 ring-slate-900">
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
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-slate-900/95 text-white shadow-lg backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <Link href="/" aria-label={t.app.name}>
            <Brand />
          </Link>
          <nav
            aria-label={t.nav.label}
            className="hidden items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1 md:flex [&_svg]:size-5"
          >
            {items.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                aria-current={current(i.href)}
                title={i.label}
                className="flex min-h-10 items-center gap-2 rounded-full px-3.5 text-sm font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white aria-[current]:bg-lime aria-[current]:font-bold aria-[current]:text-slate-950 aria-[current]:shadow-[0_0_24px_-6px_rgb(163_230_53/0.7)]"
              >
                <NavIcon item={i} />
                <span className="max-xl:sr-only">{i.label}</span>
              </Link>
            ))}
          </nav>
          {bell && (
            <Link href={bell.href} aria-label={bell.label} className="flex size-11 items-center justify-center md:hidden">
              <NavIcon item={bell} />
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 max-md:pb-24 sm:px-6 lg:px-8">{children}</main>

      <nav
        aria-label={t.nav.label}
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-white/5 bg-slate-900/95 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-lg md:hidden"
      >
        {items
          .filter((i) => i.tab)
          .map((i) => (
            <Link
              key={i.href}
              href={i.href}
              aria-current={current(i.href)}
              className="group flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium text-slate-400 aria-[current]:font-bold aria-[current]:text-lime"
            >
              <span className="rounded-full px-4 py-1 transition group-aria-[current]:bg-lime/15">
                <NavIcon item={i} />
              </span>
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
