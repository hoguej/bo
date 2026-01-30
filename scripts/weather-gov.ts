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

const USER_AGENT = "bo/0.1 (+https://github.com/hoguej/bo)";

/** Timezone for display (today/tomorrow/sunrise-sunset). BO_DEFAULT_TZ or BO_TZ, fallback America/New_York. */
function getDefaultTz(): string {
  const tz = process.env.BO_DEFAULT_TZ ?? process.env.BO_TZ ?? "";
  return tz.trim() || "America/New_York";
}

/** Resolve US ZIP to lat/lon via zippopotam.us (no key). */
export async function getLatLonFromZip(zip: string): Promise<{ lat: number; lon: number; placeName?: string }> {
  const cleanZip = zip.trim().slice(0, 5);
  const res = await fetch(`https://api.zippopotam.us/us/${cleanZip}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`ZIP lookup failed: ${res.status}`);
  const data = (await res.json()) as { places?: Array<{ latitude: string; longitude: string; "place name"?: string }> };
  const place = data.places?.[0];
  if (!place) throw new Error(`No place found for ZIP ${zip}`);
  return {
    lat: Number.parseFloat(place.latitude),
    lon: Number.parseFloat(place.longitude),
    placeName: place["place name"],
  };
}

/** NWS points API: get grid forecast and hourly URLs from lat/lon. */
async function getPoints(lat: number, lon: number): Promise<{
  forecastUrl: string;
  forecastHourlyUrl: string;
  relativeLocation?: { properties?: { city?: string; state?: string } };
}> {
  const res = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`NWS points failed: ${res.status}`);
  const data = (await res.json()) as {
    properties?: {
      forecast?: string;
      forecastHourly?: string;
      relativeLocation?: { properties?: { city?: string; state?: string } };
    };
  };
  const props = data.properties;
  if (!props?.forecast || !props?.forecastHourly) throw new Error("NWS points missing forecast URLs");
  return {
    forecastUrl: props.forecast,
    forecastHourlyUrl: props.forecastHourly,
    relativeLocation: props.relativeLocation,
  };
}

export interface DailyPeriod {
  name: string;
  startTime: string;
  endTime: string;
  tempF: number | null;
  tempUnit: string;
  shortForecast: string;
  detailedForecast: string;
  isDaytime: boolean;
  windSpeed?: string;
  windDirection?: string;
  probabilityOfPrecipitation?: number | null;
}

/** Daily forecast periods (Today, Tonight, Thu, Thu Night, ...) from NWS grid. */
export async function getDailyForecastFromZip(zip: string): Promise<{
  locationLabel: string;
  periods: DailyPeriod[];
}> {
  const { lat, lon, placeName } = await getLatLonFromZip(zip);
  const { forecastUrl, relativeLocation } = await getPoints(lat, lon);
  const res = await fetch(forecastUrl, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`NWS forecast failed: ${res.status}`);
  const data = (await res.json()) as { properties?: { periods?: Array<{
    name: string;
    startTime: string;
    endTime: string;
    temperature: number;
    temperatureUnit: string;
    shortForecast: string;
    detailedForecast: string;
    isDaytime: boolean;
    windSpeed?: string;
    windDirection?: string;
    probabilityOfPrecipitation?: { value: number | null };
  }> } };
  const rawPeriods = data.properties?.periods ?? [];
  const city = relativeLocation?.properties?.city ?? placeName ?? zip;
  const state = relativeLocation?.properties?.state ?? "";
  const locationLabel = state ? `${city}, ${state}` : city;
  const periods: DailyPeriod[] = rawPeriods.map((p) => ({
    name: p.name,
    startTime: p.startTime,
    endTime: p.endTime,
    tempF: p.temperature ?? null,
    tempUnit: p.temperatureUnit ?? "F",
    shortForecast: p.shortForecast ?? "",
    detailedForecast: p.detailedForecast ?? "",
    isDaytime: p.isDaytime ?? true,
    windSpeed: p.windSpeed,
    windDirection: p.windDirection,
    probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value ?? null,
  }));
  return { locationLabel, periods };
}

export interface HourlyPeriod {
  startTime: string;
  tempF: number | null;
  precipChance: number | null;
  shortForecast: string;
  isDaytime: boolean;
}

/** Hourly forecast for next ~48–72 hours from NWS. */
export async function getHourlyForecastFromZip(zip: string): Promise<{
  locationLabel: string;
  periods: HourlyPeriod[];
}> {
  const { lat, lon, placeName } = await getLatLonFromZip(zip);
  const { forecastHourlyUrl, relativeLocation } = await getPoints(lat, lon);
  const res = await fetch(forecastHourlyUrl, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`NWS hourly failed: ${res.status}`);
  const data = (await res.json()) as { properties?: { periods?: Array<{
    startTime: string;
    temperature: number;
    probabilityOfPrecipitation?: { value: number | null };
    shortForecast: string;
    isDaytime: boolean;
  }> } };
  const rawPeriods = data.properties?.periods ?? [];
  const city = relativeLocation?.properties?.city ?? placeName ?? zip;
  const periods: HourlyPeriod[] = rawPeriods.map((p) => ({
    startTime: p.startTime,
    tempF: p.temperature ?? null,
    precipChance: p.probabilityOfPrecipitation?.value ?? null,
    shortForecast: p.shortForecast ?? "",
    isDaytime: p.isDaytime ?? true,
  }));
  return { locationLabel: city, periods };
}

/** Sunrise/sunset for a date (default today) at lat/lon. Uses sunrise-sunset.org (no key). */
export async function getSunriseSunsetFromZip(
  zip: string,
  date?: string
): Promise<{ sunrise: string; sunset: string; date: string; locationLabel: string }> {
  const { lat, lon, placeName } = await getLatLonFromZip(zip);
  const dateStr = date ?? new Date().toISOString().slice(0, 10);
  const res = await fetch(
    `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&date=${dateStr}&formatted=0`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`Sunrise-sunset request failed: ${res.status}`);
  const data = (await res.json()) as { status?: string; results?: { sunrise: string; sunset: string } };
  if (data.status !== "OK" || !data.results) throw new Error("Sunrise-sunset API error");
  const tz = getDefaultTz();
  const toLocalTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
  };
  return {
    sunrise: toLocalTime(data.results.sunrise),
    sunset: toLocalTime(data.results.sunset),
    date: dateStr,
    locationLabel: placeName ?? zip,
  };
}

export async function getTomorrowForecastFromZip(zip: string): Promise<TomorrowForecast> {
  const cleanZip = zip.trim();
  const sourceUrl = `https://forecast.weather.gov/zipcity.php?inputstring=${encodeURIComponent(cleanZip)}`;
  const res = await fetch(sourceUrl, { headers: { "User-Agent": USER_AGENT } });
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

