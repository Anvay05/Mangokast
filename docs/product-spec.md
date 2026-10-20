# Mangokast MVP product specification

## Positioning

> Find influencers by expected ROI, not follower count.

> Reduce influencer acquisition cost with performance-based creator matching.

## Primary user

A D2C or app-growth marketer who has a fixed campaign budget and needs qualified traffic or purchases from YouTube sponsorships.

## Acceptance criteria

1. A marketer can describe a campaign using category, audience, geography, budget, and goal.
2. Mangokast presents a shortlist with a clear explanation of fit, recent performance, cost assumptions, and risks.
3. Every metric has a timestamp and is distinguished as a YouTube metric, a creator-authorized metric, or a Mangokast estimate.
4. A marketer can compare expected spend, views, clicks, conversions, and CAC.
5. The product never presents an estimate as a guarantee and surfaces missing data.

## MVP screens

### 1. Campaign brief

- Product/category
- Campaign goal: awareness, traffic, leads, or purchases
- Target location and language
- Budget
- Target CAC or CPA
- Audience description

### 2. Creator shortlist

- Creator name and channel
- Subscriber count
- Recent median views
- View/subscriber ratio
- Engagement indicators
- Expected relevant views
- Estimated fee range
- Estimated CAC range
- Data confidence
- Safety and fit notes

### 3. Creator detail

- Recent video evidence
- Comment-intent themes (aggregate only)
- Audience fit
- Sponsorship history supplied by creator or brand
- Missing-data warnings
- Source links and retrieved-at timestamp

### 4. Campaign results

- UTM clicks
- Leads or purchases
- Revenue
- Actual CAC
- Planned versus actual performance

## Ranking approach

The first release should show explainable signals rather than a black-box score. Use the following internal feature set for Mangokast-owned campaign intelligence:

```text
expected_relevant_views
expected_click_rate
expected_conversion_rate
estimated_fee
estimated_CAC
audience_fit
performance_consistency
purchase_intent
brand_safety
data_confidence
```

Keep YouTube-provided values clearly separated from Mangokast-derived campaign estimates. Validate any cross-channel ranking design against YouTube API policies before production launch.

## Business model hypothesis

- Free: limited campaign briefs and public snapshots
- Pro: saved campaigns, creator comparisons, tracking, and reports
- Managed: campaign execution and a small performance fee

## Non-goals for v1

- Every social platform
- Guaranteed conversion forecasts
- Unrestricted scraping
- Automatic sponsorship contracting or payments
- Permanent storage of raw public comments
