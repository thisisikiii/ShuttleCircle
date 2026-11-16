"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { MatchForm } from "@/components/match-form";
import { Empty, Load, buttonClass } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/strings";
import type { MatchDetail } from "@/lib/types";

export default function EditMatchPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ["match", id],
    queryFn: () => api.get<MatchDetail>(`/matches/${id}`).then((r) => r.data),
    refetchInterval: false, // the form starts from one snapshot
  });
  return (
    <Load q={q}>
      {(m) =>
        m.can_manage && m.status === "scheduled" ? (
          <MatchForm match={m} />
        ) : (
          <Empty
            action={
              <Link href={`/matches/${id}`} className={buttonClass()}>
                {t.common.back}
              </Link>
            }
          >
            {t.form.locked}
          </Empty>
        )
      }
    </Load>
  );
}
