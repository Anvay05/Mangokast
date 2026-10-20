# Mangokast

**Performance-first influencer matching for YouTube.**

Mangokast helps brands find creators by expected ROI and customer acquisition cost—not follower count alone.

## Current MVP scope

- YouTube-only creator discovery
- Campaign-aware creator recommendations through the official YouTube search API
- Campaign brief capture
- Transparent creator comparison using recent performance signals
- Cost and CAC planning inputs
- Campaign-aware expected purchases and expected CAC ranges
- 24-hour creator-analysis cache to reduce repeat YouTube API requests
- Creator-specific tracking links
- Idempotent click, lead, purchase, and refund event ingestion
- Planned-versus-actual campaign performance
- Actual CAC once actual spend and purchases are present
- Creator-authorized analytics as the long-term source of truth
- Audience demographics and quality records with source/confidence metadata
- Past sponsorship records with explicit provenance
- Brand-only public sponsorship description signals with compact 30-day-retained output
- Shopify webhook foundation for attributed orders and refunds
- AI UGC Team workflow category for brief-to-content operations
- Campaign tracking through UTM links and coupon codes

## Project structure

```text
.
├── docs/
│   ├── product-spec.md
│   └── youtube-data-plan.md
├── src/
│   ├── app.js
│   └── styles.css
└── index.html
```

## Run locally

The frontend is a dependency-free static app. The backend is a Node/Express service in `api/`.

### 1. Start the API

Open Terminal 1:

```bash
cd "/Users/anvay/Downloads/MAngokast/api"
npm start
```

The API runs on <http://127.0.0.1:3000>.

### 2. Start the frontend

Open Terminal 2:

```bash
cd "/Users/anvay/Downloads/MAngokast"
python3 -m http.server 4173
```

Then visit <http://localhost:4173>.

### 3. Verify the API

```bash
curl http://127.0.0.1:3000/health
```

### 4. Run the backend smoke test

```bash
cd "/Users/anvay/Downloads/MAngokast/api"
npm test
```

## Data and policy boundary

Mangokast uses the official YouTube Data API. It does not scrape YouTube pages or use undocumented endpoints. Public YouTube facts, creator-authorized analytics, Mangokast planning estimates, and Mangokast-owned campaign outcomes are shown as separate data classes.

The current local database is `api/mangokast.db`. For production, add authentication, workspace isolation, hosted storage, retention/deletion controls, monitoring, and a reviewed commerce integration before serving multiple businesses.

## Next engineering step

Replace the local demo attribution form with a real Shopify or custom-store webhook connector plus a reconciliation job. Use the campaign outcome data to calibrate planning estimates before automating budget recommendations.
