"use client";

import { useEffect, useId, useRef } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { errorText } from "@/lib/api";
import { t } from "@/lib/strings";

// DESIGN.md §9: pill buttons. primary = emerald fill, secondary = outline, tertiary = text, danger = rose tint.
const variants = {
  primary:
    "bg-accent px-6 text-on-accent shadow-lg shadow-emerald-700/25 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-emerald-700/30 hover:brightness-110",
  secondary: "border-2 border-border bg-surface px-5 text-fg hover:border-accent/50 hover:bg-accent/5",
  tertiary: "px-3.5 text-secondary hover:bg-accent/10",
  danger: "bg-danger/10 px-5 text-danger hover:bg-danger/15",
};
type Variant = keyof typeof variants;

export const buttonClass = (variant: Variant = "secondary") =>
  `inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-bold whitespace-nowrap transition duration-200 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${variants[variant]}`;

export function Button({
  variant,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" className={`${buttonClass(variant)} ${className}`} {...props} />;
}

// 16 px text on phones so iOS does not zoom on focus (DESIGN.md §10).
export const controlClass =
  "block min-h-12 w-full rounded-2xl border-2 border-border bg-surface px-4 text-base text-fg transition placeholder:text-muted hover:border-control focus:border-accent focus:outline-none aria-invalid:border-danger md:text-sm";

function Field({
  label,
  error,
  className,
  children,
}: {
  label: string;
  error?: string;
  className?: string;
  children: (id: string, errorId: string | undefined) => ReactNode;
}) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="label mb-1.5 block">
        {label}
      </label>
      {children(id, errorId)}
      {error && (
        <p id={errorId} className="caption mt-1 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

type FieldProps = { label: string; error?: string };

export function Input({ label, error, className, ...props }: InputHTMLAttributes<HTMLInputElement> & FieldProps) {
  return (
    <Field label={label} error={error} className={className}>
      {(id, errorId) => (
        <input id={id} aria-invalid={!!error} aria-describedby={errorId} className={controlClass} {...props} />
      )}
    </Field>
  );
}

export function Select({ label, error, className, ...props }: SelectHTMLAttributes<HTMLSelectElement> & FieldProps) {
  return (
    <Field label={label} error={error} className={className}>
      {(id, errorId) => (
        <select id={id} aria-invalid={!!error} aria-describedby={errorId} className={controlClass} {...props} />
      )}
    </Field>
  );
}

export function Checkbox({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex min-h-11 items-center gap-3">
      <input type="checkbox" className="size-5 accent-accent" {...props} />
      {label}
    </label>
  );
}

const tones = {
  neutral: "bg-muted/15 text-label",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
};
const statusTone: Record<keyof typeof t.status, keyof typeof tones> = {
  pending: "warning",
  awaiting_payment: "warning",
  confirmed: "success",
  rejected: "danger",
  expired: "danger",
  cancelled: "danger",
  scheduled: "neutral",
  ongoing: "warning",
  completed: "neutral",
  active: "success",
  suspended: "danger",
};

/** Status is always a text label; the color only supports it. */
export function Chip({ status }: { status: keyof typeof t.status }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] leading-4 font-bold whitespace-nowrap ${tones[statusTone[status]]}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {t.status[status]}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`rounded-xl bg-border motion-safe:animate-pulse ${className}`} />;
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status">
      <span className="sr-only">{t.common.loading}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="mb-2 h-11" />
      ))}
    </div>
  );
}

export function Alert({
  tone = "danger",
  children,
  action,
}: {
  tone?: "danger" | "info";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "note"}
      className={`my-3 flex flex-wrap items-center justify-between gap-x-4 rounded-2xl border px-4 py-3 text-sm font-medium ${tone === "danger" ? "border-danger/30 bg-danger/10 text-danger" : "border-accent/20 bg-accent/5"}`}
    >
      <p>{children}</p>
      {action}
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert
      action={
        onRetry && (
          <Button variant="tertiary" onClick={onRetry}>
            {t.common.retry}
          </Button>
        )
      }
    >
      {errorText(error)}
    </Alert>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-3xl border-2 border-dashed border-border bg-surface px-4 py-10 text-center text-muted">
      <span aria-hidden className="tile-icon mb-3 bg-lime/25 text-success">
        <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-current" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="8" />
          <path d="M8 13.5c2 2 6 2 8 0M9 9.5h.01M15 9.5h.01" />
        </svg>
      </span>
      <p>{children}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

type Loadable<T> = { isPending: boolean; error: unknown; refetch: () => unknown; data: T | undefined };

/** Skeleton while loading, inline error with retry, then the content. Stale data stays up during a failed poll. */
export function Load<T>({
  q,
  skeleton,
  children,
}: {
  q: Loadable<T>;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (q.data !== undefined) return children(q.data);
  if (q.isPending) return skeleton ?? <SkeletonRows />;
  return <ErrorAlert error={q.error} onRetry={() => q.refetch()} />;
}

export function LoadMore({
  q,
}: {
  q: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
}) {
  if (!q.hasNextPage) return null;
  return (
    <Button className="mt-4 w-full" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
      {t.common.loadMore}
    </Button>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1>{title}</h1>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

/** Summary strip: one tile per figure (wallet and finance). The first tile is the highlight, lime like Fresyls. */
export function Strip({ items, className }: { items: { label: string; value: ReactNode }[]; className: string }) {
  return (
    <dl className={`mb-6 grid gap-3 ${className}`}>
      {items.map((item, i) => (
        <div key={item.label} className={`card p-5 ${i === 0 ? "border-lime bg-lime [--color-label:#1a2e05]" : ""}`}>
          <dt className="label">{item.label}</dt>
          <dd className="mono mt-1.5 text-2xl font-extrabold tracking-tight text-primary">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type Column<T> = { head: string; cell: (row: T) => ReactNode; className?: string };

/** A table on tablets and up; on phones each row stacks its cells (DESIGN.md §10). */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  selected,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selected?: string | null;
}) {
  return (
    <table className="w-full text-left">
      <thead className="max-md:sr-only">
        <tr>
          {columns.map((c) => (
            <th key={c.head} scope="col" className={`label py-2 pr-4 ${c.className ?? ""}`}>
              {c.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={rowKey(row)}
            data-selected={selected === rowKey(row) || undefined}
            className="border-t border-border data-selected:bg-primary/4 max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-4 max-md:py-2"
          >
            {columns.map((c) => (
              <td key={c.head} className={`md:py-2 md:pr-4 ${c.className ?? ""}`}>
                {c.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby={titleId}
      className="m-auto max-h-[92dvh] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-[2rem] border border-border bg-surface p-6 text-fg shadow-2xl backdrop:bg-slate-900/60 backdrop:backdrop-blur-sm max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]"
    >
      <h2 id={titleId} className="mb-3">
        {title}
      </h2>
      {children}
    </dialog>
  );
}

/** Confirmation for irreversible actions. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  action,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  action: { mutate: () => void; isPending: boolean; error: unknown };
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p>{body}</p>
      {!!action.error && <ErrorAlert error={action.error} />}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="tertiary" onClick={onClose}>
          {t.common.back}
        </Button>
        <Button disabled={action.isPending} onClick={action.mutate}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
