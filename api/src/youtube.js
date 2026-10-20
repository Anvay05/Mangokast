const axios = require("axios");

const YOUTUBE_API_BASE =
  "https://www.googleapis.com/youtube/v3";

const USD_TO_INR_PLANNING_RATE = 84;
const YOUTUBE_DATA_API_SOURCE = "youtube_data_api";
const MAX_DISCOVERY_RESULTS = 10;
const DEFAULT_DISCOVERY_RESULTS = 10;
const DISCOVERY_QUOTA_NOTE =
  "YouTube search.list is expensive (typically 100 quota units); result limits are capped at 10.";
const PUBLIC_SPONSORSHIP_SIGNAL_SOURCE = "public_description_signal";
const PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER =
  "This is not verified sponsorship history.";
const PUBLIC_SPONSORSHIP_SIGNAL_RETENTION_NOTE =
  "Refresh or delete public description signals within 30 days; raw descriptions are never stored.";

// These patterns intentionally require disclosure or promotion context. A
// bare word such as "sponsor" is not enough to create a public sponsorship
// signal because it commonly appears in unrelated creator copy.
const PUBLIC_SPONSORSHIP_PATTERNS = [
  { keyword: "sponsored by", expression: /\bsponsored\s+by\b/gi, strength: 3 },
  { keyword: "sponsored content", expression: /\bsponsored\s+content\b/gi, strength: 3 },
  { keyword: "video is sponsored", expression: /\b(?:this\s+)?(?:video|content)\s+is\s+sponsored\b/gi, strength: 3 },
  { keyword: "sponsoring this video", expression: /\bsponsor(?:ed|ing)\s+(?:this\s+)?(?:video|content)\b/gi, strength: 3 },
  { keyword: "paid partnership", expression: /\bpaid\s+(?:brand\s+)?partnership\b/gi, strength: 3 },
  { keyword: "in partnership with", expression: /\bin\s+partnership\s+with\b/gi, strength: 3 },
  { keyword: "brand partner", expression: /\bbrand\s+partner(?:ship)?\b/gi, strength: 3 },
  { keyword: "official sponsor", expression: /\bofficial\s+sponsor\b/gi, strength: 3 },
  { keyword: "brought to you by", expression: /\bbrought\s+to\s+you\s+by\b/gi, strength: 3 },
  { keyword: "#ad", expression: /(?:^|[\s([{:#])#ad\b/gi, strength: 3 },
  { keyword: "#sponsored", expression: /(?:^|[\s([{:#])#sponsored\b/gi, strength: 3 },
  { keyword: "#sponsor", expression: /(?:^|[\s([{:#])#sponsor\b/gi, strength: 3 },
  { keyword: "advertisement", expression: /\badvertisement\b/gi, strength: 3 },
  { keyword: "promo code", expression: /\bpromo(?:tional)?\s+code\b/gi, strength: 2 },
  { keyword: "coupon code", expression: /\bcoupon\s+code\b/gi, strength: 2 },
  { keyword: "discount code", expression: /\bdiscount\s+code\b/gi, strength: 2 },
  { keyword: "use code", expression: /\buse\s+(?:my\s+)?code\b/gi, strength: 2 },
  { keyword: "affiliate link", expression: /\baffiliate\s+links?\b/gi, strength: 2 },
  { keyword: "affiliate disclosure", expression: /\baffiliate\s+disclosure\b/gi, strength: 2 },
  { keyword: "earn commission", expression: /\bearn(?:s|ing)?\s+(?:a\s+)?commission\b/gi, strength: 2 },
  { keyword: "commission", expression: /\bcommission(?:able)?\s+link\b/gi, strength: 2 }
];

const PUBLIC_SPONSORSHIP_NEGATION =
  /\b(?:not|no|never|without|isn't|isnt|wasn't|wasnt|don't|dont|doesn't|doesnt)\s+(?:(?:an?|any)\s+)?(?:sponsor(?:ed|ship)?|ad(?:vertisement)?|affiliate|promo(?:tion)?|coupon|discount|paid\s+partnership)\b/i;

function hasNegatedMatch(description, matchIndex) {
  const prefix = description.slice(Math.max(0, matchIndex - 48), matchIndex);
  return PUBLIC_SPONSORSHIP_NEGATION.test(prefix.replace(/#/g, ""));
}

function extractPublicSponsorshipDomains(description) {
  const candidatePattern = /\b(?:(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"'`]*)?)/gi;
  const candidates = [...description.matchAll(candidatePattern)];
  const domains = new Set();

  for (const candidateMatch of candidates) {
    if (candidateMatch.index > 0 && description[candidateMatch.index - 1] === "@") {
      continue;
    }
    const candidate = candidateMatch[0];
    const trimmed = candidate.replace(/[),.!?:;]+$/g, "");
    if (trimmed.includes("@")) {
      continue;
    }

    try {
      const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
      if (
        !hostname ||
        hostname === "youtube.com" ||
        hostname.endsWith(".youtube.com") ||
        hostname === "youtu.be"
      ) {
        continue;
      }
      domains.add(hostname);
    } catch (error) {
      // A malformed URL-like token is not a public signal.
    }
  }

  return [...domains].slice(0, 10);
}

function confidenceForPublicSponsorshipSignal({ strongestMatch, matchedKeywords, domains }) {
  const score = strongestMatch + Math.max(0, matchedKeywords.length - 1) + (domains.length > 0 ? 1 : 0);
  if (strongestMatch >= 3 || score >= 4) {
    return "high";
  }
  if (score >= 2) {
    return "medium";
  }
  return "low";
}

/**
 * Derive compact public sponsorship signals from video snippet descriptions.
 * The descriptions are read only for this in-memory operation and are never
 * included in the returned records.
 */
function scanPublicSponsorshipSignals(videos, options = {}) {
  const retrievedAt = options.retrievedAt || new Date().toISOString();
  const signals = [];

  for (const video of Array.isArray(videos) ? videos : []) {
    const videoId = typeof video?.id === "string" ? video.id.trim() : "";
    const description = typeof video?.snippet?.description === "string"
      ? video.snippet.description
      : "";
    if (!videoId || description.length === 0) {
      continue;
    }

    const matched = new Map();
    let strongestMatch = 0;
    for (const pattern of PUBLIC_SPONSORSHIP_PATTERNS) {
      pattern.expression.lastIndex = 0;
      let match;
      while ((match = pattern.expression.exec(description)) !== null) {
        if (!hasNegatedMatch(description, match.index)) {
          matched.set(pattern.keyword, true);
          strongestMatch = Math.max(strongestMatch, pattern.strength);
        }
        if (pattern.expression.lastIndex === match.index) {
          pattern.expression.lastIndex += 1;
        }
      }
    }

    const matchedKeywords = [...matched.keys()];
    const detectedDomains = extractPublicSponsorshipDomains(description);
    const hasNegatedLanguage = PUBLIC_SPONSORSHIP_NEGATION.test(description);

    // A plain portfolio/social link is retained as a low-confidence outbound
    // domain signal, but a wholly negative disclosure sentence must not become
    // a false positive merely because it contains a link.
    if (matchedKeywords.length === 0 && detectedDomains.length === 0) {
      continue;
    }
    if (matchedKeywords.length === 0 && hasNegatedLanguage) {
      continue;
    }

    signals.push({
      videoId,
      title: typeof video.snippet?.title === "string" ? video.snippet.title : "",
      date: typeof video.snippet?.publishedAt === "string" ? video.snippet.publishedAt : null,
      sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      detectedDomains,
      matchedKeywords,
      confidence: confidenceForPublicSponsorshipSignal({
        strongestMatch,
        matchedKeywords,
        domains: detectedDomains
      }),
      sourceType: PUBLIC_SPONSORSHIP_SIGNAL_SOURCE,
      retrievedAt,
      disclaimer: PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER
    });
  }

  return signals;
}

function apiError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseYouTubeUrl(input) {
  if (typeof input !== "string") {
    return null;
  }

  try {
    const candidate = /^https?:\/\//i.test(input)
      ? input
      : `https://${input}`;
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();

    if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(hostname)) {
      return null;
    }

    return url;
  } catch (error) {
    return null;
  }
}

function extractChannelId(input) {
  if (typeof input !== "string") {
    return null;
  }

  const value = input.trim();

  if (/^UC[a-zA-Z0-9_-]{20,}$/.test(value)) {
    return value;
  }

  const url = parseYouTubeUrl(value);
  const match = url?.pathname.match(/^\/channel\/(UC[a-zA-Z0-9_-]+)/);

  if (match) {
    return match[1];
  }

  return null;
}

function extractHandle(input) {
  if (typeof input !== "string") {
    return null;
  }

  const value = input.trim();

  const url = parseYouTubeUrl(value);
  const urlMatch = url?.pathname.match(/^\/@([^/?]+)/);

  if (urlMatch) {
    return `@${urlMatch[1]}`;
  }

  if (value.startsWith("@")) {
    return value;
  }

  return null;
}

async function request(endpoint, params) {
  if (!process.env.YOUTUBE_API_KEY) {
    throw apiError("YouTube API is not configured.", 503);
  }

  try {
    const response = await axios.get(
      `${YOUTUBE_API_BASE}/${endpoint}`,
      {
        params: {
          ...params,
          key: process.env.YOUTUBE_API_KEY
        }
      }
    );

    return response.data;
  } catch (error) {
    const upstreamStatus = error?.response?.status;
    const upstreamErrorStatus = error?.response?.data?.error?.status;
    const upstreamReasons = Array.isArray(error?.response?.data?.error?.errors)
      ? error.response.data.error.errors
      : [];
    const isQuotaError = upstreamReasons.some((upstreamError) => [
      "dailyLimitExceeded",
      "quotaExceeded",
      "rateLimitExceeded",
      "userRateLimitExceeded"
    ].includes(upstreamError?.reason)) || upstreamErrorStatus === "RESOURCE_EXHAUSTED";

    if (upstreamStatus === 429 || isQuotaError) {
      throw apiError("YouTube API quota is temporarily unavailable.", 429);
    }

    throw apiError("YouTube API request failed.", 502);
  }
}

function validateDiscoveryInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw apiError("A creator discovery request object is required.", 400);
  }

  const query = body.query;
  if (typeof query !== "string" || query.trim().length === 0 || query.length > 200) {
    throw apiError("query must be a non-empty string of at most 200 characters.", 400);
  }

  const regionCode = normalizeDiscoveryCode(
    body.regionCode ?? body.region,
    "regionCode",
    /^[A-Za-z]{2}$/,
    {
      india: "IN",
      in: "IN",
      "united states": "US",
      usa: "US",
      us: "US",
      "united kingdom": "GB",
      uk: "GB",
      gb: "GB",
      canada: "CA",
      ca: "CA",
      australia: "AU",
      au: "AU"
    }
  );
  const relevanceLanguage = normalizeDiscoveryCode(
    body.relevanceLanguage ?? body.language,
    "relevanceLanguage",
    /^[A-Za-z]{2}$/,
    {
      english: "en",
      en: "en",
      hindi: "hi",
      hi: "hi",
      bengali: "bn",
      bn: "bn",
      marathi: "mr",
      mr: "mr",
      tamil: "ta",
      ta: "ta",
      telugu: "te",
      te: "te",
      kannada: "kn",
      kn: "kn"
    }
  );
  const maxResults = parseDiscoveryMaxResults(body.maxResults);

  return {
    query: query.trim(),
    ...(regionCode ? { regionCode: regionCode.toUpperCase() } : {}),
    ...(relevanceLanguage ? { relevanceLanguage: relevanceLanguage.toLowerCase() } : {}),
    maxResults
  };
}

function normalizeDiscoveryCode(value, fieldName, pattern, aliases) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  const mapped = aliases[normalized] || String(value).trim();
  if (!pattern.test(mapped)) {
    throw apiError(`${fieldName} must be a valid two-letter language or region code.`, 400);
  }

  return mapped;
}

function parseDiscoveryMaxResults(value) {
  if (value === undefined || value === null) {
    return DEFAULT_DISCOVERY_RESULTS;
  }

  const number = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_DISCOVERY_RESULTS) {
    throw apiError(`maxResults must be an integer between 1 and ${MAX_DISCOVERY_RESULTS}.`, 400);
  }

  return number;
}

async function discoverCreators(options) {
  const discovery = validateDiscoveryInput(options);
  const requestParams = {
    part: "snippet",
    q: discovery.query,
    type: "channel",
    maxResults: discovery.maxResults
  };

  if (discovery.regionCode) {
    requestParams.regionCode = discovery.regionCode;
  }
  if (discovery.relevanceLanguage) {
    requestParams.relevanceLanguage = discovery.relevanceLanguage;
  }

  const data = await request("search", requestParams);
  const timestamp = new Date().toISOString();
  const candidates = (data?.items || [])
    .map((item) => {
      const channelId = item.id?.channelId;
      const snippet = item.snippet || {};

      if (!channelId) {
        return null;
      }

      return {
        channelId,
        channelName: snippet.title || "",
        description: snippet.description || "",
        thumbnailUrl: snippet.thumbnails?.high?.url
          || snippet.thumbnails?.medium?.url
          || snippet.thumbnails?.default?.url
          || null,
        channelUrl: `https://www.youtube.com/channel/${channelId}`,
        source: YOUTUBE_DATA_API_SOURCE,
        timestamp
      };
    })
    .filter(Boolean);

  return {
    query: discovery.query,
    candidates,
    source: YOUTUBE_DATA_API_SOURCE,
    timestamp,
    quotaNote: DISCOVERY_QUOTA_NOTE
  };
}

async function getChannel(channelInput) {
  const channelId = extractChannelId(channelInput);
  const handle = extractHandle(channelInput);

  let data;

  if (channelId) {
    data = await request("channels", {
      part: "snippet,statistics,contentDetails",
      id: channelId
    });
  } else if (handle) {
    data = await request("channels", {
      part: "snippet,statistics,contentDetails",
      forHandle: handle
    });
  } else {
    throw apiError(
      "Please use a YouTube channel URL, channel ID, or @handle.",
      400
    );
  }

  if (!data.items || data.items.length === 0) {
    throw apiError("YouTube channel was not found.", 404);
  }

  return data.items[0];
}

async function getRecentVideos(channel) {
  const uploadsPlaylistId =
    channel.contentDetails.relatedPlaylists.uploads;

  const playlist = await request("playlistItems", {
    part: "contentDetails,snippet",
    playlistId: uploadsPlaylistId,
    maxResults: 20
  });

  const videoIds = playlist.items
    .map((item) => item.contentDetails.videoId)
    .filter(Boolean);

  if (videoIds.length === 0) {
    return [];
  }

  const videos = await request("videos", {
    part: "snippet,statistics,contentDetails",
    id: videoIds.join(",")
  });

  return videos.items || [];
}

async function scanChannelPublicSponsorshipSignals(channelInput) {
  if (
    typeof channelInput !== "string" ||
    channelInput.trim().length === 0 ||
    channelInput.length > 2048
  ) {
    throw apiError(
      "channelUrl must be a non-empty YouTube channel URL, channel ID, or @handle.",
      400
    );
  }

  const channel = await getChannel(channelInput.trim());
  const videos = await getRecentVideos(channel);
  const retrievedAt = new Date().toISOString();
  const signals = scanPublicSponsorshipSignals(videos, { retrievedAt });

  return {
    channelId: channel.id,
    channelName: channel.snippet?.title || "",
    signals,
    publicSponsorshipSignals: signals,
    public_sponsorship_signals: signals,
    source: YOUTUBE_DATA_API_SOURCE,
    retrievedAt,
    disclaimer: PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER,
    retentionNote: PUBLIC_SPONSORSHIP_SIGNAL_RETENTION_NOTE
  };
}

function calculateMedian(numbers) {
  if (numbers.length === 0) {
    return 0;
  }

  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return Math.round(
      (sorted[middle - 1] + sorted[middle]) / 2
    );
  }

  return sorted[middle];
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function calculateConsistency(views) {
  if (views.length < 2) {
    return null;
  }

  const mean = views.reduce((total, value) => total + value, 0) / views.length;

  if (mean === 0) {
    return 0;
  }

  const variance = views.reduce(
    (total, value) => total + ((value - mean) ** 2),
    0
  ) / views.length;
  const coefficientOfVariation = Math.sqrt(variance) / mean;

  return Number(clamp(1 - coefficientOfVariation, 0, 1).toFixed(4));
}

function calculateEngagementRate(videos) {
  const totals = videos.reduce(
    (result, video) => {
      const views = Number(video.statistics?.viewCount || 0);
      const likes = Number(video.statistics?.likeCount || 0);
      const comments = Number(video.statistics?.commentCount || 0);

      if (views > 0) {
        result.views += views;
        result.interactions += likes + comments;
      }

      return result;
    },
    { views: 0, interactions: 0 }
  );

  if (totals.views === 0) {
    return null;
  }

  return Number((totals.interactions / totals.views).toFixed(4));
}

function calculateEstimates({ medianRecentViews, views, videos }) {
  const engagementRate = calculateEngagementRate(videos);
  const missingData = [];

  if (views.length === 0) {
    missingData.push("recent_views");
  }

  if (videos.length < 5) {
    missingData.push("small_recent_video_sample");
  }

  if (engagementRate === null) {
    missingData.push("likes_or_comments");
  }

  const expectedRelevantViews = medianRecentViews > 0
    ? Math.round(medianRecentViews * 0.7)
    : null;
  const feeBase = medianRecentViews > 0
    ? medianRecentViews / 1000
    : null;

  return {
    source: "mangokast_estimate",
    performanceConsistency: calculateConsistency(views),
    engagementRate,
    expectedRelevantViews,
    estimatedFeeRange: feeBase === null
      ? null
      : {
          min: Math.max(300, Math.round(feeBase * 20)),
          max: Math.max(500, Math.round(feeBase * 50)),
          currency: "USD"
        },
    dataConfidence: videos.length >= 10
      ? "high"
      : videos.length >= 5
        ? "medium"
        : "low",
    isEstimate: true,
    methodology: {
      version: "mvp-v1",
      sampleSize: videos.length,
      relevantViewRate: 0.7,
      feeCpmRangeUsd: [20, 50],
      missingData,
      note: "Planning estimates only; validate with creator-specific data."
    }
  };
}

function normalizeRate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 100) {
    return null;
  }

  return numericValue > 1 ? numericValue / 100 : numericValue;
}

function roundEstimate(value) {
  return Number(value.toFixed(2));
}

function calculateCampaignEconomics({ estimates, campaign, assumptions = {} }) {
  const feeRange = estimates?.estimatedFeeRange || null;
  const expectedRelevantViews = estimates?.expectedRelevantViews ?? null;
  const requestedClickThroughRate = assumptions.ctr
    ?? assumptions.clickThroughRate
    ?? assumptions.expectedClickRate;
  const requestedConversionRate = assumptions.conversionRate
    ?? assumptions.expectedConversionRate;
  const clickThroughRate = normalizeRate(
    requestedClickThroughRate ?? campaign?.clickThroughRate ?? campaign?.expectedClickRate
  );
  const conversionRate = normalizeRate(
    requestedConversionRate ?? campaign?.conversionRate ?? campaign?.expectedConversionRate
  );
  const effectiveClickThroughRate = clickThroughRate ?? 0.01;
  const effectiveConversionRate = conversionRate ?? 0.02;
  const productPrice = Number(campaign?.productPrice);
  const grossMarginInput = Number(campaign?.grossMargin);
  const grossMargin = Number.isFinite(grossMarginInput)
    ? grossMarginInput > 1 ? grossMarginInput / 100 : grossMarginInput
    : null;
  const expectedClicks = expectedRelevantViews === null
    ? null
    : roundEstimate(expectedRelevantViews * effectiveClickThroughRate);
  const expectedPurchases = expectedClicks === null
    ? null
    : roundEstimate(expectedRelevantViews * effectiveClickThroughRate * effectiveConversionRate);
  const currency = campaign?.currency || "USD";
  const exchangeRate = currency === "INR" ? USD_TO_INR_PLANNING_RATE : 1;
  const totalEstimatedSpend = feeRange
    ? {
        min: roundEstimate(feeRange.min * exchangeRate),
        max: roundEstimate(feeRange.max * exchangeRate),
        currency
      }
    : null;
  const expectedCacRange = totalEstimatedSpend && expectedPurchases > 0
    ? {
        min: roundEstimate(totalEstimatedSpend.min / expectedPurchases),
        max: roundEstimate(totalEstimatedSpend.max / expectedPurchases),
        currency: totalEstimatedSpend.currency
      }
    : null;
  const missingData = [];
  const hasClickThroughRateAssumption = (
    requestedClickThroughRate !== undefined && requestedClickThroughRate !== null
  ) || (
    campaign?.clickThroughRate !== undefined && campaign?.clickThroughRate !== null
  );
  const hasConversionRateAssumption = (
    requestedConversionRate !== undefined && requestedConversionRate !== null
  ) || (
    campaign?.conversionRate !== undefined && campaign?.conversionRate !== null
  );

  if (expectedRelevantViews === null) {
    missingData.push("expected_relevant_views");
  }
  if (!feeRange) {
    missingData.push("estimated_fee");
  }
  if (!Number.isFinite(productPrice) || productPrice <= 0) {
    missingData.push("product_price");
  }
  if (grossMargin === null || grossMargin < 0 || grossMargin > 1) {
    missingData.push("gross_margin");
  }
  if (!hasClickThroughRateAssumption) {
    missingData.push("ctr_assumption");
  }
  if (!hasConversionRateAssumption) {
    missingData.push("conversion_rate_assumption");
  }

  return {
    estimateType: "planning_estimate",
    label: "Planning estimate",
    isEstimate: true,
    expectedRelevantViews,
    estimatedFeeRange: feeRange,
    targetCac: Number.isFinite(Number(campaign?.targetCac))
      ? Number(campaign.targetCac)
      : null,
    clickThroughRate: effectiveClickThroughRate,
    conversionRate: effectiveConversionRate,
    expectedClicks,
    expectedPurchases,
    totalEstimatedSpend,
    expectedCacRange,
    currency,
    exchangeRate,
    breakEvenCac:
      Number.isFinite(productPrice) && productPrice > 0 && grossMargin !== null && grossMargin >= 0 && grossMargin <= 1
        ? roundEstimate(productPrice * grossMargin)
        : null,
    missingData,
    missingDataFlags: missingData,
    assumptions: {
      clickThroughRate: effectiveClickThroughRate,
      conversionRate: effectiveConversionRate,
      defaultsApplied: {
        clickThroughRate: !hasClickThroughRateAssumption,
        conversionRate: !hasConversionRateAssumption
      }
    },
    methodology: {
      version: "campaign-planning-v1",
      formula: "expected purchases = expected relevant views × CTR × conversion rate; expected CAC = estimated spend ÷ expected purchases",
      note: "Planning estimates only; these values are not actual CAC or a performance guarantee.",
      feeCurrency: feeRange?.currency || "USD",
      campaignCurrency: currency,
      usdToCampaignRate: exchangeRate
    }
  };
}

function campaignContext(value) {
  if (!value) {
    return null;
  }

  if (value.campaign) {
    return value;
  }

  return { campaign: value, assumptions: {} };
}

function calculateSummary(channel, videos, campaignOptions) {
  const views = videos
    .map((video) => Number(video.statistics?.viewCount || 0))
    .filter((value) => Number.isFinite(value));

  const medianRecentViews = calculateMedian(views);

  const subscribers = Number(
    channel.statistics?.subscriberCount || 0
  );

  const youtubeMetrics = {
    subscribers,
    videoCount: videos.length,
    medianRecentViews,
    viewsToSubscriberRatio:
      subscribers > 0
        ? Number(
            (medianRecentViews / subscribers).toFixed(4)
          )
        : null,
    retrievedAt: new Date().toISOString(),
    source: "youtube_data_api"
  };

  const summary = {
    channelId: channel.id,
    channelName: channel.snippet.title,
    subscribers,
    videoCount: videos.length,
    medianRecentViews,
    viewsToSubscriberRatio: youtubeMetrics.viewsToSubscriberRatio,
    retrievedAt: youtubeMetrics.retrievedAt,
    youtubeMetrics,
    estimates: calculateEstimates({
      medianRecentViews,
      views,
      videos
    })
  };

  const context = campaignContext(campaignOptions);
  if (context?.campaign) {
    summary.campaignId = context.campaign.id ?? null;
    summary.estimates.campaignEconomics = calculateCampaignEconomics({
      estimates: summary.estimates,
      campaign: context.campaign,
      assumptions: context.assumptions || {}
    });
  }

  return summary;
}

async function analyseChannel(channelInput, options = {}) {
  if (
    typeof channelInput !== "string" ||
    channelInput.trim().length === 0 ||
    channelInput.length > 2048
  ) {
    throw apiError(
      "channelUrl must be a non-empty YouTube channel URL, channel ID, or @handle.",
      400
    );
  }

  const channel = await getChannel(channelInput);
  const videos = await getRecentVideos(channel);
  const summary = calculateSummary(channel, videos, options);

  return {
    summary,
    videos: videos.map((video) => ({
      id: video.id,
      title: video.snippet.title,
      publishedAt: video.snippet.publishedAt,
      views: Number(video.statistics?.viewCount || 0),
      likes: Number(video.statistics?.likeCount || 0),
      comments: Number(video.statistics?.commentCount || 0),
      url: `https://www.youtube.com/watch?v=${video.id}`
    }))
  };
}

module.exports = {
  analyseChannel,
  calculateCampaignEconomics,
  calculateSummary,
  calculateMedian,
  discoverCreators,
  extractChannelId,
  extractHandle,
  extractPublicSponsorshipSignals: scanPublicSponsorshipSignals,
  scanChannelPublicSponsorshipSignals,
  scanPublicSponsorshipSignals,
  validateDiscoveryInput
};
