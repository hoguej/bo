import OpenAI from "openai";
import { formatFactsForPrompt, getRelevantFacts } from "../src/memory";

function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

async function main() {
  const apiKey = getEnv("AI_GATEWAY_API_KEY") ?? getEnv("VERCEL_OIDC_TOKEN");
  if (!apiKey) {
    console.error("Missing AI Gateway auth. Set AI_GATEWAY_API_KEY (recommended) or VERCEL_OIDC_TOKEN.");
    process.exit(1);
  }

  const model = getEnv("BO_LLM_MODEL") ?? "openai/gpt-4.1";

  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error("Usage: bun run scripts/gateway-chat.ts \"your prompt here\"");
    process.exit(1);
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: "https://ai-gateway.vercel.sh/v1",
  });

  const facts = getRelevantFacts(prompt, { max: 10 });
  const factsBlock = formatFactsForPrompt(facts);

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      ...(factsBlock
        ? [
            {
              role: "system" as const,
              content: factsBlock,
            },
          ]
        : []),
      {
        role: "user",
        content: prompt,
      },
    ],
    stream: false,
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

