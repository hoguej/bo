import { dbGetConfig } from "../../src/db";
import {
  getDailyForecastFromZip,
  getHourlyForecastFromZip,
  getSunriseSunsetFromZip,
  getTomorrowForecastFromZip,
} from "../weather-gov";

type Input = {
  location?: string;
  intent?:
    | "summary"
    | "rain_timing"
    | "sunrise_sunset"
    | "above_freezing"
    | "at_time";
  day?: string;
  time?: string;
  date?: string;
};

function readJsonStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    process.stdin.on("error", reject);
  });
}

function extractZip(s?: string): string | null {
  if (!s) return null;
  const m = s.match(/\b(\d{5})\b/);
  return m ? m[1]! : null;
}

function normalizeDay(day?: string): "today" | "tomorrow" | string | null {
  if (!day || !day.trim()) return null;
  const d = day.trim().toLowerCase();
  if (d === "today") return "today";
  if (d === "tomorrow") return "tomorrow";
  return d;
}

/** Timezone for all date/time display and "today"/"tomorrow" logic. BO_DEFAULT_TZ or BO_TZ, fallback America/New_York. */
function getDefaultTz(): string {
  const tz = process.env.BO_DEFAULT_TZ ?? process.env.BO_TZ ?? "";
  return tz.trim() || "America/New_York";
}

/** Parse "tomorrow,saturday" or "tomorrow and saturday" into ["tomorrow", "saturday"]. Single day returns [day]. */
function parseDays(day?: string | null): string[] {
  if (!day || !day.trim()) return [];
  const raw = day.trim().toLowerCase();
  const parts = raw.split(/\s+and\s+|,/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  if (parts.length === 1) return [parts[0]!];
  return parts;
}

/** Match NWS period name (e.g. "Thursday", "Thu", "Thursday Night") to user day. */
function periodMatchesDay(periodName: string, day: string): boolean {
  const p = periodName.toLowerCase();
  const want = day.toLowerCase();
  if (want === "today") return p === "today";
  if (want === "tonight") return p === "tonight";
  if (want === "tomorrow") return p === "tomorrow" || p === "tomorrow night";
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const short = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  for (let i = 0; i < dayNames.length; i++) {
    if (want === dayNames[i] || want === short[i]) {
      return p.startsWith(short[i]!) || p.startsWith(dayNames[i]!);
    }
  }
  return p.includes(want);
}

/** Parse "5pm", "17:00", "5 pm" into hour (0-23). */
function parseTimeToHour(timeStr?: string): number | null {
  if (!timeStr || !timeStr.trim()) return null;
  const s = timeStr.trim();
  const pm = /\b(\d{1,2})\s*:?\s*(\d{2})?\s*pm\b/i.test(s) || /\b(\d{1,2})\s*pm\b/i.test(s);
  const am = /\b(\d{1,2})\s*:?\s*(\d{2})?\s*am\b/i.test(s) || /\b(\d{1,2})\s*am\b/i.test(s);
  let m = s.match(/\b(\d{1,2})\s*:?\s*(\d{2})?\s*(am|pm)?\b/i);
  if (!m) return null;
  let hour = parseInt(m[1]!, 10);
  if (pm && hour !== 12) hour += 12;
  if (am && hour === 12) hour = 0;
  if (!am && !pm && hour < 7) hour += 12;
  return Math.min(23, Math.max(0, hour));
}

function formatHourlyTime(iso: string, tz?: string): string {
  const d = new Date(iso);
  const timeZone = tz ?? getDefaultTz();
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone });
}

function formatHourlyDate(iso: string, tz?: string): string {
  const d = new Date(iso);
  const timeZone = tz ?? getDefaultTz();
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone });
  const tomorrowStr = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone });
  const periodDateStr = d.toLocaleDateString("en-CA", { timeZone });
  if (periodDateStr === todayStr) return "today";
  if (periodDateStr === tomorrowStr) return "tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "short", timeZone });
}

async function main() {
  const input = (await readJsonStdin()) as Input;
  const zip =
    extractZip(input.location) ??
    dbGetConfig("default_zip") ??
    process.env.BO_DEFAULT_ZIP ??
    process.env.BO_ZIP ??
    process.env.HOME_ZIP;
  if (!zip) {
    console.error(
      'Missing location. Provide {"location":"43130"} or {"location":"Columbus 43130"} or set config default_zip or BO_DEFAULT_ZIP.'
    );
    process.exit(1);
  }

  const intent = (input.intent ?? "summary").toLowerCase();
  const day = normalizeDay(input.day);
  const timeStr = input.time?.trim();
  const dateStr = input.date?.trim();

  if (intent === "sunrise_sunset") {
    const ss = await getSunriseSunsetFromZip(zip, dateStr || undefined);
    process.stdout.write(
      `${ss.locationLabel} on ${ss.date}: Sunrise ${ss.sunrise}, Sunset ${ss.sunset}.`
    );
    return;
  }

  const tz = getDefaultTz();

  if (intent === "rain_timing") {
    const { locationLabel, periods } = await getHourlyForecastFromZip(zip);
    const rainPeriods = periods.filter((p) => (p.precipChance ?? 0) > 20);
    if (rainPeriods.length === 0) {
      process.stdout.write(
        `No significant rain in the forecast for ${locationLabel} over the next couple of days.`
      );
      return;
    }
    const first = rainPeriods[0]!;
    const times = rainPeriods
      .slice(0, 5)
      .map((p) => `${formatHourlyDate(p.startTime, tz)} ${formatHourlyTime(p.startTime, tz)} (${p.precipChance}% chance)`)
      .join("; ");
    process.stdout.write(
      `Rain possible for ${locationLabel}: ${times}. First chance ${formatHourlyDate(first.startTime, tz)} around ${formatHourlyTime(first.startTime, tz)} (${first.precipChance}% chance).`
    );
    return;
  }

  if (intent === "above_freezing") {
    const { locationLabel, periods } = await getHourlyForecastFromZip(zip);
    const above = periods.find((p) => (p.tempF ?? 0) > 32);
    if (!above) {
      process.stdout.write(
        `Forecast for ${locationLabel} doesn't show temps above freezing in the next couple of days.`
      );
      return;
    }
    process.stdout.write(
      `Above freezing again ${formatHourlyDate(above.startTime, tz)} around ${formatHourlyTime(above.startTime, tz)} (${above.tempF}°F) in ${locationLabel}.`
    );
    return;
  }

  if (intent === "at_time" && timeStr) {
    const targetHour = parseTimeToHour(timeStr);
    if (targetHour == null) {
      process.stdout.write("Could not parse time. Try e.g. \"5pm\" or \"17:00\".");
      process.exit(1);
    }
    const tz = getDefaultTz();
    const { locationLabel, periods } = await getHourlyForecastFromZip(zip);
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const tomorrowStr = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: tz });
    const wantDateStr = day === "tomorrow" ? tomorrowStr : todayStr;
    let best: (typeof periods)[0] | null = null;
    let bestHourDiff = Infinity;
    for (const p of periods) {
      const d = new Date(p.startTime);
      const periodDateStr = d.toLocaleDateString("en-CA", { timeZone: tz });
      if (periodDateStr !== wantDateStr) continue;
      const periodHour = parseInt(d.toLocaleTimeString("en-US", { hour: "2-digit", hour12: false, timeZone: tz }), 10);
      const hourDiff = Math.abs(periodHour - targetHour);
      if (hourDiff < bestHourDiff) {
        bestHourDiff = hourDiff;
        best = p;
      }
    }
    if (!best) {
      process.stdout.write("No hourly data for that time.");
      process.exit(1);
    }
    const temp = best.tempF != null ? `${best.tempF}°F` : "N/A";
    const precip = best.precipChance != null ? `${best.precipChance}%` : "N/A";
    process.stdout.write(
      `${locationLabel} around ${timeStr} (${formatHourlyDate(best.startTime, tz)}): ${best.shortForecast}. Temp ${temp}, precip chance ${precip}.`
    );
    return;
  }

  if (intent === "summary" || !intent) {
    const parsed = parseDays(day);
    const dayKeys = parsed.length ? parsed : ["tomorrow"];
    const parts: string[] = [];
    for (const dayKey of dayKeys) {
      if (dayKey === "tomorrow") {
        const wx = await getTomorrowForecastFromZip(zip);
        const loc = wx.locationLabel ?? zip;
        const summary = wx.rawTomorrowText ?? "N/A";
        const high = wx.tomorrowHighF != null ? `${wx.tomorrowHighF}°F` : "N/A";
        const low = wx.tomorrowNightLowF != null ? `${wx.tomorrowNightLowF}°F` : "N/A";
        const wind = wx.tomorrowWind ?? "N/A";
        const precip = wx.tomorrowPrecipChancePct != null ? `${wx.tomorrowPrecipChancePct}%` : "N/A";
        parts.push(`Tomorrow (${loc}): ${summary} High ${high} / Low ${low}. Wind: ${wind} Precip: ${precip}.`);
        continue;
      }
      const { locationLabel, periods } = await getDailyForecastFromZip(zip);
      let period = periods.find((p) => periodMatchesDay(p.name, dayKey));
      if (!period && dayKey === "today") period = periods[0] ?? null;
      if (!period) {
        const names = periods.slice(0, 6).map((p) => p.name).join(", ");
        parts.push(`No period matched "${dayKey}" for ${locationLabel}. Available: ${names}.`);
        continue;
      }
      const temp = period.tempF != null ? `${period.tempF}°F` : "N/A";
      const precip =
        period.probabilityOfPrecipitation != null
          ? `${period.probabilityOfPrecipitation}%`
          : "N/A";
      parts.push(
        `${period.name} (${locationLabel}): ${period.shortForecast} Temp ${temp}, precip chance ${precip}. ${period.detailedForecast.slice(0, 200)}.`
      );
    }
    process.stdout.write(parts.join("\n\n"));
  }
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
