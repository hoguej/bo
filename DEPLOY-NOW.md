# Deploy to Railway Right Now (5 Minutes)

## ✅ Everything is Already Built

All code is implemented. You just need to create services in Railway dashboard.

## 🚀 Steps

### 1. Open Your Railway Project (1 min)

Go to: https://railway.app/project/[your-project-id]

### 2. Add 4 Services (2 min)

**Click "New Service" 4 times:**

**Service 1: PostgreSQL**
- Click "New Service"
- Select "Database"
- Choose "PostgreSQL"
- Click "Add"

**Service 2: Redis**
- Click "New Service"
- Select "Database"
- Choose "Redis"
- Click "Add"

**Service 3: Web Portal**
- Click "New Service"
- Select "GitHub Repo"
- Choose your Bo repository
- Click "Add"
- Railway will auto-detect and name it

**Service 4: Daemon**
- Click "New Service"
- Select "GitHub Repo"
- Choose your Bo repository again
- Click "Add"

### 3. Configure Services (2 min)

**For Web Portal Service:**
1. Click on the service
2. Go to "Settings" → "Deploy"
3. Set Start Command: `bun run start:next`
4. Save

**For Daemon Service:**
1. Click on the service
2. Go to "Settings" → "Deploy"
3. Set Start Command: `bun run watch-self`
4. Save

### 4. Set Environment Variables (1 min)

For **both** Web and Daemon services:

1. Click "Variables" tab
2. Click "Raw Editor"
3. Paste this:

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

4. Click "Add" or "Save"

**Note:** DATABASE_URL and REDIS_URL are automatically set by Railway when you add those services.

### 5. Deploy (Automatic)

Railway will automatically deploy when you push to GitHub:

```bash
git add .
git commit -m "Add Railway multi-tenant platform"
git push origin main
```

## 📊 What Happens Next

1. **PostgreSQL** provisions (~2 minutes)
2. **Redis** provisions (~1 minute)
3. **Web & Daemon** build and deploy (~3-5 minutes)

## ⏳ While Waiting: Run Database Migration

Once PostgreSQL shows "Active" status:

1. Click on PostgreSQL service
2. Copy the "DATABASE_URL" connection string
3. Run locally:

```bash
export DATABASE_URL="<paste-connection-string-here>"
psql $DATABASE_URL -f migrations/001_initial_schema.sql
bun run scripts/migrate-sqlite-to-pg.ts
```

This creates the schema and migrates all your data from SQLite.

## ✅ Done!

Test it:
1. Send message to Telegram bot
2. Visit web portal at Railway URL
3. Check logs in Railway dashboard

**Total time: ~10 minutes** (5 min setup + 5 min deploy)

## 🆘 If Something Goes Wrong

Your local SQLite database at `~/.bo/bo.db` is untouched. You can always:
```bash
pkill -f "watch-self"
npm run watch-self
```

And you're back to local operation.
