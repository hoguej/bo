# Bo Platform Architecture

## Overview

Bo is a multi-tenant AI assistant platform designed for family groups. Each family has isolated data, shared AI personality, and role-based access control.

## System Components

```
┌─────────────────────────────────────────────────────────────┐
│                         Railway                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ PostgreSQL  │  │   Redis     │  │  Next.js    │        │
│  │             │  │             │  │   Portal    │        │
│  │ Multi-tenant│  │ Rate limit  │  │             │        │
│  │  Database   │  │   Cache     │  │  Telegram   │        │
│  └─────────────┘  └─────────────┘  │    Auth     │        │
│                                      └─────────────┘        │
│                                                              │
│  ┌─────────────────────────────────────────────────┐       │
│  │          Bo Daemon (Persistent Process)          │       │
│  ├─────────────────────────────────────────────────┤       │
│  │  • Telegram Bot (Long Polling)                  │       │
│  │  • Scheduler (Reminders, Daily Todos)           │       │
│  │  • Rate Limiter                                 │       │
│  │  • Content Moderator                            │       │
│  │  • AI Router (GPT-4.1/5.2, Gemini 3 Flash)     │       │
│  └─────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘

                           │
                           │ API Calls
                           ▼
               ┌──────────────────────────┐
               │  Vercel AI Gateway       │
               │  (Zero-markup proxy)     │
               ├──────────────────────────┤
               │  • OpenAI (GPT-4.1/5.2)  │
               │  • Google (Gemini 3)     │
               └──────────────────────────┘
```

## Database Schema

### Core Entities

**families** - Top-level tenant isolation
- `id`, `name`, `created_at`

**users** - Individual users (can belong to multiple families)
- `id`, `first_name`, `last_name`, `phone_number`, `telegram_id`
- `last_active_family_id` - For DM context
- `is_system_admin` - Platform admin flag

**family_memberships** - Many-to-many with roles
- `user_id`, `family_id`, `role` (owner/manager/member)
- Trigger: Ensures at least one owner per family

### User Data (Family-Isolated)

All tables have composite key: `(user_id, family_id)`

- **facts** - Knowledge base
- **conversation** - Chat history
- **summary** - Conversation summaries
- **user_personalities** - Per-family AI personality
- **todos** - Task lists
- **reminders** - One-off and recurring reminders

### System Tables

- **llm_log** - LLM request tracking
- **moderation_flags** - Content safety logs
- **rate_limit_log** - Rate limit violations
- **skills_registry** - Available skills
- **skills_access_default** - Default skill permissions
- **skills_access_by_user** - Per-user skill overrides
- **group_chats** - Telegram group metadata
- **watch_self_replied** - Message deduplication
- **schedule_state** - Scheduler state per user
- **config** - Global key-value settings

## Multi-Tenancy Model

### Family Isolation

All user data queries must include `family_id`:

```typescript
// ✅ Correct - Family isolated
SELECT * FROM facts WHERE user_id = $1 AND family_id = $2;

// ❌ Wrong - Could leak data across families
SELECT * FROM facts WHERE user_id = $1;
```

### Family Context Determination

**Telegram Group Chats:**
- Look up `family_id` from `group_chats.chat_id`
- All members share same context

**Telegram DMs:**
- Use `users.last_active_family_id`
- Updated when user interacts with a family

### Roles & Permissions

**Owner:**
- Full control over family
- Manage billing (future)
- Manage all members and roles
- Access all family member data
- Multiple owners allowed, minimum one required

**Manager:**
- Everything except billing
- Manage members and roles
- Access all family member data

**Member:**
- Manage own data only
- View family information
- Cannot modify others' data

**System Admin:**
- Platform-level access
- Can view/manage all families
- Access moderation dashboard
- Handle crisis flags

## AI Model Strategy

### Hybrid Approach (Cost Optimization)

**Gemini 3 Flash** ($0.01/$0.02 per 1M tokens)
- Extract dates/times
- Parse structured data
- Simple acknowledgments
- List formatting
- ~40% of requests

**GPT-4.1** ($10/$30 per 1M tokens)
- Standard conversations
- Fact extraction
- Skill routing
- ~40% of requests

**GPT-5.2** ($20/$60 per 1M tokens)
- Personality responses
- Red flag detection
- Crisis intervention
- Code generation
- ~20% of requests

**Total AI cost:** ~$41/month at 10K messages
**Savings:** 60% vs all Sonnet 4.5, 49% vs all GPT-5.2

## Rate Limiting

### Algorithm

- **Limit:** 4 messages per minute per family member
- **Window:** Rolling 15 minutes
- **Calculation:** Family with 4 members = 60 messages per 15 min

### Escalating Cooldowns

1. First violation: 30 seconds
2. Second: 1 minute
3. Third: 2 minutes
4. Fourth: 4 minutes
5. Fifth: 10 minutes
6. Sixth: 30 minutes
7. Seventh: 1 hour

### Implementation

- Redis sorted sets track message timestamps
- Cooldown level persists for 24 hours
- Messages during cooldown are logged but not processed
- Personality-appropriate cooldown messages

## Content Safety

### Post-Response Moderation (PG Filter)

1. Generate AI response
2. Check via OpenAI Moderation API
3. If flagged:
   - Log original + replacement
   - Generate personality-appropriate excuse
   - Flag for admin review
4. Send safe response to user

### Pre-Processing Red Flag Detection

1. Scan user message for keywords (self-harm, violence)
2. Determine severity (low/medium/high/critical)
3. For critical:
   - Provide crisis resources
   - Notify system admin
   - Do not process further
4. For high/medium:
   - Log and continue with supportive response

## Security

### Data Isolation

- PostgreSQL row-level security via `family_id`
- All queries require family context
- Indexes optimized for `(user_id, family_id)` lookups

### Authentication

- Telegram OAuth for portal
- Telegram bot token for bot API
- Session management via `iron-session`
- HTTPS enforced by Railway

### Secrets Management

**Environment Variables (Railway):**
- `DATABASE_URL`, `REDIS_URL` - Auto-generated
- `SESSION_SECRET` - Random 32-char hex
- `BO_TELEGRAM_BOT_TOKEN` - From BotFather
- `AI_GATEWAY_API_KEY` - From Vercel

**Database (Encrypted):**
- Future: OAuth tokens per user
- Future: Per-family API keys

## Monitoring & Observability

### Logging

- Railway dashboard: Service logs
- PostgreSQL: Query performance
- Redis: Rate limit metrics
- `llm_log` table: All AI requests/responses

### Metrics

- Message volume per family
- Rate limit violations
- Moderation flags
- Model usage breakdown
- Response times

### Alerts (Future)

- Sentry for error tracking
- Crisis flag notifications
- Rate limit abuse patterns
- Database health checks

## Scalability

### Current Capacity

- **Users:** Hundreds (single Railway instance)
- **Families:** Dozens simultaneously
- **Messages:** 10K-50K/month per instance
- **Database:** Scales with Railway PostgreSQL

### Growth Path

1. **0-100 users:** Current setup sufficient
2. **100-1K users:** Add read replicas, increase Railway tier
3. **1K-10K users:** Horizontal scaling, load balancer
4. **10K+ users:** Multi-region, CDN, dedicated infrastructure

### Bottlenecks

- **LLM API calls:** Rate limited by providers
- **PostgreSQL connections:** Pool size = 20
- **Redis:** Single instance, vertical scaling
- **Daemon:** Single process, long polling

## Cost Breakdown

### Monthly (10K messages)

- Railway: $20-25
  - PostgreSQL: ~$5-10
  - Redis: ~$5
  - Web + Daemon: ~$10-15
- AI models: ~$41
- **Total: ~$61-66/month**

### Scaling Costs

- 50K messages/month: ~$100-120
- 100K messages/month: ~$180-220
- 500K messages/month: ~$800-1000

Most cost is AI API calls (scales linearly with usage).

## Development Workflow

### Local Development

```bash
# Install dependencies
bun install

# Run Next.js dev server
bun run dev

# Run Telegram bot locally (uses SQLite)
bun run watch-self

# Run migrations
export DATABASE_URL="<local postgres>"
bun run migrate:up
```

### Testing

```bash
# Run integration tests
bun test

# Test family isolation
bun test tests/family-isolation.test.ts

# Test moderation
# (create tests/moderation.test.ts)
```

### Deployment

```bash
# Commit changes
git add .
git commit -m "Feature: X"
git push

# Railway auto-deploys
# Monitor: railway logs
```

## Future Enhancements (Round 2)

1. **Google OAuth** - Gmail/Calendar integration
2. **Self-service onboarding** - Create family via Telegram
3. **Subscription tiers** - Free/Pro/Enterprise
4. **Advanced portal** - React components, real-time updates
5. **Mobile app** - React Native or PWA
6. **Voice messages** - Telegram voice transcription
7. **File sharing** - Family document storage
8. **Analytics dashboard** - Usage insights for owners

## Technical Decisions

### Why Railway?

- All-in-one hosting ($20-25/month)
- Managed PostgreSQL + Redis
- GraphQL API for programmatic setup
- Simple deployment (git push)
- Great developer experience

### Why PostgreSQL?

- ACID compliance for critical data
- Strong multi-tenancy support
- Row-level security
- Mature ecosystem
- Easy backups and replication

### Why Redis?

- Fast in-memory rate limiting
- Rolling window calculations
- TTL for automatic cleanup
- Atomic operations (ZADD, ZCOUNT)

### Why Next.js?

- Server-side rendering
- API routes (no separate backend)
- TypeScript support
- Easy deployment
- React ecosystem

### Why Hybrid Models?

- 60% cost savings vs single premium model
- Task-appropriate model selection
- Maintains quality for complex tasks
- Optimizes for high-volume simple tasks
