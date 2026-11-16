"use client";

import { useEffect, useId, useRef } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { errorText } from "@/lib/api";
import { t } from "@/lib/strings";

// DESIGN.md §9: primary = green fill with a glow (one per viewport), secondary = ring outline, tertiary = text.
const variants = {
  primary: "bg-accent px-5 text-on-accent shadow-[0_0_32px_-4px_rgba(124,255,79,.35)] hover:brightness-110",
  secondary: "border-[1.5px] border-border px-5 text-fg hover:border-accent",
  tertiary: "px-3 text-secondary hover:bg-primary/6",
};
type Variant = keyof typeof variants;

export const buttonClass = (variant: Variant = "secondary") =>
  `inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-2xl font-medium transition-[border-radius] duration-200 hover:rounded-[999px] disabled:hover:rounded-2xl disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]}`;

export function Button({
  variant,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" className={`${buttonClass(variant)} ${className}`} {...props} />;
}

// 16 px text on phones so iOS does not zoom on focus (DESIGN.md §10).
export const controlClass =
  "block min-h-11 w-full rounded-2xl border-[1.5px] border-border bg-surface px-3 text-base aria-invalid:border-danger md:text-[0.9375rem]";

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
      <label htmlFor={id} className="caption mb-1 block">
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
  neutral: "border-border text-muted",
  success: "border-success text-success",
  warning: "border-warning text-warning",
  danger: "border-danger text-danger",
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
      className={`caption inline-block rounded-full border bg-surface px-2.5 py-0.5 whitespace-nowrap ${tones[statusTone[status]]}`}
    >
      {t.status[status]}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`rounded-sm bg-border/60 motion-safe:animate-pulse ${className}`} />;
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
      className={`my-3 flex flex-wrap items-center justify-between gap-x-4 border-l-2 bg-surface px-3 py-2 ${tone === "danger" ? "border-danger" : "border-muted"}`}
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
    <div className="py-10 text-center text-muted">
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
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <h1>{title}</h1>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

/** Summary strip: hairline-separated figures (wallet and finance). */
export function Strip({ items, className }: { items: { label: string; value: ReactNode }[]; className: string }) {
  return (
    <dl className={`mb-6 grid gap-px border border-border bg-border ${className}`}>
      {items.map((item) => (
        <div key={item.label} className="bg-surface p-3">
          <dt className="caption text-muted">{item.label}</dt>
          <dd className="mono mt-1 text-base">{item.value}</dd>
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
            <th key={c.head} scope="col" className={`caption py-2 pr-4 text-muted ${c.className ?? ""}`}>
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
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border-[1.5px] border-border bg-surface p-6 text-fg backdrop:bg-black/70"
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
