"use client";

import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/strings";

const ANNOUNCE_AT = [60, 300, 600]; // seconds left: 1, 5 and 10 minutes (DESIGN.md §12)

/** Live seat-hold countdown. Visible every second; announced to screen readers only at 10, 5, 1 minutes and expiry. */
export function Countdown({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
  const secondsLeft = () => Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
  const [left, setLeft] = useState(secondsLeft);
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef(left);

  useEffect(() => {
    const timer = setInterval(() => setLeft(secondsLeft()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    const crossed = ANNOUNCE_AT.find((s) => previous.current > s && left <= s);
    if (left === 0 && previous.current > 0) {
      setAnnouncement(t.countdown.expired);
      onExpire(); // re-check the server at zero (DESIGN.md §11)
    } else if (crossed) setAnnouncement(t.countdown.minutesLeft(crossed / 60));
    previous.current = left;
  }, [left]);

  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return (
    <>
      <span
        className={`mono text-xl font-extrabold text-accent ${left > 0 && left <= 60 ? "motion-safe:animate-pulse" : ""}`}
      >
        {left > 0 ? `${mm}:${ss}` : t.countdown.expired}
      </span>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
