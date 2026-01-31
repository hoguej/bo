/**
 * Content Moderation & Red Flag Detection
 * 
 * - Post-response moderation (PG filter)
 * - Pre-processing red flag detection (self-harm, violence)
 */

import OpenAI from "openai";
import { dbLogModerationFlag } from "./db-pg";

const openai = new OpenAI({
  apiKey: process.env.AI_GATEWAY_API_KEY || process.env.OPENAI_API_KEY,
});

export interface ModerationResult {
  safe: boolean;
  flags: Record<string, any>;
  reason?: string;
}

/**
 * Check content for inappropriate material (post-response)
 */
export async function moderateContent(content: string): Promise<ModerationResult> {
  try {
    const response = await openai.moderations.create({
      input: content,
    });

    const result = response.results[0];
    const flagged = result.flagged;

    if (!flagged) {
      return { safe: true, flags: {} };
    }

    // Extract flagged categories
    const flags: Record<string, any> = {};
    const categories = result.categories;
    
    for (const [category, isFlagged] of Object.entries(categories)) {
      if (isFlagged) {
        flags[category] = true;
      }
    }

    return {
      safe: false,
      flags,
      reason: `Content flagged for: ${Object.keys(flags).join(', ')}`,
    };
  } catch (error) {
    console.error('[Moderation Error]', error);
    // Fail open: allow content if moderation API fails
    return { safe: true, flags: {} };
  }
}

/**
 * Red flag keywords for self-harm, violence, crisis
 */
const RED_FLAG_KEYWORDS = [
  // Self-harm
  'kill myself',
  'end my life',
  'suicide',
  'suicidal',
  'want to die',
  'better off dead',
  'hurt myself',
  'self harm',
  'cut myself',
  
  // Violence
  'kill someone',
  'murder',
  'shoot up',
  'bomb',
  'terrorist',
  'mass shooting',
  
  // Crisis
  'overdose',
  'pills',
  'jump off',
];

/**
 * Detect red flags in user input (pre-processing)
 */
export async function detectRedFlags(userMessage: string): Promise<{
  hasRedFlags: boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  keywords: string[];
}> {
  const lowerMessage = userMessage.toLowerCase();
  const foundKeywords: string[] = [];

  for (const keyword of RED_FLAG_KEYWORDS) {
    if (lowerMessage.includes(keyword)) {
      foundKeywords.push(keyword);
    }
  }

  if (foundKeywords.length === 0) {
    return { hasRedFlags: false, severity: 'low', keywords: [] };
  }

  // Determine severity based on keywords
  const criticalKeywords = ['kill myself', 'end my life', 'suicide', 'overdose'];
  const highKeywords = ['want to die', 'better off dead', 'hurt myself'];
  
  let severity: 'low' | 'medium' | 'high' | 'critical' = 'medium';
  
  if (foundKeywords.some(k => criticalKeywords.includes(k))) {
    severity = 'critical';
  } else if (foundKeywords.some(k => highKeywords.includes(k))) {
    severity = 'high';
  }

  return {
    hasRedFlags: true,
    severity,
    keywords: foundKeywords,
  };
}

/**
 * Generate personality-appropriate moderation excuse
 */
export async function generateModerationExcuse(userId: number, familyId: number): Promise<string> {
  // TODO: Load user personality and generate custom excuse
  // For now, use a default
  return "We're trying to keep things PG around here. Let's talk about something else!";
}

/**
 * Handle content moderation workflow
 */
export async function handleModeration(
  response: string,
  userId: number,
  familyId: number,
  userMessage: string
): Promise<{ finalResponse: string; wasModerated: boolean }> {
  const moderation = await moderateContent(response);

  if (moderation.safe) {
    return { finalResponse: response, wasModerated: false };
  }

  // Log violation
  const excuse = await generateModerationExcuse(userId, familyId);
  
  await dbLogModerationFlag({
    userId,
    familyId,
    message: userMessage,
    originalResponse: response,
    replacementResponse: excuse,
    flags: moderation.flags,
    action: 'replaced',
  });

  return { finalResponse: excuse, wasModerated: true };
}

/**
 * Handle red flag detection workflow
 */
export async function handleRedFlags(
  userMessage: string,
  userId: number,
  familyId: number,
  systemAdminId: number
): Promise<{ shouldContinue: boolean; response?: string }> {
  const detection = await detectRedFlags(userMessage);

  if (!detection.hasRedFlags) {
    return { shouldContinue: true };
  }

  // Log red flag
  await dbLogModerationFlag({
    userId,
    familyId,
    message: userMessage,
    flags: {
      red_flags: detection.keywords,
      severity: detection.severity,
    },
    action: 'flagged',
  });

  // For critical severity, provide crisis resources
  if (detection.severity === 'critical') {
    const crisisResponse = `I'm really concerned about what you just said. If you're in crisis, please reach out to someone who can help:

• National Suicide Prevention Lifeline: 988 (call or text)
• Crisis Text Line: Text HOME to 741741
• International: https://findahelpline.com

I care about you and want you to be safe. Please talk to someone right away.`;

    // Notify system admin (you)
    // TODO: Send Telegram notification to system admin
    console.error(`[RED FLAG - CRITICAL] User ${userId} in family ${familyId}: "${userMessage}"`);

    return { shouldContinue: false, response: crisisResponse };
  }

  // For high severity, express concern but continue
  if (detection.severity === 'high') {
    console.warn(`[RED FLAG - HIGH] User ${userId} in family ${familyId}: "${userMessage}"`);
    // Could add supportive prefix to response
  }

  // For medium/low, just log and continue
  return { shouldContinue: true };
}
