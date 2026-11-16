"use client";

import { MatchForm } from "@/components/match-form";
import { Guard } from "@/components/shell";

export default function NewMatchPage() {
  return <Guard min="host">{() => <MatchForm />}</Guard>;
}
