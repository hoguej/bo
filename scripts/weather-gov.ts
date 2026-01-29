export interface TomorrowForecast {
  zip: string;
  locationLabel: string | null;
  tomorrowName: string | null;
  tomorrowSummary: string | null;
  tomorrowHighF: number | null;
  tomorrowWind: string | null;
  tomorrowPrecipChancePct: number | null;
  tomorrowNightLowF: number | null;
  rawTomorrowText: string | null;
  rawTomorrowNightText: string | null;
  sourceUrl: string;
}

function htmlToText(html: string): string {
  return (
    html
      // normalize newlines
      .replace(/\r\n/g, "\n")
      // add line breaks for common block separators
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/p\s*>/gi, "\n")
      .replace(/<\s*\/h\d\s*>/gi, "\n")
      .replace(/<\s*\/div\s*>/gi, "\n")
      .replace(/<\s*\/li\s*>/gi, "\n")
      // strip tags
      .replace(/<[^>]+>/g, " ")
      // decode a few entities we care about
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&deg;/g, "°")
      .replace(/&#176;/g, "°")
      // collapse whitespace
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

type Period = { name: string; text: string };

function extractDetailedForecast(text: string): Period[] {
  const idx = text.indexOf("Detailed Forecast");
  if (idx === -1) return [];
  const after = text.slice(idx);
  const lines = after
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Find the first period header after "Detailed Forecast"
  const periods: Period[] = [];
  let i = 0;
  while (i < lines.length && lines[i] !== "Detailed Forecast") i++;
  if (i < lines.length && lines[i] === "Detailed Forecast") i++;

  const isHeader = (s: string) =>
    s.length <= 30 &&
    !/[.?!:]$/.test(s) &&
    !/^\d/.test(s) &&
    !s.includes("%") &&
    !s.includes("°") &&
    !s.toLowerCase().includes("forecast");

  while (i < lines.length) {
    const name = lines[i];
    if (!isHeader(name)) {
      i++;
      continue;
    }
    i++;
    const parts: string[] = [];
    while (i < lines.length && !isHeader(lines[i])) {
      parts.push(lines[i]);
      i++;
    }
    const textBlock = parts.join(" ").trim();
    if (textBlock) periods.push({ name, text: textBlock });
  }

  return periods;
}

function pickTomorrow(periods: Period[]): { tomorrow: Period | null; tomorrowNight: Period | null } {
  if (periods.length === 0) return { tomorrow: null, tomorrowNight: null };
  const first = periods[0].name.toLowerCase();

  // Common ordering:
  // - Today, Tonight, Thu, Thu Night...
  // - Tonight, Thu, Thu Night...
  let tomorrowIdx = 1;
  if (first === "today") tomorrowIdx = 2;
  if (first === "tonight") tomorrowIdx = 1;

  const tomorrow = periods[tomorrowIdx] ?? null;
  const tomorrowNight = periods[tomorrowIdx + 1] ?? null;
  return { tomorrow, tomorrowNight };
}

function parseHighF(text: string): number | null {
  const m = text.match(/\bhigh near (-?\d+)\b/i) ?? text.match(/\bHigh:\s*(-?\d+)\s*°?F\b/i);
  if (!m) return null;
  return Number.parseInt(m[1]!, 10);
}

function parseLowF(text: string): number | null {
  const m = text.match(/\blow around (-?\d+)\b/i) ?? text.match(/\bLow:\s*(-?\d+)\s*°?F\b/i);
  if (!m) return null;
  return Number.parseInt(m[1]!, 10);
}

function parsePrecipPct(text: string): number | null {
  const m = text.match(/Chance of precipitation is (\d+)%/i);
  if (!m) return null;
  return Number.parseInt(m[1]!, 10);
}

function parseWind(text: string): string | null {
  // grab first sentence containing "wind"
  const sentences = text.split(".").map((s) => s.trim());
  const windSentence =
    // prefer real wind sentences
    sentences.find((s) => /\bwind\b/i.test(s) && /\bmph\b/i.test(s)) ??
    sentences.find((s) => /\bwind\b/i.test(s) && /\b(north|south|east|west|calm)\b/i.test(s)) ??
    // fallback
    sentences.find((s) => /\bwind\b/i.test(s));
  return windSentence ? windSentence + "." : null;
}

function parseLocationLabel(text: string): string | null {
  const m = text.match(/\bExtended Forecast for\s+([A-Za-z0-9 ,.'/-]+)\b/i);
  if (m) return m[1]!.trim();
  return null;
}

export async function getTomorrowForecastFromZip(zip: string): Promise<TomorrowForecast> {
  const cleanZip = zip.trim();
  const sourceUrl = `https://forecast.weather.gov/zipcity.php?inputstring=${encodeURIComponent(cleanZip)}`;
  const res = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "bo/0.1 (+https://github.com/hoguej/bo)",
    },
  });
  if (!res.ok) {
    throw new Error(`weather.gov request failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const text = htmlToText(html);

  const locationLabel = parseLocationLabel(text);
  const periods = extractDetailedForecast(text);
  const { tomorrow, tomorrowNight } = pickTomorrow(periods);

  const tomorrowHighF = tomorrow ? parseHighF(tomorrow.text) : null;
  const tomorrowPrecipChancePct = tomorrow ? parsePrecipPct(tomorrow.text) : null;
  const tomorrowWind = tomorrow ? parseWind(tomorrow.text) : null;
  const tomorrowNightLowF = tomorrowNight ? parseLowF(tomorrowNight.text) : null;

  return {
    zip: cleanZip,
    locationLabel,
    tomorrowName: tomorrow?.name ?? null,
    tomorrowSummary: tomorrow?.text ?? null,
    tomorrowHighF,
    tomorrowWind,
    tomorrowPrecipChancePct,
    tomorrowNightLowF,
    rawTomorrowText: tomorrow?.text ?? null,
    rawTomorrowNightText: tomorrowNight?.text ?? null,
    sourceUrl,
  };
}

// CLI usage: bun run scripts/weather-gov.ts 43130
if (import.meta.main) {
  const zip = process.argv[2];
  if (!zip) {
    console.error("Usage: bun run scripts/weather-gov.ts <ZIP>");
    process.exit(1);
  }
  getTomorrowForecastFromZip(zip)
    .then((out) => {
      console.log(JSON.stringify(out, null, 2));
    })
    .catch((err) => {
      console.error(err?.message ?? String(err));
      process.exit(1);
    });
}

