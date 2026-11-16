const JAKARTA_OFFSET_MS = 7 * 3600_000; // UTC+7 all year, no DST

const idr = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
export const rupiah = (n: number) => idr.format(n);

function formatter(options: Intl.DateTimeFormatOptions) {
  const f = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", ...options });
  return (iso: string) => f.format(new Date(iso));
}
export const fmtTime = formatter({ hour: "2-digit", minute: "2-digit" });
export const fmtDate = formatter({ weekday: "short", day: "numeric", month: "short", year: "numeric" });
export const fmtDateTime = formatter({
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export const fmtMonth = formatter({ month: "long", year: "numeric" });

/** Jakarta wall clock of a UTC instant, as a datetime-local value "YYYY-MM-DDTHH:mm". */
export const toJakartaInput = (iso: string) =>
  new Date(Date.parse(iso) + JAKARTA_OFFSET_MS).toISOString().slice(0, 16);
/** A datetime-local value typed as Jakarta time, as a UTC ISO string. */
export const fromJakartaInput = (local: string) => new Date(`${local}:00+07:00`).toISOString();
/** Jakarta calendar day "YYYY-MM-DD" of a UTC instant. */
export const jakartaDay = (iso: string) => toJakartaInput(iso).slice(0, 10);
export const today = () => jakartaDay(new Date().toISOString());
/** First day "YYYY-MM-01" of the Jakarta month `offset` months from the current one. */
export function monthStart(offset = 0) {
  const [y, m] = today().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 10);
}

export function groupBy<T>(items: T[], keyOf: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}
