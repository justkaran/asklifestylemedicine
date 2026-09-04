// Astronomical utilities for Palo Alto

const PA_LAT = 37.4419;
const PA_LON = -122.143;

function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date.getTime() - start.getTime()) / 86400000);
}

function getPATZOffsetHours(): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(new Date());
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-7";
  const m = tz.match(/GMT([+-]\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : -7;
}

export function getSunTimesPA(): { sunrise: number; sunset: number } {
  const now = new Date();
  const doy = getDayOfYear(now);
  const declRad =
    (23.45 * Math.sin(((360 / 365) * (doy - 81) * Math.PI) / 180) * Math.PI) /
    180;
  const latRad = (PA_LAT * Math.PI) / 180;
  const cosH =
    (Math.sin((-0.8333 * Math.PI) / 180) -
      Math.sin(latRad) * Math.sin(declRad)) /
    (Math.cos(latRad) * Math.cos(declRad));
  const H = (Math.acos(Math.max(-1, Math.min(1, cosH))) * 180) / Math.PI / 15;
  const solarNoonUTC = 12 - PA_LON / 15;
  const tz = getPATZOffsetHours();
  return {
    sunrise: ((solarNoonUTC - H + tz + 48) % 24),
    sunset: ((solarNoonUTC + H + tz + 48) % 24),
  };
}

/** 0 = new moon, 0.5 = full, 1 = back to new */
export function getMoonPhase(): number {
  const EPOCH = new Date("2000-01-06T18:14:00Z").getTime();
  const SYNODIC_MS = 29.53058867 * 24 * 60 * 60 * 1000;
  return ((Date.now() - EPOCH) % SYNODIC_MS) / SYNODIC_MS;
}

/** SVG path for the illuminated portion of the moon, centered at origin, radius r */
export function moonSVGPath(phase: number, r: number): string {
  if (phase < 0.02 || phase > 0.98) return ""; // new moon — dark
  const isWaxing = phase < 0.5;
  const p = isWaxing ? phase * 2 : (phase - 0.5) * 2; // 0→1 within half-cycle
  const ex = r * Math.cos(p * Math.PI); // terminator ellipse x-radius (signed)
  const aex = Math.max(Math.abs(ex), 0.5);
  if (isWaxing) {
    const st = ex > 0 ? 1 : 0;
    return `M 0 ${-r} A ${r} ${r} 0 0 1 0 ${r} A ${aex} ${r} 0 0 ${st} 0 ${-r} Z`;
  } else {
    const st = ex < 0 ? 1 : 0;
    return `M 0 ${-r} A ${r} ${r} 0 0 0 0 ${r} A ${aex} ${r} 0 0 ${st} 0 ${-r} Z`;
  }
}

export type Season = "spring" | "summer" | "autumn" | "winter";

export function getSeason(): Season {
  const now = new Date();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  if ((m === 3 && d >= 20) || m === 4 || m === 5 || (m === 6 && d < 21))
    return "spring";
  if ((m === 6 && d >= 21) || m === 7 || m === 8 || (m === 9 && d < 23))
    return "summer";
  if ((m === 9 && d >= 23) || m === 10 || m === 11 || (m === 12 && d < 21))
    return "autumn";
  return "winter";
}

/** 0 = full daylight, 1 = full night */
export function getDarkness(
  paHours: number,
  sunrise: number,
  sunset: number
): number {
  const twi = 1.2;
  const inDay = paHours >= sunrise && paHours <= sunset;
  if (inDay) {
    const fromRise = paHours - sunrise;
    const toSet = sunset - paHours;
    return 1 - Math.min(Math.min(fromRise, toSet) / twi, 1);
  }
  const pastSet =
    paHours > sunset ? paHours - sunset : paHours + 24 - sunset;
  const toRise =
    paHours < sunrise ? sunrise - paHours : sunrise + 24 - paHours;
  return Math.min(Math.min(pastSet, toRise) / twi, 1);
}
