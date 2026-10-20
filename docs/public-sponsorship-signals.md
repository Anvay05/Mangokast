# Public sponsorship signal scanner

Mangokast exposes a brand-facing public sponsorship signal scanner for YouTube
channels. It uses only the official YouTube Data API path already used by the
backend: `channels.list`, `playlistItems.list`, and `videos.list` with the
`snippet` part. It does not scrape YouTube pages or call undocumented
endpoints.

## What is returned

`POST /api/brands/sponsorship-signals` accepts a `channelUrl`, channel ID, or
`@handle`. Equivalent creator-scoped aliases are available for API clients.
The response exposes the records under `signals` and the explicit
`public_sponsorship_signals` label, with each compact record containing:

- `videoId`, `title`, and publication `date`
- the YouTube `sourceUrl`
- detected outbound `detectedDomains`
- matched, normalized `matchedKeywords`
- detection `confidence` (`low`, `medium`, or `high`)
- `sourceType: "public_description_signal"`
- `retrievedAt`
- the disclaimer: **This is not verified sponsorship history.**

The scanner reads each `videos.list` snippet description in memory. Raw
descriptions, page HTML, audio, and video content are never returned or
stored. Disclosure terms such as sponsored/paid partnership/#ad and
promotion/affiliate/coupon language are matched conservatively; a negated
statement such as “not sponsored” does not become a sponsorship signal. An
outbound domain without disclosure language is at most a low-confidence
public-description signal.

## Persistence and retention

The backend keeps at most one compact scan per channel in
`public_sponsorship_signal_scans`. A scan expires after 30 days and can be
refreshed by posting with `forceRefresh: true` or deleted with
`DELETE /api/brands/sponsorship-signals/:scanId`. Listing and reading scans
prune expired rows. The API includes this note in responses:

> Refresh or delete public description signals within 30 days; raw descriptions
> are never stored.

This scanner is intentionally separate from creator-authorized,
creator-supplied, provider, or Mangokast-review sponsorship records. A public
description signal is evidence to review, not a verified sponsorship history
or a claim that a brand relationship existed.

## Decision-model research: Laya and Jev

Research completed on 2026-10-18. Laya and Jev are **typed decision models**,
not web-research agents or data collectors:

- Laya is an open-weight, locally runnable model. Its official repository
  accepts text/JSON state and typed `choice`, `score`, and `noul` questions.
- Jev is TypeSafe's hosted System One model. Its official documentation also
  describes text/JSON state plus typed questions; it does not browse YouTube,
  retrieve channel images, or establish sponsorship history for us.
- Neither model should be used to scrape YouTube pages. YouTube's developer
  policies prohibit scraping and undocumented API access.

Therefore MangoKast keeps collection and evidence acquisition on the official
YouTube Data API path:

- `snippet.thumbnails` supplies the channel/video image URL for display.
- `videos.list` supplies the public title, date, and description text used for
  the compact signal scan.
- A licensed creator-data provider or brand-supplied evidence is needed for
  stronger cross-platform sponsorship history; a model cannot turn a public
  description into verified history.

Laya or Jev may be added later as an **optional second-pass classifier** over
the already collected title/description evidence. A useful bounded question
set would classify `explicit_paid`, `affiliate_or_promo`, `ambiguous`, or
`none`, plus whether human review is needed. The existing deterministic
keyword scanner should remain the auditable baseline, and model output must
never trigger creator outreach, budget changes, or a “verified sponsorship”
claim without human/provider evidence.

### Source links

- [Laya official repository](https://github.com/NandhaKishorM/laya)
- [TypeSafe Jev documentation](https://docs.typesafe.ai/introduction)
- [YouTube Data API overview](https://developers.google.com/youtube/data)
- [YouTube API developer policies](https://developers.google.com/youtube/terms/developer-policies)
