import { useRef, useState, useCallback, useEffect } from "react";
import DailyIframe from "@daily-co/daily-js";
import type { DailyCall, DailyParticipant } from "@daily-co/daily-js";

const SANS =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";
const PAPER = "#fafaf7";
const INK = "#08020a";

type Phase = "idle" | "loading" | "connecting" | "live" | "error";

/**
 * daily-js allows only ONE call object per page. A remount (the ask page
 * re-keys this component on every portrait click) or a rapid double-start can
 * otherwise race the old instance's async teardown against the new instance's
 * createCallObject() and throw "Duplicate DailyIframe" — which, in autoStart
 * mode, used to fail silently. Track the live call at module scope and tear
 * it down before creating a new one.
 */
let globalCall: DailyCall | null = null;
// Serializes teardowns: a new create must wait until the previous call object
// has ACTUALLY finished leave/destroy, not just been unreferenced.
let globalTeardown: Promise<void> = Promise.resolve();

async function teardownCall(call: DailyCall): Promise<void> {
  try {
    await call.leave().catch(() => undefined);
  } catch {
    /* already left */
  }
  try {
    await call.destroy();
  } catch {
    /* already destroyed */
  }
}

/** Begin tearing down `call` (if it is the tracked one) without waiting. */
function releaseGlobalCall(call: DailyCall | null) {
  if (!call) return;
  if (globalCall === call) globalCall = null;
  globalTeardown = globalTeardown.then(() => teardownCall(call));
}

/** Wait until no call object exists — required before createCallObject(). */
async function destroyGlobalCall(): Promise<void> {
  const call = globalCall;
  if (call) {
    globalCall = null;
    globalTeardown = globalTeardown.then(() => teardownCall(call));
  }
  await globalTeardown;
}

interface Props {
  /** When set, Pal greets the user with question-aware context. */
  question?: string;
  /** If true, the session starts automatically on mount (with a short delay). */
  autoStart?: boolean;
  /** Only render the trigger button when the user has English selected. */
  isEnglish?: boolean;
  /** Which AI persona to create. Defaults to "pal". */
  persona?: "pal" | "karan" | "ai-lab-education-leadership" | "steward";
  /** The faculty context required by the governed steward avatar route. */
  steward?: {
    pillarSlug: string;
    pillarName: string;
    stewardName: string | null;
    institution: string | null;
  };
  /** Reuses the name the visitor already gave Palonur in Daily's join call. */
  visitorName?: string;
  /**
   * Visual style of the idle trigger.
   * "pill"  = the default dark-red rounded button (Pal on the home page).
   * "card"  = the cream inline card.
   */
  triggerVariant?: "pill" | "card" | "inline";
  /** Plain-language label for the compact inline trigger. */
  triggerLabel?: string;
  /**
   * Whether the user already has a research answer for their question.
   * When true, the Tavus context shifts from "here's how to search" to
   * "I can see you got an answer — want to talk through it?"
   */
  answered?: boolean;
  /**
   * Short summary of the answer already on screen (first sentence of ANSWER
   * block). Injected into Pal's greeting so she can reference it naturally.
   */
  answerSummary?: string;
  /**
   * Called with the user's real-time transcribed speech so the parent can
   * populate a search box or similar. Fires on both interim and final segments.
   * `isFinal` is true when the segment is confirmed (not a live partial word).
   */
  onTranscript?: (text: string, isFinal: boolean) => void;
  /**
   * Called whenever the call goes live (true) or ends (false), so the parent
   * can show a "listening" indicator on the search input.
   */
  onLive?: (live: boolean) => void;
  /**
   * The current text in the search box. While Pal is live, this is shown in
   * the panel and — after a 1.5 s debounce — sent to Pal via the interrupt
   * API so she can comment on it in real-time.
   */
  liveText?: string;
}

/**
 * TavusAvatarButton
 *
 * Opens Pal as a floating bottom-right panel so the page stays visible.
 * Uses daily-js createCallObject (headless) — no pre-join screen.
 * Explicitly manages audio via track-started (required for createCallObject).
 * Video borders: container aspect-ratio is synced to the video's natural ratio
 * via onLoadedMetadata, so there are no letterbox bars.
 *
 * Transcription: after joining, startTranscription() is called so the user's
 * speech flows back to the parent via onTranscript in real-time.
 */
export default function TavusAvatarButton({
  question,
  autoStart = false,
  isEnglish = true,
  persona = "pal",
  triggerVariant = "pill",
  steward,
  visitorName,
  triggerLabel,
  onTranscript,
  onLive,
  liveText,
  answered = false,
  answerSummary,
}: Props) {
  const displayName =
    persona === "steward"
      ? (steward?.stewardName ?? steward?.pillarName ?? "Faculty avatar")
      : persona === "karan" || persona === "ai-lab-education-leadership"
        ? "Karan Dehghani"
        : "Pal Harford";
  const [phase, setPhase] = useState<Phase>("idle");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState("");
  const [muted, setMuted] = useState(false);
  const [avatarReady, setAvatarReady] = useState(false);
  // Detected video aspect ratio (width/height). Null until first frame arrives.
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  // Drag position in top/left space. Null = use default bottom-right corner.
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const callRef = useRef<DailyCall | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // createCallObject() does NOT auto-play remote audio — we create elements manually
  const audioEls = useRef<HTMLAudioElement[]>([]);
  // Track whether autoStart has fired so we don't double-start
  const autoStartedRef = useRef(false);
  // Generation counter: bumped on every start and on unmount so a stale
  // in-flight start (component remounted mid-fetch) bails out instead of
  // joining a session that a newer start has already superseded.
  const startGenRef = useRef(0);
  // Track if dismissed by user so we don't re-auto-start
  const dismissedRef = useRef(false);
  // Accumulate confirmed transcript segments from the user's microphone
  const finalTranscriptRef = useRef<string>("");
  // Drag tracking: grab offset from panel origin
  const dragStartRef = useRef<{
    clientX: number;
    clientY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const cleanupAudio = useCallback(() => {
    for (const el of audioEls.current) {
      el.srcObject = null;
      el.remove();
    }
    audioEls.current = [];
  }, []);

  const startSession = useCallback(async () => {
    if (phase === "loading" || phase === "connecting" || phase === "live")
      return;
    startGenRef.current += 1;
    const gen = startGenRef.current;
    setPhase("loading");
    setErrMsg("");
    setAvatarReady(false);
    setVideoAspect(null);
    finalTranscriptRef.current = "";

    try {
      const res = await fetch(
        `${import.meta.env.BASE_URL}api/tavus/conversation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: question?.trim() || undefined,
            persona,
            answered: answered || undefined,
            answerSummary: answerSummary?.trim() || undefined,
            ...(persona === "steward"
              ? {
                  pillarSlug: steward?.pillarSlug ?? "",
                  pillarName: steward?.pillarName ?? "",
                  stewardName: steward?.stewardName ?? "",
                  institution: steward?.institution ?? "",
                }
              : {}),
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not start session");
      }
      const data = (await res.json()) as {
        conversation_url: string;
        conversation_id: string;
      };
      const roomUrl = data.conversation_url.split("?")[0];

      // A newer start (or an unmount) superseded this one while the fetch was
      // in flight — free the just-created conversation and bail quietly.
      if (startGenRef.current !== gen) {
        fetch(
          `${import.meta.env.BASE_URL}api/tavus/conversation/${data.conversation_id}`,
          {
            method: "DELETE",
          },
        ).catch(() => undefined);
        return;
      }

      setConversationId(data.conversation_id);
      setPhase("connecting");

      // Tear down any call object left by a previous instance/session before
      // creating a new one — daily-js allows only one per page.
      await destroyGlobalCall();
      if (startGenRef.current !== gen) {
        fetch(
          `${import.meta.env.BASE_URL}api/tavus/conversation/${data.conversation_id}`,
          {
            method: "DELETE",
          },
        ).catch(() => undefined);
        return;
      }

      const call = DailyIframe.createCallObject();
      globalCall = call;
      callRef.current = call;

      call.on("track-started", (ev) => {
        if (!ev || !ev.participant || ev.participant.local) return;

        if (ev.track.kind === "video" && videoRef.current) {
          const stream = new MediaStream([ev.track]);
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => undefined);
          setAvatarReady(true);
        }

        if (ev.track.kind === "audio") {
          // Explicit audio element required — createCallObject() is headless
          const audio = document.createElement("audio");
          audio.autoplay = true;
          audio.srcObject = new MediaStream([ev.track]);
          document.body.appendChild(audio);
          audioEls.current.push(audio);
          audio.play().catch(() => undefined);
        }
      });

      // Belt-and-suspenders: catch video arriving via participant-updated too
      const attachVideoFromParticipant = (p: DailyParticipant) => {
        if (p.local || avatarReady) return;
        const track = p.tracks?.video?.persistentTrack;
        if (track && videoRef.current) {
          const stream = new MediaStream([track]);
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => undefined);
          setAvatarReady(true);
        }
      };
      call.on("participant-updated", (ev) => {
        if (ev?.participant) attachVideoFromParticipant(ev.participant);
      });

      call.on("joined-meeting", () => {
        setPhase("live");
        onLive?.(true);
        // Start real-time transcription so the user's speech flows into the search box.
        // Degrades gracefully when not available on the plan.
        if (onTranscript) {
          try {
            call.startTranscription();
          } catch {
            /* plan may not support it */
          }
        }
      });

      // Real-time speech → search box
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      call.on("transcription-message" as any, (ev: any) => {
        if (!ev || !onTranscript) return;

        // Only transcribe the LOCAL participant (the user), not Pal.
        const localId = call.participants()?.local?.session_id;
        if (localId && ev.participant_id && ev.participant_id !== localId)
          return;

        const isFinal = Boolean(ev.is_final);
        const text: string = ev.text ?? "";

        if (isFinal) {
          // Append confirmed segment
          finalTranscriptRef.current = finalTranscriptRef.current
            ? `${finalTranscriptRef.current} ${text}`
            : text;
          onTranscript(finalTranscriptRef.current.trim(), true);
        } else {
          // Show live interim result (final so far + current partial word)
          const live = finalTranscriptRef.current
            ? `${finalTranscriptRef.current} ${text}`
            : text;
          onTranscript(live.trim(), false);
        }
      });

      call.on("error", (ev) => {
        setErrMsg(ev?.errorMsg ?? "Connection error");
        setPhase("error");
        onLive?.(false);
      });
      call.on("left-meeting", () => {
        releaseGlobalCall(call);
        if (callRef.current === call) callRef.current = null;
        onLive?.(false);
      });

      // Final staleness check: dismiss/unmount may have fired while the call
      // object was being created and wired up.
      if (startGenRef.current !== gen) {
        releaseGlobalCall(call);
        if (callRef.current === call) callRef.current = null;
        fetch(
          `${import.meta.env.BASE_URL}api/tavus/conversation/${data.conversation_id}`,
          {
            method: "DELETE",
          },
        ).catch(() => undefined);
        return;
      }

      // Joining Daily directly is deliberate: it bypasses Tavus's hosted
      // pre-join name screen, preserves the visitor's existing name, and
      // guarantees their own camera stays off. The mic remains available for
      // a natural spoken conversation and can be muted from the call panel.
      await call.join({
        url: roomUrl,
        userName: visitorName?.trim() || "Palonur visitor",
        startVideoOff: true,
        startAudioOff: false,
      });
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "Something went wrong");
      setPhase("error");
      onLive?.(false);
    }
  }, [
    phase,
    avatarReady,
    question,
    onTranscript,
    onLive,
    persona,
    answered,
    answerSummary,
    steward,
    visitorName,
  ]);

  const dismiss = useCallback(() => {
    dismissedRef.current = true;
    startGenRef.current += 1; // invalidate any in-flight start
    releaseGlobalCall(callRef.current); // handles leave + destroy, serialized
    callRef.current = null;
    if (conversationId) {
      fetch(
        `${import.meta.env.BASE_URL}api/tavus/conversation/${conversationId}`,
        {
          method: "DELETE",
        },
      ).catch(() => undefined);
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    cleanupAudio();
    setPhase("idle");
    setConversationId(null);
    setAvatarReady(false);
    setVideoAspect(null);
    setMuted(false);
    setErrMsg("");
    // Reset drag position so next session starts in the default corner
    setDragPos(null);
    setIsDragging(false);
    dragStartRef.current = null;
    onLive?.(false);
  }, [conversationId, cleanupAudio, onLive]);

  const toggleMute = useCallback(async () => {
    if (!callRef.current) return;
    const next = !muted;
    await callRef.current.setLocalAudio(!next);
    setMuted(next);
  }, [muted]);

  // Auto-start: fire once on mount after a short delay (lets the page settle first)
  useEffect(() => {
    if (
      !autoStart ||
      autoStartedRef.current ||
      dismissedRef.current ||
      !isEnglish
    )
      return;
    autoStartedRef.current = true;
    // Short settle delay only — a long delay here makes the click feel dead
    // and invites a second click (which remounts the panel and churns sessions).
    const id = setTimeout(() => {
      void startSession();
    }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, isEnglish]);

  // While live, debounce liveText changes and send to Pal via the interrupt API
  useEffect(() => {
    if (phase !== "live" || !conversationId || !liveText?.trim()) return;
    const id = setTimeout(() => {
      fetch(
        `${import.meta.env.BASE_URL}api/tavus/conversation/${conversationId}/say`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: liveText.trim() }),
        },
      ).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(id);
  }, [liveText, phase, conversationId]);

  // Drag — window-level pointer tracking (mount-time, refs only, no deps needed)
  useEffect(() => {
    const onMove = (e: MouseEvent | TouchEvent) => {
      if (!dragStartRef.current || !panelRef.current) return;
      const clientX =
        "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY =
        "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
      const dx = clientX - dragStartRef.current.clientX;
      const dy = clientY - dragStartRef.current.clientY;
      const newX = dragStartRef.current.originX + dx;
      const newY = dragStartRef.current.originY + dy;
      const pw = panelRef.current.offsetWidth;
      const ph = panelRef.current.offsetHeight;
      const clampedX = Math.max(0, Math.min(newX, window.innerWidth - pw));
      const clampedY = Math.max(0, Math.min(newY, window.innerHeight - ph));
      setDragPos({ x: clampedX, y: clampedY });
      if ("touches" in e) e.preventDefault(); // prevent page scroll while dragging
    };
    const onEnd = () => {
      if (!dragStartRef.current) return;
      dragStartRef.current = null;
      setIsDragging(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mouseup", onEnd);
    window.addEventListener("touchend", onEnd);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchend", onEnd);
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      startGenRef.current += 1; // invalidate any in-flight start
      releaseGlobalCall(callRef.current); // handles leave + destroy, serialized
      callRef.current = null;
      cleanupAudio();
      onLive?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupAudio]);

  // Don't render anything when the user has switched to a non-English language
  if (!isEnglish) return null;

  const isLoading = phase === "loading";
  const isConnecting = phase === "connecting";
  const isOpen = phase === "connecting" || phase === "live";

  return (
    <>
      {/* Trigger pill — only shown in idle/error states (pill variant only) */}
      {!isOpen && !autoStart && triggerVariant === "pill" && (
        <button
          type="button"
          onClick={startSession}
          disabled={isLoading || isConnecting}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontFamily: SANS,
            fontSize: "clamp(11.5px, 1.05vw, 13px)",
            fontWeight: 600,
            color:
              isLoading || isConnecting ? "rgba(255,255,255,0.55)" : "#fff",
            background:
              isLoading || isConnecting ? "rgba(140,21,21,0.55)" : "#8C1515",
            border: "none",
            borderRadius: 999,
            padding: "9px 18px 9px 14px",
            cursor: isLoading || isConnecting ? "default" : "pointer",
            boxShadow: "0 4px 18px rgba(140,21,21,0.45)",
            transition: "background .15s, box-shadow .15s",
            whiteSpace: "nowrap",
          }}
          onMouseEnter={(e) => {
            if (isLoading || isConnecting) return;
            e.currentTarget.style.background = "#a01a1a";
            e.currentTarget.style.boxShadow = "0 6px 22px rgba(140,21,21,0.55)";
          }}
          onMouseLeave={(e) => {
            if (isLoading || isConnecting) return;
            e.currentTarget.style.background = "#8C1515";
            e.currentTarget.style.boxShadow = "0 4px 18px rgba(140,21,21,0.45)";
          }}
        >
          {isLoading || isConnecting ? <Spinner /> : <VideoIcon />}
          {isLoading
            ? "Connecting…"
            : isConnecting
              ? "Joining…"
              : `Talk to ${displayName}`}
        </button>
      )}

      {/* Card trigger variant — cream inline card */}
      {!isOpen && !autoStart && triggerVariant === "card" && (
        <button
          type="button"
          onClick={startSession}
          disabled={isLoading || isConnecting}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
            justifyContent: "center",
            padding: "20px 32px",
            background: "#fdfaf5",
            border: "1px solid rgba(178,107,31,0.32)",
            borderRadius: 18,
            textDecoration: "none",
            cursor: "pointer",
            boxShadow: "0 10px 30px rgba(28,22,16,0.06)",
            transition: "box-shadow .15s, border-color .15s",
            fontFamily: SANS, // reset browser button styles
            outline: "none",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.boxShadow =
              "0 14px 38px rgba(178,107,31,0.15)";
            e.currentTarget.style.borderColor = "rgba(178,107,31,0.55)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = "0 10px 30px rgba(28,22,16,0.06)";
            e.currentTarget.style.borderColor = "rgba(178,107,31,0.32)";
          }}
        >
          {isLoading || isConnecting ? (
            <Spinner />
          ) : (
            <span aria-hidden style={{ fontSize: 24 }}>
              🎙
            </span>
          )}
          <span
            style={{
              fontFamily:
                "-apple-system,BlinkMacSystemFont,'Palatino Linotype',Georgia,serif",
              fontSize: 19,
              color: "#1c1610",
            }}
          >
            {isLoading || isConnecting
              ? "Connecting…"
              : "Would you rather talk than type?"}
          </span>
          {!isLoading && !isConnecting && (
            <span
              style={{
                fontFamily: SANS,
                fontSize: 17,
                fontWeight: 700,
                color: "#8F5518",
              }}
            >
              {persona === "karan" || persona === "ai-lab-education-leadership"
                ? `Talk to an AI avatar of ${displayName}`
                : `Talk to our assistant ${displayName}`}
            </span>
          )}
        </button>
      )}

      {/* Compact inline trigger — used within the faculty conversation. It
          starts a spoken, camera-off call instead of sending visitors through
          the provider's generic pre-join form. */}
      {!isOpen && !autoStart && triggerVariant === "inline" && (
        <button
          type="button"
          onClick={startSession}
          disabled={isLoading || isConnecting}
          style={{
            marginTop: 10,
            width: "100%",
            background: "transparent",
            border: "1.5px solid rgba(10,10,15,0.16)",
            borderRadius: 999,
            padding: "9px 16px",
            fontFamily: SANS,
            fontSize: 12.5,
            fontWeight: 700,
            color: INK,
            cursor: isLoading || isConnecting ? "default" : "pointer",
            opacity: isLoading || isConnecting ? 0.6 : 1,
          }}
        >
          {isLoading
            ? "Connecting…"
            : isConnecting
              ? "Joining…"
              : (triggerLabel ?? `🎙 Talk with ${displayName} (camera off)`)}
        </button>
      )}

      {/* Auto-start loading state — shown when autoStart is connecting */}
      {autoStart && (isLoading || isConnecting) && !isOpen && (
        <div
          style={{
            position: "fixed",
            bottom: 72,
            right: 28,
            zIndex: 9100,
            width: "clamp(220px, 22vw, 300px)",
            borderRadius: 16,
            background: INK,
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: SANS,
            fontSize: 12,
            color: "rgba(255,255,255,0.5)",
          }}
        >
          <Spinner />
          <span>
            Connecting to {displayName === "Pal Harford" ? "Pal" : displayName}…
          </span>
        </div>
      )}

      {/* Auto-start error state — plain-language message with a retry, so a
          failed or killed session never just vanishes silently. */}
      {autoStart && phase === "error" && (
        <div
          style={{
            position: "fixed",
            bottom: 72,
            right: 28,
            zIndex: 9100,
            width: "clamp(240px, 24vw, 320px)",
            borderRadius: 16,
            background: INK,
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
            padding: "16px 18px",
            fontFamily: SANS,
          }}
        >
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.55,
              color: "rgba(255,255,255,0.85)",
              marginBottom: 12,
            }}
          >
            The video call could not start. This can happen when the line is
            busy. Please try again.
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => void startSession()}
              style={{
                fontFamily: SANS,
                fontSize: 13,
                fontWeight: 700,
                color: "#fff",
                background: "#8C1515",
                border: "none",
                borderRadius: 999,
                padding: "8px 18px",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={dismiss}
              style={{
                fontFamily: SANS,
                fontSize: 13,
                fontWeight: 600,
                color: "rgba(255,255,255,0.6)",
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 999,
                padding: "8px 16px",
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {phase === "error" && errMsg && !autoStart && (
        <div
          style={{
            fontSize: 12,
            color: "rgba(255,180,180,0.85)",
            fontFamily: SANS,
            textAlign: "center",
          }}
        >
          {errMsg}
        </div>
      )}

      {/* Floating corner panel — page stays fully visible behind it */}
      {isOpen && (
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            // Use dragged top/left when available; fall back to default bottom-right corner
            ...(dragPos
              ? {
                  top: dragPos.y,
                  left: dragPos.x,
                  bottom: "auto",
                  right: "auto",
                }
              : { bottom: 76, right: 28 }),
            zIndex: 9100,
            width: "clamp(200px, 22vw, 300px)",
            borderRadius: 16,
            overflow: "hidden",
            background: INK,
            boxShadow:
              "0 20px 60px rgba(0,0,0,0.70), 0 0 0 1px rgba(255,255,255,0.06)",
            display: "flex",
            flexDirection: "column",
            // Prevent text selection while dragging
            userSelect: isDragging ? "none" : "auto",
            cursor: isDragging ? "grabbing" : "auto",
          }}
        >
          {/* Header — drag handle */}
          <div
            onMouseDown={(e) => {
              if (!panelRef.current) return;
              const rect = panelRef.current.getBoundingClientRect();
              dragStartRef.current = {
                clientX: e.clientX,
                clientY: e.clientY,
                originX: rect.left,
                originY: rect.top,
              };
              setIsDragging(true);
              // Switch immediately to top/left so subsequent moves are in the right space
              setDragPos({ x: rect.left, y: rect.top });
            }}
            onTouchStart={(e) => {
              if (!panelRef.current) return;
              const touch = e.touches[0];
              const rect = panelRef.current.getBoundingClientRect();
              dragStartRef.current = {
                clientX: touch.clientX,
                clientY: touch.clientY,
                originX: rect.left,
                originY: rect.top,
              };
              setIsDragging(true);
              setDragPos({ x: rect.left, y: rect.top });
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "9px 11px",
              background: "rgba(6,1,10,0.92)",
              backdropFilter: "blur(12px)",
              flexShrink: 0,
              cursor: isDragging ? "grabbing" : "grab",
              touchAction: "none",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <GripIcon />
              <span
                style={{
                  display: "inline-block",
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: phase === "live" ? "#22c55e" : "#f59e0b",
                  boxShadow: `0 0 5px ${phase === "live" ? "#22c55e" : "#f59e0b"}`,
                }}
              />
              <span
                style={{
                  color: PAPER,
                  fontWeight: 600,
                  fontSize: 12,
                  fontFamily: SANS,
                }}
              >
                {displayName}
              </span>
              {isConnecting && (
                <span
                  style={{
                    color: "rgba(255,255,255,0.38)",
                    fontSize: 10,
                    fontFamily: SANS,
                  }}
                >
                  joining…
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {phase === "live" && (
                <button
                  onClick={toggleMute}
                  title={muted ? "Unmute" : "Mute mic"}
                  style={iconBtnStyle}
                >
                  {muted ? <MicOffIcon /> : <MicIcon />}
                </button>
              )}
              <button
                onClick={dismiss}
                title="End conversation"
                style={{ ...iconBtnStyle, color: PAPER, fontSize: 13 }}
              >
                ✕
              </button>
            </div>
          </div>

          {/* Video area — aspect ratio adapts to the actual video stream */}
          <div
            style={{
              position: "relative",
              // Use detected video ratio; fall back to portrait (9:16) while connecting
              aspectRatio: videoAspect ? String(videoAspect) : "9/16",
              background: "#080010",
              overflow: "hidden",
            }}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) {
                  setVideoAspect(v.videoWidth / v.videoHeight);
                }
              }}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                // cover fills perfectly once the container matches video ratio
                objectFit: "cover",
                display: "block",
                opacity: avatarReady ? 1 : 0,
                transition: "opacity .5s",
              }}
            />
            {!avatarReady && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  color: "rgba(255,255,255,0.35)",
                  fontFamily: SANS,
                  fontSize: 11,
                }}
              >
                <LargeSpinner />
                <span>Connecting to {displayName}…</span>
              </div>
            )}
          </div>

          {phase === "live" && (
            <div
              style={{
                padding: "8px 12px",
                background: "rgba(6,1,10,0.90)",
                borderTop: "1px solid rgba(255,255,255,0.06)",
                fontFamily: SANS,
                fontSize: 10.5,
                lineHeight: 1.45,
                color: "rgba(255,255,255,0.58)",
              }}
            >
              Your camera is off. Speak naturally, or use the mic button to
              pause.
            </div>
          )}

          {/* Typing strip — shows what the user is typing; updates in real-time */}
          {phase === "live" && liveText?.trim() && (
            <div
              style={{
                padding: "7px 12px",
                background: "rgba(6,1,10,0.90)",
                borderTop: "1px solid rgba(255,255,255,0.06)",
                fontFamily: SANS,
                fontSize: 10.5,
                color: "rgba(255,255,255,0.55)",
                lineHeight: 1.4,
              }}
            >
              <span style={{ color: "rgba(255,255,255,0.30)", marginRight: 4 }}>
                You typed:
              </span>
              <span
                style={{ color: "rgba(255,255,255,0.75)", fontStyle: "italic" }}
              >
                {liveText.length > 80 ? liveText.slice(0, 80) + "…" : liveText}
              </span>
            </div>
          )}

          {/* Listening footer — shown when live and onTranscript is wired */}
          {phase === "live" && onTranscript && !liveText?.trim() && (
            <div
              style={{
                padding: "8px 12px",
                background: "rgba(6,1,10,0.85)",
                borderTop: "1px solid rgba(255,255,255,0.06)",
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontFamily: SANS,
                fontSize: 10.5,
                color: "rgba(255,255,255,0.40)",
              }}
            >
              <PulsingDot />
              <span>Your words go into the search box as you speak</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

const iconBtnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.10)",
  border: "none",
  borderRadius: "50%",
  width: 26,
  height: 26,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

function VideoIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgba(255,255,255,0.80)"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgba(239,68,68,0.90)"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 18 18"
      fill="none"
      style={{ animation: "tavusSpin 0.8s linear infinite", flexShrink: 0 }}
    >
      <style>{`@keyframes tavusSpin{to{transform:rotate(360deg)}}`}</style>
      <circle
        cx="9"
        cy="9"
        r="7"
        stroke="rgba(255,255,255,0.20)"
        strokeWidth="2.5"
      />
      <path
        d="M9 2a7 7 0 0 1 7 7"
        stroke="rgba(255,255,255,0.65)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LargeSpinner() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 36 36"
      fill="none"
      style={{ animation: "tavusSpin 1s linear infinite" }}
    >
      <circle
        cx="18"
        cy="18"
        r="15"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="3"
      />
      <path
        d="M18 3a15 15 0 0 1 15 15"
        stroke="rgba(255,255,255,0.45)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      {[0, 4].map((cx) =>
        [0, 4, 8].map((cy) => (
          <circle
            key={`${cx}-${cy}`}
            cx={cx + 1}
            cy={cy + 1}
            r="1"
            fill="rgba(255,255,255,0.30)"
          />
        )),
      )}
    </svg>
  );
}

function PulsingDot() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: "#22c55e",
        flexShrink: 0,
        animation: "tavusPulse 1.4s ease-in-out infinite",
      }}
    >
      <style>{`@keyframes tavusPulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
    </span>
  );
}
