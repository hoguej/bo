import { getTomorrowForecastFromZip } from "../weather-gov";

type Input = { zip?: string };

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

async function main() {
  const input = (await readJsonStdin()) as Input;
  const zip = extractZip(input.zip) ?? process.env.BO_DEFAULT_ZIP ?? process.env.BO_ZIP ?? process.env.HOME_ZIP;
  if (!zip) {
    console.error("Missing zip. Provide {\"zip\":\"43130\"} or set BO_DEFAULT_ZIP.");
    process.exit(1);
  }

  const wx = await getTomorrowForecastFromZip(zip);
  const loc = wx.locationLabel ?? zip;
  const summary = wx.rawTomorrowText ?? "N/A";
  const high = wx.tomorrowHighF != null ? `${wx.tomorrowHighF}°F` : "N/A";
  const low = wx.tomorrowNightLowF != null ? `${wx.tomorrowNightLowF}°F` : "N/A";
  const wind = wx.tomorrowWind ?? "N/A";
  const precip = wx.tomorrowPrecipChancePct != null ? `${wx.tomorrowPrecipChancePct}%` : "N/A";

  process.stdout.write(`Tomorrow (${loc}): ${summary} High ${high} / Low ${low}. Wind: ${wind} Precip: ${precip}.`);
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});

