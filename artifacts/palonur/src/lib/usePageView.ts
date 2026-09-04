import { useEffect, useRef } from "react";

const API_BASE = "/api";

function getSessionId(): string {
  try {
    let id = sessionStorage.getItem("palonur_sid");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("palonur_sid", id);
    }
    return id;
  } catch {
    return "unknown";
  }
}

// Persistent across visits (localStorage) so returning visitors are
// recognizable and retention can be measured properly. Null when
// storage is unavailable (private mode) — the server stores NULL.
function getVisitorId(): string | null {
  try {
    let id = localStorage.getItem("palonur_vid");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("palonur_vid", id);
    }
    return id;
  } catch {
    return null;
  }
}

export function usePageView(page: string) {
  const pvIdRef = useRef<number | null>(null);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    const session_id = getSessionId();
    const visitor_id = getVisitorId();
    const referrer = document.referrer;
    startRef.current = Date.now();

    fetch(`${API_BASE}/pageview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id, page, referrer, visitor_id }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.id) pvIdRef.current = d.id; })
      .catch(() => {});

    function sendDuration() {
      const id = pvIdRef.current;
      if (!id) return;
      const duration_ms = Date.now() - startRef.current;
      // sendBeacon requires a Blob to set Content-Type for JSON
      navigator.sendBeacon(
        `${API_BASE}/pageview/${id}`,
        new Blob([JSON.stringify({ duration_ms })], { type: "application/json" }),
      );
    }

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") sendDuration();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      sendDuration();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
}
