require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("node:crypto");

const {
  analyseChannel,
  discoverCreators,
  extractChannelId,
  extractHandle,
  scanChannelPublicSponsorshipSignals
} = require("./youtube");

const {
  saveSnapshot,
  getSnapshots,
  getSnapshotsByIds,
  createCampaign,
  getCampaigns,
  getCampaignById,
  getSnapshotById,
  createTrackingLink,
  getTrackingLinkById,
  getTrackingLinkByToken,
  getTrackingLinksByCampaignId,
  recordAttributionEvent,
  getCampaignPerformance,
  getCachedAnalysis,
  saveAnalysisCache,
  createAudienceProfile,
  getAudienceProfiles,
  getAudienceProfileById,
  updateAudienceProfile,
  deleteAudienceProfile,
  createQualityReview,
  getQualityReviews,
  getQualityReviewById,
  updateQualityReview,
  deleteQualityReview,
  createSponsorshipRecord,
  getSponsorshipRecords,
  getSponsorshipRecordById,
  updateSponsorshipRecord,
  deleteSponsorshipRecord,
  savePublicSponsorshipSignalScan,
  getPublicSponsorshipSignalScans,
  getPublicSponsorshipSignalScanById,
  deletePublicSponsorshipSignalScan,
  ingestShopifyEvent
} = require("./database");

const app = express();

const EVENT_TYPES = new Set(["click", "lead", "purchase", "refund"]);
const MAX_EVENT_KEY_LENGTH = 200;
const MAX_METADATA_BYTES = 4096;
const MAX_EVENT_AMOUNT = 1_000_000_000;
const MAX_MONEY = 1_000_000_000_000;
const MAX_EVENTS = 1_000_000_000;
const DEFAULT_ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER =
  "This is not verified sponsorship history.";
const PUBLIC_SPONSORSHIP_SIGNAL_RETENTION_NOTE =
  "Refresh or delete public description signals within 30 days; raw descriptions are never stored.";
const CREATOR_INTELLIGENCE_SOURCE_TYPES = new Set([
  "creator_authorized",
  "creator_supplied",
  "provider",
  "mangokast_review"
]);

app.use(cors());

// Shopify signs the exact request bytes. Keep this route ahead of the global
// JSON parser so verification does not depend on JSON serialization details.
app.post(
  ["/api/webhooks/shopify", "/api/webhooks/shopify/orders", "/api/webhooks/shopify/refunds"],
  express.raw({ type: "application/json", limit: "256kb" }),
  handleShopifyWebhook
);
app.use(express.json({ limit: "32kb" }));

app.get("/health", (request, response) => {
  response.json({
    ok: true,
    service: "Mangokast API"
  });
});

app.post("/api/campaigns", (request, response) => {
  try {
    const campaign = validateCampaignInput(request.body || {});
    const savedCampaign = createCampaign(campaign);
    return response.status(201).json({ campaign: savedCampaign });
  } catch (error) {
    return sendError(response, error);
  }
});

app.get("/api/campaigns", (request, response) => {
  try {
    return response.json({ campaigns: getCampaigns() });
  } catch (error) {
    return sendError(response, error);
  }
});

app.get("/api/campaigns/active", (request, response) => {
  try {
    const campaign = getCampaigns()[0] || null;
    return response.json({ campaign });
  } catch (error) {
    return sendError(response, error);
  }
});

app.get("/api/campaigns/:campaignId", (request, response) => {
  try {
    const campaignId = parsePositiveId(request.params.campaignId, "campaignId");
    const campaign = getCampaignById(campaignId);

    if (!campaign) {
      return response.status(404).json({ error: "Campaign not found." });
    }

    return response.json({ campaign });
  } catch (error) {
    return sendError(response, error);
  }
});

app.post("/api/campaigns/:campaignId/tracking-links", (request, response) => {
  return createCampaignTrackingLink(request, response, request.params.campaignId);
});

app.get("/api/campaigns/:campaignId/tracking-links", (request, response) => {
  try {
    const campaignId = parsePositiveId(request.params.campaignId, "campaignId");
    if (!getCampaignById(campaignId)) {
      return response.status(404).json({ error: "Campaign not found." });
    }
    return response.json({ trackingLinks: getTrackingLinksByCampaignId(campaignId) });
  } catch (error) {
    return sendError(response, error);
  }
});

// This collection form is useful for API clients that already carry the
// campaign ID in their request body. The campaign-scoped route above remains
// the canonical form.
app.post("/api/tracking-links", (request, response) => {
  return createCampaignTrackingLink(
    request,
    response,
    request.body?.campaignId ?? request.body?.campaign_id
  );
});

app.post("/api/tracking-links/:trackingLinkId/events", (request, response) => {
  return createAttributionEvent(request, response, request.params.trackingLinkId);
});

app.post("/api/tracking-links/:trackingLinkId/attribution-events", (request, response) => {
  return createAttributionEvent(request, response, request.params.trackingLinkId);
});

app.post("/api/tracking-links/:trackingLinkId/event", (request, response) => {
  return createAttributionEvent(request, response, request.params.trackingLinkId);
});

app.post("/api/attribution/events", (request, response) => {
  try {
    const trackingLinkId = request.body?.trackingLinkId ?? request.body?.linkId;
    if (trackingLinkId !== undefined) {
      return createAttributionEvent(request, response, trackingLinkId);
    }

    const token = request.body?.trackingLinkToken ?? request.body?.token;
    if (typeof token !== "string" || token.trim().length === 0) {
      return response.status(400).json({ error: "trackingLinkId or trackingLinkToken is required." });
    }
    const trackingLink = getTrackingLinkByToken(token.trim());
    if (!trackingLink) {
      return response.status(404).json({ error: "Tracking link not found." });
    }
    return createAttributionEvent(request, response, trackingLink.id);
  } catch (error) {
    return sendError(response, error);
  }
});

app.post("/api/campaigns/:campaignId/tracking-links/:trackingLinkId/events", (request, response) => {
  return createAttributionEvent(
    request,
    response,
    request.params.trackingLinkId,
    request.params.campaignId
  );
});

app.get("/api/tracking-links/:trackingLinkId", (request, response) => {
  try {
    const trackingLinkId = parsePositiveId(request.params.trackingLinkId, "trackingLinkId");
    const trackingLink = getTrackingLinkById(trackingLinkId);
    if (!trackingLink) {
      return response.status(404).json({ error: "Tracking link not found." });
    }
    return response.json({ trackingLink });
  } catch (error) {
    return sendError(response, error);
  }
});

app.get("/api/tracking-links/by-token/:token", (request, response) => {
  try {
    const trackingLink = getTrackingLinkByToken(request.params.token);
    if (!trackingLink) {
      return response.status(404).json({ error: "Tracking link not found." });
    }
    return response.json({ trackingLink });
  } catch (error) {
    return sendError(response, error);
  }
});

app.get("/t/:token", (request, response) => {
  try {
    const trackingLink = getTrackingLinkByToken(request.params.token);
    if (!trackingLink) {
      return response.status(404).json({ error: "Tracking link not found." });
    }

    recordAttributionEvent({
      trackingLinkId: trackingLink.id,
      eventKey: `visit-${crypto.randomUUID()}`,
      eventType: "click",
      amount: null,
      currency: trackingLink.currency,
      occurredAt: new Date().toISOString(),
      metadata: { source: "tracking_link_redirect" },
      createdAt: new Date().toISOString()
    });
    return response.redirect(302, trackingLink.destinationUrl);
  } catch (error) {
    return sendError(response, error);
  }
});

app.get("/api/campaigns/:campaignId/performance", (request, response) => {
  return getCampaignPerformanceSummary(request, response);
});

app.get("/api/campaigns/:campaignId/attribution", (request, response) => {
  return getCampaignPerformanceSummary(request, response);
});

app.get("/api/campaigns/:campaignId/summary", (request, response) => {
  return getCampaignPerformanceSummary(request, response);
});

app.post("/api/creators/analyse", async (request, response) => {
  try {
    const { channelUrl } = request.body || {};

    if (
      typeof channelUrl !== "string" ||
      channelUrl.trim().length === 0 ||
      channelUrl.length > 2048
    ) {
      return response.status(400).json({
        error: "channelUrl must be a non-empty YouTube channel URL, channel ID, or @handle."
      });
    }

    const campaignId = parseOptionalPositiveId(request.body?.campaignId, "campaignId");
    const campaign = campaignId === null ? null : getCampaignById(campaignId);

    if (campaignId !== null && !campaign) {
      return response.status(404).json({ error: "Campaign not found." });
    }

    const assumptions = validateAnalysisAssumptions(request.body?.assumptions || request.body || {});
    const forceRefresh = parseBoolean(
      request.body?.forceRefresh ?? request.query.forceRefresh ?? false,
      "forceRefresh"
    );
    const channelKeys = [
      extractChannelId(channelUrl.trim()),
      extractHandle(channelUrl.trim())
    ].filter(Boolean);
    const cacheTtlMs = getAnalysisCacheTtlMs();

    if (!forceRefresh && channelKeys.length > 0) {
      const cached = getCachedAnalysis({
        campaignId,
        channelKeys,
        ttlMs: cacheTtlMs
      });

      if (cached) {
        return response.json({
          ...cached.result,
          campaign: campaign || undefined,
          snapshotId: cached.snapshotId,
          cacheHit: true,
          cachedAt: cached.cachedAt,
          analysisCacheTtlMs: cacheTtlMs
        });
      }
    }

    const result = await analyseChannel(
      channelUrl.trim(),
      campaign ? { campaign, assumptions } : undefined
    );

    const savedSnapshot = saveSnapshot(result.summary, campaignId);
    const snapshotId = Number(savedSnapshot.lastInsertRowid);
    saveAnalysisCache({
      campaignId,
      channelKeys: [
        ...channelKeys,
        result.summary.channelId
      ],
      channelId: result.summary.channelId,
      snapshotId,
      result,
      analysedAt: result.summary.retrievedAt
    });

    return response.json({
      ...result,
      campaign: campaign || undefined,
      snapshotId,
      cacheHit: false,
      analysisCacheTtlMs: cacheTtlMs
    });
  } catch (error) {
    return sendError(response, error);
  }
});

app.post("/api/creators/discover", async (request, response) => {
  try {
    const result = await discoverCreators(request.body || {});
    return response.json(result);
  } catch (error) {
    return sendError(response, error);
  }
});

// This scanner is deliberately separate from creator-supplied sponsorship
// history. It only derives compact, clearly labelled signals from descriptions
// returned by the official videos.list API call; it does not verify a deal.
app.post(
  [
    "/api/brands/sponsorship-signals/scan",
    "/api/brands/public-sponsorship-signals/scan",
    "/api/creators/sponsorship-signals/scan",
    "/api/creators/public-sponsorship-signals/scan",
    "/api/brands/sponsorship-signals",
    "/api/brands/public-sponsorship-signals",
    "/api/creators/sponsorship-signals",
    "/api/creators/public-sponsorship-signals"
  ],
  (request, response) => scanPublicSponsorshipSignalsRoute(request, response)
);

app.post(
  [
    "/api/brands/:channelId/sponsorship-signals",
    "/api/creators/:channelId/sponsorship-signals",
    "/api/creators/:channelId/public-sponsorship-signals"
  ],
  (request, response) => scanPublicSponsorshipSignalsRoute(
    request,
    response,
    request.params.channelId
  )
);

app.get(
  [
    "/api/brands/sponsorship-signals",
    "/api/brands/public-sponsorship-signals",
    "/api/creators/sponsorship-signals",
    "/api/creators/public-sponsorship-signals"
  ],
  (request, response) => listPublicSponsorshipSignalsRoute(request, response)
);

app.get(
  [
    "/api/brands/:channelId/sponsorship-signals",
    "/api/creators/:channelId/sponsorship-signals",
    "/api/creators/:channelId/public-sponsorship-signals"
  ],
  (request, response) => listPublicSponsorshipSignalsRoute(
    request,
    response,
    request.params.channelId
  )
);

app.get(
  [
    "/api/brands/sponsorship-signals/:scanId",
    "/api/brands/public-sponsorship-signals/:scanId",
    "/api/creators/sponsorship-signals/:scanId",
    "/api/creators/public-sponsorship-signals/:scanId"
  ],
  (request, response) => getPublicSponsorshipSignalScanRoute(request, response)
);

app.delete(
  [
    "/api/brands/sponsorship-signals/:scanId",
    "/api/brands/public-sponsorship-signals/:scanId",
    "/api/creators/sponsorship-signals/:scanId",
    "/api/creators/public-sponsorship-signals/:scanId"
  ],
  (request, response) => deletePublicSponsorshipSignalScanRoute(request, response)
);

app.get("/api/creators/snapshots", (request, response) => {
  try {
    const ids = parseSnapshotIds(request.query.ids);
    const snapshots = ids ? getSnapshotsByIds(ids) : getSnapshots();

    return response.json({ snapshots });
  } catch (error) {
    return sendError(response, error);
  }
});

app.post("/api/creators/snapshots/compare", (request, response) => {
  try {
    const ids = parseSnapshotIds(request.body?.snapshotIds, {
      required: true,
      minimum: 2,
      maximum: 10
    });
    const snapshots = getSnapshotsByIds(ids);

    if (snapshots.length !== ids.length) {
      const found = new Set(snapshots.map((snapshot) => snapshot.id));
      const missingIds = ids.filter((id) => !found.has(id));
      return response.status(404).json({
        error: "One or more snapshots were not found.",
        missingIds
      });
    }

    return response.json({
      snapshotIds: ids,
      snapshots,
      comparison: buildComparison(snapshots)
    });
  } catch (error) {
    return sendError(response, error);
  }
});

// Creator intelligence is intentionally supplied by an authorized creator,
// creator, provider, or Mangokast review. It is never inferred from public
// YouTube API fields by these endpoints.
app.post(["/api/audience-profiles", "/api/creators/audience-profiles"], (request, response) => {
  return createAudienceProfileRoute(request, response);
});

app.get(["/api/audience-profiles", "/api/creators/audience-profiles"], (request, response) => {
  return listCreatorIntelligenceRoute(
    request,
    response,
    getAudienceProfiles,
    "audienceProfiles"
  );
});

app.get(["/api/audience-profiles/:profileId", "/api/creators/audience-profiles/:profileId"], (request, response) => {
  return getCreatorIntelligenceRoute(
    request,
    response,
    getAudienceProfileById,
    "audienceProfile",
    "profileId"
  );
});

app.patch(["/api/audience-profiles/:profileId", "/api/creators/audience-profiles/:profileId"], (request, response) => {
  return updateCreatorIntelligenceRoute(
    request,
    response,
    updateAudienceProfile,
    getAudienceProfileById,
    "audienceProfile",
    "profileId"
  );
});

app.put(["/api/audience-profiles/:profileId", "/api/creators/audience-profiles/:profileId"], (request, response) => {
  return updateCreatorIntelligenceRoute(
    request,
    response,
    updateAudienceProfile,
    getAudienceProfileById,
    "audienceProfile",
    "profileId"
  );
});

app.delete(["/api/audience-profiles/:profileId", "/api/creators/audience-profiles/:profileId"], (request, response) => {
  return deleteCreatorIntelligenceRoute(
    request,
    response,
    deleteAudienceProfile,
    "profileId"
  );
});

app.post(
  [
    "/api/creators/:channelId/audience-profile",
    "/api/creators/:channelId/audience",
    "/api/creators/:channelId/audience-demographics"
  ],
  (request, response) => createAudienceProfileRoute(request, response, request.params.channelId)
);

app.get(
  [
    "/api/creators/:channelId/audience-profile",
    "/api/creators/:channelId/audience",
    "/api/creators/:channelId/audience-demographics"
  ],
  (request, response) => listCreatorIntelligenceRoute(
    request,
    response,
    getAudienceProfiles,
    "audienceProfiles",
    request.params.channelId
  )
);

app.post(["/api/quality-reviews", "/api/creators/quality-reviews"], (request, response) => {
  return createQualityReviewRoute(request, response);
});

app.get(["/api/quality-reviews", "/api/creators/quality-reviews"], (request, response) => {
  return listCreatorIntelligenceRoute(request, response, getQualityReviews, "qualityReviews");
});

app.get(["/api/quality-reviews/:reviewId", "/api/creators/quality-reviews/:reviewId"], (request, response) => {
  return getCreatorIntelligenceRoute(request, response, getQualityReviewById, "qualityReview", "reviewId");
});

app.patch(["/api/quality-reviews/:reviewId", "/api/creators/quality-reviews/:reviewId"], (request, response) => {
  return updateCreatorIntelligenceRoute(request, response, updateQualityReview, getQualityReviewById, "qualityReview", "reviewId");
});

app.put(["/api/quality-reviews/:reviewId", "/api/creators/quality-reviews/:reviewId"], (request, response) => {
  return updateCreatorIntelligenceRoute(request, response, updateQualityReview, getQualityReviewById, "qualityReview", "reviewId");
});

app.delete(["/api/quality-reviews/:reviewId", "/api/creators/quality-reviews/:reviewId"], (request, response) => {
  return deleteCreatorIntelligenceRoute(request, response, deleteQualityReview, "reviewId");
});

app.post(
  [
    "/api/creators/:channelId/quality-review",
    "/api/creators/:channelId/audience-quality",
    "/api/creators/:channelId/quality"
  ],
  (request, response) => createQualityReviewRoute(request, response, request.params.channelId)
);

app.get(
  [
    "/api/creators/:channelId/quality-review",
    "/api/creators/:channelId/audience-quality",
    "/api/creators/:channelId/quality"
  ],
  (request, response) => listCreatorIntelligenceRoute(
    request,
    response,
    getQualityReviews,
    "qualityReviews",
    request.params.channelId
  )
);

app.post(["/api/sponsorship-records", "/api/creators/sponsorship-records", "/api/creators/sponsorships"], (request, response) => {
  return createSponsorshipRoute(request, response);
});

app.get(["/api/sponsorship-records", "/api/creators/sponsorship-records", "/api/creators/sponsorships"], (request, response) => {
  return listCreatorIntelligenceRoute(request, response, getSponsorshipRecords, "sponsorships");
});

app.get(["/api/sponsorship-records/:sponsorshipId", "/api/creators/sponsorship-records/:sponsorshipId"], (request, response) => {
  return getCreatorIntelligenceRoute(request, response, getSponsorshipRecordById, "sponsorship", "sponsorshipId");
});

app.patch(["/api/sponsorship-records/:sponsorshipId", "/api/creators/sponsorship-records/:sponsorshipId"], (request, response) => {
  return updateCreatorIntelligenceRoute(request, response, updateSponsorshipRecord, getSponsorshipRecordById, "sponsorship", "sponsorshipId");
});

app.put(["/api/sponsorship-records/:sponsorshipId", "/api/creators/sponsorship-records/:sponsorshipId"], (request, response) => {
  return updateCreatorIntelligenceRoute(request, response, updateSponsorshipRecord, getSponsorshipRecordById, "sponsorship", "sponsorshipId");
});

app.delete(["/api/sponsorship-records/:sponsorshipId", "/api/creators/sponsorship-records/:sponsorshipId"], (request, response) => {
  return deleteCreatorIntelligenceRoute(request, response, deleteSponsorshipRecord, "sponsorshipId");
});

app.post(
  [
    "/api/creators/:channelId/sponsorships",
    "/api/creators/:channelId/sponsorship-records",
    "/api/creators/:channelId/past-sponsorships"
  ],
  (request, response) => createSponsorshipRoute(request, response, request.params.channelId)
);

app.get(
  [
    "/api/creators/:channelId/sponsorships",
    "/api/creators/:channelId/sponsorship-records",
    "/api/creators/:channelId/past-sponsorships"
  ],
  (request, response) => listCreatorIntelligenceRoute(
    request,
    response,
    getSponsorshipRecords,
    "sponsorships",
    request.params.channelId
  )
);

app.use((request, response) => {
  response.status(404).json({ error: "Route not found." });
});

app.use((error, request, response, next) => {
  if (error instanceof SyntaxError && error.status === 400 && error.type === "entity.parse.failed") {
    return response.status(400).json({ error: "Request body must be valid JSON." });
  }

  return sendError(response, error);
});

function createCampaignTrackingLink(request, response, campaignIdValue) {
  try {
    const campaignId = parsePositiveId(campaignIdValue, "campaignId");
    const campaign = getCampaignById(campaignId);
    if (!campaign) {
      return response.status(404).json({ error: "Campaign not found." });
    }

    const snapshotId = parsePositiveId(
      request.body?.snapshotId
        ?? request.body?.creatorSnapshotId
        ?? request.body?.snapshot_id
        ?? request.body?.creator_snapshot_id,
      "snapshotId"
    );
    const snapshot = getSnapshotById(snapshotId);
    if (!snapshot) {
      return response.status(404).json({ error: "Creator snapshot not found." });
    }

    const link = validateTrackingLinkInput(request.body || {}, campaign, snapshot);
    const trackingLink = createTrackingLink({
      campaignId,
      snapshotId,
      ...link
    });

    return response.status(201).json({ trackingLink, link: trackingLink });
  } catch (error) {
    if (String(error.code || "").includes("SQLITE_CONSTRAINT_UNIQUE")) {
      return response.status(409).json({ error: "A tracking link with that code already exists." });
    }
    return sendError(response, error);
  }
}

function createAttributionEvent(request, response, trackingLinkIdValue, campaignIdValue) {
  try {
    const trackingLinkId = typeof trackingLinkIdValue === "string" && !/^\d+$/.test(trackingLinkIdValue.trim())
      ? null
      : parsePositiveId(trackingLinkIdValue, "trackingLinkId");
    const trackingLink = trackingLinkId === null
      ? getTrackingLinkByToken(String(trackingLinkIdValue).trim())
      : getTrackingLinkById(trackingLinkId);
    if (!trackingLink) {
      return response.status(404).json({ error: "Tracking link not found." });
    }

    if (campaignIdValue !== undefined && campaignIdValue !== null) {
      const campaignId = parsePositiveId(campaignIdValue, "campaignId");
      if (trackingLink.campaignId !== campaignId) {
        return response.status(404).json({ error: "Tracking link not found for this campaign." });
      }
    }

    const campaign = getCampaignById(trackingLink.campaignId);
    const event = validateAttributionEventInput(request.body || {}, trackingLink, campaign);
    const result = recordAttributionEvent({
      trackingLinkId: trackingLink.id,
      ...event
    });

    return response.status(result.created ? 201 : 200).json({
      event: result.event,
      idempotent: !result.created,
      created: result.created
    });
  } catch (error) {
    return sendError(response, error);
  }
}

function getCampaignPerformanceSummary(request, response) {
  try {
    const campaignId = parsePositiveId(request.params.campaignId, "campaignId");
    const performance = getCampaignPerformance(campaignId);
    if (!performance) {
      return response.status(404).json({ error: "Campaign not found." });
    }
    return response.json({ performance, ...performance });
  } catch (error) {
    return sendError(response, error);
  }
}

function validateTrackingLinkInput(body, campaign, snapshot) {
  const destinationUrl = requiredText(
    body.destinationUrl
      ?? body.destination_url
      ?? body.url
      ?? body.landingUrl
      ?? body.landing_page_url
      ?? campaign.destinationUrl,
    "destinationUrl",
    2048
  );
  let parsedUrl;
  try {
    parsedUrl = new URL(destinationUrl);
  } catch (error) {
    throw httpError("destinationUrl must be a valid HTTP or HTTPS URL.", 400);
  }
  if (!/^https?:$/.test(parsedUrl.protocol) || !parsedUrl.hostname) {
    throw httpError("destinationUrl must be a valid HTTP or HTTPS URL.", 400);
  }

  const customToken = body.token ?? body.code ?? body.trackingCode;
  if (customToken !== undefined && (
    typeof customToken !== "string" ||
    !/^[A-Za-z0-9_-]{6,128}$/.test(customToken)
  )) {
    throw httpError("token must contain 6-128 letters, numbers, underscores, or hyphens.", 400);
  }

  const economics = snapshot.estimates?.campaignEconomics || {};
  const estimatedFeeRange = snapshot.estimates?.estimatedFeeRange || {};
  const estimatedFee = economics.totalEstimatedSpend || {
    min: finiteOrNull(estimatedFeeRange.min) === null
      ? null
      : finiteOrNull(estimatedFeeRange.min) * (campaign.currency === "INR" ? 84 : 1),
    max: finiteOrNull(estimatedFeeRange.max) === null
      ? null
      : finiteOrNull(estimatedFeeRange.max) * (campaign.currency === "INR" ? 84 : 1)
  };
  const plannedFeeObject = body.plannedFee && typeof body.plannedFee === "object"
    ? body.plannedFee
    : null;
  const explicitPlannedFee = body.plannedFee !== undefined && !plannedFeeObject
    ? requiredNumber(body.plannedFee, "plannedFee", { maximum: MAX_MONEY })
    : null;
  const plannedFeeMin = body.plannedFeeMin !== undefined
    ? requiredNumber(body.plannedFeeMin, "plannedFeeMin", { maximum: MAX_MONEY })
    : explicitPlannedFee ?? (plannedFeeObject?.min !== undefined
      ? requiredNumber(plannedFeeObject.min, "plannedFee.min", { maximum: MAX_MONEY })
      : finiteOrNull(estimatedFee.min));
  const plannedFeeMax = body.plannedFeeMax !== undefined
    ? requiredNumber(body.plannedFeeMax, "plannedFeeMax", { maximum: MAX_MONEY })
    : explicitPlannedFee ?? (plannedFeeObject?.max !== undefined
      ? requiredNumber(plannedFeeObject.max, "plannedFee.max", { maximum: MAX_MONEY })
      : finiteOrNull(estimatedFee.max));

  if (
    plannedFeeMin !== null && plannedFeeMax !== null &&
    plannedFeeMin > plannedFeeMax
  ) {
    throw httpError("plannedFeeMin cannot be greater than plannedFeeMax.", 400);
  }

  const plannedCacObject = body.plannedCac && typeof body.plannedCac === "object"
    ? body.plannedCac
    : null;
  const explicitPlannedCac = body.plannedCac !== undefined && !plannedCacObject
    ? requiredNumber(body.plannedCac, "plannedCac", { maximum: MAX_MONEY })
    : null;
  const plannedCacMin = body.plannedCacMin !== undefined
    ? requiredNumber(body.plannedCacMin, "plannedCacMin", { maximum: MAX_MONEY })
    : explicitPlannedCac ?? (plannedCacObject?.min !== undefined
      ? requiredNumber(plannedCacObject.min, "plannedCac.min", { maximum: MAX_MONEY })
      : finiteOrNull(economics.expectedCacRange?.min));
  const plannedCacMax = body.plannedCacMax !== undefined
    ? requiredNumber(body.plannedCacMax, "plannedCacMax", { maximum: MAX_MONEY })
    : explicitPlannedCac ?? (plannedCacObject?.max !== undefined
      ? requiredNumber(plannedCacObject.max, "plannedCac.max", { maximum: MAX_MONEY })
      : finiteOrNull(economics.expectedCacRange?.max));

  if (
    plannedCacMin !== null && plannedCacMax !== null &&
    plannedCacMin > plannedCacMax
  ) {
    throw httpError("plannedCacMin cannot be greater than plannedCacMax.", 400);
  }

  const plannedPurchases = body.plannedPurchases !== undefined
    ? requiredNumber(body.plannedPurchases, "plannedPurchases", { maximum: MAX_EVENTS })
    : finiteOrNull(economics.expectedPurchases);
  const plannedRevenue = body.plannedRevenue !== undefined
    ? requiredNumber(body.plannedRevenue, "plannedRevenue", { maximum: MAX_MONEY })
    : plannedPurchases === null
      ? null
      : Number((plannedPurchases * campaign.productPrice).toFixed(2));
  const actualFeeInput = firstDefined(
    body.actualFee,
    body.actual_fee,
    body.actualSpend,
    body.spend,
    body.fee
  );

  return {
    token: customToken,
    destinationUrl,
    channelId: snapshot.channelId,
    channelName: snapshot.channelName,
    plannedFeeMin,
    plannedFeeMax,
    plannedCacMin,
    plannedCacMax,
    plannedClicks: body.plannedClicks === undefined
      ? finiteOrNull(economics.expectedClicks)
      : requiredNumber(body.plannedClicks, "plannedClicks", { maximum: MAX_EVENTS }),
    plannedLeads: body.plannedLeads === undefined
      ? null
      : requiredNumber(body.plannedLeads, "plannedLeads", { maximum: MAX_EVENTS }),
    plannedPurchases,
    plannedRevenue,
    actualFee: actualFeeInput === undefined || actualFeeInput === null || actualFeeInput === ""
      ? null
      : requiredNumber(actualFeeInput, "actualFee", { maximum: MAX_MONEY }),
    currency: campaign.currency,
    createdAt: new Date().toISOString()
  };
}

function validateAttributionEventInput(body, trackingLink, campaign) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("An attribution event object is required.", 400);
  }

  const eventType = String(
    body.eventType ?? body.event_type ?? body.type ?? body.event ?? ""
  ).trim().toLowerCase();
  if (!EVENT_TYPES.has(eventType)) {
    throw httpError("eventType must be one of click, lead, purchase, or refund.", 400);
  }

  const rawEventKey = body.idempotencyKey
    ?? body.idempotency_key
    ?? body.eventId
    ?? body.event_id
    ?? body.externalId
    ?? body.key
    ?? body.id;
  const eventKey = typeof rawEventKey === "number" && Number.isSafeInteger(rawEventKey)
    ? String(rawEventKey)
    : rawEventKey;
  if (
    typeof eventKey !== "string" ||
    eventKey.trim().length === 0 ||
    eventKey.length > MAX_EVENT_KEY_LENGTH
  ) {
    throw httpError("idempotencyKey (or eventId) must be a non-empty string of at most 200 characters.", 400);
  }

  const amountInput = firstDefined(
    body.amount,
    body.revenue,
    body.orderValue,
    body.value,
    eventType === "refund" ? body.refundAmount : undefined
  );
  let amount = null;
  if (eventType === "purchase" || eventType === "refund") {
    if (amountInput === undefined || amountInput === null || amountInput === "") {
      throw httpError(`${eventType} events require a positive amount.`, 400);
    }
    amount = requiredNumber(amountInput, "amount", {
      minimum: 0.01,
      maximum: MAX_EVENT_AMOUNT
    });
  } else if (amountInput !== undefined && amountInput !== null && amountInput !== "") {
    throw httpError("click and lead events must not include an amount.", 400);
  }

  const occurredAt = body.occurredAt
    ?? body.occurred_at
    ?? body.timestamp
    ?? new Date().toISOString();
  if (
    typeof occurredAt !== "string" ||
    occurredAt.length > 64 ||
    !Number.isFinite(Date.parse(occurredAt))
  ) {
    throw httpError("occurredAt must be a valid ISO date.", 400);
  }

  const metadata = body.metadata ?? null;
  if (metadata !== null && (typeof metadata !== "object" || Array.isArray(metadata))) {
    throw httpError("metadata must be a JSON object.", 400);
  }
  if (
    metadata !== null &&
    Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES
  ) {
    throw httpError(`metadata must be at most ${MAX_METADATA_BYTES} bytes.`, 400);
  }

  const currency = body.currency === undefined || body.currency === null
    ? trackingLink.currency
    : normalizeCurrency(body.currency);
  if (currency !== trackingLink.currency || currency !== campaign.currency) {
    throw httpError(`currency must match the campaign currency (${campaign.currency}).`, 400);
  }

  return {
    eventKey: eventKey.trim(),
    eventType,
    amount,
    currency,
    occurredAt,
    metadata,
    createdAt: new Date().toISOString()
  };
}

function parseBoolean(value, fieldName) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) {
    return value.toLowerCase() === "true";
  }
  throw httpError(`${fieldName} must be true or false.`, 400);
}

function getAnalysisCacheTtlMs() {
  const rawMilliseconds = process.env.MANGOKAST_ANALYSIS_CACHE_TTL_MS
    ?? process.env.MANGOKAST_CREATOR_ANALYSIS_CACHE_TTL_MS
    ?? process.env.CREATOR_ANALYSIS_CACHE_TTL_MS;
  const rawHours = process.env.MANGOKAST_ANALYSIS_CACHE_TTL_HOURS
    ?? process.env.MANGOKAST_CREATOR_ANALYSIS_CACHE_TTL_HOURS
    ?? process.env.CREATOR_ANALYSIS_CACHE_TTL_HOURS;
  const value = rawMilliseconds !== undefined
    ? Number(rawMilliseconds)
    : rawHours !== undefined
      ? Number(rawHours) * 60 * 60 * 1000
      : DEFAULT_ANALYSIS_CACHE_TTL_MS;
  return Number.isFinite(value) && value >= 0 && value <= MAX_CACHE_TTL_MS
    ? value
    : DEFAULT_ANALYSIS_CACHE_TTL_MS;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function finiteOrNull(value) {
  return value === undefined || value === null || !Number.isFinite(Number(value))
    ? null
    : Number(value);
}

function parseSnapshotIds(value, options = {}) {
  if (value === undefined && !options.required) {
    return null;
  }

  const rawIds = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;

  if (!rawIds || rawIds.length === 0) {
    throw httpError("snapshotIds must contain positive integer IDs.", 400);
  }

  const ids = rawIds.map((value) => {
    if (
      typeof value !== "number" &&
      !(typeof value === "string" && /^\d+$/.test(value.trim()))
    ) {
      throw httpError("snapshotIds must contain positive integer IDs.", 400);
    }

    const id = Number(value);

    if (!Number.isSafeInteger(id) || id <= 0) {
      throw httpError("snapshotIds must contain positive integer IDs.", 400);
    }

    return id;
  });

  if (new Set(ids).size !== ids.length) {
    throw httpError("snapshotIds must not contain duplicates.", 400);
  }

  if (options.minimum && ids.length < options.minimum) {
    throw httpError(`Select at least ${options.minimum} snapshots to compare.`, 400);
  }

  if (options.maximum && ids.length > options.maximum) {
    throw httpError(`Select no more than ${options.maximum} snapshots to compare.`, 400);
  }

  return ids;
}

function parsePositiveId(value, fieldName) {
  const id = parseOptionalPositiveId(value, fieldName);
  if (id === null) {
    throw httpError(`${fieldName} must be a positive integer ID.`, 400);
  }
  return id;
}

function parseOptionalPositiveId(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (
    (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value.trim())))
  ) {
    throw httpError(`${fieldName} must be a positive integer ID.`, 400);
  }

  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw httpError(`${fieldName} must be a positive integer ID.`, 400);
  }
  return id;
}

function requiredText(value, fieldName, maximum = 1000) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw httpError(`${fieldName} must be a non-empty string.`, 400);
  }
  return value.trim();
}

function requiredNumber(value, fieldName, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw httpError(`${fieldName} must be a number between ${minimum} and ${maximum}.`, 400);
  }
  return number;
}

function normalizeRate(value, fieldName, { optional = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) {
      return null;
    }
    throw httpError(`${fieldName} must be a percentage between 0 and 100.`, 400);
  }

  const number = requiredNumber(value, fieldName, { minimum: 0, maximum: 100 });
  return number > 1 ? number / 100 : number;
}

function validateCampaignInput(body) {
  const locationLanguage = body.locationLanguage ?? body.marketLanguage;
  const grossMarginInput = requiredNumber(body.grossMargin, "grossMargin", {
    minimum: 0,
    maximum: 100
  });

  return {
    name: requiredText(body.name ?? body.campaignName, "name", 200),
    product: requiredText(body.product ?? body.productName, "product", 200),
    goal: requiredText(body.goal, "goal", 200),
    budget: requiredNumber(body.budget, "budget"),
    targetCac: requiredNumber(body.targetCac ?? body.targetCAC, "targetCac"),
    productPrice: requiredNumber(body.productPrice, "productPrice", { minimum: 0.01 }),
    grossMargin: grossMarginInput > 1 ? grossMarginInput / 100 : grossMarginInput,
    audience: requiredText(body.audience, "audience"),
    location: requiredText(body.location ?? body.targetLocation ?? locationLanguage, "location", 200),
    language: requiredText(body.language ?? body.targetLanguage ?? locationLanguage, "language", 200),
    destinationUrl: optionalHttpUrl(body.destinationUrl ?? body.destination_url ?? body.landingUrl),
    currency: normalizeCurrency(body.currency),
    clickThroughRate: normalizeRate(
      body.clickThroughRate ?? body.expectedClickRate ?? body.ctr,
      "clickThroughRate"
    ),
    conversionRate: normalizeRate(
      body.conversionRate ?? body.expectedConversionRate,
      "conversionRate"
    )
  };
}

function optionalHttpUrl(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const destinationUrl = requiredText(value, "destinationUrl", 2048);
  let parsedUrl;
  try {
    parsedUrl = new URL(destinationUrl);
  } catch (error) {
    throw httpError("destinationUrl must be a valid HTTP or HTTPS URL.", 400);
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
    throw httpError("destinationUrl must be a valid HTTP or HTTPS URL.", 400);
  }

  return parsedUrl.toString();
}

function normalizeCurrency(value) {
  const currency = String(value || "USD").trim().toUpperCase();
  if (!["USD", "INR"].includes(currency)) {
    throw httpError("currency must be USD or INR.", 400);
  }
  return currency;
}

function validateAnalysisAssumptions(body) {
  return {
    ctr: normalizeRate(
      body.ctr ?? body.clickThroughRate ?? body.expectedClickRate,
      "ctr"
    ),
    conversionRate: normalizeRate(
      body.conversionRate ?? body.expectedConversionRate,
      "conversionRate"
    )
  };
}

function buildComparison(snapshots) {
  const ranked = (readValue) => snapshots
    .map((snapshot) => ({
      snapshotId: snapshot.id,
      value: readValue(snapshot)
    }))
    .filter((entry) => entry.value !== null && entry.value !== undefined)
    .sort((left, right) => right.value - left.value);

  return {
    expectedRelevantViews: ranked((snapshot) => snapshot.estimates.expectedRelevantViews),
    engagementRate: ranked((snapshot) => snapshot.estimates.engagementRate),
    performanceConsistency: ranked((snapshot) => snapshot.estimates.performanceConsistency),
    estimatedFeeMin: [...ranked((snapshot) => snapshot.estimates.estimatedFeeRange?.min)]
      .sort((left, right) => left.value - right.value),
    estimatedFeeMax: [...ranked((snapshot) => snapshot.estimates.estimatedFeeRange?.max)]
      .sort((left, right) => left.value - right.value)
  };
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendError(response, error) {
  const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600
    ? error.statusCode
    : 500;
  const message = statusCode === 500
    ? "Internal server error."
    : error.message;

  if (statusCode >= 500) {
    console.error(error.message);
  }

  return response.status(statusCode).json({ error: message });
}

async function scanPublicSponsorshipSignalsRoute(request, response, channelUrlOverride) {
  try {
    const channelUrl = requiredText(
      channelUrlOverride
        ?? request.body?.channelUrl
        ?? request.body?.channel_url
        ?? request.body?.channel
        ?? request.body?.url,
      "channelUrl",
      2048
    );
    const forceRefresh = request.body?.forceRefresh === undefined && request.query.forceRefresh === undefined
      ? false
      : parseBoolean(
        request.body?.forceRefresh ?? request.query.forceRefresh,
        "forceRefresh"
      );

    // A channel ID can be served without spending another API request while a
    // still-valid compact scan exists. Handles and URLs are resolved through
    // the official channels.list/videos.list path below.
    const directChannelId = extractChannelId(channelUrl);
    if (!forceRefresh && directChannelId) {
      const cached = getPublicSponsorshipSignalScans({ channelId: directChannelId })[0];
      if (cached) {
        return response.json({
          scan: cached,
          signals: cached.signals,
          public_sponsorship_signals: cached.signals,
          channelId: cached.channelId,
          disclaimer: PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER,
          retentionNote: PUBLIC_SPONSORSHIP_SIGNAL_RETENTION_NOTE,
          cacheHit: true
        });
      }
    }

    const scan = await scanChannelPublicSponsorshipSignals(channelUrl);
    const existing = !forceRefresh
      ? getPublicSponsorshipSignalScans({ channelId: scan.channelId })[0]
      : null;
    if (existing) {
      return response.json({
        scan: existing,
        signals: existing.signals,
        public_sponsorship_signals: existing.signals,
        channelId: existing.channelId,
        disclaimer: PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER,
        retentionNote: PUBLIC_SPONSORSHIP_SIGNAL_RETENTION_NOTE,
        cacheHit: true
      });
    }

    const saved = savePublicSponsorshipSignalScan(scan);
    return response.status(201).json({
      scan: saved,
      signals: saved.signals,
      public_sponsorship_signals: saved.signals,
      channelId: saved.channelId,
      disclaimer: PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER,
      retentionNote: PUBLIC_SPONSORSHIP_SIGNAL_RETENTION_NOTE,
      cacheHit: false
    });
  } catch (error) {
    return sendError(response, error);
  }
}

function listPublicSponsorshipSignalsRoute(request, response, channelIdOverride) {
  try {
    const rawChannelId = channelIdOverride ?? request.query.channelId ?? request.query.channel_id;
    const channelId = rawChannelId === undefined
      ? undefined
      : requiredText(rawChannelId, "channelId", 256);
    const scans = getPublicSponsorshipSignalScans({ channelId });
    const signals = scans.flatMap((scan) => scan.signals);
    return response.json({
      scans,
      signals,
      public_sponsorship_signals: signals,
      disclaimer: PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER,
      retentionNote: PUBLIC_SPONSORSHIP_SIGNAL_RETENTION_NOTE
    });
  } catch (error) {
    return sendError(response, error);
  }
}

function getPublicSponsorshipSignalScanRoute(request, response) {
  try {
    const scanId = parsePositiveId(request.params.scanId, "scanId");
    const scan = getPublicSponsorshipSignalScanById(scanId);
    if (!scan) {
      return response.status(404).json({ error: "Public sponsorship signal scan not found." });
    }
    return response.json({
      scan,
      signals: scan.signals,
      public_sponsorship_signals: scan.signals,
      disclaimer: PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER,
      retentionNote: PUBLIC_SPONSORSHIP_SIGNAL_RETENTION_NOTE
    });
  } catch (error) {
    return sendError(response, error);
  }
}

function deletePublicSponsorshipSignalScanRoute(request, response) {
  try {
    const scanId = parsePositiveId(request.params.scanId, "scanId");
    if (!deletePublicSponsorshipSignalScan(scanId)) {
      return response.status(404).json({ error: "Public sponsorship signal scan not found." });
    }
    return response.status(204).send();
  } catch (error) {
    return sendError(response, error);
  }
}

function createAudienceProfileRoute(request, response, channelIdOverride) {
  try {
    const record = validateCreatorIntelligenceInput(
      request.body || {},
      "audience",
      channelIdOverride
    );
    const saved = createAudienceProfile(record);
    return response.status(201).json({ audienceProfile: saved, record: saved });
  } catch (error) {
    return sendError(response, error);
  }
}

function createQualityReviewRoute(request, response, channelIdOverride) {
  try {
    const record = validateCreatorIntelligenceInput(
      request.body || {},
      "quality",
      channelIdOverride
    );
    const saved = createQualityReview(record);
    return response.status(201).json({ qualityReview: saved, record: saved });
  } catch (error) {
    return sendError(response, error);
  }
}

function createSponsorshipRoute(request, response, channelIdOverride) {
  try {
    const record = validateCreatorIntelligenceInput(
      request.body || {},
      "sponsorship",
      channelIdOverride
    );
    const saved = createSponsorshipRecord(record);
    return response.status(201).json({ sponsorship: saved, sponsorshipRecord: saved, record: saved });
  } catch (error) {
    return sendError(response, error);
  }
}

function listCreatorIntelligenceRoute(request, response, getter, responseKey, channelIdOverride) {
  try {
    const channelId = channelIdOverride
      ?? request.query.channelId
      ?? request.query.channel_id;
    if (channelId !== undefined) {
      requiredText(channelId, "channelId", 256);
    }
    const snapshotId = request.query.snapshotId === undefined && request.query.snapshot_id === undefined
      ? null
      : parsePositiveId(request.query.snapshotId ?? request.query.snapshot_id, "snapshotId");
    const records = getter({ channelId, snapshotId });
    const body = { [responseKey]: records, records };
    if (responseKey === "audienceProfiles") {
      body.profiles = records;
      body.audienceProfile = records[0] || null;
    }
    if (responseKey === "qualityReviews") {
      body.reviews = records;
      body.qualityReview = records[0] || null;
    }
    if (responseKey === "sponsorships") {
      body.sponsorshipRecords = records;
      body.sponsorshipRecord = records[0] || null;
    }
    return response.json(body);
  } catch (error) {
    return sendError(response, error);
  }
}

function getCreatorIntelligenceRoute(request, response, getter, responseKey, idParameter) {
  try {
    const id = parsePositiveId(request.params[idParameter], idParameter);
    const record = getter(id);
    if (!record) {
      return response.status(404).json({ error: "Creator intelligence record not found." });
    }
    const body = { [responseKey]: record, record };
    if (responseKey === "sponsorship") {
      body.sponsorshipRecord = record;
    }
    return response.json(body);
  } catch (error) {
    return sendError(response, error);
  }
}

function updateCreatorIntelligenceRoute(
  request,
  response,
  updater,
  getter,
  responseKey,
  idParameter
) {
  try {
    const id = parsePositiveId(request.params[idParameter], idParameter);
    const existing = getter(id);
    if (!existing) {
      return response.status(404).json({ error: "Creator intelligence record not found." });
    }
    const input = validateCreatorIntelligenceInput(request.body || {}, "generic", undefined, {
      partial: true,
      existing
    });
    const updated = updater(id, input);
    const body = { [responseKey]: updated, record: updated };
    if (responseKey === "sponsorship") {
      body.sponsorshipRecord = updated;
    }
    return response.json(body);
  } catch (error) {
    return sendError(response, error);
  }
}

function deleteCreatorIntelligenceRoute(request, response, deleter, idParameter) {
  try {
    const id = parsePositiveId(request.params[idParameter], idParameter);
    if (!deleter(id)) {
      return response.status(404).json({ error: "Creator intelligence record not found." });
    }
    return response.status(204).send();
  } catch (error) {
    return sendError(response, error);
  }
}

function validateCreatorIntelligenceInput(body, kind, channelIdOverride, options = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("A creator intelligence record object is required.", 400);
  }
  const partial = Boolean(options.partial);
  const existing = options.existing || {};
  const channelId = channelIdOverride
    ?? body.channelId
    ?? body.channel_id;
  const sourceType = body.sourceType ?? body.source_type ?? body.source;
  const retrievedAt = body.retrievedAt ?? body.retrieved_at;
  const confidence = body.confidence ?? body.confidenceScore ?? body.confidence_score;
  const status = body.status;

  const result = {};
  if (channelId !== undefined) {
    result.channelId = requiredText(channelId, "channelId", 256);
  } else if (!partial) {
    throw httpError("channelId is required.", 400);
  }
  if (sourceType !== undefined) {
    if (typeof sourceType !== "string" || !CREATOR_INTELLIGENCE_SOURCE_TYPES.has(sourceType.trim())) {
      throw httpError(
        "sourceType must be one of creator_authorized, creator_supplied, provider, or mangokast_review.",
        400
      );
    }
    result.sourceType = sourceType.trim();
  } else if (!partial) {
    throw httpError("sourceType is required.", 400);
  }
  if (retrievedAt !== undefined) {
    if (typeof retrievedAt !== "string" || retrievedAt.length > 64 || !Number.isFinite(Date.parse(retrievedAt))) {
      throw httpError("retrievedAt must be a valid ISO date.", 400);
    }
    result.retrievedAt = retrievedAt;
  } else if (!partial) {
    throw httpError("retrievedAt is required.", 400);
  }
  if (confidence !== undefined) {
    result.confidence = requiredNumber(confidence, "confidence", { minimum: 0, maximum: 1 });
  } else if (!partial) {
    throw httpError("confidence is required.", 400);
  }
  if (status !== undefined) {
    result.status = requiredText(status, "status", 64);
  } else if (!partial) {
    throw httpError("status is required.", 400);
  }

  const rawSnapshotId = body.snapshotId ?? body.snapshot_id;
  if (rawSnapshotId !== undefined) {
    result.snapshotId = parsePositiveId(rawSnapshotId, "snapshotId");
  } else if (!partial && body.snapshotId === null) {
    result.snapshotId = null;
  }

  const explicitData = body.data
    ?? body.profile
    ?? body.audienceProfile
    ?? body.audience
    ?? body.review
    ?? body.qualityReview
    ?? body.quality
    ?? body.sponsorship
    ?? body.sponsorshipRecord;
  const payloadKeys = new Set([
    "channelId", "channel_id", "snapshotId", "snapshot_id", "sourceType", "source_type", "source",
    "retrievedAt", "retrieved_at", "confidence", "confidenceScore", "confidence_score", "status",
    "data", "profile", "audienceProfile", "audience", "review", "qualityReview", "quality",
    "sponsorship", "sponsorshipRecord"
  ]);
  const inferredData = Object.fromEntries(
    Object.entries(body).filter(([key]) => !payloadKeys.has(key))
  );
  if (explicitData !== undefined) {
    if (!explicitData || typeof explicitData !== "object" || Array.isArray(explicitData)) {
      throw httpError("data must be a JSON object.", 400);
    }
    result.data = explicitData;
  } else if (Object.keys(inferredData).length > 0 || !partial) {
    result.data = inferredData;
  }

  if (result.snapshotId !== undefined) {
    const snapshot = getSnapshotById(result.snapshotId);
    if (!snapshot) {
      throw httpError("Creator snapshot not found.", 404);
    }
    const effectiveChannelId = result.channelId ?? existing.channelId;
    if (snapshot.channelId !== effectiveChannelId) {
      throw httpError("snapshotId does not belong to channelId.", 400);
    }
  }

  // A PATCH is merged in database.js. Keep omitted fields omitted here.
  if (partial) {
    for (const [key, value] of Object.entries(existing)) {
      if (result[key] === undefined && ["channelId", "sourceType", "retrievedAt", "confidence", "status"].includes(key)) {
        result[key] = value;
      }
    }
  }
  return result;
}

function handleShopifyWebhook(request, response) {
  try {
    const rawBody = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(JSON.stringify(request.body || {}), "utf8");
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (secret && !verifyShopifySignature(rawBody, request.get("x-shopify-hmac-sha256"))) {
      return response.status(401).json({ error: "Invalid Shopify webhook signature." });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (error) {
      throw httpError("Shopify webhook body must be valid JSON.", 400);
    }
    const normalized = normalizeShopifyWebhookPayload(payload, request);
    const result = ingestShopifyEvent(normalized);
    return response.status(200).json({
      ok: true,
      received: true,
      event: result.event,
      attributionEvent: result.attributionEvent,
      attributed: Boolean(result.attributionEvent),
      idempotent: !result.created,
      created: result.created
    });
  } catch (error) {
    return sendError(response, error);
  }
}

function verifyShopifySignature(rawBody, signature) {
  if (typeof signature !== "string" || signature.trim().length === 0) {
    return false;
  }
  const expected = crypto.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");
  const provided = signature.trim().replace(/^sha256=/i, "");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  return expectedBuffer.length === providedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function normalizeShopifyWebhookPayload(body, request) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("Shopify webhook body must be a JSON object.", 400);
  }
  const topic = String(request.get("x-shopify-topic") || "").toLowerCase();
  const rawType = String(
    body.eventType
      ?? body.event_type
      ?? body.type
      ?? body.event
      ?? body.topic
      ?? topic
  ).toLowerCase();
  const eventType = rawType.includes("refund")
    ? "refund"
    : rawType.includes("order") || rawType.includes("purchase")
      ? "purchase"
      : null;
  if (!eventType) {
    throw httpError("Shopify webhook eventType must identify an order or refund.", 400);
  }

  const eventIdValue = body.eventId
    ?? body.event_id
    ?? body.externalId
    ?? body.external_id
    ?? (eventType === "refund" ? body.refundId ?? body.refund_id : undefined)
    ?? body.orderId
    ?? body.order_id
    ?? body.id
    ?? request.get("x-shopify-webhook-id");
  const eventId = typeof eventIdValue === "number" && Number.isSafeInteger(eventIdValue)
    ? String(eventIdValue)
    : eventIdValue;
  if (typeof eventId !== "string" || eventId.trim().length === 0 || eventId.length > MAX_EVENT_KEY_LENGTH) {
    throw httpError("eventId is required and must be at most 200 characters.", 400);
  }

  const utm = extractShopifyUtm(body);
  const directToken = firstDefined(
    body.trackingToken,
    body.tracking_token,
    body.creatorToken,
    body.creator_token,
    body.campaignToken,
    body.campaign_token,
    body.creatorCampaignToken,
    body.creator_campaign_token,
    body.trackingLinkToken,
    body.tracking_link_token,
    body.mangokastTrackingToken,
    body.mangokast_tracking_token,
    body.attribution?.trackingToken,
    body.attribution?.tracking_token,
    body.attribution?.token,
    body.metadata?.trackingToken,
    body.metadata?.tracking_token,
    body.token,
    utm.utm_content,
    utm.utm_campaign
  );
  const directLinkId = body.trackingLinkId
    ?? body.tracking_link_id
    ?? body.linkId
    ?? body.attribution?.trackingLinkId
    ?? body.attribution?.tracking_link_id;
  let trackingLink = null;
  if (directLinkId !== undefined && directLinkId !== null && directLinkId !== "") {
    const linkId = parsePositiveId(directLinkId, "trackingLinkId");
    trackingLink = getTrackingLinkById(linkId);
    if (!trackingLink) {
      throw httpError("Tracking link not found.", 404);
    }
  }
  if (!trackingLink && typeof directToken === "string" && directToken.trim().length > 0) {
    trackingLink = getTrackingLinkByToken(directToken.trim());
  }
  if (!trackingLink) {
    const fallbackTokens = [
      utm.tracking_token,
      utm.utm_content,
      utm.utm_campaign,
      utm.utm_source
    ].filter((value) => typeof value === "string" && value.trim().length > 0);
    for (const candidate of fallbackTokens) {
      trackingLink = getTrackingLinkByToken(candidate.trim());
      if (trackingLink) break;
    }
  }

  const amountValue = firstDefined(
    body.amount,
    body.revenue,
    body.orderValue,
    body.value,
    eventType === "refund" ? body.refundAmount : undefined,
    eventType === "refund" ? body.refund_amount : undefined,
    body.total_price,
    body.totalPrice,
    body.total_price_set?.shop_money?.amount,
    body.refund?.amount,
    body.refund?.total_amount
  );
  const amount = requiredNumber(amountValue, "amount", { minimum: 0.01, maximum: MAX_EVENT_AMOUNT });
  const occurredAt = body.occurredAt
    ?? body.occurred_at
    ?? body.timestamp
    ?? body.processed_at
    ?? body.created_at
    ?? new Date().toISOString();
  if (typeof occurredAt !== "string" || occurredAt.length > 64 || !Number.isFinite(Date.parse(occurredAt))) {
    throw httpError("occurredAt must be a valid ISO date.", 400);
  }
  const currency = String(
    body.currency
      ?? body.currencyCode
      ?? body.currency_code
      ?? body.total_price_set?.shop_money?.currency_code
      ?? trackingLink?.currency
      ?? "USD"
  ).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw httpError("currency must be a three-letter ISO code.", 400);
  }
  if (trackingLink && currency !== trackingLink.currency) {
    throw httpError(`currency must match the tracking link currency (${trackingLink.currency}).`, 400);
  }

  return {
    eventId: eventId.trim(),
    eventType,
    amount,
    currency,
    occurredAt,
    trackingLinkId: trackingLink?.id ?? null,
    trackingToken: typeof directToken === "string" ? directToken.trim() : null,
    utm,
    payload: body,
    createdAt: new Date().toISOString()
  };
}

function extractShopifyUtm(body) {
  const utm = {};
  const nestedUtm = body.metadata?.utm;
  const input = body.utm && typeof body.utm === "object" && !Array.isArray(body.utm)
    ? body.utm
    : nestedUtm && typeof nestedUtm === "object" && !Array.isArray(nestedUtm)
      ? nestedUtm
    : {};
  for (const key of ["source", "medium", "campaign", "content", "term"]) {
    const value = input[key] ?? input[`utm_${key}`] ?? body[`utm_${key}`] ?? body.metadata?.[`utm_${key}`];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      utm[`utm_${key}`] = String(value).trim();
    }
  }

  const attributes = Array.isArray(body.note_attributes)
    ? body.note_attributes
    : Array.isArray(body.attributes)
      ? body.attributes
      : [];
  for (const attribute of attributes) {
    if (!attribute || typeof attribute !== "object") continue;
    const name = String(attribute.name ?? attribute.key ?? "").toLowerCase();
    const value = attribute.value;
    if (value === undefined || value === null || String(value).trim() === "") continue;
    const match = name.match(/^utm_(source|medium|campaign|content|term)$/);
    if (match) utm[`utm_${match[1]}`] = String(value).trim();
    if (["tracking_token", "mangokast_token", "creator_token", "campaign_token"].includes(name)) {
      utm.tracking_token = String(value).trim();
    }
  }

  const landingSite = body.landing_site || body.landingSite;
  if (typeof landingSite === "string") {
    try {
      const url = new URL(landingSite, "https://shopify.local");
      for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
        if (!utm[key] && url.searchParams.get(key)) utm[key] = url.searchParams.get(key);
      }
    } catch (error) {
      // UTM fields already supplied directly remain valid when landing_site is not a URL.
    }
  }
  return utm;
}

const port = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Mangokast API running on port ${port}`);
  });
}

module.exports = {
  app,
  buildComparison,
  parseSnapshotIds,
  validateCampaignInput,
  validateAnalysisAssumptions,
  validateTrackingLinkInput,
  validateAttributionEventInput,
  getAnalysisCacheTtlMs
};
