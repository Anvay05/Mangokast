# YouTube data and cost plan

## Official data path

Use the YouTube Data API v3 for public channel, upload, video, and published-comment metadata. Ask a user to provide a channel or video URL in the first version instead of doing broad discovery: `search.list` is the expensive quota operation.

Use creator OAuth plus the YouTube Analytics API when the creator wants to connect their own channel. This is the path for private metrics such as watch time, retention, impressions, click-through rate, and audience information where the API makes them available.

Sources:

- https://developers.google.com/youtube/v3/getting-started
- https://developers.google.com/youtube/data/determine_quota_cost
- https://developers.google.com/youtube/data/reference/rest/v3/videos/list
- https://developers.google.com/youtube/data/reference/rest/v3/commentThreads/list
- https://developers.google.com/youtube/analytics
- https://developers.google.com/youtube/terms/developer-policies

## Quota strategy

The default project allocation is generally 10,000 units per day. Typical list requests such as `channels.list`, `videos.list`, `playlistItems.list`, and `commentThreads.list` cost 1 unit; `search.list` commonly costs 100 units. Pagination costs quota again.

Engineering rules:

1. Resolve and persist channel IDs once.
2. Traverse the uploads playlist rather than repeatedly searching.
3. Batch video IDs in `videos.list` calls.
4. Request only the required `part` fields and use partial responses.
5. Cache with ETags and maintain a quota ledger.
6. Add a hard daily budget and exponential backoff.
7. Start comment analysis with a bounded sample.

## Data governance

- Do not scrape pages or use undocumented endpoints.
- Do not store downloaded videos or audio.
- Store compact metadata, IDs, timestamps, and derived operational state only.
- Implement refresh/deletion/revocation workflows before production.
- Treat comment analysis as aggregate Mangokast analysis, not a YouTube metric.
- Keep raw commenter profiling out of the product.
- Link back to YouTube and preserve required attribution.

## Public sponsorship signals

The brand-facing public sponsorship signal scanner parses only the `snippet`
descriptions returned by the existing official `videos.list` request. It never
scrapes YouTube pages. It stores compact signal JSON only: video ID/title/date,
YouTube source URL, detected outbound domains, matched disclosure/promotion
keywords, low/medium/high detection confidence, `sourceType` set to
`public_description_signal`, and retrieval time. Raw descriptions are not
stored.

These records are clearly labelled as public description signals and include
the disclaimer “This is not verified sponsorship history.” A 30-day
refresh/delete note is included in the API response; expired rows are pruned,
and clients can explicitly delete a scan. Negated disclosure language such as
“not sponsored” is treated as a false-positive-safe case.

## Cost model

At MVP scale, API quota—not model inference—is likely the first constraint. Control inference spend by classifying only sampled comments and using a small model for sentiment/topic labels. Recompute creator features only when source data changes. Store feature summaries rather than repeatedly sending full comment text to an LLM.

Example processing budget per creator refresh:

```text
1 channel lookup
1 uploads-playlist page
1–3 video-statistics batches
1–5 bounded comment pages
1 comment classification batch
```

The exact quota and AI cost must be measured in production because pagination, comment volume, model choice, and refresh frequency change the result.

## Policy warning

YouTube policies may restrict how API data is stored and whether cross-channel derived scores or rankings can be created solely from API data. Before launch, have counsel review the proposed ranking, retention, and comment-processing design. The safest early product separates raw YouTube facts from Mangokast-owned campaign outcomes such as tracked clicks, conversions, spend, and actual CAC.
