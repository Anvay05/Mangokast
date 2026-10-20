# Creator intelligence and Shopify ingestion

## Creator intelligence records

Mangokast stores audience profiles, audience-quality reviews, and past-sponsorship records separately from public YouTube metrics. The records are keyed by `channelId` and may optionally point to a persisted `snapshotId`.

Every record requires:

- `sourceType`: `creator_authorized`, `creator_supplied`, `provider`, or `mangokast_review`
- `retrievedAt`: an ISO timestamp
- `confidence`: a number from `0` to `1`
- `status`: an explicit workflow status such as `draft`, `verified`, or `needs_review`

The submitted record payload is retained as JSON under `data` and is also exposed under the resource-specific key. These endpoints never infer demographics, quality, or sponsorship history from public YouTube API values. The separate brand-only public sponsorship signal scanner reports compact description signals for review; those signals are not sponsorship history and use `sourceType: "public_description_signal"`.

See [Public sponsorship signal scanner](public-sponsorship-signals.md) for its
official API-only input path, response fields, disclaimer, and 30-day
refresh/delete retention note.

Canonical endpoints (equivalent creator-scoped aliases are also available):

| Capability | Create | List/read | Update/delete |
| --- | --- | --- | --- |
| Audience profile | `POST /api/audience-profiles` | `GET /api/audience-profiles?channelId=...` | `/api/audience-profiles/:id` |
| Quality review | `POST /api/quality-reviews` | `GET /api/quality-reviews?channelId=...` | `/api/quality-reviews/:id` |
| Sponsorship | `POST /api/sponsorship-records` | `GET /api/sponsorship-records?channelId=...` | `/api/sponsorship-records/:id` |

Use `PATCH` for partial updates, `PUT` for a complete metadata update, and `DELETE` to remove a record. A supplied `snapshotId` must exist and belong to the supplied channel.

## Shopify webhook

Send order and refund events to `POST /api/webhooks/shopify`. The endpoint accepts the normalized shape below, as well as Shopify-style `orders/*` and `refunds/*` topics and common total-price fields:

```json
{
  "eventId": "order-123",
  "eventType": "order",
  "amount": 1499.00,
  "currency": "USD",
  "occurredAt": "2026-02-02T00:00:00.000Z",
  "trackingToken": "creator-campaign-token",
  "utm": {
    "campaign": "creator-campaign-token"
  }
}
```

When `SHOPIFY_WEBHOOK_SECRET` is configured, the endpoint requires the Shopify `X-Shopify-Hmac-Sha256` header and verifies the base64 HMAC-SHA256 digest over the exact request body. If the secret is not configured, signature verification is skipped for local development.

Events are deduplicated by `eventId`. A token, tracking-link ID, or `utm_campaign`/`utm_content` value that matches a Mangokast tracking link attributes the normalized purchase/refund to the existing attribution ledger. Unmatched events are still retained in the Shopify event intake table and return successfully so they can be reconciled later. A duplicate response is marked with `idempotent: true` and never increments campaign performance twice.

Production integration requirements:

1. Set `MANGOKAST_DB_PATH` to a durable SQLite location.
2. Set `SHOPIFY_WEBHOOK_SECRET` to the Shopify app/webhook signing secret.
3. Include a stable event ID; Shopify's `X-Shopify-Webhook-Id` is used only when the payload has no event ID.
4. Include a creator/campaign tracking token in the order attribution or preserve UTM values in `landing_site`/note attributes.
5. Register both order-created and refund-created topics and run a periodic reconciliation because webhook delivery can be retried or missed.
