// ─── Live Palo Alto sky ────────────────────────────────────────────────────────
// Extracted from App.tsx so both the brand home ("/") and the sleep landing
// ("/sleep") render the same living hero sky: real PA sun/moon times, live
// weather from open-meteo, stars, birds at dawn/dusk, rain, fog, lightning.
import { useState, useEffect, useCallback, useMemo, memo, useRef } from "react";
import { getSunTimesPA, getMoonPhase, getDarkness } from "@/astro";

// ─── Color helpers ─────────────────────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? [parseInt(r[1], 16), parseInt(r[2], 16), parseInt(r[3], 16)] : [0, 0, 0];
}
function rgbToHex(r: number, g: number, b: number) {
  return "#" + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function lerpColor(a: string, b: string, t: number) {
  const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

// ─── Sky keyframes ─────────────────────────────────────────────────────────────
const SKY = [
  { h: 0,    top: "#01010A", upper: "#04041A", horizon: "#080825", glow: "#100818" },
  { h: 4,    top: "#01010A", upper: "#03030F", horizon: "#07071E", glow: "#0D0718" },
  { h: 5,    top: "#03030F", upper: "#08082A", horizon: "#120E38", glow: "#1E1448" },
  { h: 5.75, top: "#080530", upper: "#160A48", horizon: "#2A1258", glow: "#3E1858" },
  { h: 6.5,  top: "#130840", upper: "#3A1050", horizon: "#8A2035", glow: "#C83010" },
  { h: 7.0,  top: "#1C0A40", upper: "#6B2028", horizon: "#B84010", glow: "#F07020" },
  { h: 7.5,  top: "#251040", upper: "#7A3020", horizon: "#C86020", glow: "#FFB040" },
  { h: 8.5,  top: "#2A3860", upper: "#5878A0", horizon: "#D0A870", glow: "#FFE0A0" },
  { h: 10,   top: "#3858A0", upper: "#6898C0", horizon: "#E8D0A0", glow: "#FFF5E0" },
  { h: 12,   top: "#3D6AB0", upper: "#75A5C8", horizon: "#EED8B0", glow: "#FFFAF5" },
  { h: 14,   top: "#3860A8", upper: "#70A0C0", horizon: "#E8D0A8", glow: "#FFF5F0" },
  { h: 16,   top: "#305898", upper: "#6080A8", horizon: "#E0C080", glow: "#FFE8B8" },
  { h: 17.5, top: "#284070", upper: "#604858", horizon: "#D08040", glow: "#FFC860" },
  { h: 18.5, top: "#1C1840", upper: "#6A2828", horizon: "#C04010", glow: "#FF8030" },
  { h: 19.5, top: "#0E0A28", upper: "#3C1018", horizon: "#900808", glow: "#E04010" },
  { h: 20.5, top: "#070418", upper: "#180818", horizon: "#3C0808", glow: "#7A1010" },
  { h: 21.5, top: "#03020E", upper: "#090618", horizon: "#140A18", glow: "#200A18" },
  { h: 23,   top: "#01010A", upper: "#04041A", horizon: "#080825", glow: "#100818" },
  { h: 24,   top: "#01010A", upper: "#04041A", horizon: "#080825", glow: "#100818" },
];

function interpolateSky(h: number) {
  let p = SKY[0], n = SKY[SKY.length - 1];
  for (let i = 0; i < SKY.length - 1; i++) {
    if (h >= SKY[i].h && h < SKY[i + 1].h) { p = SKY[i]; n = SKY[i + 1]; break; }
  }
  const t = (h - p.h) / (n.h - p.h);
  const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  return {
    top:     lerpColor(p.top,     n.top,     e),
    upper:   lerpColor(p.upper,   n.upper,   e),
    horizon: lerpColor(p.horizon, n.horizon, e),
    glow:    lerpColor(p.glow,    n.glow,    e),
  };
}

function getPAHours() {
  const pa = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return pa.getHours() + pa.getMinutes() / 60 + pa.getSeconds() / 3600;
}

// ─── Weather ───────────────────────────────────────────────────────────────────
interface Weather {
  code: number; cloudCover: number; precipitation: number; windSpeed: number;
}
async function fetchWeather(): Promise<Weather> {
  const res = await fetch(
    "https://api.open-meteo.com/v1/forecast?latitude=37.4419&longitude=-122.1430" +
    "&current=weather_code,cloud_cover,precipitation,wind_speed_10m&wind_speed_unit=kmh"
  );
  const d = await res.json();
  const c = d.current;
  return { code: c.weather_code, cloudCover: c.cloud_cover, precipitation: c.precipitation, windSpeed: c.wind_speed_10m };
}

function weatherCategory(code: number) {
  if (code === 45 || code === 48)                             return "fog" as const;
  if (code === 51 || code === 53 || code === 55)              return "drizzle" as const;
  if (code === 61 || code === 63 || code === 80 || code === 81) return "rain" as const;
  if (code === 65 || code === 82)                             return "heavy-rain" as const;
  if (code >= 95)                                             return "storm" as const;
  return "clear" as const;
}

// ─── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
  html, body, #root { margin: 0; padding: 0; background: #01010A !important; min-height: 100%; }

  @property --sky-top    { syntax:'<color>'; inherits:false; initial-value:#01010A; }
  @property --sky-upper  { syntax:'<color>'; inherits:false; initial-value:#04041A; }
  @property --sky-horizon{ syntax:'<color>'; inherits:false; initial-value:#080825; }
  @property --sky-glow   { syntax:'<color>'; inherits:false; initial-value:#100818; }

  .sky-bg {
    background: radial-gradient(ellipse 85% 55% at 50% 100%,
      var(--sky-glow) 0%, var(--sky-horizon) 28%, var(--sky-upper) 62%, var(--sky-top) 100%);
    transition: --sky-top 90s ease, --sky-upper 90s ease, --sky-horizon 90s ease, --sky-glow 90s ease;
  }

  @keyframes twinkle {
    0%,100% { opacity: var(--tw-lo); }
    50%      { opacity: var(--tw-hi); }
  }
  @keyframes fall {
    0%   { transform: translateY(-10vh); opacity: 0; }
    10%  { opacity: 1; }
    90%  { opacity: 0.7; }
    100% { transform: translateY(110vh); opacity: 0; }
  }
  @keyframes flyBird {
    from { transform: translateX(var(--bird-from)); }
    to   { transform: translateX(var(--bird-to)); }
  }
  @keyframes drift {
    0%,100% { transform: translateX(0) translateY(0); opacity: 0; }
    20%,80% { opacity: 1; }
    50%     { transform: translateX(40px) translateY(-15px); opacity: 0.8; }
  }
  @keyframes lightning {
    0%,88%,90%,92%,100% { opacity: 0; }
    89%,91%             { opacity: 0.35; }
  }
`;

// ─── Stars ─────────────────────────────────────────────────────────────────────
const Stars = memo(function Stars({ darkness }: { darkness: number }) {
  const stars = useMemo(() =>
    Array.from({ length: 130 }, (_, i) => ({
      id: i,
      x: `${(Math.random() * 100).toFixed(2)}%`,
      y: `${(Math.random() * 75).toFixed(2)}%`,
      r: (0.5 + Math.random() * 1.5).toFixed(2),
      dur: `${(2 + Math.random() * 4).toFixed(1)}s`,
      del: `${(Math.random() * 5).toFixed(1)}s`,
      lo: (0.1 + Math.random() * 0.3).toFixed(2),
      hi: (0.6 + Math.random() * 0.4).toFixed(2),
    })), []);

  if (darkness < 0.15) return null;
  return (
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
      {stars.map(s => (
        <circle key={s.id} cx={s.x} cy={s.y} r={s.r} fill="white"
          style={{
            opacity: 0,
            animation: `twinkle ${s.dur} ease-in-out ${s.del} infinite`,
            "--tw-lo": `${parseFloat(s.lo) * darkness}`,
            "--tw-hi": `${parseFloat(s.hi) * darkness}`,
          } as React.CSSProperties}
        />
      ))}
    </svg>
  );
});

// ─── Moon ──────────────────────────────────────────────────────────────────────
// Uses SVG mask approach: lit-half rect + terminator ellipse.
// Avoids degenerate SVG arcs at antipodal points (which broke full/gibbous phases).
const MOON_R = 28;
const MOON_PAD = 20;
function Moon({ phase, darkness }: { phase: number; darkness: number }) {
  if (darkness < 0.4) return null;
  const opacity = Math.min((darkness - 0.4) / 0.4, 1);
  const isFull = phase > 0.45 && phase < 0.55;
  const dim = (MOON_R + MOON_PAD) * 2;
  const vb = -MOON_R - MOON_PAD;

  // Phase geometry
  const isWaxing = phase < 0.5;
  const p = isWaxing ? phase * 2 : (phase - 0.5) * 2; // 0→1 within half-cycle
  const ex = MOON_R * Math.cos(p * Math.PI);           // terminator x-radius (signed)
  const aex = Math.max(Math.abs(ex), 0.5);
  // Waxing:  ex>0 = crescent (subtract), ex<0 = gibbous/full (add right)
  // Waning:  ex>0 = full/gibbous (add right half), ex<0 = crescent (subtract left)
  const termAdds = isWaxing ? ex < 0 : ex > 0;

  return (
    <div style={{
      position: "absolute", top: "8%", right: "12%",
      opacity, transition: "opacity 120s ease",
      pointerEvents: "none",
    }}>
      <svg width={dim} height={dim} overflow="visible"
        viewBox={`${vb} ${vb} ${dim} ${dim}`}>
        <defs>
          <mask id="moon-mask" maskUnits="userSpaceOnUse"
            x={-MOON_R} y={-MOON_R} width={MOON_R * 2} height={MOON_R * 2}>
            {/* Lit base: always the correct half */}
            <rect
              x={isWaxing ? 0 : -MOON_R} y={-MOON_R}
              width={MOON_R} height={MOON_R * 2}
              fill="white"
            />
            {/* Terminator ellipse: white=add illumination, black=subtract */}
            <ellipse rx={aex} ry={MOON_R} fill={termAdds ? "white" : "black"} />
          </mask>
        </defs>

        {/* Halo glow for full moon */}
        {isFull && (
          <circle r={MOON_R + 10} fill="none"
            stroke="rgba(255,252,220,0.14)" strokeWidth="9" />
        )}
        {/* Dark backing disc (occludes the sky behind the moon) */}
        <circle r={MOON_R} fill="rgba(4,4,18,0.88)" />
        {/* Illuminated surface, shaped by the phase mask */}
        <circle r={MOON_R} fill="#FFFCE8" opacity="0.94" mask="url(#moon-mask)" />
        {/* Thin rim highlight */}
        {isFull && (
          <circle r={MOON_R} fill="none"
            stroke="rgba(255,252,220,0.22)" strokeWidth="1.5" />
        )}
      </svg>
    </div>
  );
}

// ─── Birds ─────────────────────────────────────────────────────────────────────
function Birds({ paHours, sunrise, sunset }: { paHours: number; sunrise: number; sunset: number }) {
  const flock = useMemo(() =>
    Array.from({ length: 6 }, (_, i) => ({
      id: i,
      y: 10 + Math.random() * 35,
      scale: 0.7 + Math.random() * 0.6,
      dur: `${10 + Math.random() * 8}s`,
      del: `${i * 2.5 + Math.random() * 2}s`,
      oy: (Math.random() - 0.5) * 30,
    })), []);

  const nearDawn = Math.abs(paHours - sunrise) < 1.5;
  const nearDusk = Math.abs(paHours - sunset)  < 1.5;
  if (!nearDawn && !nearDusk) return null;
  const rtl = nearDusk;

  return (
    <>
      {flock.map(b => (
        <div key={b.id} style={{
          position: "absolute", top: `${b.y}%`, left: 0, right: 0,
          pointerEvents: "none",
          animation: `flyBird ${b.dur} linear ${b.del} infinite`,
          "--bird-from": rtl ? "110vw" : "-15vw",
          "--bird-to":   rtl ? "-15vw" : "110vw",
        } as React.CSSProperties}>
          <svg width={28 * b.scale} height={14 * b.scale} viewBox="0 0 28 14"
            style={{ display: "block", transform: `translateY(${b.oy}px)` }}>
            <path
              d={rtl ? "M28 7 C22 3 17 2 14 5 C11 2 6 3 0 7" : "M0 7 C6 3 11 2 14 5 C17 2 22 3 28 7"}
              fill="none" stroke="rgba(20,10,5,0.55)" strokeWidth="1.8" strokeLinecap="round"
            />
          </svg>
        </div>
      ))}
    </>
  );
}

// ─── Rain ──────────────────────────────────────────────────────────────────────
function Rain({ count, heavy }: { count: number; heavy: boolean }) {
  const drops = useMemo(() =>
    Array.from({ length: count }, (_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      delay: `${(Math.random() * 2).toFixed(2)}s`,
      duration: `${(heavy ? 0.35 + Math.random() * 0.25 : 0.65 + Math.random() * 0.4).toFixed(2)}s`,
      height: heavy ? `${14 + Math.random() * 10}px` : `${7 + Math.random() * 6}px`,
    })), [count, heavy]);

  return (
    <>
      {drops.map(d => (
        <div key={d.id} style={{
          position: "absolute", top: 0, left: d.left,
          width: heavy ? 1.5 : 1, height: d.height,
          borderRadius: "9999px",
          background: heavy ? "rgba(180,210,255,0.65)" : "rgba(200,225,255,0.45)",
          animation: `fall ${d.duration} linear ${d.delay} infinite`,
          pointerEvents: "none",
        }} />
      ))}
    </>
  );
}

// ─── Fog ───────────────────────────────────────────────────────────────────────
function Fog() {
  const wisps = useMemo(() =>
    Array.from({ length: 9 }, (_, i) => ({
      id: i,
      left: `${i * 12 - 5}%`, bottom: `${5 + Math.random() * 30}%`,
      w: 300 + Math.random() * 200, h: 90 + Math.random() * 70,
      dur: `${9 + Math.random() * 7}s`, del: `${Math.random() * 6}s`,
    })), []);

  return (
    <>
      {wisps.map(w => (
        <div key={w.id} style={{
          position: "absolute", left: w.left, bottom: w.bottom,
          width: w.w, height: w.h, borderRadius: "50%",
          filter: "blur(40px)", background: "rgba(235,240,255,0.16)",
          animation: `drift ${w.dur} ease-in-out ${w.del} infinite`,
          pointerEvents: "none",
        }} />
      ))}
    </>
  );
}

// ─── Stanford Silhouette ───────────────────────────────────────────────────────
// Use a Canvas to pixel-process the PNG: make white/near-white areas transparent.
// (Kept with the sky machinery; currently unused by either hero.)
export const StanfordSilhouette = memo(function StanfordSilhouette() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);

      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d  = id.data;

      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        // brightness in [0,255]: 255 = pure white
        const br = (r * 299 + g * 587 + b * 114) / 1000;
        // Threshold: above 210 → fade out, 180–210 → partial fade
        if (br >= 210) {
          d[i + 3] = 0;
        } else if (br > 160) {
          d[i + 3] = Math.round(d[i + 3] * (1 - (br - 160) / 50));
        }
      }
      ctx.putImageData(id, 0, 0);
    };
    img.src = "/stanford-building.png";
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute", bottom: 0, left: 0,
        width: "min(680px, 100vw)", height: "auto",
        pointerEvents: "none", display: "block",
        WebkitMaskImage: "linear-gradient(to top, transparent 5%, black 30%)",
        maskImage: "linear-gradient(to top, transparent 5%, black 30%)",
      }}
    />
  );
});

// ─── SkyPage ───────────────────────────────────────────────────────────────────
// Full-viewport live sky with a render-prop hero (receives current darkness
// 0..1) followed by arbitrary below-fold content.
export function SkyPage({
  hero,
  below,
}: {
  hero: (darkness: number) => React.ReactNode;
  below?: React.ReactNode;
}) {
  const [paHours, setPAHours] = useState(getPAHours);
  const [colors, setColors]   = useState(() => interpolateSky(getPAHours()));
  const [sunTimes]            = useState(getSunTimesPA);
  const [moonPhase]           = useState(getMoonPhase);
  const [weather, setWeather] = useState<Weather | null>(null);

  useEffect(() => {
    const tick = () => {
      const h = getPAHours();
      setPAHours(h);
      setColors(interpolateSky(h));
    };
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const loadWeather = useCallback(async () => {
    try { setWeather(await fetchWeather()); } catch { /* silent */ }
  }, []);
  useEffect(() => {
    loadWeather();
    const id = setInterval(loadWeather, 10 * 60_000);
    return () => clearInterval(id);
  }, [loadWeather]);

  const { sunrise, sunset } = sunTimes;
  const darkness  = getDarkness(paHours, sunrise, sunset);
  const category  = weather ? weatherCategory(weather.code) : "clear";
  const rainCount =
    category === "heavy-rain" || category === "storm" ? 200 :
    category === "rain"    ? 110 :
    category === "drizzle" ? 50  : 0;

  return (
    <>
      <style>{CSS}</style>
      <style>{`html, body { overflow-y: auto !important; }`}</style>
      <div
        className="sky-bg"
        style={{
          position: "relative", overflow: "hidden",
          height: "100dvh", minHeight: "100vh", width: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          paddingBottom: "10vh",
          "--sky-top":     colors.top,
          "--sky-upper":   colors.upper,
          "--sky-horizon": colors.horizon,
          "--sky-glow":    colors.glow,
        } as React.CSSProperties}
      >
        <Stars darkness={darkness} />
        <Moon phase={moonPhase} darkness={darkness} />
        <Birds paHours={paHours} sunrise={sunrise} sunset={sunset} />

        {category === "fog" && <Fog />}
        {rainCount > 0 && <Rain count={rainCount} heavy={category === "heavy-rain" || category === "storm"} />}
        {category === "storm" && (
          <div style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            background: "rgba(200,220,255,1)",
            animation: "lightning 6s ease-in-out infinite",
          }} />
        )}

        <div style={{
          position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5,
          background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,0.18) 75%, rgba(0,0,0,0.32) 100%)",
        }} />

        {hero(darkness)}
      </div>
      {below}
    </>
  );
}
