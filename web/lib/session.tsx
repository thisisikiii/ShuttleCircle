"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useContext } from "react";
import { ApiError, api, bootSession, setToken } from "./api";
import type { Health, Me, Role } from "./types";

const ranks: Record<Role, number> = { member: 0, host: 1, admin: 2, superadmin: 3 };
export const atLeast = (me: Me, role: Role) => me.kind === "member" && ranks[me.role] >= ranks[role];

export const MeContext = createContext<Me | null>(null);
export function useMe() {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe needs the session shell");
  return me;
}

/** `null` means no session at all: neither a member nor a guest cookie. */
export function useMeQuery() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async (): Promise<Me | null> => {
      await bootSession();
      try {
        return (await api.get<Me>("/me")).data;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

/** Optional integrations the server has configured; undefined until known. */
export function useFeatures() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => fetch("/api/v1/healthz").then((r) => r.json() as Promise<Health>),
    staleTime: Infinity,
    refetchInterval: false,
  }).data?.features;
}

/** Stores a fresh access token and continues to `?next=` (same-site paths only) or the calendar. */
export function useSignIn() {
  const qc = useQueryClient();
  const router = useRouter();
  return (accessToken: string) => {
    setToken(accessToken);
    qc.invalidateQueries();
    const next = new URLSearchParams(window.location.search).get("next");
    router.replace(next && /^\/(?![/\\])/.test(next) ? next : "/");
  };
}
