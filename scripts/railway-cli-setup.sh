#!/bin/bash
# Railway CLI setup script
# Requires: npm install -g @railway/cli

set -e

echo "🚂 Setting up Railway services via CLI..."
echo ""

# Check if railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI not found"
    echo "Install with: npm install -g @railway/cli"
    exit 1
fi

# Make sure we're logged in
echo "Checking Railway authentication..."
railway whoami || {
    echo "❌ Not logged in to Railway"
    echo "Run: railway login"
    exit 1
}

# Link to project if not already linked
if [ ! -f ".railway/project.json" ]; then
    echo "Linking to Railway project..."
    railway link
fi

echo ""
echo "📦 Adding services..."
echo ""

# Add PostgreSQL
echo "1. Adding PostgreSQL..."
railway add --database postgres || echo "  (PostgreSQL might already exist)"

# Add Redis  
echo "2. Adding Redis..."
railway add --database redis || echo "  (Redis might already exist)"

echo ""
echo "⚙️  Setting environment variables..."
echo ""

# Set environment variables
railway variables set \
    SESSION_SECRET="<generate-32-char-hex>" \
    BO_TELEGRAM_BOT_TOKEN="<your-telegram-bot-token>" \
    AI_GATEWAY_API_KEY="<your-ai-gateway-key>" \
    BRAVE_API_KEY="<your-brave-api-key>" \
    BO_LLM_MODEL="openai/gpt-4.1" \
    BO_SIMPLE_MODEL="google/gemini-3-flash" \
    BO_COMPLEX_MODEL="openai/gpt-5.2" \
    NODE_ENV="production"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Services configured!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Next steps:"
echo "   1. Add 2 GitHub repo services in Railway dashboard:"
echo "      • bo-web (start: bun run start:next)"
echo "      • bo-daemon (start: bun run watch-self)"
echo "   2. Wait for PostgreSQL to be ready"
echo "   3. Run: railway run psql \$DATABASE_URL -f migrations/001_initial_schema.sql"
echo "   4. Run: railway run bun run scripts/migrate-sqlite-to-pg.ts"
echo "   5. Push to GitHub: git push origin main"
echo ""
