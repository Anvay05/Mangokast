const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const axios = require("axios");

const testDatabasePath = path.join(
  os.tmpdir(),
  `mangokast-smoke-${process.pid}.db`
);
process.env.MANGOKAST_DB_PATH = testDatabasePath;

const {
  calculateSummary,
  scanPublicSponsorshipSignals
} = require("../src/youtube");
const {
  saveSnapshot,
  savePublicSponsorshipSignalScan,
  getPublicSponsorshipSignalScans,
  deletePublicSponsorshipSignalScan,
  closeDatabase
} = require("../src/database");
const { app } = require("../src/server");

function makeVideos(multiplier) {
  return Array.from({ length: 6 }, (_, index) => ({
    id: `video-${multiplier}-${index}`,
    snippet: {
      title: `Video ${index}`,
      publishedAt: "2026-01-01T00:00:00.000Z"
    },
    statistics: {
      viewCount: String(10000 * multiplier + index * 1000),
      likeCount: String(500 * multiplier),
      commentCount: String(50 * multiplier)
    }
  }));
}

function request(server, method, requestPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const requestBody = body === undefined ? null : JSON.stringify(body);
    const requestOptions = {
      method,
      path: requestPath,
      port: server.address().port,
      headers: requestBody
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(requestBody),
            ...headers
          }
        : headers
    };
    const request = http.request(requestOptions, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          body: responseBody ? JSON.parse(responseBody) : null
        });
      });
    });
    request.on("error", reject);
    if (requestBody) {
      request.write(requestBody);
    }
    request.end();
  });
}

async function main() {
  const sampleRetrievedAt = new Date().toISOString();
  const publicSignalSamples = [
    {
      id: "signal-video-1",
      snippet: {
        title: "Acme routine",
        publishedAt: "2026-01-20T00:00:00.000Z",
        description: "Sponsored by Acme. Use my promo code GLOW at https://acme.example/offer."
      }
    },
    {
      id: "signal-video-2",
      snippet: {
        title: "No deal disclosure",
        publishedAt: "2026-01-19T00:00:00.000Z",
        description: "This video is not sponsored and has no affiliate links. More at https://creator.example/about."
      }
    },
    {
      id: "signal-video-3",
      snippet: {
        title: "Resource list",
        publishedAt: "2026-01-18T00:00:00.000Z",
        description: "My general resources are listed at https://creator.example/resources."
      }
    },
    {
      id: "signal-video-4",
      snippet: {
        title: "Everyday update",
        publishedAt: "2026-01-17T00:00:00.000Z",
        description: "I discuss sponsorship as a concept, with no promotion or links."
      }
    },
    {
      id: "signal-video-5",
      snippet: {
        title: "Contact details",
        publishedAt: "2026-01-16T00:00:00.000Z",
        description: "Business contact: partnerships@example.com"
      }
    }
  ];
  const publicSignals = scanPublicSponsorshipSignals(publicSignalSamples, {
    retrievedAt: sampleRetrievedAt
  });
  assert.equal(publicSignals.length, 2);
  assert.deepEqual(publicSignals[0], {
    videoId: "signal-video-1",
    title: "Acme routine",
    date: "2026-01-20T00:00:00.000Z",
    sourceUrl: "https://www.youtube.com/watch?v=signal-video-1",
    detectedDomains: ["acme.example"],
    matchedKeywords: ["sponsored by", "promo code"],
    confidence: "high",
    sourceType: "public_description_signal",
    retrievedAt: sampleRetrievedAt,
    disclaimer: "This is not verified sponsorship history."
  });
  assert.deepEqual(publicSignals[1].detectedDomains, ["creator.example"]);
  assert.deepEqual(publicSignals[1].matchedKeywords, []);
  assert.equal(publicSignals[1].confidence, "low");
  assert.equal(
    JSON.stringify(publicSignals).includes("not sponsored and has no affiliate links"),
    false
  );

  const persistedPublicScan = savePublicSponsorshipSignalScan({
    channelId: "UC9999999999999999999999",
    channelName: "Signal sample creator",
    signals: publicSignals,
    retrievedAt: sampleRetrievedAt
  });
  assert.equal(persistedPublicScan.sourceType, "public_description_signal");
  assert.equal(
    Date.parse(persistedPublicScan.expiresAt) - Date.parse(sampleRetrievedAt),
    30 * 24 * 60 * 60 * 1000
  );
  assert.equal(
    JSON.stringify(getPublicSponsorshipSignalScans({ channelId: persistedPublicScan.channelId }))
      .includes("not sponsored and has no affiliate links"),
    false
  );
  assert.equal(deletePublicSponsorshipSignalScan(persistedPublicScan.id), true);
  const expiredChannelId = "UC8888888888888888888888";
  savePublicSponsorshipSignalScan({
    channelId: expiredChannelId,
    channelName: "Expired signal sample",
    signals: publicSignals,
    retrievedAt: new Date(Date.now() - (31 * 24 * 60 * 60 * 1000)).toISOString()
  });
  assert.equal(
    getPublicSponsorshipSignalScans({ channelId: expiredChannelId }).length,
    0
  );

  const first = calculateSummary(
    {
      id: "UC1111111111111111111111",
      snippet: { title: "Creator One" },
      statistics: { subscriberCount: "100000" }
    },
    makeVideos(1)
  );
  const second = calculateSummary(
    {
      id: "UC2222222222222222222222",
      snippet: { title: "Creator Two" },
      statistics: { subscriberCount: "200000" }
    },
    makeVideos(2)
  );

  assert.equal(first.youtubeMetrics.source, "youtube_data_api");
  assert.equal(first.estimates.source, "mangokast_estimate");
  assert.equal(first.estimates.isEstimate, true);
  assert.equal(first.estimates.expectedRelevantViews, 8750);
  assert.equal(first.estimates.estimatedFeeRange.currency, "USD");

  const firstSnapshot = saveSnapshot(first);
  const secondSnapshot = saveSnapshot(second);

  const server = app.listen(0);
  const originalAxiosGet = axios.get;
  const originalYoutubeApiKey = process.env.YOUTUBE_API_KEY;
  const originalShopifyWebhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
  try {
    process.env.YOUTUBE_API_KEY = "smoke-test-youtube-key";

    const invalidDiscovery = await request(server, "POST", "/api/creators/discover", {
      query: "skincare creators",
      maxResults: 11
    });
    assert.equal(invalidDiscovery.statusCode, 400);
    assert.match(invalidDiscovery.body.error, /maxResults/);

    const missingDiscoveryQuery = await request(server, "POST", "/api/creators/discover", {});
    assert.equal(missingDiscoveryQuery.statusCode, 400);
    assert.match(missingDiscoveryQuery.body.error, /query/);

    const campaignPayload = {
      name: "GlowSkin launch",
      product: "Vitamin C serum",
      goal: "purchases",
      budget: 200000,
      targetCac: 500,
      productPrice: 1499,
      grossMargin: 60,
      audience: "Women aged 18-30 interested in skincare",
      location: "India",
      language: "Hindi / English",
      clickThroughRate: 2,
      conversionRate: 10
    };
    const createdCampaign = await request(server, "POST", "/api/campaigns", campaignPayload);
    assert.equal(createdCampaign.statusCode, 201);
    assert.equal(createdCampaign.body.campaign.name, campaignPayload.name);
    assert.equal(createdCampaign.body.campaign.grossMargin, 0.6);
    assert.equal(createdCampaign.body.campaign.clickThroughRate, 0.02);
    assert.equal(createdCampaign.body.campaign.conversionRate, 0.1);

    const campaignId = createdCampaign.body.campaign.id;
    const listedCampaigns = await request(server, "GET", "/api/campaigns");
    assert.equal(listedCampaigns.statusCode, 200);
    assert.equal(listedCampaigns.body.campaigns.length, 1);
    const activeCampaign = await request(server, "GET", "/api/campaigns/active");
    assert.equal(activeCampaign.statusCode, 200);
    assert.equal(activeCampaign.body.campaign.id, campaignId);
    const fetchedCampaign = await request(server, "GET", `/api/campaigns/${campaignId}`);
    assert.equal(fetchedCampaign.statusCode, 200);
    assert.deepEqual(fetchedCampaign.body.campaign, createdCampaign.body.campaign);

    const invalidCampaign = await request(server, "POST", "/api/campaigns", {
      ...campaignPayload,
      product: ""
    });
    assert.equal(invalidCampaign.statusCode, 400);

    const campaignSummary = calculateSummary(
      {
        id: "UC3333333333333333333333",
        snippet: { title: "Campaign Creator" },
        statistics: { subscriberCount: "100000" }
      },
      makeVideos(1),
      {
        campaign: createdCampaign.body.campaign,
        assumptions: { ctr: 2, conversionRate: 10 }
      }
    );
    const economics = campaignSummary.estimates.campaignEconomics;
    assert.equal(economics.estimateType, "planning_estimate");
    assert.equal(economics.expectedRelevantViews, 8750);
    assert.equal(economics.expectedClicks, 175);
    assert.equal(economics.expectedPurchases, 17.5);
    assert.deepEqual(economics.totalEstimatedSpend, {
      min: 300,
      max: 625,
      currency: "USD"
    });
    assert.deepEqual(economics.expectedCacRange, {
      min: 17.14,
      max: 35.71,
      currency: "USD"
    });
    assert.equal(economics.breakEvenCac, 899.4);
    assert.equal(economics.isEstimate, true);
    assert.match(economics.methodology.note, /not actual CAC/);

    const inrCampaignSummary = calculateSummary(
      {
        id: "UC4444444444444444444444",
        snippet: { title: "INR Campaign Creator" },
        statistics: { subscriberCount: "100000" }
      },
      makeVideos(1),
      {
        campaign: { ...createdCampaign.body.campaign, currency: "INR" },
        assumptions: { ctr: 2, conversionRate: 10 }
      }
    );
    assert.deepEqual(inrCampaignSummary.estimates.campaignEconomics.totalEstimatedSpend, {
      min: 25200,
      max: 52500,
      currency: "INR"
    });
    assert.deepEqual(inrCampaignSummary.estimates.campaignEconomics.expectedCacRange, {
      min: 1440,
      max: 3000,
      currency: "INR"
    });

    let youtubeRequestCount = 0;
    let discoveryRequest;
    axios.get = async (url, config) => {
      youtubeRequestCount += 1;
      if (url.endsWith("/search")) {
        discoveryRequest = { url, params: config.params };
        return {
          data: {
            items: [
              {
                id: { channelId: "UC5555555555555555555555" },
                snippet: {
                  title: "Search Creator",
                  description: "A creator found by the campaign query.",
                  thumbnails: {
                    default: { url: "https://img.example.test/default.jpg" },
                    high: { url: "https://img.example.test/high.jpg" }
                  }
                }
              },
              {
                id: { channelId: "UC6666666666666666666666" },
                snippet: {
                  title: "Second Search Creator",
                  description: "Another creator candidate."
                }
              }
            ]
          }
        };
      }
      if (url.endsWith("/channels")) {
        return {
          data: {
            items: [{
              id: "UC3333333333333333333333",
              snippet: { title: "Campaign Creator" },
              statistics: { subscriberCount: "100000" },
              contentDetails: { relatedPlaylists: { uploads: "uploads-1" } }
            }]
          }
        };
      }
      if (url.endsWith("/playlistItems")) {
        return {
          data: {
            items: makeVideos(1).map((video) => ({
              contentDetails: { videoId: video.id },
              snippet: video.snippet
            }))
          }
        };
      }
      return { data: { items: makeVideos(1) } };
    };

    const discovery = await request(server, "POST", "/api/creators/discover", {
      query: "  skincare creators  ",
      regionCode: "in",
      relevanceLanguage: "EN",
      maxResults: 2
    });
    assert.equal(discovery.statusCode, 200);
    assert.deepEqual(discovery.body.query, "skincare creators");
    assert.equal(discovery.body.candidates.length, 2);
    assert.deepEqual(discovery.body.candidates[0], {
      channelId: "UC5555555555555555555555",
      channelName: "Search Creator",
      description: "A creator found by the campaign query.",
      thumbnailUrl: "https://img.example.test/high.jpg",
      channelUrl: "https://www.youtube.com/channel/UC5555555555555555555555",
      source: "youtube_data_api",
      timestamp: discovery.body.timestamp
    });
    assert.equal(discovery.body.candidates[1].thumbnailUrl, null);
    assert.equal(discovery.body.source, "youtube_data_api");
    assert.equal(discovery.body.candidates[0].timestamp, discovery.body.timestamp);
    assert.match(discovery.body.quotaNote, /search\.list/);
    assert.deepEqual(discoveryRequest.params, {
      part: "snippet",
      q: "skincare creators",
      type: "channel",
      maxResults: 2,
      regionCode: "IN",
      relevanceLanguage: "en",
      key: "smoke-test-youtube-key"
    });

    const discoveryAxiosGet = axios.get;
    axios.get = async () => {
      const error = new Error("quota exceeded");
      error.response = {
        status: 403,
        data: {
          error: {
            errors: [{ reason: "quotaExceeded" }]
          }
        }
      };
      throw error;
    };
    const quotaDiscovery = await request(server, "POST", "/api/creators/discover", {
      query: "quota test"
    });
    assert.equal(quotaDiscovery.statusCode, 429);
    assert.equal(quotaDiscovery.body.error, "YouTube API quota is temporarily unavailable.");
    axios.get = discoveryAxiosGet;

    const scannerAxiosGet = axios.get;
    axios.get = async (url) => {
      if (url.endsWith("/channels")) {
        return {
          data: {
            items: [{
              id: "UC7777777777777777777777",
              snippet: { title: "Signal Creator" },
              contentDetails: { relatedPlaylists: { uploads: "signal-uploads" } }
            }]
          }
        };
      }
      if (url.endsWith("/playlistItems")) {
        return {
          data: {
            items: [{
              contentDetails: { videoId: "signal-video-api" },
              snippet: { title: "API signal", publishedAt: "2026-01-10T00:00:00.000Z" }
            }]
          }
        };
      }
      return {
        data: {
          items: [{
            id: "signal-video-api",
            snippet: {
              title: "API signal",
              publishedAt: "2026-01-10T00:00:00.000Z",
              description: "Paid partnership with Acme. Coupon code SAVE at https://acme.example/deal"
            }
          }]
        }
      };
    };
    const signalScan = await request(
      server,
      "POST",
      "/api/brands/sponsorship-signals",
      { channelUrl: "https://www.youtube.com/channel/UC7777777777777777777777" }
    );
    assert.equal(signalScan.statusCode, 201);
    assert.equal(signalScan.body.scan.channelId, "UC7777777777777777777777");
    assert.equal(signalScan.body.signals.length, 1);
    assert.equal(signalScan.body.signals[0].sourceType, "public_description_signal");
    assert.equal(signalScan.body.signals[0].detectedDomains[0], "acme.example");
    assert.equal(signalScan.body.scan.retentionNote.includes("30 days"), true);
    assert.equal(JSON.stringify(signalScan.body).includes("Paid partnership with Acme"), false);

    const listedSignalScans = await request(
      server,
      "GET",
      "/api/brands/sponsorship-signals?channelId=UC7777777777777777777777"
    );
    assert.equal(listedSignalScans.statusCode, 200);
    assert.equal(listedSignalScans.body.scans.length, 1);
    assert.equal(listedSignalScans.body.signals.length, 1);
    const deletedSignalScan = await request(
      server,
      "DELETE",
      `/api/brands/sponsorship-signals/${signalScan.body.scan.id}`
    );
    assert.equal(deletedSignalScan.statusCode, 204);
    axios.get = scannerAxiosGet;

    const analysed = await request(server, "POST", "/api/creators/analyse", {
      channelUrl: "@campaign-creator",
      campaignId,
      assumptions: { ctr: 2, conversionRate: 10 }
    });
    assert.equal(analysed.statusCode, 200);
    assert.equal(analysed.body.campaign.id, campaignId);
    assert.equal(analysed.body.summary.campaignId, campaignId);
    assert.equal(analysed.body.summary.estimates.campaignEconomics.expectedPurchases, 17.5);
    assert.equal(analysed.body.cacheHit, false);
    const requestsAfterRefresh = youtubeRequestCount;

    const trackingLinkResponse = await request(
      server,
      "POST",
      `/api/campaigns/${campaignId}/tracking-links`,
      {
        snapshotId: analysed.body.snapshotId,
        destinationUrl: "https://shop.example.test/glow-skin",
        actualFee: 400,
        token: "campaign-creator"
      }
    );
    assert.equal(trackingLinkResponse.statusCode, 201);
    assert.equal(trackingLinkResponse.body.trackingLink.snapshotId, analysed.body.snapshotId);
    assert.equal(trackingLinkResponse.body.trackingLink.actualFee, 400);

    const trackingLinkId = trackingLinkResponse.body.trackingLink.id;
    const clickEvent = await request(
      server,
      "POST",
      `/api/tracking-links/${trackingLinkId}/events`,
      { eventType: "click", idempotencyKey: "click-1" }
    );
    assert.equal(clickEvent.statusCode, 201);
    const duplicateClick = await request(
      server,
      "POST",
      `/api/tracking-links/${trackingLinkId}/events`,
      { eventType: "click", idempotencyKey: "click-1" }
    );
    assert.equal(duplicateClick.statusCode, 200);
    assert.equal(duplicateClick.body.idempotent, true);
    assert.equal(duplicateClick.body.event.id, clickEvent.body.event.id);

    const leadEvent = await request(
      server,
      "POST",
      `/api/tracking-links/${trackingLinkId}/events`,
      { eventType: "lead", idempotencyKey: "lead-1" }
    );
    assert.equal(leadEvent.statusCode, 201);
    const purchaseEvent = await request(
      server,
      "POST",
      `/api/tracking-links/${trackingLinkId}/events`,
      { eventType: "purchase", idempotencyKey: "purchase-1", amount: 1499 }
    );
    assert.equal(purchaseEvent.statusCode, 201);
    const refundEvent = await request(
      server,
      "POST",
      `/api/tracking-links/${trackingLinkId}/events`,
      { eventType: "refund", idempotencyKey: "refund-1", amount: 200 }
    );
    assert.equal(refundEvent.statusCode, 201);

    const performance = await request(
      server,
      "GET",
      `/api/campaigns/${campaignId}/performance`
    );
    assert.equal(performance.statusCode, 200);
    assert.equal(performance.body.performance.clicks, 1);
    assert.equal(performance.body.performance.leads, 1);
    assert.equal(performance.body.performance.purchases, 1);
    assert.equal(performance.body.performance.revenue, 1499);
    assert.equal(performance.body.performance.refunds, 200);
    assert.equal(performance.body.performance.actualCac, 400);
    assert.equal(performance.body.performance.actual.netRevenue, 1299);
    assert.equal(performance.body.performance.plannedVsActual.purchases.actual, 1);
    assert.equal(performance.body.performance.plannedVsActual.purchases.planned, 17.5);

    const intelligenceTimestamp = "2026-02-01T00:00:00.000Z";
    const audienceProfile = await request(
      server,
      "POST",
      "/api/creators/UC3333333333333333333333/audience-profile",
      {
        snapshotId: analysed.body.snapshotId,
        sourceType: "creator_authorized",
        retrievedAt: intelligenceTimestamp,
        confidence: 0.92,
        status: "verified",
        demographics: {
          age: { "18-24": 0.4, "25-34": 0.6 },
          countries: [{ name: "India", share: 0.8 }]
        }
      }
    );
    assert.equal(audienceProfile.statusCode, 201);
    assert.equal(audienceProfile.body.audienceProfile.channelId, "UC3333333333333333333333");
    assert.equal(audienceProfile.body.audienceProfile.sourceType, "creator_authorized");
    assert.equal(audienceProfile.body.audienceProfile.confidence, 0.92);
    assert.equal(audienceProfile.body.audienceProfile.data.demographics.countries[0].share, 0.8);

    const listedAudienceProfiles = await request(
      server,
      "GET",
      `/api/audience-profiles?channelId=UC3333333333333333333333&snapshotId=${analysed.body.snapshotId}`
    );
    assert.equal(listedAudienceProfiles.statusCode, 200);
    assert.equal(listedAudienceProfiles.body.audienceProfiles.length, 1);
    const audienceProfileId = audienceProfile.body.audienceProfile.id;
    const updatedAudienceProfile = await request(
      server,
      "PATCH",
      `/api/audience-profiles/${audienceProfileId}`,
      { status: "reviewed", confidence: 0.95 }
    );
    assert.equal(updatedAudienceProfile.statusCode, 200);
    assert.equal(updatedAudienceProfile.body.audienceProfile.status, "reviewed");
    assert.equal(updatedAudienceProfile.body.audienceProfile.data.demographics.age["18-24"], 0.4);

    const invalidAudienceProfile = await request(
      server,
      "POST",
      "/api/audience-profiles",
      {
        channelId: "UC3333333333333333333333",
        sourceType: "public_youtube_guess",
        retrievedAt: intelligenceTimestamp,
        confidence: 0.8,
        status: "draft",
        data: { countries: [] }
      }
    );
    assert.equal(invalidAudienceProfile.statusCode, 400);

    const qualityReview = await request(
      server,
      "POST",
      "/api/creators/UC3333333333333333333333/quality-review",
      {
        snapshotId: analysed.body.snapshotId,
        sourceType: "mangokast_review",
        retrievedAt: intelligenceTimestamp,
        confidence: 0.75,
        status: "needs_review",
        score: 72,
        notes: ["Brand safety review pending"]
      }
    );
    assert.equal(qualityReview.statusCode, 201);
    assert.equal(qualityReview.body.qualityReview.data.score, 72);

    const sponsorship = await request(
      server,
      "POST",
      "/api/creators/UC3333333333333333333333/sponsorships",
      {
        snapshotId: analysed.body.snapshotId,
        sourceType: "creator_supplied",
        retrievedAt: intelligenceTimestamp,
        confidence: 0.8,
        status: "reported",
        brandName: "Example Brand",
        campaignName: "Spring launch",
        outcome: "Tracked purchase campaign"
      }
    );
    assert.equal(sponsorship.statusCode, 201);
    assert.equal(sponsorship.body.sponsorshipRecord.data.brandName, "Example Brand");

    const deletedAudienceProfile = await request(
      server,
      "DELETE",
      `/api/audience-profiles/${audienceProfileId}`
    );
    assert.equal(deletedAudienceProfile.statusCode, 204);
    const missingAudienceProfile = await request(
      server,
      "GET",
      `/api/audience-profiles/${audienceProfileId}`
    );
    assert.equal(missingAudienceProfile.statusCode, 404);

    process.env.SHOPIFY_WEBHOOK_SECRET = "smoke-shopify-secret";
    const shopifyPurchase = {
      eventId: "shopify-order-1",
      eventType: "order",
      amount: 1499,
      currency: "USD",
      occurredAt: "2026-02-02T00:00:00.000Z",
      trackingToken: "campaign-creator"
    };
    const purchaseSignature = crypto
      .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(JSON.stringify(shopifyPurchase))
      .digest("base64");
    const shopifyPurchaseResponse = await request(
      server,
      "POST",
      "/api/webhooks/shopify",
      shopifyPurchase,
      { "X-Shopify-Hmac-Sha256": purchaseSignature }
    );
    assert.equal(shopifyPurchaseResponse.statusCode, 200);
    assert.equal(shopifyPurchaseResponse.body.created, true);
    assert.equal(shopifyPurchaseResponse.body.attributed, true);
    assert.equal(shopifyPurchaseResponse.body.attributionEvent.eventType, "purchase");

    const duplicateShopifyPurchase = await request(
      server,
      "POST",
      "/api/webhooks/shopify",
      shopifyPurchase,
      { "X-Shopify-Hmac-Sha256": purchaseSignature }
    );
    assert.equal(duplicateShopifyPurchase.statusCode, 200);
    assert.equal(duplicateShopifyPurchase.body.idempotent, true);
    assert.equal(duplicateShopifyPurchase.body.attributionEvent.id, shopifyPurchaseResponse.body.attributionEvent.id);

    const shopifyRefund = {
      eventId: "shopify-refund-1",
      type: "refund",
      amount: 200,
      currency: "USD",
      occurredAt: "2026-02-03T00:00:00.000Z",
      utm: { campaign: "campaign-creator" }
    };
    const refundSignature = crypto
      .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(JSON.stringify(shopifyRefund))
      .digest("base64");
    const shopifyRefundResponse = await request(
      server,
      "POST",
      "/api/webhooks/shopify",
      shopifyRefund,
      { "X-Shopify-Hmac-Sha256": refundSignature }
    );
    assert.equal(shopifyRefundResponse.statusCode, 200);
    assert.equal(shopifyRefundResponse.body.attributionEvent.eventType, "refund");

    const invalidSignature = await request(
      server,
      "POST",
      "/api/webhooks/shopify",
      { ...shopifyPurchase, eventId: "shopify-order-invalid-signature" },
      { "X-Shopify-Hmac-Sha256": "invalid" }
    );
    assert.equal(invalidSignature.statusCode, 401);

    const webhookPerformance = await request(
      server,
      "GET",
      `/api/campaigns/${campaignId}/performance`
    );
    assert.equal(webhookPerformance.statusCode, 200);
    assert.equal(webhookPerformance.body.performance.purchases, 2);
    assert.equal(webhookPerformance.body.performance.refunds, 400);

    const cachedAnalysis = await request(server, "POST", "/api/creators/analyse", {
      channelUrl: "@campaign-creator",
      campaignId,
      assumptions: { ctr: 2, conversionRate: 10 }
    });
    assert.equal(cachedAnalysis.statusCode, 200);
    assert.equal(cachedAnalysis.body.cacheHit, true);
    assert.equal(cachedAnalysis.body.snapshotId, analysed.body.snapshotId);
    assert.equal(youtubeRequestCount, requestsAfterRefresh);

    const forcedAnalysis = await request(server, "POST", "/api/creators/analyse", {
      channelUrl: "@campaign-creator",
      campaignId,
      assumptions: { ctr: 2, conversionRate: 10 },
      forceRefresh: true
    });
    assert.equal(forcedAnalysis.statusCode, 200);
    assert.equal(forcedAnalysis.body.cacheHit, false);
    assert.notEqual(forcedAnalysis.body.snapshotId, analysed.body.snapshotId);
    assert.ok(youtubeRequestCount > requestsAfterRefresh);

    const snapshots = await request(server, "GET", "/api/creators/snapshots");
    assert.equal(snapshots.statusCode, 200);
    assert.equal(snapshots.body.snapshots.length, 4);
    assert.ok(snapshots.body.snapshots[0].youtubeMetrics);
    assert.ok(snapshots.body.snapshots[0].estimates);
    const persistedAnalysis = snapshots.body.snapshots.find(
      (snapshot) => snapshot.id === analysed.body.snapshotId
    );
    assert.equal(persistedAnalysis.campaignId, campaignId);
    assert.equal(
      persistedAnalysis.estimates.campaignEconomics.expectedCacRange.max,
      35.71
    );

    const invalidAnalysis = await request(
      server,
      "POST",
      "/api/creators/analyse",
      { channelUrl: "https://example.com/not-youtube" }
    );
    assert.equal(invalidAnalysis.statusCode, 400);

    const comparison = await request(
      server,
      "POST",
      "/api/creators/snapshots/compare",
      { snapshotIds: [firstSnapshot.lastInsertRowid, secondSnapshot.lastInsertRowid] }
    );
    assert.equal(comparison.statusCode, 200);
    assert.deepEqual(comparison.body.snapshotIds, [1, 2]);
    assert.equal(comparison.body.snapshots.length, 2);
    assert.equal(comparison.body.comparison.expectedRelevantViews[0].snapshotId, 2);

    const invalid = await request(
      server,
      "POST",
      "/api/creators/snapshots/compare",
      { snapshotIds: [firstSnapshot.lastInsertRowid] }
    );
    assert.equal(invalid.statusCode, 400);
  } finally {
    axios.get = originalAxiosGet;
    if (originalYoutubeApiKey === undefined) {
      delete process.env.YOUTUBE_API_KEY;
    } else {
      process.env.YOUTUBE_API_KEY = originalYoutubeApiKey;
    }
    if (originalShopifyWebhookSecret === undefined) {
      delete process.env.SHOPIFY_WEBHOOK_SECRET;
    } else {
      process.env.SHOPIFY_WEBHOOK_SECRET = originalShopifyWebhookSecret;
    }
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
  }

  console.log("Mangokast API smoke check passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
