"use client";

import { Guard } from "@/components/shell";
import { Button, Empty, ErrorAlert, Load, LoadMore, PageHeader } from "@/components/ui";
import { api, useAct, usePaged } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { t } from "@/lib/strings";
import type { Notice } from "@/lib/types";

export default function NotificationsPage() {
  return <Guard min="member">{() => <Notifications />}</Guard>;
}

function Notifications() {
  const q = usePaged<Notice>(["notifications"], "/notifications");
  const readAll = useAct(() => api.post("/notifications/read", { all: true }));
  return (
    <>
      <PageHeader title={t.notifications.title}>
        <Button
          disabled={readAll.isPending || q.items.every((n) => n.read_at)}
          onClick={() => readAll.mutate()}
        >
          {t.notifications.readAll}
        </Button>
      </PageHeader>
      {readAll.isError && <ErrorAlert error={readAll.error} />}
      <Load q={q}>
        {() =>
          q.items.length === 0 ? (
            <Empty>{t.notifications.empty}</Empty>
          ) : (
            <>
              <ul className="card divide-y divide-border px-5">
                {q.items.map((n) => (
                  <li key={n.id} className="py-3.5">
                    <p className={n.read_at ? "" : "font-semibold"}>
                      {!n.read_at && <span className="caption mr-2 text-warning">{t.notifications.unread}</span>}
                      {n.payload.title}
                    </p>
                    <p>{n.payload.body}</p>
                    <p className="caption text-muted">{fmtDateTime(n.created_at)}</p>
                  </li>
                ))}
              </ul>
              <LoadMore q={q} />
            </>
          )
        }
      </Load>
    </>
  );
}
