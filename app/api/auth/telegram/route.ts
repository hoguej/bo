import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';

/**
 * Telegram OAuth Authentication
 * Validates Telegram login widget data and creates session
 */

interface TelegramAuthData {
  id: string;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
}

interface SessionData {
  userId?: number;
  telegramId?: string;
  firstName?: string;
  lastName?: string;
  isSystemAdmin?: boolean;
}

/**
 * Verify Telegram auth data
 * https://core.telegram.org/widgets/login#checking-authorization
 */
function verifyTelegramAuth(data: TelegramAuthData, botToken: string): boolean {
  const { hash, ...fields } = data;
  
  // Create data-check-string
  const dataCheckArr = Object.keys(fields)
    .sort()
    .map(key => `${key}=${fields[key as keyof typeof fields]}`)
    .join('\n');

  // Compute secret key
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  
  // Compute hash
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckArr)
    .digest('hex');

  return computedHash === hash;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as TelegramAuthData;
    
    const botToken = process.env.BO_TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return NextResponse.json({ error: 'Bot token not configured' }, { status: 500 });
    }

    // Verify auth data
    if (!verifyTelegramAuth(body, botToken)) {
      return NextResponse.json({ error: 'Invalid authentication' }, { status: 401 });
    }

    // Check auth_date (shouldn't be too old)
    const authDate = parseInt(body.auth_date);
    const now = Math.floor(Date.now() / 1000);
    const maxAge = 86400; // 24 hours

    if (now - authDate > maxAge) {
      return NextResponse.json({ error: 'Authentication expired' }, { status: 401 });
    }

    // TODO: Look up user in database by telegram_id
    // For now, create a simple session
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, {
      password: process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long',
      cookieName: 'bo_session',
      cookieOptions: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 86400 * 7, // 7 days
      },
    });

    session.telegramId = body.id;
    session.firstName = body.first_name;
    session.lastName = body.last_name;
    // TODO: Set userId from database lookup
    // TODO: Check if system admin

    await session.save();

    return NextResponse.json({
      success: true,
      user: {
        telegramId: body.id,
        firstName: body.first_name,
        lastName: body.last_name,
      },
    });

  } catch (error) {
    console.error('[Auth Error]', error);
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, {
      password: process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long',
      cookieName: 'bo_session',
      cookieOptions: {
        secure: process.env.NODE_ENV === 'production',
      },
    });

    if (!session.telegramId) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        telegramId: session.telegramId,
        firstName: session.firstName,
        lastName: session.lastName,
        isSystemAdmin: session.isSystemAdmin,
      },
    });

  } catch (error) {
    console.error('[Session Error]', error);
    return NextResponse.json({ error: 'Session error' }, { status: 500 });
  }
}
