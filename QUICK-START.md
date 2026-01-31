# Railway Deployment - Quick Start

## ✅ What's Already Done

All code is implemented and ready:
- ✅ PostgreSQL schema (`migrations/001_initial_schema.sql`)
- ✅ Data migration script (`scripts/migrate-sqlite-to-pg.ts`)
- ✅ PostgreSQL database layer (`src/db-pg.ts`)
- ✅ Rate limiting (`src/rate-limiter.ts`)
- ✅ Content moderation (`src/moderation.ts`)
- ✅ Model routing (`src/model-router.ts`)
- ✅ Next.js portal (`app/`)
- ✅ Tests (`tests/`)

## 🚀 What You Need to Do (5 Steps)

### Step 1: Add Services in Railway Dashboard

Go to your Railway project dashboard and add these 4 services:

1. **Add PostgreSQL**
   - Click "New Service" → "Database" → "PostgreSQL"
   - Name: postgres

2. **Add Redis**
   - Click "New Service" → "Database" → "Redis"
   - Name: redis

3. **Add Web App**
   - Click "New Service" → "GitHub Repo" → Select "bo"
   - Name: bo-web
   - Root Directory: leave empty
   - Start Command: `bun run build && bun run start:next`

4. **Add Daemon**
   - Click "New Service" → "GitHub Repo" → Select "bo"
   - Name: bo-daemon
   - Root Directory: leave empty
   - Start Command: `bun run watch-self`

### Step 2: Set Environment Variables

In Railway dashboard, for **ALL services**, add these variables:

```
SESSION_SECRET=<generate-32-char-hex>
BO_TELEGRAM_BOT_TOKEN=<your-telegram-bot-token>
AI_GATEWAY_API_KEY=<your-ai-gateway-key>
BRAVE_API_KEY=<your-brave-api-key>
BO_LLM_MODEL=openai/gpt-4.1
BO_SIMPLE_MODEL=google/gemini-3-flash
BO_COMPLEX_MODEL=openai/gpt-5.2
NODE_ENV=production
```

Note: `DATABASE_URL` and `REDIS_URL` are automatically set by Railway.

### Step 3: Run Database Migrations

Once PostgreSQL is provisioned, connect and run migrations:

**Option A: From Railway Dashboard**
1. Open PostgreSQL service → "Data" tab
2. Click "Connect" to get psql command
3. Run locally:
   ```bash
   psql <connection-string> -f migrations/001_initial_schema.sql
   export DATABASE_URL=<connection-string>
   bun run scripts/migrate-sqlite-to-pg.ts
   ```

**Option B: Via Railway CLI**
```bash
railway run psql $DATABASE_URL -f migrations/001_initial_schema.sql
railway run bun run scripts/migrate-sqlite-to-pg.ts
```

### Step 4: Push to GitHub

```bash
git add .
git commit -m "Add Railway multi-tenant platform implementation"
git push origin main
```

Railway will auto-deploy both services (bo-web and bo-daemon).

### Step 5: Test

1. **Test Telegram Bot**: Send a message to @BoAndCattle_bot
2. **Test Web Portal**: Visit your Railway app URL
3. **Check Logs**: View in Railway dashboard

## 🎯 Success Checklist

- [ ] PostgreSQL service created and DATABASE_URL available
- [ ] Redis service created and REDIS_URL available
- [ ] bo-web service deployed and accessible
- [ ] bo-daemon service running (check logs)
- [ ] All environment variables set
- [ ] Database schema migrated (15 tables created)
- [ ] SQLite data migrated to PostgreSQL
- [ ] Telegram bot responds to messages
- [ ] Web portal loads at Railway URL

## 📊 Estimated Time

- Step 1-2: 10 minutes (add services + env vars)
- Step 3: 5 minutes (run migrations)
- Step 4-5: 5 minutes (push + verify)

**Total: ~20 minutes**

## 🆘 Troubleshooting

**Database connection fails:**
- Verify DATABASE_URL is set in all services
- Check PostgreSQL service is "Active" in Railway

**Bot not responding:**
- Check bo-daemon logs in Railway
- Verify BO_TELEGRAM_BOT_TOKEN is correct
- Ensure REDIS_URL is available

**Web portal 500 error:**
- Check bo-web logs
- Verify SESSION_SECRET is set
- Ensure all dependencies installed

## 📞 Need Help?

Check detailed guides:
- `DEPLOYMENT.md` - Full deployment guide
- `ARCHITECTURE.md` - System architecture
- `MIGRATION-CHECKLIST.md` - Detailed checklist
