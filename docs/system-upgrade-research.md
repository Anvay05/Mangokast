# Mangokast system-upgrade research

Updated: 18 October 2026

## What the research says

Mangokast should not become another creator-directory SaaS. The strongest products connect the full operating loop:

```text
Campaign brief → creator research → deal/activation → links/codes → sales → actual CAC → next recommendation
```

Modash publicly describes discovery, vetting, tracking links and promo codes, sales measurement, reporting, and integrations. GRIN publicly describes a connected system for creator discovery, programs, deals, payments, content, and measurement. The lesson is that the product value is in the connected record and outcome feedback—not in a prettier creator card.

## Efficiency decisions

### 1. Do not begin with broad YouTube search

Google's current YouTube quota documentation states that most list requests such as `channels.list`, `playlistItems.list`, `videos.list`, and `commentThreads.list` cost 1 unit, while `search.list` has a separate daily limit. The first workflow should therefore accept a channel URL, channel ID, or handle and resolve it once.

Mangokast now caches an analysis for a campaign and channel for 24 hours by default. A deliberate `forceRefresh` option is available for a fresh request. This avoids repeated channel and video calls when a marketer revisits the same creator.

The product now exposes discovery as an explicit second path instead of making every business provide a creator URL:

```text
I already have creators → paste a URL or handle
Help me find creators → search with a campaign-aware query
```

Discovery is capped at 10 recommendations per request. Common region and language names are normalized to YouTube's two-letter codes. This keeps the user experience simple while making the quota cost visible and bounded.

### 2. Separate source classes

The system keeps these classes distinct:

- **YouTube public API facts:** subscribers, video metadata, views, likes, comments, timestamps, and source links.
- **Creator-authorized data:** future OAuth-based channel analytics such as watch time, retention, audience geography, and impressions.
- **Mangokast planning estimates:** expected relevant views, fee scenarios, expected purchases, and expected CAC ranges.
- **Mangokast-owned outcomes:** tracked clicks, leads, purchases, revenue, refunds, spend, and actual CAC.

No planning estimate is presented as a guarantee. Actual CAC is only calculated when actual spend and purchases exist.

### 3. Build attribution before complex AI

Without attribution, the system cannot learn which creator worked. A durable link and event model is more valuable than adding a black-box ranking score too early.

The MVP now supports:

- Campaign-scoped tracking links
- Creator-specific tracking tokens
- Click, lead, purchase, and refund events
- Idempotency keys so duplicate events do not double-count
- Campaign performance aggregation
- Planned-versus-actual metrics
- Actual CAC when fee and purchases are available

### 4. Use events plus reconciliation for commerce

Shopify's webhook guidance recommends webhooks for near-real-time events, but also recommends reconciliation because webhook delivery is not guaranteed. The production architecture should therefore use:

```text
Webhook event → durable event table → deduplicate → aggregate
Periodic reconciliation → repair missed or late events
```

The current local MVP provides the durable event table and aggregation layer. A Shopify or custom-store connector can be added without replacing the core model.

## Current system after this upgrade

```text
Campaign brief
  ├─ product economics, audience, location, language, landing page
  └─ target CAC and currency

Creator analysis
  ├─ 24-hour cache by campaign + channel
  ├─ official YouTube Data API facts
  ├─ separate planning estimates
  └─ SQLite snapshot history

Activation
  └─ creator tracking link with planned fee and CAC fields

Outcome loop
  ├─ click / lead / purchase / refund events
  ├─ idempotent ingestion
  ├─ revenue and net revenue
  ├─ actual fee / spend
  └─ actual CAC + planned versus actual
```

The current product also has explicit foundations for:

- **Audience demographics:** stored only from creator-authorized, creator-supplied, or approved provider records.
- **Audience quality:** a review record with score/assessment, source, confidence, and status; no public-API guess is accepted.
- **Past sponsorships:** separately sourced records with provenance rather than inferred brand deals.
- **Shopify:** HMAC-verified order/refund webhook intake with event deduplication and attribution into the campaign ledger.
- **AI UGC Team:** a product workflow category for brief, concepts/scripts, creator assignment, rights/review, and performance learning. Generation and rights automation are intentionally not claimed as live until their integrations are built.

## Production gaps to solve before launch

1. Add real user authentication and workspace isolation.
2. Add a privacy policy, YouTube Terms link, Google Privacy Policy link, and data deletion controls.
3. Refresh or delete stored non-authorized YouTube data within the policy window and make source timestamps visible.
4. Add creator OAuth only when a private creator-authorized metric is needed; never ask for YouTube passwords.
5. Replace the local SQLite runner with a hosted database and background jobs.
6. Add a Shopify/custom-store connector using signed webhooks plus reconciliation.
7. Add a reviewable candidate-discovery provider only after the URL-first workflow proves demand; do not scrape YouTube.
8. Calibrate expected CAC from real campaign outcomes before using it for automated budget recommendations.
9. Add monitoring, backups, rate limits, audit logs, and secret management.

## Sources

- YouTube quota costs: https://developers.google.com/youtube/data/determine_quota_cost
- YouTube Analytics and Reporting APIs: https://developers.google.com/youtube/analytics
- YouTube API Developer Policies: https://developers.google.com/youtube/terms/developer-policies
- Modash discovery: https://www.modash.io/features/influencer-discovery
- Modash tracking: https://www.modash.io/features/influencer-tracking
- GRIN platform: https://grin.co/platform
- Shopify webhooks and reconciliation guidance: https://shopify.dev/docs/apps/build/webhooks

## Honest product boundary

This is a working, local, YouTube-first outcome-loop MVP. It is not yet a production multi-tenant marketplace, a guaranteed CAC predictor, or a full commerce integration. The next reliable step is to run a few controlled campaigns, collect actual outcomes, and use that evidence to improve the model.
