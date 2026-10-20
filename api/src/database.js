const Database = require("better-sqlite3");
const crypto = require("node:crypto");

const db = new Database(process.env.MANGOKAST_DB_PATH || "mangokast.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS campaign_briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    product TEXT NOT NULL,
    goal TEXT NOT NULL,
    budget REAL NOT NULL,
    target_cac REAL NOT NULL,
    product_price REAL NOT NULL,
    gross_margin REAL NOT NULL,
    audience TEXT NOT NULL,
    location TEXT NOT NULL,
    language TEXT NOT NULL,
    destination_url TEXT,
    currency TEXT NOT NULL DEFAULT 'USD',
    click_through_rate REAL,
    conversion_rate REAL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS creator_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    subscribers INTEGER,
    video_count INTEGER,
    median_recent_views INTEGER,
    views_to_subscriber_ratio REAL,
    retrieved_at TEXT NOT NULL,
    youtube_subscribers INTEGER,
    youtube_video_count INTEGER,
    youtube_median_recent_views INTEGER,
    youtube_views_to_subscriber_ratio REAL,
    youtube_source TEXT,
    performance_consistency REAL,
    engagement_rate REAL,
    expected_relevant_views INTEGER,
    estimated_fee_min INTEGER,
    estimated_fee_max INTEGER,
    estimated_fee_currency TEXT,
    estimate_data_confidence TEXT,
    estimate_methodology_json TEXT,
    campaign_id INTEGER,
    campaign_economics_json TEXT
  );

  CREATE TABLE IF NOT EXISTS tracking_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    snapshot_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    destination_url TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    planned_fee_min REAL,
    planned_fee_max REAL,
    planned_cac_min REAL,
    planned_cac_max REAL,
    planned_clicks REAL,
    planned_leads REAL,
    planned_purchases REAL,
    planned_revenue REAL,
    actual_fee REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS tracking_links_campaign_idx
    ON tracking_links (campaign_id, created_at);

  CREATE TABLE IF NOT EXISTS attribution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracking_link_id INTEGER NOT NULL,
    event_key TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('click', 'lead', 'purchase', 'refund')),
    amount REAL,
    currency TEXT,
    occurred_at TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (tracking_link_id, event_key)
  );

  CREATE INDEX IF NOT EXISTS attribution_events_link_type_idx
    ON attribution_events (tracking_link_id, event_type, occurred_at);

  CREATE TABLE IF NOT EXISTS creator_analysis_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    channel_key TEXT NOT NULL,
    channel_id TEXT,
    snapshot_id INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    analysed_at TEXT NOT NULL,
    UNIQUE (campaign_id, channel_key)
  );

  CREATE INDEX IF NOT EXISTS creator_analysis_cache_lookup_idx
    ON creator_analysis_cache (campaign_id, channel_key, analysed_at);

  CREATE TABLE IF NOT EXISTS creator_audience_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    snapshot_id INTEGER,
    source_type TEXT NOT NULL CHECK (source_type IN (
      'creator_authorized', 'creator_supplied', 'provider', 'mangokast_review'
    )),
    retrieved_at TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS creator_audience_profiles_lookup_idx
    ON creator_audience_profiles (channel_id, snapshot_id, retrieved_at);

  CREATE TABLE IF NOT EXISTS creator_quality_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    snapshot_id INTEGER,
    source_type TEXT NOT NULL CHECK (source_type IN (
      'creator_authorized', 'creator_supplied', 'provider', 'mangokast_review'
    )),
    retrieved_at TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    review_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS creator_quality_reviews_lookup_idx
    ON creator_quality_reviews (channel_id, snapshot_id, retrieved_at);

  CREATE TABLE IF NOT EXISTS creator_sponsorships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    snapshot_id INTEGER,
    source_type TEXT NOT NULL CHECK (source_type IN (
      'creator_authorized', 'creator_supplied', 'provider', 'mangokast_review'
    )),
    retrieved_at TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    sponsorship_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS public_sponsorship_signal_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL UNIQUE,
    channel_name TEXT NOT NULL,
    snapshot_id INTEGER,
    signals_json TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS public_sponsorship_signal_scans_expiry_idx
    ON public_sponsorship_signal_scans (expires_at);

  CREATE INDEX IF NOT EXISTS creator_sponsorships_lookup_idx
    ON creator_sponsorships (channel_id, snapshot_id, retrieved_at);

  CREATE TABLE IF NOT EXISTS shopify_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK (event_type IN ('purchase', 'refund')),
    amount REAL NOT NULL,
    currency TEXT,
    occurred_at TEXT NOT NULL,
    tracking_link_id INTEGER,
    tracking_token TEXT,
    utm_json TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS shopify_webhook_events_tracking_idx
    ON shopify_webhook_events (tracking_link_id, occurred_at);
`);

// Keep campaign briefs readable if a local database was created by an earlier
// campaign prototype. Nullable additions let the next write fill the complete
// brief without rebuilding or dropping the user's SQLite file.
const existingCampaignColumns = new Set(
  db.prepare("PRAGMA table_info(campaign_briefs)").all().map((column) => column.name)
);
const campaignColumns = {
  name: "TEXT",
  product: "TEXT",
  goal: "TEXT",
  budget: "REAL",
  target_cac: "REAL",
  product_price: "REAL",
  gross_margin: "REAL",
  audience: "TEXT",
  location: "TEXT",
  language: "TEXT",
  destination_url: "TEXT",
  currency: "TEXT",
  click_through_rate: "REAL",
  conversion_rate: "REAL",
  created_at: "TEXT"
};

for (const [column, type] of Object.entries(campaignColumns)) {
  if (!existingCampaignColumns.has(column)) {
    db.exec(`ALTER TABLE campaign_briefs ADD COLUMN ${column} ${type}`);
  }
}

// Existing local databases predate the separated metric columns. Add them in
// place so the original SQLite file and old snapshot rows remain usable.
const existingColumns = new Set(
  db.prepare("PRAGMA table_info(creator_snapshots)").all().map((column) => column.name)
);
const columns = {
  youtube_subscribers: "INTEGER",
  youtube_video_count: "INTEGER",
  youtube_median_recent_views: "INTEGER",
  youtube_views_to_subscriber_ratio: "REAL",
  youtube_source: "TEXT",
  performance_consistency: "REAL",
  engagement_rate: "REAL",
  expected_relevant_views: "INTEGER",
  estimated_fee_min: "INTEGER",
  estimated_fee_max: "INTEGER",
  estimated_fee_currency: "TEXT",
  estimate_data_confidence: "TEXT",
  estimate_methodology_json: "TEXT",
  campaign_id: "INTEGER",
  campaign_economics_json: "TEXT"
};

for (const [column, type] of Object.entries(columns)) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE creator_snapshots ADD COLUMN ${column} ${type}`);
  }
}

db.exec(`
  UPDATE creator_snapshots
  SET
    youtube_subscribers = COALESCE(youtube_subscribers, subscribers),
    youtube_video_count = COALESCE(youtube_video_count, video_count),
    youtube_median_recent_views = COALESCE(youtube_median_recent_views, median_recent_views),
    youtube_views_to_subscriber_ratio = COALESCE(youtube_views_to_subscriber_ratio, views_to_subscriber_ratio),
    youtube_source = COALESCE(youtube_source, 'youtube_data_api')
  WHERE youtube_subscribers IS NULL
`);

function serializeEstimateMethodology(estimates) {
  return estimates?.methodology
    ? JSON.stringify(estimates.methodology)
    : null;
}

function serializeCampaignEconomics(estimates) {
  return estimates?.campaignEconomics
    ? JSON.stringify(estimates.campaignEconomics)
    : null;
}

function createCampaign(campaign) {
  if (!campaign || typeof campaign !== "object") {
    throw new Error("A campaign brief is required.");
  }

  const statement = db.prepare(`
    INSERT INTO campaign_briefs (
      name, product, goal, budget, target_cac, product_price, gross_margin,
      audience, location, language, destination_url, click_through_rate, conversion_rate, created_at,
      currency
    ) VALUES (
      @name, @product, @goal, @budget, @targetCac, @productPrice, @grossMargin,
      @audience, @location, @language, @destinationUrl, @clickThroughRate, @conversionRate, @createdAt,
      @currency
    )
  `);

  const result = statement.run({
    name: campaign.name,
    product: campaign.product,
    goal: campaign.goal,
    budget: campaign.budget,
    targetCac: campaign.targetCac,
    productPrice: campaign.productPrice,
    grossMargin: campaign.grossMargin,
    audience: campaign.audience,
    location: campaign.location,
    language: campaign.language,
    destinationUrl: campaign.destinationUrl || null,
    currency: campaign.currency || "USD",
    clickThroughRate: campaign.clickThroughRate ?? null,
    conversionRate: campaign.conversionRate ?? null,
    createdAt: campaign.createdAt || new Date().toISOString()
  });

  return getCampaignById(Number(result.lastInsertRowid));
}

function toCampaign(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    product: row.product,
    goal: row.goal,
    budget: row.budget,
    targetCac: row.target_cac,
    productPrice: row.product_price,
    grossMargin: row.gross_margin,
    audience: row.audience,
    location: row.location,
    language: row.language,
    destinationUrl: row.destination_url || null,
    currency: row.currency || "USD",
    clickThroughRate: row.click_through_rate,
    conversionRate: row.conversion_rate,
    createdAt: row.created_at
  };
}

function getCampaigns() {
  return db
    .prepare("SELECT * FROM campaign_briefs ORDER BY created_at DESC, id DESC")
    .all()
    .map(toCampaign);
}

function getCampaignById(id) {
  return toCampaign(
    db.prepare("SELECT * FROM campaign_briefs WHERE id = ?").get(id)
  );
}

function saveSnapshot(summary, campaignId = summary?.campaignId) {
  if (!summary || !summary.channelId || !summary.channelName || !summary.retrievedAt) {
    throw new Error("A snapshot requires channelId, channelName, and retrievedAt.");
  }

  const youtubeMetrics = summary.youtubeMetrics || {
    subscribers: summary.subscribers,
    videoCount: summary.videoCount,
    medianRecentViews: summary.medianRecentViews,
    viewsToSubscriberRatio: summary.viewsToSubscriberRatio,
    retrievedAt: summary.retrievedAt,
    source: "youtube_data_api"
  };
  const estimates = summary.estimates || {};
  const feeRange = estimates.estimatedFeeRange || {};

  const statement = db.prepare(`
    INSERT INTO creator_snapshots (
      channel_id,
      channel_name,
      subscribers,
      video_count,
      median_recent_views,
      views_to_subscriber_ratio,
      retrieved_at,
      youtube_subscribers,
      youtube_video_count,
      youtube_median_recent_views,
      youtube_views_to_subscriber_ratio,
      youtube_source,
      performance_consistency,
      engagement_rate,
      expected_relevant_views,
      estimated_fee_min,
      estimated_fee_max,
      estimated_fee_currency,
      estimate_data_confidence,
      estimate_methodology_json,
      campaign_id,
      campaign_economics_json
    ) VALUES (
      @channelId,
      @channelName,
      @subscribers,
      @videoCount,
      @medianRecentViews,
      @viewsToSubscriberRatio,
      @retrievedAt,
      @youtubeSubscribers,
      @youtubeVideoCount,
      @youtubeMedianRecentViews,
      @youtubeViewsToSubscriberRatio,
      @youtubeSource,
      @performanceConsistency,
      @engagementRate,
      @expectedRelevantViews,
      @estimatedFeeMin,
      @estimatedFeeMax,
      @estimatedFeeCurrency,
      @estimateDataConfidence,
      @estimateMethodologyJson,
      @campaignId,
      @campaignEconomicsJson
    )
  `);

  return statement.run({
    channelId: summary.channelId,
    channelName: summary.channelName,
    subscribers: summary.subscribers ?? youtubeMetrics.subscribers ?? null,
    videoCount: summary.videoCount ?? youtubeMetrics.videoCount ?? null,
    medianRecentViews: summary.medianRecentViews ?? youtubeMetrics.medianRecentViews ?? null,
    viewsToSubscriberRatio: summary.viewsToSubscriberRatio ?? youtubeMetrics.viewsToSubscriberRatio ?? null,
    retrievedAt: summary.retrievedAt,
    youtubeSubscribers: youtubeMetrics.subscribers ?? null,
    youtubeVideoCount: youtubeMetrics.videoCount ?? null,
    youtubeMedianRecentViews: youtubeMetrics.medianRecentViews ?? null,
    youtubeViewsToSubscriberRatio: youtubeMetrics.viewsToSubscriberRatio ?? null,
    youtubeSource: youtubeMetrics.source || "youtube_data_api",
    performanceConsistency: estimates.performanceConsistency ?? null,
    engagementRate: estimates.engagementRate ?? null,
    expectedRelevantViews: estimates.expectedRelevantViews ?? null,
    estimatedFeeMin: feeRange.min ?? null,
    estimatedFeeMax: feeRange.max ?? null,
    estimatedFeeCurrency: feeRange.currency || "USD",
    estimateDataConfidence: estimates.dataConfidence || null,
    estimateMethodologyJson: serializeEstimateMethodology(estimates),
    campaignId: campaignId ?? null,
    campaignEconomicsJson: serializeCampaignEconomics(estimates)
  });
}

function toSnapshot(row) {
  const methodology = row.estimate_methodology_json
    ? JSON.parse(row.estimate_methodology_json)
    : null;
  const campaignEconomics = row.campaign_economics_json
    ? JSON.parse(row.campaign_economics_json)
    : null;

  return {
    ...row,
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    subscribers: row.subscribers,
    videoCount: row.video_count,
    medianRecentViews: row.median_recent_views,
    viewsToSubscriberRatio: row.views_to_subscriber_ratio,
    retrievedAt: row.retrieved_at,
    campaignId: row.campaign_id ?? null,
    youtubeMetrics: {
      subscribers: row.youtube_subscribers ?? row.subscribers,
      videoCount: row.youtube_video_count ?? row.video_count,
      medianRecentViews: row.youtube_median_recent_views ?? row.median_recent_views,
      viewsToSubscriberRatio: row.youtube_views_to_subscriber_ratio ?? row.views_to_subscriber_ratio,
      retrievedAt: row.retrieved_at,
      source: row.youtube_source || "youtube_data_api"
    },
    estimates: {
      source: row.estimate_methodology_json ? "mangokast_estimate" : null,
      performanceConsistency: row.performance_consistency,
      engagementRate: row.engagement_rate,
      expectedRelevantViews: row.expected_relevant_views,
      estimatedFeeRange: row.estimated_fee_min === null && row.estimated_fee_max === null
        ? null
        : {
            min: row.estimated_fee_min,
            max: row.estimated_fee_max,
            currency: row.estimated_fee_currency || "USD"
          },
      dataConfidence: row.estimate_data_confidence,
      isEstimate: Boolean(row.estimate_methodology_json),
      methodology,
      campaignEconomics
    }
  };
}

function getSnapshots() {
  return db
    .prepare(`
      SELECT *
      FROM creator_snapshots
      ORDER BY retrieved_at DESC, id DESC
    `)
    .all()
    .map(toSnapshot);
}

function getSnapshotsByIds(ids) {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM creator_snapshots WHERE id IN (${placeholders})`)
    .all(...ids)
    .map(toSnapshot);
  const byId = new Map(rows.map((row) => [row.id, row]));

  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function getSnapshotById(id) {
  const row = db.prepare("SELECT * FROM creator_snapshots WHERE id = ?").get(id);
  return toSnapshot(row);
}

function createTrackingLink(link) {
  if (!link || typeof link !== "object") {
    throw new Error("A tracking link is required.");
  }

  const token = link.token || crypto.randomBytes(12).toString("base64url");
  const statement = db.prepare(`
    INSERT INTO tracking_links (
      campaign_id,
      snapshot_id,
      token,
      destination_url,
      channel_id,
      channel_name,
      planned_fee_min,
      planned_fee_max,
      planned_cac_min,
      planned_cac_max,
      planned_clicks,
      planned_leads,
      planned_purchases,
      planned_revenue,
      actual_fee,
      currency,
      created_at
    ) VALUES (
      @campaignId,
      @snapshotId,
      @token,
      @destinationUrl,
      @channelId,
      @channelName,
      @plannedFeeMin,
      @plannedFeeMax,
      @plannedCacMin,
      @plannedCacMax,
      @plannedClicks,
      @plannedLeads,
      @plannedPurchases,
      @plannedRevenue,
      @actualFee,
      @currency,
      @createdAt
    )
  `);

  const result = statement.run({
    campaignId: link.campaignId,
    snapshotId: link.snapshotId,
    token,
    destinationUrl: link.destinationUrl,
    channelId: link.channelId,
    channelName: link.channelName,
    plannedFeeMin: link.plannedFeeMin ?? null,
    plannedFeeMax: link.plannedFeeMax ?? null,
    plannedCacMin: link.plannedCacMin ?? null,
    plannedCacMax: link.plannedCacMax ?? null,
    plannedClicks: link.plannedClicks ?? null,
    plannedLeads: link.plannedLeads ?? null,
    plannedPurchases: link.plannedPurchases ?? null,
    plannedRevenue: link.plannedRevenue ?? null,
    actualFee: link.actualFee ?? null,
    currency: link.currency || "USD",
    createdAt: link.createdAt || new Date().toISOString()
  });

  return getTrackingLinkById(Number(result.lastInsertRowid));
}

function toTrackingLink(row) {
  if (!row) {
    return null;
  }

  const plannedFee = row.planned_fee_min === null && row.planned_fee_max === null
    ? null
    : {
        min: row.planned_fee_min,
        max: row.planned_fee_max,
        currency: row.currency || "USD"
      };
  const plannedCac = row.planned_cac_min === null && row.planned_cac_max === null
    ? null
    : {
        min: row.planned_cac_min,
        max: row.planned_cac_max,
        currency: row.currency || "USD"
      };

  return {
    id: row.id,
    campaignId: row.campaign_id,
    snapshotId: row.snapshot_id,
    token: row.token,
    code: row.token,
    trackingUrl: `/t/${row.token}`,
    destinationUrl: row.destination_url,
    channelId: row.channel_id,
    channelName: row.channel_name,
    plannedFee,
    plannedFeeMin: row.planned_fee_min,
    plannedFeeMax: row.planned_fee_max,
    plannedCac,
    plannedCacMin: row.planned_cac_min,
    plannedCacMax: row.planned_cac_max,
    plannedClicks: row.planned_clicks,
    plannedLeads: row.planned_leads,
    plannedPurchases: row.planned_purchases,
    plannedRevenue: row.planned_revenue,
    actualFee: row.actual_fee,
    actualSpend: row.actual_fee,
    spend: row.actual_fee,
    fee: row.actual_fee,
    currency: row.currency || "USD",
    createdAt: row.created_at
  };
}

function getTrackingLinkById(id) {
  return toTrackingLink(
    db.prepare("SELECT * FROM tracking_links WHERE id = ?").get(id)
  );
}

function getTrackingLinkByToken(token) {
  return toTrackingLink(
    db.prepare("SELECT * FROM tracking_links WHERE token = ?").get(token)
  );
}

function getTrackingLinksByCampaignId(campaignId) {
  return db
    .prepare(`
      SELECT *
      FROM tracking_links
      WHERE campaign_id = ?
      ORDER BY created_at DESC, id DESC
    `)
    .all(campaignId)
    .map(toTrackingLink);
}

function toAttributionEvent(row) {
  if (!row) {
    return null;
  }

  let metadata = null;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch (error) {
      metadata = null;
    }
  }

  return {
    id: row.id,
    trackingLinkId: row.tracking_link_id,
    idempotencyKey: row.event_key,
    eventId: row.event_key,
    type: row.event_type,
    eventType: row.event_type,
    amount: row.amount,
    currency: row.currency,
    occurredAt: row.occurred_at,
    metadata,
    createdAt: row.created_at
  };
}

function recordAttributionEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("An attribution event is required.");
  }

  const existing = db.prepare(`
    SELECT *
    FROM attribution_events
    WHERE tracking_link_id = ? AND event_key = ?
  `).get(event.trackingLinkId, event.eventKey);

  if (existing) {
    if (
      existing.event_type !== event.eventType ||
      Number(existing.amount ?? 0) !== Number(event.amount ?? 0)
    ) {
      const conflict = new Error("An idempotency key was already used for a different event.");
      conflict.statusCode = 409;
      throw conflict;
    }

    return { event: toAttributionEvent(existing), created: false };
  }

  const statement = db.prepare(`
    INSERT INTO attribution_events (
      tracking_link_id,
      event_key,
      event_type,
      amount,
      currency,
      occurred_at,
      metadata_json,
      created_at
    ) VALUES (
      @trackingLinkId,
      @eventKey,
      @eventType,
      @amount,
      @currency,
      @occurredAt,
      @metadataJson,
      @createdAt
    )
  `);

  try {
    const result = statement.run({
      trackingLinkId: event.trackingLinkId,
      eventKey: event.eventKey,
      eventType: event.eventType,
      amount: event.amount ?? null,
      currency: event.currency ?? null,
      occurredAt: event.occurredAt,
      metadataJson: event.metadata ? JSON.stringify(event.metadata) : null,
      createdAt: event.createdAt || new Date().toISOString()
    });
    return {
      event: toAttributionEvent(
        db.prepare("SELECT * FROM attribution_events WHERE id = ?").get(Number(result.lastInsertRowid))
      ),
      created: true
    };
  } catch (error) {
    // A concurrent request can win the unique-key race. Return that durable
    // event rather than counting it twice.
    if (String(error.code || "").includes("SQLITE_CONSTRAINT")) {
      const raced = db.prepare(`
        SELECT *
        FROM attribution_events
        WHERE tracking_link_id = ? AND event_key = ?
      `).get(event.trackingLinkId, event.eventKey);
      if (raced) {
        return { event: toAttributionEvent(raced), created: false };
      }
    }
    throw error;
  }
}

function getCampaignPerformance(campaignId) {
  const campaign = getCampaignById(campaignId);
  if (!campaign) {
    return null;
  }

  const rows = db.prepare(`
    SELECT
      tl.*,
      SUM(CASE WHEN ae.event_type = 'click' THEN 1 ELSE 0 END) AS clicks,
      SUM(CASE WHEN ae.event_type = 'lead' THEN 1 ELSE 0 END) AS leads,
      SUM(CASE WHEN ae.event_type = 'purchase' THEN 1 ELSE 0 END) AS purchases,
      SUM(CASE WHEN ae.event_type = 'refund' THEN 1 ELSE 0 END) AS refunds,
      COALESCE(SUM(CASE WHEN ae.event_type = 'purchase' THEN ae.amount ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ae.event_type = 'refund' THEN ae.amount ELSE 0 END), 0) AS refunds_amount,
      CASE WHEN tl.actual_fee IS NULL THEN 0 ELSE 1 END AS has_actual_fee
    FROM tracking_links tl
    LEFT JOIN attribution_events ae ON ae.tracking_link_id = tl.id
    WHERE tl.campaign_id = ?
    GROUP BY tl.id
    ORDER BY tl.created_at ASC, tl.id ASC
  `).all(campaignId);

  const sum = (field) => rows.reduce(
    (total, row) => total + (Number.isFinite(Number(row[field])) ? Number(row[field]) : 0),
    0
  );
  const nullableSum = (field) => {
    const values = rows
      .map((row) => row[field])
      .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
    return values.length === 0 ? null : values.reduce((total, value) => total + Number(value), 0);
  };
  const round = (value) => Number(value.toFixed(2));
  const plannedFeeMin = nullableSum("planned_fee_min");
  const plannedFeeMax = nullableSum("planned_fee_max");
  const plannedCacMin = nullableSum("planned_cac_min");
  const plannedCacMax = nullableSum("planned_cac_max");
  const planned = {
    clicks: nullableSum("planned_clicks"),
    leads: nullableSum("planned_leads"),
    purchases: nullableSum("planned_purchases"),
    revenue: nullableSum("planned_revenue"),
    fee: plannedFeeMin === null && plannedFeeMax === null
      ? null
      : { min: plannedFeeMin, max: plannedFeeMax, currency: campaign.currency },
    spend: plannedFeeMin === null && plannedFeeMax === null
      ? null
      : { min: plannedFeeMin, max: plannedFeeMax, currency: campaign.currency },
    cac: plannedCacMin === null && plannedCacMax === null
      ? null
      : { min: plannedCacMin, max: plannedCacMax, currency: campaign.currency }
  };
  const actualFee = nullableSum("actual_fee");
  const actual = {
    clicks: sum("clicks"),
    leads: sum("leads"),
    purchases: sum("purchases"),
    revenue: round(sum("revenue")),
    refunds: round(sum("refunds_amount")),
    refundCount: sum("refunds"),
    fee: actualFee === null ? null : round(actualFee),
    spend: actualFee === null ? null : round(actualFee),
    cac: actualFee !== null && sum("purchases") > 0
      ? round(actualFee / sum("purchases"))
      : null
  };
  const actualRevenue = actual.revenue - actual.refunds;
  actual.actualFee = actual.fee;
  actual.actualSpend = actual.spend;
  actual.actualCac = actual.cac;
  actual.actualCAC = actual.cac;
  actual.netRevenue = round(actualRevenue);

  const variance = (plannedValue, actualValue) => ({
    planned: plannedValue,
    actual: actualValue,
    delta: plannedValue === null || plannedValue === undefined || actualValue === null || actualValue === undefined
      ? null
      : round(actualValue - plannedValue),
    ratio: plannedValue === null || plannedValue === undefined || plannedValue === 0 || actualValue === null || actualValue === undefined
      ? null
      : round(actualValue / plannedValue)
  });

  const plannedVsActual = {
    clicks: variance(planned.clicks, actual.clicks),
    leads: variance(planned.leads, actual.leads),
    purchases: variance(planned.purchases, actual.purchases),
    revenue: variance(planned.revenue, actual.revenue),
    refunds: variance(0, actual.refunds),
    fee: variance(planned.fee?.min ?? null, actual.fee),
    cac: variance(planned.cac?.min ?? null, actual.cac)
  };

  const links = rows.map((row) => {
    const link = toTrackingLink(row);
    const linkFee = row.actual_fee === null ? null : Number(row.actual_fee);
    const linkPurchases = Number(row.purchases || 0);
    const linkRevenue = Number(row.revenue || 0);
    const linkRefunds = Number(row.refunds_amount || 0);
    return {
      ...link,
      performance: {
        clicks: Number(row.clicks || 0),
        leads: Number(row.leads || 0),
        purchases: linkPurchases,
        revenue: round(linkRevenue),
        refunds: round(linkRefunds),
        refundCount: Number(row.refunds || 0),
        netRevenue: round(linkRevenue - linkRefunds),
        actualFee: linkFee,
        actualSpend: linkFee,
        actualCac: linkFee !== null && linkPurchases > 0
          ? round(linkFee / linkPurchases)
          : null
      }
    };
  });

  return {
    campaignId,
    currency: campaign.currency,
    links,
    planned,
    actual,
    plannedVsActual,
    // Flat aliases make the summary convenient for reporting clients while
    // retaining the explicit planned/actual namespaces above.
    clicks: actual.clicks,
    leads: actual.leads,
    purchases: actual.purchases,
    revenue: actual.revenue,
    refunds: actual.refunds,
    refundCount: actual.refundCount,
    actualRevenue: actual.revenue,
    actualRefunds: actual.refunds,
    netRevenue: actual.netRevenue,
    spend: actual.spend,
    fee: actual.fee,
    actualSpend: actual.spend,
    actualFee: actual.fee,
    actualCac: actual.cac,
    actualCAC: actual.cac,
    plannedClicks: planned.clicks,
    plannedLeads: planned.leads,
    plannedPurchases: planned.purchases,
    plannedRevenue: planned.revenue,
    plannedSpend: planned.spend,
    plannedFee: planned.fee,
    plannedFeeMin,
    plannedFeeMax,
    plannedCac: planned.cac,
    plannedCacMin,
    plannedCacMax,
    plannedCAC: planned.cac
  };
}

function getCachedAnalysis({ campaignId, channelKeys, ttlMs, now = Date.now() }) {
  const keys = [...new Set((channelKeys || []).filter(Boolean))];
  if (keys.length === 0) {
    return null;
  }

  const placeholders = keys.map(() => "?").join(", ");
  const row = db.prepare(`
    SELECT *
    FROM creator_analysis_cache
    WHERE campaign_id = ?
      AND channel_key IN (${placeholders})
    ORDER BY analysed_at DESC, id DESC
    LIMIT 1
  `).get(campaignId ?? 0, ...keys);

  if (!row || !Number.isFinite(Date.parse(row.analysed_at))) {
    return null;
  }

  if (Date.parse(row.analysed_at) < now - ttlMs) {
    return null;
  }

  let result;
  try {
    result = JSON.parse(row.result_json);
  } catch (error) {
    return null;
  }

  return {
    result,
    snapshotId: row.snapshot_id,
    cachedAt: row.analysed_at,
    channelId: row.channel_id || result.summary?.channelId || null
  };
}

function saveAnalysisCache({ campaignId, channelKeys, channelId, snapshotId, result, analysedAt }) {
  const keys = [...new Set((channelKeys || []).filter(Boolean))];
  if (keys.length === 0) {
    return;
  }

  const statement = db.prepare(`
    INSERT INTO creator_analysis_cache (
      campaign_id,
      channel_key,
      channel_id,
      snapshot_id,
      result_json,
      analysed_at
    ) VALUES (@campaignId, @channelKey, @channelId, @snapshotId, @resultJson, @analysedAt)
    ON CONFLICT (campaign_id, channel_key) DO UPDATE SET
      channel_id = excluded.channel_id,
      snapshot_id = excluded.snapshot_id,
      result_json = excluded.result_json,
      analysed_at = excluded.analysed_at
  `);
  const transaction = db.transaction(() => {
    for (const channelKey of keys) {
      statement.run({
        campaignId: campaignId ?? 0,
        channelKey,
        channelId: channelId || null,
        snapshotId,
        resultJson: JSON.stringify(result),
        analysedAt: analysedAt || new Date().toISOString()
      });
    }
  });
  transaction();
}

const CREATOR_INTELLIGENCE_SOURCE_TYPES = new Set([
  "creator_authorized",
  "creator_supplied",
  "provider",
  "mangokast_review"
]);

const INTELLIGENCE_TABLES = {
  audience: {
    table: "creator_audience_profiles",
    jsonColumn: "profile_json",
    responseKey: "audienceProfile"
  },
  quality: {
    table: "creator_quality_reviews",
    jsonColumn: "review_json",
    responseKey: "qualityReview"
  },
  sponsorship: {
    table: "creator_sponsorships",
    jsonColumn: "sponsorship_json",
    responseKey: "sponsorship"
  }
};

function validateCreatorIntelligenceMetadata(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("A creator intelligence record is required.");
  }
  if (typeof record.channelId !== "string" || record.channelId.trim().length === 0) {
    throw new Error("channelId is required.");
  }
  if (!CREATOR_INTELLIGENCE_SOURCE_TYPES.has(record.sourceType)) {
    throw new Error("sourceType must be one of creator_authorized, creator_supplied, provider, or mangokast_review.");
  }
  if (typeof record.retrievedAt !== "string" || !Number.isFinite(Date.parse(record.retrievedAt))) {
    throw new Error("retrievedAt must be a valid ISO date.");
  }
  if (!Number.isFinite(Number(record.confidence)) || Number(record.confidence) < 0 || Number(record.confidence) > 1) {
    throw new Error("confidence must be a number between 0 and 1.");
  }
  if (typeof record.status !== "string" || record.status.trim().length === 0) {
    throw new Error("status is required.");
  }
}

function intelligenceData(record, descriptor) {
  const explicitData = record.data
    ?? record[descriptor.responseKey]
    ?? record.profile
    ?? record.review
    ?? record.audience
    ?? record.quality
    ?? record.qualityReview
    ?? record.audienceProfile
    ?? record.sponsorship
    ?? record.sponsorshipRecord;
  if (explicitData !== undefined) {
    if (!explicitData || typeof explicitData !== "object" || Array.isArray(explicitData)) {
      throw new Error("data must be a JSON object.");
    }
    return explicitData;
  }

  const metadataKeys = new Set([
    "id", "channelId", "snapshotId", "sourceType", "retrievedAt", "confidence", "status",
    "createdAt", "updatedAt"
  ]);
  const data = Object.fromEntries(
    Object.entries(record).filter(([key]) => !metadataKeys.has(key))
  );
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("data must be a JSON object.");
  }
  return data;
}

function toCreatorIntelligenceRecord(row, descriptor) {
  if (!row) {
    return null;
  }

  let data = {};
  try {
    data = JSON.parse(row[descriptor.jsonColumn]);
  } catch (error) {
    data = {};
  }

  const record = {
    id: row.id,
    channelId: row.channel_id,
    snapshotId: row.snapshot_id ?? null,
    sourceType: row.source_type,
    source: row.source_type,
    retrievedAt: row.retrieved_at,
    confidence: row.confidence,
    status: row.status,
    data,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  record[descriptor.responseKey] = data;
  if (descriptor.responseKey === "audienceProfile") record.profile = data;
  if (descriptor.responseKey === "qualityReview") record.review = data;
  if (descriptor.responseKey === "sponsorship") record.sponsorshipRecord = data;

  // Keep common submitted fields convenient for API consumers while retaining
  // the complete payload under data/profile/review/sponsorship.
  for (const [key, value] of Object.entries(data)) {
    if (record[key] === undefined) {
      record[key] = value;
    }
  }
  return record;
}

function createCreatorIntelligenceRecord(kind, record) {
  const descriptor = INTELLIGENCE_TABLES[kind];
  if (!descriptor) {
    throw new Error("Unknown creator intelligence record type.");
  }
  validateCreatorIntelligenceMetadata(record);
  const data = intelligenceData(record, descriptor);
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO ${descriptor.table} (
      channel_id, snapshot_id, source_type, retrieved_at, confidence, status,
      ${descriptor.jsonColumn}, created_at, updated_at
    ) VALUES (@channelId, @snapshotId, @sourceType, @retrievedAt, @confidence, @status,
      @dataJson, @createdAt, @updatedAt)
  `).run({
    channelId: record.channelId.trim(),
    snapshotId: record.snapshotId ?? null,
    sourceType: record.sourceType,
    retrievedAt: record.retrievedAt,
    confidence: Number(record.confidence),
    status: record.status.trim(),
    dataJson: JSON.stringify(data),
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || now
  });
  return getCreatorIntelligenceRecordById(kind, Number(result.lastInsertRowid));
}

function getCreatorIntelligenceRecords(kind, filters = {}) {
  const descriptor = INTELLIGENCE_TABLES[kind];
  if (!descriptor) {
    throw new Error("Unknown creator intelligence record type.");
  }
  const clauses = [];
  const values = [];
  if (filters.channelId !== undefined && filters.channelId !== null) {
    clauses.push("channel_id = ?");
    values.push(filters.channelId);
  }
  if (filters.snapshotId !== undefined && filters.snapshotId !== null) {
    clauses.push("snapshot_id = ?");
    values.push(filters.snapshotId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT *
    FROM ${descriptor.table}
    ${where}
    ORDER BY retrieved_at DESC, id DESC
  `).all(...values).map((row) => toCreatorIntelligenceRecord(row, descriptor));
}

function getCreatorIntelligenceRecordById(kind, id) {
  const descriptor = INTELLIGENCE_TABLES[kind];
  if (!descriptor) {
    throw new Error("Unknown creator intelligence record type.");
  }
  return toCreatorIntelligenceRecord(
    db.prepare(`SELECT * FROM ${descriptor.table} WHERE id = ?`).get(id),
    descriptor
  );
}

function updateCreatorIntelligenceRecord(kind, id, record) {
  const descriptor = INTELLIGENCE_TABLES[kind];
  const existing = getCreatorIntelligenceRecordById(kind, id);
  if (!descriptor) {
    throw new Error("Unknown creator intelligence record type.");
  }
  if (!existing) {
    return null;
  }
  const merged = {
    ...existing,
    ...record,
    channelId: record.channelId ?? existing.channelId,
    snapshotId: record.snapshotId === undefined ? existing.snapshotId : record.snapshotId,
    sourceType: record.sourceType ?? existing.sourceType,
    retrievedAt: record.retrievedAt ?? existing.retrievedAt,
    confidence: record.confidence ?? existing.confidence,
    status: record.status ?? existing.status,
    data: record.data
      ?? record[descriptor.responseKey]
      ?? record.profile
      ?? record.review
      ?? record.audience
      ?? record.quality
      ?? record.qualityReview
      ?? record.audienceProfile
      ?? record.sponsorship
      ?? record.sponsorshipRecord
      ?? existing.data
  };
  validateCreatorIntelligenceMetadata(merged);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE ${descriptor.table}
    SET channel_id = @channelId,
        snapshot_id = @snapshotId,
        source_type = @sourceType,
        retrieved_at = @retrievedAt,
        confidence = @confidence,
        status = @status,
        ${descriptor.jsonColumn} = @dataJson,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    channelId: merged.channelId.trim(),
    snapshotId: merged.snapshotId ?? null,
    sourceType: merged.sourceType,
    retrievedAt: merged.retrievedAt,
    confidence: Number(merged.confidence),
    status: merged.status.trim(),
    dataJson: JSON.stringify(intelligenceData(merged, descriptor)),
    updatedAt: now
  });
  return getCreatorIntelligenceRecordById(kind, id);
}

function deleteCreatorIntelligenceRecord(kind, id) {
  const descriptor = INTELLIGENCE_TABLES[kind];
  if (!descriptor) {
    throw new Error("Unknown creator intelligence record type.");
  }
  const result = db.prepare(`DELETE FROM ${descriptor.table} WHERE id = ?`).run(id);
  return result.changes > 0;
}

function createAudienceProfile(record) {
  return createCreatorIntelligenceRecord("audience", record);
}

function getAudienceProfiles(filters) {
  return getCreatorIntelligenceRecords("audience", filters);
}

function getAudienceProfileById(id) {
  return getCreatorIntelligenceRecordById("audience", id);
}

const getAudienceProfile = getAudienceProfileById;

function updateAudienceProfile(id, record) {
  return updateCreatorIntelligenceRecord("audience", id, record);
}

function deleteAudienceProfile(id) {
  return deleteCreatorIntelligenceRecord("audience", id);
}

function createQualityReview(record) {
  return createCreatorIntelligenceRecord("quality", record);
}

function getQualityReviews(filters) {
  return getCreatorIntelligenceRecords("quality", filters);
}

function getQualityReviewById(id) {
  return getCreatorIntelligenceRecordById("quality", id);
}

const getQualityReview = getQualityReviewById;

function updateQualityReview(id, record) {
  return updateCreatorIntelligenceRecord("quality", id, record);
}

function deleteQualityReview(id) {
  return deleteCreatorIntelligenceRecord("quality", id);
}

function createSponsorshipRecord(record) {
  return createCreatorIntelligenceRecord("sponsorship", record);
}

function getSponsorshipRecords(filters) {
  return getCreatorIntelligenceRecords("sponsorship", filters);
}

function getSponsorshipRecordById(id) {
  return getCreatorIntelligenceRecordById("sponsorship", id);
}

const getSponsorshipRecord = getSponsorshipRecordById;

function updateSponsorshipRecord(id, record) {
  return updateCreatorIntelligenceRecord("sponsorship", id, record);
}

function deleteSponsorshipRecord(id) {
  return deleteCreatorIntelligenceRecord("sponsorship", id);
}

const PUBLIC_SPONSORSHIP_SIGNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_SPONSORSHIP_SIGNAL_SOURCE = "public_description_signal";
const PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER =
  "This is not verified sponsorship history.";

function compactPublicSponsorshipSignals(signals) {
  if (!Array.isArray(signals)) {
    throw new Error("signals must be an array.");
  }

  return signals.map((signal) => {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
      throw new Error("Each sponsorship signal must be a JSON object.");
    }
    if (typeof signal.videoId !== "string" || signal.videoId.trim().length === 0) {
      throw new Error("Each sponsorship signal requires videoId.");
    }
    if (typeof signal.retrievedAt !== "string" || !Number.isFinite(Date.parse(signal.retrievedAt))) {
      throw new Error("Each sponsorship signal requires a valid retrievedAt.");
    }
    if (signal.sourceType !== PUBLIC_SPONSORSHIP_SIGNAL_SOURCE) {
      throw new Error(`sourceType must be ${PUBLIC_SPONSORSHIP_SIGNAL_SOURCE}.`);
    }
    if (!["low", "medium", "high"].includes(signal.confidence)) {
      throw new Error("confidence must be low, medium, or high.");
    }

    return {
      videoId: signal.videoId.trim().slice(0, 128),
      title: typeof signal.title === "string" ? signal.title.slice(0, 500) : "",
      date: typeof signal.date === "string" && Number.isFinite(Date.parse(signal.date))
        ? signal.date
        : null,
      sourceUrl: typeof signal.sourceUrl === "string" ? signal.sourceUrl.slice(0, 2048) : null,
      detectedDomains: Array.isArray(signal.detectedDomains)
        ? [...new Set(signal.detectedDomains.filter((domain) => typeof domain === "string"))].slice(0, 10)
        : [],
      matchedKeywords: Array.isArray(signal.matchedKeywords)
        ? [...new Set(signal.matchedKeywords.filter((keyword) => typeof keyword === "string"))].slice(0, 20)
        : [],
      confidence: signal.confidence,
      sourceType: PUBLIC_SPONSORSHIP_SIGNAL_SOURCE,
      retrievedAt: signal.retrievedAt,
      disclaimer: PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER
    };
  });
}

function toPublicSponsorshipSignalScan(row) {
  if (!row) {
    return null;
  }

  let signals = [];
  try {
    const parsed = JSON.parse(row.signals_json);
    signals = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    signals = [];
  }

  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    snapshotId: row.snapshot_id ?? null,
    signals,
    public_sponsorship_signals: signals,
    sourceType: PUBLIC_SPONSORSHIP_SIGNAL_SOURCE,
    retrievedAt: row.retrieved_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disclaimer: PUBLIC_SPONSORSHIP_SIGNAL_DISCLAIMER,
    retentionNote: "Public description signals expire after 30 days and can be deleted sooner; raw descriptions are never stored."
  };
}

function deleteExpiredPublicSponsorshipSignalScans(now = new Date()) {
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return db.prepare(
    "DELETE FROM public_sponsorship_signal_scans WHERE expires_at <= ?"
  ).run(timestamp).changes;
}

function savePublicSponsorshipSignalScan(scan) {
  if (!scan || typeof scan !== "object" || Array.isArray(scan)) {
    throw new Error("A public sponsorship signal scan is required.");
  }
  if (typeof scan.channelId !== "string" || scan.channelId.trim().length === 0) {
    throw new Error("channelId is required.");
  }
  if (typeof scan.retrievedAt !== "string" || !Number.isFinite(Date.parse(scan.retrievedAt))) {
    throw new Error("retrievedAt must be a valid ISO date.");
  }

  const signals = compactPublicSponsorshipSignals(scan.signals || []);
  const retrievedAt = new Date(scan.retrievedAt).toISOString();
  const expiresAt = new Date(
    Date.parse(retrievedAt) + PUBLIC_SPONSORSHIP_SIGNAL_RETENTION_MS
  ).toISOString();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO public_sponsorship_signal_scans (
      channel_id, channel_name, snapshot_id, signals_json, retrieved_at,
      expires_at, created_at, updated_at
    ) VALUES (
      @channelId, @channelName, @snapshotId, @signalsJson, @retrievedAt,
      @expiresAt, @createdAt, @updatedAt
    )
    ON CONFLICT (channel_id) DO UPDATE SET
      channel_name = excluded.channel_name,
      snapshot_id = excluded.snapshot_id,
      signals_json = excluded.signals_json,
      retrieved_at = excluded.retrieved_at,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run({
    channelId: scan.channelId.trim(),
    channelName: typeof scan.channelName === "string" ? scan.channelName.slice(0, 500) : "",
    snapshotId: scan.snapshotId ?? null,
    signalsJson: JSON.stringify(signals),
    retrievedAt,
    expiresAt,
    createdAt: scan.createdAt || now,
    updatedAt: now
  });

  return getPublicSponsorshipSignalScans({ channelId: scan.channelId.trim() })[0] || null;
}

function getPublicSponsorshipSignalScans(filters = {}) {
  deleteExpiredPublicSponsorshipSignalScans();
  const clauses = [];
  const values = [];
  if (filters.channelId !== undefined && filters.channelId !== null) {
    clauses.push("channel_id = ?");
    values.push(filters.channelId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT *
    FROM public_sponsorship_signal_scans
    ${where}
    ORDER BY retrieved_at DESC, id DESC
  `).all(...values).map(toPublicSponsorshipSignalScan);
}

function getPublicSponsorshipSignalScanById(id) {
  deleteExpiredPublicSponsorshipSignalScans();
  return toPublicSponsorshipSignalScan(
    db.prepare("SELECT * FROM public_sponsorship_signal_scans WHERE id = ?").get(id)
  );
}

function deletePublicSponsorshipSignalScan(id) {
  return db.prepare("DELETE FROM public_sponsorship_signal_scans WHERE id = ?").run(id).changes > 0;
}

function toShopifyWebhookEvent(row) {
  if (!row) {
    return null;
  }
  const parseJson = (value) => {
    if (!value) return null;
    try { return JSON.parse(value); } catch (error) { return null; }
  };
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    amount: row.amount,
    currency: row.currency,
    occurredAt: row.occurred_at,
    trackingLinkId: row.tracking_link_id ?? null,
    trackingToken: row.tracking_token || null,
    utm: parseJson(row.utm_json),
    payload: parseJson(row.payload_json),
    createdAt: row.created_at
  };
}

function getShopifyWebhookEventById(eventId) {
  return toShopifyWebhookEvent(
    db.prepare("SELECT * FROM shopify_webhook_events WHERE event_id = ?").get(eventId)
  );
}

function ingestShopifyEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("A Shopify event is required.");
  }
  if (typeof event.eventId !== "string" || event.eventId.trim().length === 0) {
    throw new Error("eventId is required.");
  }
  if (!["purchase", "refund"].includes(event.eventType)) {
    throw new Error("eventType must be purchase or refund.");
  }
  if (!Number.isFinite(Number(event.amount)) || Number(event.amount) <= 0) {
    throw new Error("Shopify events require a positive amount.");
  }
  if (typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new Error("occurredAt must be a valid ISO date.");
  }

  const transaction = db.transaction(() => {
    const existing = db.prepare(
      "SELECT * FROM shopify_webhook_events WHERE event_id = ?"
    ).get(event.eventId.trim());
    if (existing) {
      if (
        existing.event_type !== event.eventType ||
        Number(existing.amount) !== Number(event.amount)
      ) {
        const conflict = new Error("A Shopify event ID was already used for a different event.");
        conflict.statusCode = 409;
        throw conflict;
      }
      const attribution = existing.tracking_link_id
        ? db.prepare(`
            SELECT * FROM attribution_events
            WHERE tracking_link_id = ? AND event_key = ?
          `).get(existing.tracking_link_id, existing.event_id)
        : null;
      return {
        event: toShopifyWebhookEvent(existing),
        attributionEvent: toAttributionEvent(attribution),
        created: false
      };
    }

    const now = event.createdAt || new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO shopify_webhook_events (
        event_id, event_type, amount, currency, occurred_at, tracking_link_id,
        tracking_token, utm_json, payload_json, created_at
      ) VALUES (@eventId, @eventType, @amount, @currency, @occurredAt, @trackingLinkId,
        @trackingToken, @utmJson, @payloadJson, @createdAt)
    `).run({
      eventId: event.eventId.trim(),
      eventType: event.eventType,
      amount: Number(event.amount),
      currency: event.currency || null,
      occurredAt: event.occurredAt,
      trackingLinkId: event.trackingLinkId ?? null,
      trackingToken: event.trackingToken || null,
      utmJson: event.utm ? JSON.stringify(event.utm) : null,
      payloadJson: JSON.stringify(event.payload || {}),
      createdAt: now
    });

    let attributionEvent = null;
    if (event.trackingLinkId) {
      const resultAttribution = recordAttributionEvent({
        trackingLinkId: event.trackingLinkId,
        eventKey: event.eventId.trim(),
        eventType: event.eventType,
        amount: Number(event.amount),
        currency: event.currency || null,
        occurredAt: event.occurredAt,
        metadata: {
          source: "shopify_webhook",
          shopifyEventId: event.eventId.trim(),
          ...(event.utm ? { utm: event.utm } : {})
        },
        createdAt: now
      });
      attributionEvent = resultAttribution.event;
    }

    return {
      event: toShopifyWebhookEvent(
        db.prepare("SELECT * FROM shopify_webhook_events WHERE id = ?").get(Number(result.lastInsertRowid))
      ),
      attributionEvent,
      created: true
    };
  });

  return transaction();
}

function closeDatabase() {
  if (db.open) {
    db.close();
  }
}

module.exports = {
  createCampaign,
  getCampaigns,
  getCampaignById,
  saveSnapshot,
  getSnapshots,
  getSnapshotsByIds,
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
  getAudienceProfile,
  updateAudienceProfile,
  deleteAudienceProfile,
  createQualityReview,
  getQualityReviews,
  getQualityReviewById,
  getQualityReview,
  updateQualityReview,
  deleteQualityReview,
  createSponsorshipRecord,
  getSponsorshipRecords,
  getSponsorshipRecordById,
  getSponsorshipRecord,
  updateSponsorshipRecord,
  deleteSponsorshipRecord,
  savePublicSponsorshipSignalScan,
  getPublicSponsorshipSignalScans,
  getPublicSponsorshipSignalScanById,
  deletePublicSponsorshipSignalScan,
  deleteExpiredPublicSponsorshipSignalScans,
  getShopifyWebhookEventById,
  ingestShopifyEvent,
  closeDatabase
};
