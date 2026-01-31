# Railway Setup Commands

Since the GraphQL API requires specific permissions, here are the Railway CLI commands to set up your services:

## 1. Install Railway CLI

```bash
npm install -g @railway/cli
railway login
```

## 2. Link to Your Project

```bash
cd /Users/hoguej/dev/bo
railway link
# Select your "bo" project from the list
```

## 3. Add PostgreSQL Service

```bash
railway add --database postgres
```

This creates a managed PostgreSQL service and automatically sets the `DATABASE_URL` environment variable.

## 4. Add Redis Service

```bash
railway add --database redis
```

This creates a managed Redis service and automatically sets the `REDIS_URL` environment variable.

## 5. Set Environment Variables

```bash
# Session secret (generated earlier)
railway variables set SESSION_SECRET=<generate-32-char-hex>

# Telegram bot
railway variables set BO_TELEGRAM_BOT_TOKEN=<your-telegram-bot-token>

# AI Gateway
railway variables set AI_GATEWAY_API_KEY=<your-ai-gateway-key>

# Brave Search
railway variables set BRAVE_API_KEY=<your-brave-api-key>

# Model configuration
railway variables set BO_LLM_MODEL=openai/gpt-4.1
railway variables set BO_SIMPLE_MODEL=google/gemini-3-flash
railway variables set BO_COMPLEX_MODEL=openai/gpt-5.2

# Production
railway variables set NODE_ENV=production
```

## 6. Create Services from GitHub

### Web Service (Next.js Portal)

In Railway dashboard:
1. Click "New Service"
2. Select "GitHub Repo"
3. Choose your Bo repository
4. Name it "bo-web"
5. Set build command: `bun install && bun run build`
6. Set start command: `bun run start:next`

### Daemon Service (Telegram Bot)

In Railway dashboard:
1. Click "New Service"
2. Select "GitHub Repo"
3. Choose your Bo repository
4. Name it "bo-daemon"
5. Set build command: `bun install`
6. Set start command: `bun run watch-self`

## 7. Run Database Migrations

Once PostgreSQL is provisioned:

```bash
# Get the DATABASE_URL
railway variables

# Run migration
railway run psql $DATABASE_URL -f migrations/001_initial_schema.sql

# Run data migration
railway run bun run scripts/migrate-sqlite-to-pg.ts
```

## 8. Deploy

```bash
git add .
git commit -m "Add Railway migration"
git push origin main
```

Railway will automatically deploy both services.

## 9. Verify

```bash
# Check services
railway status

# View logs
railway logs

# Test the bot
# Send a message to your Telegram bot
```

## Alternative: Manual Setup via Dashboard

If CLI doesn't work, use Railway dashboard:

1. Go to https://railway.app/project/your-project-id
2. Click "New Service" → "Database" → "Add PostgreSQL"
3. Click "New Service" → "Database" → "Add Redis"
4. Click "New Service" → "GitHub Repo" → Select Bo repo → Name "bo-web"
5. Click "New Service" → "GitHub Repo" → Select Bo repo → Name "bo-daemon"
6. For each service, go to "Variables" and add the environment variables listed above
7. For bo-web, set start command in "Settings" → "Deploy" → `bun run start:next`
8. For bo-daemon, set start command: `bun run watch-self`
