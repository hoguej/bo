import OpenAI from "openai";
import { getTomorrowForecastFromZip } from "./weather-gov";

function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function extractZip(msg: string): string | null {
  const m = msg.match(/\b(\d{5})\b/);
  return m ? m[1]! : null;
}

async function main() {
  const msg = process.argv.slice(2).join(" ").trim();
  if (!msg) {
    console.error("Usage: bun run scripts/weather-agent.ts \"what's the weather for 43130\"");
    process.exit(1);
  }

  const zip =
    extractZip(msg) ??
    getEnv("BO_DEFAULT_ZIP") ??
    getEnv("BO_ZIP") ??
    getEnv("HOME_ZIP");
  if (!zip) {
    process.stdout.write("What ZIP code should I use? (You can set BO_DEFAULT_ZIP to avoid this.)");
    return;
  }

  const apiKey = getEnv("AI_GATEWAY_API_KEY") ?? getEnv("VERCEL_OIDC_TOKEN");
  if (!apiKey) {
    console.error("Missing AI Gateway auth. Set AI_GATEWAY_API_KEY (recommended) or VERCEL_OIDC_TOKEN.");
    process.exit(1);
  }

  const model = getEnv("BO_LLM_MODEL") ?? "openai/gpt-4.1";
  const openai = new OpenAI({
    apiKey,
    baseURL: "https://ai-gateway.vercel.sh/v1",
  });

  const wx = await getTomorrowForecastFromZip(zip);

  const userPrompt = [
    `User asked: ${msg}`,
    "",
    "You are given a National Weather Service forecast snapshot. Produce a concise 1–2 sentence reply about TOMORROW.",
    "Output format:",
    "Tomorrow (<location>): <short summary>. High <high>°F / Low <low>°F. Wind: <wind>. Precip: <chance or 'N/A'>.",
    "",
    "Forecast snapshot:",
    `Location: ${wx.locationLabel ?? "N/A"}`,
    `Source: ${wx.sourceUrl}`,
    `Tomorrow period: ${wx.tomorrowName ?? "N/A"}`,
    `Tomorrow text: ${wx.rawTomorrowText ?? "N/A"}`,
    `Tomorrow Night text: ${wx.rawTomorrowNightText ?? "N/A"}`,
    `Parsed high: ${wx.tomorrowHighF ?? "N/A"}`,
    `Parsed low: ${wx.tomorrowNightLowF ?? "N/A"}`,
    `Parsed wind: ${wx.tomorrowWind ?? "N/A"}`,
    `Parsed precip %: ${wx.tomorrowPrecipChancePct ?? "N/A"}`,
  ].join("\n");

  const completion = await openai.chat.completions.create({
    model,
    messages: [{ role: "user", content: userPrompt }],
    stream: false,
    temperature: 0.2,
  });

  const content = completion.choices[0]?.message?.content?.trim();
  if (!content) {
    console.error("No content returned from model.");
    process.exit(1);
  }
  process.stdout.write(content);
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});

