const API_BASE = 'http://127.0.0.1:3000';
const DEFAULT_PURCHASE_RATE = 0.01;
const USD_TO_INR_PLANNING_RATE = 84;

const state = {
  creators: new Map(),
  selected: new Set(),
  history: [],
  activeCampaign: null,
  performance: null,
  performanceStatus: 'missing',
  performanceError: '',
  performanceUsesLocalFallback: false,
  trackingLinks: new Map(),
  localDemoEvents: [],
  intelligenceRequests: new Set(),
  shopify: {
    status: 'not-connected',
    source: 'No Shopify connection data returned'
  },
  performanceRequest: 0,
  discovery: {
    status: 'idle',
    candidates: [],
    error: '',
    quotaMessage: '',
    request: 0
  }
};

const form = document.querySelector('#brief-form');
const formStatus = document.querySelector('#form-status');
const creatorGrid = document.querySelector('#creator-grid');
const creatorState = document.querySelector('#creator-state');
const historyList = document.querySelector('#history-list');
const comparisonBody = document.querySelector('#comparison-body');
const performanceContent = document.querySelector('#performance-content');
const performanceMetrics = document.querySelector('#performance-metrics');
const planActualCard = document.querySelector('#plan-actual-card');
const trackingLinkList = document.querySelector('#tracking-link-list');
const demoEventForm = document.querySelector('#demo-event-form');
const demoEventStatus = document.querySelector('#demo-event-status');
const discoveryPanel = document.querySelector('#discovery-panel');
const discoveryResults = document.querySelector('#discovery-results');
const discoveryQuery = document.querySelector('#discovery-query');
const discoveryLanguage = document.querySelector('#discovery-language');
const discoveryRegion = document.querySelector('#discovery-region');
const campaignSubmit = document.querySelector('#campaign-submit');
const shopifyIntegrationPanel = document.querySelector('#shopify-integration-panel');
const shopifyStatusBadge = document.querySelector('#shopify-status-badge');
const campaignSubmitLabel = document.querySelector('#campaign-submit-label');

document.querySelectorAll('[data-scroll]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' });
  });
});

form.addEventListener('submit', saveCampaignAndAnalyse);
form.querySelectorAll('input[name="creatorSource"]').forEach((input) => {
  input.addEventListener('change', syncCreatorMode);
});
creatorGrid.addEventListener('click', handleCreatorAction);
discoveryResults.addEventListener('click', handleDiscoveryAction);
historyList.addEventListener('click', handleHistoryAction);
performanceContent.addEventListener('click', handlePerformanceAction);
demoEventForm.addEventListener('submit', recordDemoEvent);
shopifyIntegrationPanel.addEventListener('click', handleShopifyAction);
document.querySelector('#refresh-history').addEventListener('click', loadHistory);
document.querySelector('#retry-history').addEventListener('click', loadHistory);
document.querySelector('#refresh-performance').addEventListener('click', loadCampaignPerformance);

syncCreatorMode();
renderPerformance();
renderShopifyIntegration();
loadHistory();
loadActiveCampaign();

async function saveCampaignAndAnalyse(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const creatorSource = String(data.get('creatorSource') || 'existing');
  const channelUrl = String(data.get('channelUrl') || '').trim();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const payload = buildCampaignPayload(data);

  setFormStatus('loading', creatorSource === 'discover' ? 'Saving campaign and preparing creator discovery…' : 'Saving campaign and fetching live YouTube data…');
  button.disabled = true;
  button.classList.add('is-loading');

  try {
    const campaignResult = await fetchJson(`${API_BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const campaignData = campaignResult.campaign || campaignResult.activeCampaign || campaignResult;
    const campaign = normalizeCampaign({
      ...payload,
      ...campaignData,
      id: campaignData.id ?? campaignData.campaignId ?? campaignData.campaign_id ?? campaignResult.campaignId
    });

    if (!campaign.id) {
      throw new Error('The campaign was saved without an ID, so creator analysis could not be attached to it.');
    }

    setActiveCampaign(campaign);
    if (creatorSource === 'discover') {
      setFormStatus('loading', `Campaign saved. Searching for creators for ${campaign.name}…`);
      await discoverCreators(button);
    } else {
      setFormStatus('loading', `Campaign saved. Fetching live YouTube data for ${campaign.name}…`);
      await analyseCreator(channelUrl, button);
    }
  } catch (error) {
    setFormStatus('error', error.message || 'Campaign or creator analysis failed.');
    document.querySelector('#shortlist').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
}

function buildCampaignPayload(data) {
  const product = String(data.get('product') || '').trim();
  const goal = String(data.get('goal') || '').trim() || 'Purchases';
  const budgetText = String(data.get('budget') || '').trim();
  const targetCACText = String(data.get('targetCAC') || '').trim();
  const name = String(data.get('name') || '').trim() || `${product || 'Creator'} ${goal} campaign`;

  return {
    name,
    product,
    goal,
    budget: parseMoney(budgetText),
    budgetText: budgetText || null,
    targetCAC: parseMoney(targetCACText),
    targetCACText: targetCACText || null,
    productPrice: parseMoney(data.get('productPrice')),
    grossMargin: parseMoney(data.get('grossMargin')),
    currency: budgetText.includes('₹') || targetCACText.includes('₹') ? 'INR' : 'USD',
    location: String(data.get('location') || '').trim(),
    language: String(data.get('language') || '').trim(),
    destinationUrl: String(data.get('destinationUrl') || '').trim(),
    audience: String(data.get('audience') || '').trim()
  };
}

function getCreatorSource() {
  return form.querySelector('input[name="creatorSource"]:checked')?.value || 'existing';
}

function syncCreatorMode() {
  const discoveryMode = getCreatorSource() === 'discover';
  const existingPanel = document.querySelector('#existing-creators-panel');
  const channelInput = form.elements.channelUrl;

  existingPanel.classList.toggle('is-hidden', discoveryMode);
  discoveryPanel.classList.toggle('is-hidden', !discoveryMode);
  channelInput.required = !discoveryMode;
  discoveryQuery.required = discoveryMode;
  campaignSubmitLabel.textContent = discoveryMode ? 'Save campaign & find creators' : 'Save campaign & analyse';
  renderDiscovery();
}

async function discoverCreators() {
  const query = String(discoveryQuery.value || '').trim();
  if (!query) {
    throw new Error('Tell us what kind of creator you are looking for.');
  }
  if (!state.activeCampaign?.id) {
    throw new Error('Save an active campaign before finding creators.');
  }

  const requestId = ++state.discovery.request;
  state.discovery = {
    status: 'loading',
    candidates: [],
    error: '',
    quotaMessage: '',
    request: requestId
  };
  renderDiscovery();

  const language = String(discoveryLanguage.value || '').trim();
  const region = String(discoveryRegion.value || '').trim();
  const campaign = state.activeCampaign;

  try {
    const result = await fetchJson(`${API_BASE}/api/creators/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId: campaign.id,
        query,
        language: language || null,
        region: region || null,
        audience: campaign.audience || null,
        goal: campaign.goal || null,
        product: campaign.product || null
      })
    });

    if (requestId !== state.discovery.request) return;

    const candidates = extractDiscoveryCandidates(result);
    state.discovery.candidates = candidates;
    state.discovery.quotaMessage = getDiscoveryQuotaMessage(result);
    state.discovery.status = candidates.length ? 'ready' : 'empty';
    renderDiscovery();

    if (candidates.length) {
      setFormStatus('success', `${candidates.length} creator ${candidates.length === 1 ? 'recommendation is' : 'recommendations are'} ready. Analyse one to add its live YouTube snapshot to this campaign.`);
    } else {
      setFormStatus('success', 'No creator matches were found. Try a broader discovery query.');
    }
  } catch (error) {
    if (requestId !== state.discovery.request) return;
    const quotaError = isQuotaError(error);
    state.discovery.status = 'error';
    state.discovery.error = quotaError
      ? 'Creator discovery is temporarily unavailable because the recommendation quota has been reached. Try again later or analyse a channel you already have.'
      : (error.message || 'Creator discovery failed.');
    state.discovery.quotaMessage = quotaError ? 'Discovery quota reached. Existing channel analysis is still available.' : '';
    renderDiscovery();
    setFormStatus('error', state.discovery.error);
    discoveryPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderDiscovery() {
  const loading = document.querySelector('#discovery-loading');
  const empty = document.querySelector('#discovery-empty');
  const error = document.querySelector('#discovery-error');
  const quota = document.querySelector('#discovery-quota');

  loading.classList.toggle('is-hidden', state.discovery.status !== 'loading');
  empty.classList.toggle('is-hidden', state.discovery.status !== 'empty');
  error.classList.toggle('is-hidden', state.discovery.status !== 'error');
  discoveryResults.classList.toggle('is-hidden', state.discovery.candidates.length === 0 || state.discovery.status === 'loading' || state.discovery.status === 'error');
  quota.classList.toggle('is-hidden', !state.discovery.quotaMessage);
  error.textContent = state.discovery.error;
  quota.textContent = state.discovery.quotaMessage;

  discoveryResults.innerHTML = state.discovery.candidates.map(renderDiscoveryCandidate).join('');
  const note = document.querySelector('#discovery-campaign-note');
  if (state.activeCampaign) {
    note.textContent = `Recommendations will use the ${state.activeCampaign.name} campaign brief${state.activeCampaign.audience ? ` and target ${state.activeCampaign.audience}` : ''}.`;
  } else {
    note.textContent = 'Save the campaign brief to search for recommended creators.';
  }
}

function extractDiscoveryCandidates(result = {}) {
  const payload = Array.isArray(result) ? { candidates: result } : (result && typeof result === 'object' ? result : {});
  const rawCandidates = payload.candidates
    || payload.creators
    || payload.recommendations
    || payload.recommendedCreators
    || payload.creatorCandidates
    || payload.results
    || payload.data?.candidates
    || payload.data?.creators
    || payload.data?.recommendations
    || [];
  const candidates = Array.isArray(rawCandidates) ? rawCandidates : Object.values(rawCandidates || {});
  return candidates.slice(0, 10).map(normalizeDiscoveryCandidate).filter((candidate) => candidate.name || candidate.channelUrl);
}

function normalizeDiscoveryCandidate(candidate = {}) {
  if (typeof candidate === 'string') {
    return {
      name: candidate,
      description: '',
      thumbnail: '',
      channelUrl: normalizeCandidateChannelUrl(candidate)
    };
  }

  const snippet = candidate.snippet || {};
  const name = String(candidate.name || candidate.channelName || candidate.channel_name || candidate.title || snippet.title || candidate.handle || 'Unnamed creator').trim();
  const description = String(candidate.description || candidate.bio || candidate.channelDescription || candidate.channel_description || snippet.description || '').trim();
  const thumbnailValue = candidate.thumbnail
    || candidate.thumbnailUrl
    || candidate.thumbnail_url
    || candidate.image
    || candidate.imageUrl
    || candidate.image_url
    || candidate.profileImage
    || candidate.profile_image
    || candidate.avatar
    || candidate.avatarUrl
    || snippet.thumbnails?.high?.url
    || snippet.thumbnails?.medium?.url
    || snippet.thumbnails?.default?.url
    || '';
  const thumbnail = typeof thumbnailValue === 'object' ? thumbnailValue.url || '' : String(thumbnailValue || '');
  const channelUrl = normalizeCandidateChannelUrl(
    candidate.channelUrl
      || candidate.channel_url
      || candidate.youtubeUrl
      || candidate.youtube_url
      || candidate.url
      || candidate.link,
    candidate.channelId || candidate.channel_id || candidate.id,
    candidate.handle || candidate.channelHandle || candidate.channel_handle
  );

  return { name, description, thumbnail, channelUrl };
}

function normalizeCandidateChannelUrl(value, channelId, handle) {
  const raw = String(value || '').trim();
  if (raw.startsWith('@')) return `https://www.youtube.com/${encodeURIComponent(raw.slice(1))}`;
  if (/^UC[a-zA-Z0-9_-]{20,}$/.test(raw)) return `https://www.youtube.com/channel/${encodeURIComponent(raw)}`;
  if (raw) {
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname.toLowerCase())) return url.href;
    } catch (error) {
      // Invalid candidate links are omitted; the visible card remains safe to render.
    }
  }
  if (handle) {
    const normalizedHandle = String(handle).replace(/^@/, '').trim();
    if (normalizedHandle) return `https://www.youtube.com/@${encodeURIComponent(normalizedHandle)}`;
  }
  if (channelId && /^UC[a-zA-Z0-9_-]{20,}$/.test(String(channelId))) {
    return `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`;
  }
  return '';
}

function renderDiscoveryCandidate(candidate, index) {
  const thumbnail = candidate.thumbnail ? safeImageUrl(candidate.thumbnail) : '';
  const channelUrl = candidate.channelUrl ? safeUrl(candidate.channelUrl, '') : '';
  const initials = candidate.name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const media = thumbnail
    ? `<img class="discovery-thumbnail" src="${escapeHtml(thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<span class="discovery-avatar ${avatarTone(candidate.name)}">${escapeHtml(initials || '?')}</span>`;
  const description = candidate.description || 'Public channel details will be checked during analysis.';

  return `<article class="discovery-candidate">
    <div class="discovery-candidate-media">${media}</div>
    <div class="discovery-candidate-main">
      <div class="discovery-candidate-heading"><div><h4>${escapeHtml(candidate.name)}</h4><p>${escapeHtml(description)}</p></div><span class="source-badge">Suggested</span></div>
      <div class="discovery-candidate-actions">${channelUrl ? `<a class="text-button" href="${escapeHtml(channelUrl)}" target="_blank" rel="noreferrer">View channel</a>` : '<span class="discovery-no-link">Channel link unavailable</span>'}<button class="primary-button discovery-analyse-button" type="button" data-analyse-discovery="${index}">Analyse creator <span aria-hidden="true">→</span></button></div>
    </div>
  </article>`;
}

function safeImageUrl(value) {
  if (!value) return '';
  const url = safeUrl(value, '');
  return url && url !== '#' ? url : '';
}

function getDiscoveryQuotaMessage(result = {}) {
  const payload = result && typeof result === 'object' ? result : {};
  if (payload.quotaExceeded || payload.quota_exceeded || payload.quota?.exceeded) {
    return 'Discovery quota reached. Existing channel analysis is still available.';
  }
  const quota = payload.quota || payload.usage?.quota || payload.metadata?.quota || payload.meta?.quota;
  if (typeof quota === 'string' && quota.trim()) return `Discovery quota: ${quota.trim()}`;
  if (quota && typeof quota === 'object') {
    const remaining = quota.remaining ?? quota.remainingRequests ?? quota.remaining_requests;
    const limit = quota.limit ?? quota.total ?? quota.max;
    if (remaining !== undefined && limit !== undefined) return `${remaining} of ${limit} discovery requests remaining.`;
    if (remaining !== undefined) return `${remaining} discovery requests remaining.`;
    if (quota.used !== undefined && limit !== undefined) return `${quota.used} of ${limit} discovery requests used.`;
  }
  const remaining = payload.quotaRemaining ?? payload.quota_remaining ?? payload.remaining;
  if (remaining !== undefined && remaining !== null) return `${remaining} discovery requests remaining.`;
  return '';
}

function isQuotaError(error) {
  return error?.status === 429 || /quota|rate limit|too many requests/i.test(String(error?.message || ''));
}

function handleDiscoveryAction(event) {
  const action = event.target.closest('[data-analyse-discovery]');
  if (!action) return;
  const candidate = state.discovery.candidates[Number(action.dataset.analyseDiscovery)];
  if (!candidate) return;
  if (!candidate.channelUrl) {
    setFormStatus('error', 'This recommendation does not include a usable YouTube channel link.');
    return;
  }
  if (!state.activeCampaign?.id) {
    setFormStatus('error', 'Save an active campaign before analysing a discovered creator.');
    return;
  }

  action.disabled = true;
  action.classList.add('is-loading');
  setFormStatus('loading', `Fetching live YouTube data for ${candidate.name}…`);
  analyseCreator(candidate.channelUrl, action).finally(() => {
    action.disabled = false;
    action.classList.remove('is-loading');
  });
}

async function analyseCreator(channelUrl, button) {
  setFormStatus('loading', 'Fetching live YouTube data…');

  try {
    const result = await fetchJson(`${API_BASE}/api/creators/analyse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelUrl,
        campaignId: state.activeCampaign.id
      })
    });

    if (!result.summary) {
      throw new Error('The API returned no creator summary.');
    }

    const savedSummary = {
      ...result.summary,
      campaignId: result.campaignId || state.activeCampaign.id,
      estimates: { ...(result.summary.estimates || {}), ...(result.estimates || {}) },
      publicSponsorshipSignals: result.publicSponsorshipSignals
        || result.public_sponsorship_signals
        || result.sponsorshipSignals
        || result.sponsorship_signals
        || result.summary.publicSponsorshipSignals
        || result.summary.public_sponsorship_signals
        || result.summary.sponsorshipSignals
        || result.summary.sponsorship_signals,
      campaignEstimates: result.campaignEstimates || result.campaign_estimates || result.campaignEconomics || result.campaign_economics || result.planningEconomics || result.summary.campaignEstimates
    };
    const creator = upsertCreator(savedSummary, 'live', result.videos || [], state.activeCampaign.id);
    state.history = [savedSummary, ...state.history.filter((snapshot) => {
      const summary = normalizeSummary(snapshot);
      return (summary.channelId || summary.channelName) !== creator.key;
    })];
    if (state.selected.size < 4) {
      state.selected.add(creator.key);
    }
    renderHistory();
    renderCreators();
    renderComparison();
    setHistoryState('ready');
    document.querySelector('#history-count').textContent = String(state.history.length);
    document.querySelector('#data-source').textContent = 'Live YouTube API data';
    const cacheNote = result.cacheHit
      ? ' Reused the fresh 24-hour cache; no new YouTube request was needed.'
      : ' Fresh YouTube data was fetched and cached for 24 hours.';
    setFormStatus('success', `${creator.summary.channelName} analysed for ${state.activeCampaign.name} and saved to local history.${cacheNote}`);
    document.querySelector('#shortlist').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setFormStatus('error', error.message || 'Creator analysis failed.');
    document.querySelector('#shortlist').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
}

async function loadActiveCampaign() {
  try {
    const result = await fetchJson(`${API_BASE}/api/campaigns/active`);
    const campaign = normalizeCampaign(result.campaign || result.activeCampaign || result);
    if (campaign.id) {
      setActiveCampaign(campaign, false);
    } else {
      state.activeCampaign = null;
      state.shopify = normalizeShopifyState(null);
      state.performanceStatus = 'missing';
      renderShopifyIntegration();
      renderPerformance();
    }
  } catch (error) {
    // An empty campaign list is a valid first-run state. History keeps its own error UI.
    state.activeCampaign = null;
    state.shopify = normalizeShopifyState(null);
    state.performanceStatus = 'missing';
    renderShopifyIntegration();
    renderPerformance();
  }
}

async function loadHistory() {
  setHistoryState('loading');

  try {
    const result = await fetchJson(`${API_BASE}/api/creators/snapshots`);
    state.history = Array.isArray(result.snapshots) ? result.snapshots : [];
    state.creators.clear();
    state.history.forEach((snapshot) => upsertCreator(snapshot, 'history'));
    state.selected = new Set([...state.selected].filter((key) => state.creators.has(key)));
    renderHistory();
    renderCreators();
    renderComparison();
    document.querySelector('#data-source').textContent = state.history.length
      ? 'Saved YouTube snapshots'
      : 'Waiting for data';
    setHistoryState(state.history.length ? 'ready' : 'empty');
  } catch (error) {
    setHistoryState('error', error.message);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  let result;

  try {
    result = await response.json();
  } catch (error) {
    const parseError = new Error('The API returned an unreadable response.');
    parseError.status = response.status;
    throw parseError;
  }

  if (!response.ok) {
    const error = new Error(result.error || 'The API request failed.');
    error.status = response.status;
    throw error;
  }

  return result;
}

async function fetchJsonWithFallback(urls, options = {}) {
  let lastError;

  for (const url of urls) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (error.status !== 404 && error.status !== 405) throw error;
    }
  }

  throw lastError || new Error('The attribution API request failed.');
}

function setActiveCampaign(campaign, resetSelection = true) {
  const changed = state.activeCampaign?.id !== campaign.id;
  state.activeCampaign = campaign;
  state.shopify = normalizeShopifyState(campaign);
  if (changed) {
    if (resetSelection) state.selected.clear();
    state.performance = null;
    state.performanceStatus = 'loading';
    state.performanceError = '';
    state.performanceUsesLocalFallback = false;
    state.trackingLinks = new Map();
    state.discovery = {
      status: 'idle',
      candidates: [],
      error: '',
      quotaMessage: '',
      request: state.discovery.request + 1
    };
    const savedAttribution = loadLocalAttribution(campaign.id);
    state.localDemoEvents = savedAttribution.events;
    savedAttribution.links.forEach((link) => {
      const creatorKey = link.creatorKey || link.creatorId || link.creatorName;
      if (creatorKey) state.trackingLinks.set(String(creatorKey), link);
    });
  }
  renderCampaignContext();
  renderHistory();
  renderCreators();
  renderComparison();
  renderDiscovery();
  renderShopifyIntegration();
  renderPerformance();
  if (changed) loadCampaignPerformance();
}

function normalizeCampaign(campaign = {}) {
  const budgetValue = campaign.budgetAmount ?? campaign.budget_amount ?? campaign.budget;
  const targetCACValue = campaign.targetCAC ?? campaign.target_cac ?? campaign.targetCPA ?? campaign.target_cpa;
  return {
    id: campaign.id ?? campaign.campaignId ?? campaign.campaign_id ?? null,
    name: campaign.name || campaign.campaignName || campaign.campaign_name || 'Untitled campaign',
    product: campaign.product || campaign.category || '',
    goal: campaign.goal || 'Purchases',
    budgetAmount: numberOrNull(budgetValue) ?? parseMoney(budgetValue) ?? parseMoney(campaign.budgetText || campaign.budget_text),
    budgetText: campaign.budgetText || campaign.budget_text || '',
    targetCAC: numberOrNull(targetCACValue) ?? parseMoney(targetCACValue),
    location: campaign.location || campaign.targetLocation || campaign.target_location || '',
    audience: campaign.audience || campaign.targetAudience || campaign.target_audience || '',
    language: campaign.language || campaign.targetLanguage || campaign.target_language || '',
    destinationUrl: campaign.destinationUrl || campaign.destination_url || campaign.landingUrl || campaign.landing_url || '',
    status: campaign.status || 'active',
    createdAt: campaign.createdAt || campaign.created_at || null,
    currency: campaign.currency || (String(campaign.budgetText || campaign.budget || '').includes('₹') ? 'INR' : 'USD'),
    expectedPurchaseRate: numberOrNull(campaign.expectedPurchaseRate ?? campaign.expected_purchase_rate ?? campaign.conversionRate ?? campaign.conversion_rate)
  };
}

async function loadCampaignPerformance() {
  const campaign = state.activeCampaign;
  if (!campaign?.id) {
    state.performanceStatus = 'missing';
    state.performance = null;
    renderPerformance();
    return;
  }

  const requestId = ++state.performanceRequest;
  state.performanceStatus = 'loading';
  state.performanceError = '';
  renderPerformance();

  try {
    const result = await fetchJsonWithFallback([
      `${API_BASE}/api/campaigns/${encodeURIComponent(campaign.id)}/summary`,
      `${API_BASE}/api/campaigns/${encodeURIComponent(campaign.id)}/performance`,
      `${API_BASE}/api/campaigns/${encodeURIComponent(campaign.id)}/attribution`
    ]);

    if (requestId !== state.performanceRequest || state.activeCampaign?.id !== campaign.id) return;
    hydrateTrackingLinks(result);
    state.performance = normalizePerformance(result);
    state.performanceStatus = 'ready';
    state.performanceUsesLocalFallback = false;
    renderCreators();
    renderPerformance();
  } catch (error) {
    if (requestId !== state.performanceRequest || state.activeCampaign?.id !== campaign.id) return;
    state.performance = normalizePerformance({});
    state.performanceStatus = 'error';
    state.performanceError = error.message || 'Campaign performance could not be loaded.';
    state.performanceUsesLocalFallback = true;
    state.performance = mergeLocalPerformance(state.performance);
    renderPerformance();
  }
}

function normalizePerformance(result = {}) {
  const raw = result.performance || result.attribution || result.campaignSummary || result.summary || result;
  const plannedVsActual = raw.plannedVsActual || raw.planned_vs_actual || {};
  const actual = raw.actual || raw.tracked || raw.metrics || raw.outcomes || plannedVsActual.actual || raw;
  const planned = raw.planned || raw.plan || raw.forecast || raw.targets || plannedVsActual.planned || {};
  const performanceStatus = plannedVsActual.status
    || raw.performanceStatus
    || raw.performance_status
    || raw.status
    || null;

  const tracked = {
    clicks: firstNumber(actual.trackedClicks, actual.tracked_clicks, actual.clicks, actual.clickCount, actual.click_count, actual.totalClicks, raw.trackedClicks, raw.tracked_clicks, raw.clicks),
    leads: firstNumber(actual.trackedLeads, actual.tracked_leads, actual.leads, actual.leadCount, actual.lead_count, actual.totalLeads, raw.trackedLeads, raw.tracked_leads, raw.leads),
    purchases: firstNumber(actual.trackedPurchases, actual.tracked_purchases, actual.purchases, actual.purchaseCount, actual.purchase_count, actual.totalPurchases, raw.trackedPurchases, raw.tracked_purchases, raw.purchases),
    revenue: firstNumber(actual.revenue, actual.revenueAmount, actual.revenue_amount, actual.trackedRevenue, actual.tracked_revenue, actual.totalRevenue, raw.revenue, raw.revenue_amount, raw.trackedRevenue, raw.tracked_revenue),
    refunds: firstNumber(actual.refunds, actual.refundAmount, actual.refund_amount, actual.trackedRefunds, actual.tracked_refunds, actual.totalRefunds, raw.refunds, raw.refund_amount, raw.trackedRefunds, raw.tracked_refunds),
    spend: firstNumber(actual.spend, actual.cost, actual.campaignSpend, actual.campaign_spend, actual.creatorSpend, actual.creatorFees, raw.spend, raw.cost, raw.campaignSpend, raw.campaign_spend, raw.creatorFees)
  };
  const plannedValues = {
    clicks: firstNumber(planned.plannedClicks, planned.planned_clicks, planned.clicks, planned.expectedClicks, planned.expected_clicks, raw.plannedClicks, raw.planned_clicks, raw.expectedClicks, raw.expected_clicks),
    leads: firstNumber(planned.plannedLeads, planned.planned_leads, planned.leads, planned.expectedLeads, planned.expected_leads, raw.plannedLeads, raw.planned_leads, raw.expectedLeads, raw.expected_leads),
    purchases: firstNumber(planned.plannedPurchases, planned.planned_purchases, planned.purchases, planned.expectedPurchases, planned.expected_purchases, raw.plannedPurchases, raw.planned_purchases, raw.expectedPurchases, raw.expected_purchases),
    revenue: firstNumber(planned.plannedRevenue, planned.planned_revenue, planned.revenue, planned.expectedRevenue, planned.expected_revenue, raw.plannedRevenue, raw.planned_revenue, raw.expectedRevenue, raw.expected_revenue),
    targetCAC: firstNumber(planned.targetCAC, planned.targetCac, planned.target_cac, raw.targetCAC, raw.targetCac, raw.target_cac)
  };
  const actualCAC = firstNumber(
    actual.actualCAC,
    actual.actualCac,
    actual.actual_cac,
    actual.cac,
    raw.actualCAC,
    raw.actualCac,
    raw.actual_cac,
    raw.cac
  ) ?? (tracked.spend !== null && tracked.purchases > 0 ? tracked.spend / tracked.purchases : null);

  return {
    campaignId: raw.campaignId ?? raw.campaign_id ?? result.campaignId ?? null,
    tracked,
    planned: plannedValues,
    actualCAC,
    status: performanceStatus,
    updatedAt: raw.updatedAt || raw.updated_at || raw.retrievedAt || raw.retrieved_at || null
  };
}

function firstNumber(...values) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

function mergeLocalPerformance(performance) {
  const local = aggregateLocalEvents();
  if (!local.count) return performance;
  const tracked = performance?.tracked || {};
  return {
    ...(performance || normalizePerformance({})),
    tracked: {
      ...tracked,
      clicks: (tracked.clicks || 0) + local.clicks,
      leads: (tracked.leads || 0) + local.leads,
      purchases: (tracked.purchases || 0) + local.purchases,
      revenue: (tracked.revenue || 0) + local.revenue,
      refunds: (tracked.refunds || 0) + local.refunds
    },
    actualCAC: performance?.actualCAC ?? null
  };
}

function aggregateLocalEvents() {
  return state.localDemoEvents.reduce((totals, event) => {
    const amount = numberOrZero(event.amount);
    totals.count += 1;
    if (event.type === 'click') totals.clicks += 1;
    if (event.type === 'lead') totals.leads += 1;
    if (event.type === 'purchase') {
      totals.purchases += 1;
      totals.revenue += amount;
    }
    if (event.type === 'refund') totals.refunds += amount;
    return totals;
  }, { count: 0, clicks: 0, leads: 0, purchases: 0, revenue: 0, refunds: 0 });
}

function hydrateTrackingLinks(result = {}) {
  const rawLinks = result.trackingLinks || result.tracking_links || result.links || result.data?.links || [];
  const links = Array.isArray(rawLinks) ? rawLinks : Object.values(rawLinks || {});
  links.map(normalizeTrackingLink).filter(Boolean).forEach((link) => {
    const creatorKey = findCreatorKeyForLink(link) || link.creatorId || link.creatorName || link.id;
    if (creatorKey) state.trackingLinks.set(String(creatorKey), { ...link, creatorKey: String(creatorKey) });
  });
}

function normalizeTrackingLink(link = {}) {
  if (typeof link === 'string') {
    return {
      id: null,
      url: link.includes('://') ? link : '',
      code: link.includes('://') ? '' : link,
      creatorId: null,
      creatorName: '',
      creatorKey: null,
      local: false
    };
  }
  const rawUrl = link.url || link.link || link.trackingUrl || link.tracking_url || link.shortUrl || link.short_url || '';
  const url = rawUrl && rawUrl.startsWith('/') ? `${API_BASE}${rawUrl}` : rawUrl;
  const code = link.code || link.couponCode || link.coupon_code || link.trackingCode || link.tracking_code || '';
  if (!url && !code) return null;
  return {
    id: link.id ?? link.linkId ?? link.link_id ?? null,
    url: String(url),
    code: String(code),
    creatorId: link.creatorId ?? link.creator_id ?? link.channelId ?? link.channel_id ?? null,
    creatorName: link.creatorName || link.creator_name || link.channelName || link.channel_name || '',
    creatorKey: link.creatorKey || null,
    local: Boolean(link.local)
  };
}

function findCreatorKeyForLink(link) {
  if (link.creatorKey && state.creators.has(link.creatorKey)) return String(link.creatorKey);
  if (link.creatorId) {
    const creator = [...state.creators.values()].find(({ summary }) => String(summary.channelId) === String(link.creatorId));
    if (creator) return creator.key;
  }
  if (link.creatorName) {
    const creator = [...state.creators.values()].find(({ summary }) => summary.channelName === link.creatorName);
    if (creator) return creator.key;
  }
  return link.creatorKey || (link.creatorId ? String(link.creatorId) : null);
}

function upsertCreator(rawSummary, source, videos = [], campaignId = null) {
  const summary = normalizeSummary(rawSummary);
  const key = summary.channelId || summary.channelName;
  const existing = state.creators.get(key);
  const creator = {
    key,
    summary,
    videos: videos.length ? videos : existing?.videos || [],
    source,
    campaignId: campaignId || summary.campaignId || existing?.campaignId || null,
    intelligenceLoaded: existing?.intelligenceLoaded || false
  };
  state.creators.set(key, creator);
  loadCreatorIntelligence(creator);
  return creator;
}

async function loadCreatorIntelligence(creator) {
  if (!creator?.summary?.channelId || creator.intelligenceLoaded) return;
  creator.intelligenceLoaded = true;

  const channelId = encodeURIComponent(creator.summary.channelId);
  const snapshotQuery = creator.summary.id
    ? `?snapshotId=${encodeURIComponent(creator.summary.id)}`
    : '';
  const endpoints = [
    `${API_BASE}/api/creators/${channelId}/audience-profile${snapshotQuery}`,
    `${API_BASE}/api/creators/${channelId}/quality-review${snapshotQuery}`,
    `${API_BASE}/api/creators/${channelId}/sponsorships${snapshotQuery}`
  ];

  const results = await Promise.allSettled(endpoints.map((url) => fetchJson(url)));
  const audienceBody = results[0].status === 'fulfilled' ? results[0].value : null;
  const qualityBody = results[1].status === 'fulfilled' ? results[1].value : null;
  const sponsorshipBody = results[2].status === 'fulfilled' ? results[2].value : null;
  const audienceRecord = audienceBody?.audienceProfile
    || audienceBody?.profiles?.[0]
    || audienceBody?.audienceProfiles?.[0]
    || null;
  const qualityRecord = qualityBody?.qualityReview
    || qualityBody?.reviews?.[0]
    || qualityBody?.qualityReviews?.[0]
    || null;
  const sponsorshipRecords = extractPublicSponsorshipSignals(sponsorshipBody);

  if (audienceRecord || qualityRecord || sponsorshipRecords.length) {
    creator.summary.audienceDemographics = audienceRecord
      ? normalizeAudienceDemographics({
          ...(audienceRecord.data || {}),
          source: audienceRecord.sourceType || audienceRecord.source_type || ''
        })
      : null;
    creator.summary.audienceQuality = qualityRecord
      ? normalizeAudienceQuality({
          ...(qualityRecord.data || {}),
          source: qualityRecord.sourceType || qualityRecord.source_type || '',
          confidence: qualityRecord.confidence
        })
      : null;
    creator.summary.publicSponsorshipSignals = normalizePublicSponsorshipSignals(
      sponsorshipRecords.map((record) => ({
        ...(record?.data || record?.publicSponsorshipSignal || record?.public_sponsorship_signal || record?.sponsorshipSignal || record?.sponsorship_signal || record?.sponsorship || (record && typeof record === 'object' ? record : {})),
        source: record?.sourceType || record?.source_type || record?.source || '',
        confidence: record?.confidence ?? record?.confidenceScore ?? record?.confidence_score,
        evidenceLinks: record?.evidenceLinks || record?.evidence_links || record?.evidence || record?.links
      }))
    );
    creator.summary.sponsorshipHistory = creator.summary.publicSponsorshipSignals;
    renderCreators();
  }
}

function extractPublicSponsorshipSignals(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const raw = payload.publicSponsorshipSignals
    || payload.public_sponsorship_signals
    || payload.sponsorshipSignals
    || payload.sponsorship_signals
    || payload.publicSponsorshipSignal
    || payload.public_sponsorship_signal
    || payload.sponsorshipRecords
    || payload.sponsorships
    || payload.records
    || payload.data?.publicSponsorshipSignals
    || payload.data?.public_sponsorship_signals
    || payload.data?.sponsorshipSignals
    || payload.data?.sponsorship_signals
    || payload.data?.records
    || [];
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.records)) return raw.records;
    if (Array.isArray(raw.items)) return raw.items;
    if (Array.isArray(raw.signals)) return raw.signals;
    if (Array.isArray(raw.data)) return raw.data;
    return [raw];
  }
  return [];
}

function normalizeSummary(summary) {
  const youtubeMetrics = summary.youtubeMetrics || {};
  const intelligence = summary.intelligence || summary.creatorIntelligence || {};
  const estimates = summary.estimates || {};
  const feeRange = estimates.estimatedFeeRange || estimates.feeRange || {};
  const campaignEstimate = summary.campaignEstimates || summary.campaign_estimates || summary.campaignEconomics || summary.campaign_economics || estimates.campaign || estimates.planning || {};
  const publicSponsorshipSignals = normalizePublicSponsorshipSignals(
    summary.publicSponsorshipSignals
      ?? summary.public_sponsorship_signals
      ?? summary.sponsorshipSignals
      ?? summary.sponsorship_signals
      ?? summary.publicSponsorshipSignal
      ?? summary.public_sponsorship_signal
      ?? summary.sponsorshipHistory
      ?? summary.sponsorship_history
      ?? summary.sponsorships
      ?? summary.brandDeals
      ?? summary.brand_deals
      ?? intelligence.publicSponsorshipSignals
      ?? intelligence.public_sponsorship_signals
      ?? intelligence.sponsorshipSignals
      ?? intelligence.sponsorship_signals
      ?? intelligence.sponsorshipHistory
      ?? intelligence.sponsorship_history
      ?? intelligence.sponsorships
  );
  const expectedCACRange = campaignEstimate.expectedCACRange
    ?? campaignEstimate.expected_cac_range
    ?? campaignEstimate.estimatedCACRange
    ?? estimates.expectedCACRange
    ?? estimates.expected_cac_range
    ?? estimates.estimatedCACRange
    ?? summary.expectedCACRange
    ?? summary.expected_cac_range
    ?? (summary.estimated_cac_min !== null && summary.estimated_cac_min !== undefined
      ? { min: summary.estimated_cac_min, max: summary.estimated_cac_max, currency: summary.estimated_cac_currency }
      : null);

  return {
    id: numberOrNull(summary.id ?? summary.snapshotId),
    campaignId: summary.campaignId ?? summary.campaign_id ?? null,
    channelId: summary.channelId || summary.channel_id || '',
    channelName: summary.channelName || summary.channel_name || 'Unnamed creator',
    subscribers: numberOrZero(summary.subscribers ?? youtubeMetrics.subscribers),
    videoCount: numberOrZero(summary.videoCount ?? summary.video_count ?? youtubeMetrics.videoCount),
    medianRecentViews: numberOrZero(summary.medianRecentViews ?? summary.median_recent_views ?? youtubeMetrics.medianRecentViews),
    viewsToSubscriberRatio: summary.viewsToSubscriberRatio ?? summary.views_to_subscriber_ratio ?? youtubeMetrics.viewsToSubscriberRatio,
    retrievedAt: summary.retrievedAt || summary.retrieved_at || null,
    estimates: {
      expectedRelevantViews: numberOrNull(estimates.expectedRelevantViews ?? campaignEstimate.expectedRelevantViews ?? campaignEstimate.expected_relevant_views ?? summary.expected_relevant_views),
      performanceConsistency: numberOrNull(estimates.performanceConsistency ?? summary.performance_consistency),
      engagementRate: numberOrNull(estimates.engagementRate ?? summary.engagement_rate),
      feeRange: feeRange.min !== undefined && feeRange.min !== null
        ? { min: numberOrNull(feeRange.min), max: numberOrNull(feeRange.max), currency: feeRange.currency || summary.estimated_fee_currency || 'USD' }
        : summary.estimated_fee_min !== null && summary.estimated_fee_min !== undefined
          ? { min: numberOrNull(summary.estimated_fee_min), max: numberOrNull(summary.estimated_fee_max), currency: summary.estimated_fee_currency || 'USD' }
          : null,
      expectedPurchases: numberOrNull(campaignEstimate.expectedPurchases ?? campaignEstimate.expected_purchases ?? estimates.expectedPurchases ?? estimates.expected_purchases ?? summary.expectedPurchases ?? summary.expected_purchases),
      expectedCACRange: normalizeRange(expectedCACRange),
      expectedPurchaseRate: numberOrNull(campaignEstimate.expectedPurchaseRate ?? campaignEstimate.expected_purchase_rate ?? estimates.expectedPurchaseRate ?? estimates.expected_purchase_rate),
      confidence: estimates.dataConfidence || summary.estimate_data_confidence || null,
      missingData: campaignEstimate.missingData || estimates.missingData || summary.missing_data || []
    },
    audienceDemographics: normalizeAudienceDemographics(
      summary.audienceDemographics
        ?? summary.audience_demographics
        ?? summary.audience?.demographics
        ?? summary.demographics
        ?? intelligence.audienceDemographics
        ?? intelligence.audience_demographics
        ?? intelligence.audience?.demographics
    ),
    audienceQuality: normalizeAudienceQuality(
      summary.audienceQuality
        ?? summary.audience_quality
        ?? summary.audience?.quality
        ?? summary.quality
        ?? intelligence.audienceQuality
        ?? intelligence.audience_quality
        ?? intelligence.audience?.quality
        ?? intelligence.quality
    ),
    publicSponsorshipSignals,
    sponsorshipHistory: publicSponsorshipSignals
  };
}

function normalizeAudienceDemographics(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (Array.isArray(raw)) {
    const items = normalizeDistribution(raw);
    return items.length ? { groups: [{ label: 'Audience', items }], source: '' } : null;
  }
  const source = raw.source || raw.dataSource || raw.data_source || raw.provider || '';
  const groups = [];
  const addGroup = (label, value) => {
    const items = normalizeDistribution(value);
    if (items.length) groups.push({ label, items });
  };

  if (Array.isArray(raw.groups)) {
    raw.groups.forEach((group) => {
      if (!group || typeof group !== 'object') return;
      addGroup(group.label || group.name || 'Audience', group.items || group.values || group.data);
    });
  }

  addGroup('Age', raw.age || raw.ages || raw.ageDistribution || raw.age_distribution);
  addGroup('Gender', raw.gender || raw.genders || raw.genderDistribution || raw.gender_distribution);
  addGroup('Top locations', raw.location || raw.locations || raw.geography || raw.countries || raw.topCountries || raw.top_countries);
  addGroup('Language', raw.language || raw.languages || raw.languageDistribution || raw.language_distribution);

  return groups.length ? { groups, source: String(source || '') } : null;
}

function normalizeDistribution(value) {
  if (value === null || value === undefined || value === '') return [];
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'object'
      ? Object.entries(value).map(([label, item]) => ({ label, value: item }))
      : [{ label: 'Value', value }];

  return entries.map((entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const label = entry.label ?? entry.name ?? entry.key ?? entry.country ?? entry.region ?? entry.gender ?? entry.age ?? entry.range ?? entry.bucket ?? entry.segment ?? '';
      const rawValue = entry.value ?? entry.percentage ?? entry.percent ?? entry.share ?? entry.rate ?? entry.count;
      return { label: String(label || ''), value: formatAudienceValue(rawValue) };
    }
    return { label: '', value: formatAudienceValue(entry) };
  }).filter((entry) => entry.label || entry.value);
}

function formatAudienceValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'object') {
    const amount = value.value ?? value.percentage ?? value.percent ?? value.share ?? value.rate ?? value.count;
    return formatAudienceValue(amount);
  }
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0 && number <= 1) return `${Math.round(number * 100)}%`;
  if (Number.isFinite(number) && number > 1 && number <= 100) return `${number}%`;
  return String(value);
}

function normalizeAudienceQuality(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'object') {
    return { value: String(raw), source: '', confidence: '' };
  }

  const value = raw.score ?? raw.rating ?? raw.value ?? raw.label ?? raw.assessment ?? raw.quality;
  const source = raw.source || raw.dataSource || raw.data_source || raw.provider || '';
  const confidence = raw.confidence || raw.dataConfidence || raw.data_confidence || raw.confidenceLabel || '';
  const supportingMetric = raw.engagementRate ?? raw.engagement_rate ?? raw.relevance ?? raw.relevanceScore;
  if (value === null || value === undefined || value === '') {
    if (supportingMetric === null || supportingMetric === undefined || supportingMetric === '') return null;
    return { value: formatAudienceValue(supportingMetric), source: String(source || ''), confidence: String(confidence || '') };
  }
  return { value: formatQualityValue(value), source: String(source || ''), confidence: String(confidence || '') };
}

function formatQualityValue(value) {
  if (typeof value === 'number' && value >= 0 && value <= 1) return `${Math.round(value * 100)}%`;
  return String(value);
}

function normalizePublicSponsorshipSignals(raw) {
  if (!raw) return [];
  const parentSource = typeof raw === 'object' && !Array.isArray(raw)
    ? raw.source || raw.sourceType || raw.source_type || raw.dataSource || raw.data_source || raw.provider || ''
    : '';
  const parentConfidence = typeof raw === 'object' && !Array.isArray(raw)
    ? raw.confidence ?? raw.confidenceScore ?? raw.confidence_score ?? ''
    : '';
  const records = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? (Array.isArray(raw.records) ? raw.records
        : Array.isArray(raw.items) ? raw.items
          : Array.isArray(raw.signals) ? raw.signals
          : Array.isArray(raw.history) ? raw.history
            : Array.isArray(raw.data) ? raw.data
              : ['brand', 'brandName', 'brand_name', 'advertiser', 'company', 'campaign', 'campaignName', 'campaign_name', 'title', 'description', 'date', 'publishedAt', 'published_at', 'startDate', 'start_date', 'status', 'type', 'confidence', 'source', 'sourceType', 'sourceUrl', 'source_url', 'videoId', 'video_id'].some((key) => raw[key] !== undefined) ? [raw] : [])
      : [];
  return records.map((record) => {
    if (typeof record === 'string') {
      return { brand: record, campaign: '', date: '', status: '', source: parentSource, confidence: parentConfidence, evidenceLinks: [] };
    }
    const item = record || {};
    const signal = item.data
      || item.publicSponsorshipSignal
      || item.public_sponsorship_signal
      || item.sponsorshipSignal
      || item.sponsorship_signal
      || item.sponsorship
      || item;
    const evidenceLinks = normalizeEvidenceLinks(
      signal.evidenceLinks
        || signal.evidence_links
        || signal.evidenceUrl
        || signal.evidence_url
        || signal.evidence
        || signal.links
        || signal.sources
        || signal.sourceUrl
        || signal.source_url
        || signal.videoUrl
        || signal.video_url
        || signal.youtubeUrl
        || signal.youtube_url
        || signal.url
        || signal.link
        || (signal.videoId || signal.video_id || signal.youtubeVideoId ? `https://www.youtube.com/watch?v=${signal.videoId || signal.video_id || signal.youtubeVideoId}` : '')
    );
    const matchedKeywords = normalizeSignalList(signal.matchedKeywords || signal.matched_keywords || signal.keywords);
    const detectedDomains = normalizeSignalList(signal.detectedDomains || signal.detected_domains || signal.domains);
    return {
      brand: String(signal.brand || signal.brandName || signal.brand_name || signal.advertiser || signal.company || signal.name || '').trim(),
      campaign: String(signal.campaign || signal.campaignName || signal.campaign_name || signal.title || signal.description || '').trim(),
      date: String(signal.date || signal.publishedAt || signal.published_at || signal.startDate || signal.start_date || '').trim(),
      status: String(signal.status || signal.type || '').trim(),
      source: String(item.source || item.sourceType || item.source_type || item.dataSource || item.data_source || item.provider || signal.source || signal.sourceType || signal.source_type || signal.dataSource || signal.data_source || signal.provider || parentSource || '').trim(),
      confidence: item.confidence ?? item.confidenceScore ?? item.confidence_score ?? signal.confidence ?? signal.confidenceScore ?? signal.confidence_score ?? parentConfidence ?? '',
      evidenceLinks,
      matchedKeywords,
      detectedDomains
    };
  }).filter((record) => record.brand || record.campaign || record.date || record.status || record.source || record.confidence !== '' || record.evidenceLinks.length);
}

function normalizeSponsorshipHistory(raw) {
  return normalizePublicSponsorshipSignals(raw);
}

function normalizeEvidenceLinks(raw) {
  if (!raw) return [];
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? Object.values(raw)
      : [raw];
  return entries.map((entry) => {
    if (typeof entry === 'string') return { label: 'View YouTube description', url: /^https?:\/\//i.test(entry.trim()) ? entry.trim() : '' };
    const item = entry || {};
    const url = String(item.url || item.href || item.link || item.videoUrl || item.video_url || item.youtubeUrl || item.youtube_url || '').trim();
    return {
      label: String(item.label || item.title || item.videoTitle || item.name || 'View YouTube description'),
      url: /^https?:\/\//i.test(url) ? url : ''
    };
  }).filter((entry) => entry.url);
}

function normalizeSignalList(raw) {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value) => String(value || '').trim()).filter(Boolean);
}

function normalizeShopifyState(campaign) {
  const raw = campaign?.shopify
    || campaign?.shopifyIntegration
    || campaign?.shopify_integration
    || campaign?.integrations?.shopify
    || {};
  const explicitStatus = typeof raw === 'string' ? raw : raw.status || raw.state || campaign?.shopifyStatus || campaign?.shopify_status || '';
  const normalizedStatus = String(explicitStatus || '').toLowerCase().replace(/[_\s]+/g, '-');
  const status = raw.connected === true || campaign?.shopifyConnected === true || campaign?.shopify_connected === true || ['connected', 'active'].includes(normalizedStatus)
    ? 'connected'
    : raw.webhookReady === true || raw.webhook_ready === true || ['webhook-ready', 'ready', 'configured'].includes(normalizedStatus)
      ? 'webhook-ready'
      : 'not-connected';
  const source = typeof raw === 'object'
    ? raw.source || raw.dataSource || raw.data_source || ''
    : '';
  return { status, source: String(source || (campaign ? 'No Shopify connection data returned' : 'No active campaign or Shopify connection')) };
}

function renderShopifyIntegration() {
  const config = {
    'not-connected': {
      label: 'Not connected',
      title: 'No Shopify connection detected',
      copy: 'Store orders, refunds, and revenue are not available to Mangokast yet. Research and planning can continue without inventing commerce outcomes.'
    },
    'webhook-ready': {
      label: 'Webhook ready',
      title: 'Webhook handoff is ready',
      copy: 'The integration is prepared for a Shopify webhook handoff, but no order data is being treated as connected until the store confirms delivery.'
    },
    connected: {
      label: 'Connected',
      title: 'Shopify is connected',
      copy: 'Once a real connection is active, order and refund events can flow into campaign attribution with their source and delivery status preserved.'
    }
  }[state.shopify.status] || {
    label: 'Not connected',
    title: 'No Shopify connection detected',
    copy: 'Store data is not available yet.'
  };

  if (shopifyStatusBadge) shopifyStatusBadge.textContent = config.label;
  if (!shopifyIntegrationPanel) return;

  const stages = [
    ['not-connected', 'Not connected', 'No store data'],
    ['webhook-ready', 'Webhook ready', 'Handoff prepared'],
    ['connected', 'Connected', 'Events can sync']
  ];
  shopifyIntegrationPanel.innerHTML = `
    <div class="shopify-status-summary">
      <div><p class="eyebrow">CURRENT CONNECTION STATE</p><h3>${escapeHtml(config.title)}</h3><p>${escapeHtml(config.copy)}</p></div>
      <span class="shopify-current-state ${escapeHtml(state.shopify.status)}">${escapeHtml(config.label)}</span>
    </div>
    <div class="shopify-state-rail" aria-label="Shopify connection states">
      ${stages.map(([key, label, note]) => `<div class="shopify-state-step ${state.shopify.status === key ? 'is-current' : ''}"><span class="shopify-state-dot" aria-hidden="true"></span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(note)}</small></div></div>`).join('')}
    </div>
    <div class="shopify-automation-note"><div><p class="eyebrow">AFTER A REAL CONNECTION</p><h4>What becomes automatic</h4></div><ul><li>Shopify order and refund events can be matched to creator tracking links.</li><li>Revenue, refunds, and actual CAC can update campaign performance without manual test events.</li><li>Verified outcomes can feed future creator comparisons and performance learning.</li></ul><small>Connection status source: ${escapeHtml(state.shopify.source || 'Not provided')}</small></div>`;
}

function handleShopifyAction(event) {
  const action = event.target.closest('[data-shopify-action]');
  if (!action) return;
  setFormStatus('success', 'Shopify connection actions will appear here when the integration API is available. No connection was changed.');
}

function renderCampaignContext() {
  const empty = document.querySelector('#campaign-context-empty');
  const content = document.querySelector('#campaign-context-content');
  const status = document.querySelector('#campaign-status');
  const campaign = state.activeCampaign;

  empty.classList.toggle('is-hidden', Boolean(campaign));
  content.classList.toggle('is-hidden', !campaign);
  status.textContent = campaign ? `Campaign ${formatStatus(campaign.status)}` : 'No active campaign';

  if (!campaign) {
    content.innerHTML = '';
    return;
  }

  const missing = [];
  if (campaign.budgetAmount === null) missing.push('budget');
  if (!campaign.audience) missing.push('audience');
  if (!campaign.location) missing.push('location / language');
  content.innerHTML = `
    <div class="campaign-context-heading"><div><p class="eyebrow">ACTIVE CAMPAIGN</p><h3>${escapeHtml(campaign.name)}</h3><p>${escapeHtml(campaign.product || 'Product/category not provided')} · ${escapeHtml(campaign.goal)}</p></div><span class="campaign-status-badge">${escapeHtml(formatStatus(campaign.status))}</span></div>
    <div class="campaign-details">
      <div><span>Budget</span><strong>${campaign.budgetAmount === null ? 'Missing' : formatCurrency(campaign.budgetAmount, campaign.currency)}</strong></div>
      <div><span>Target CAC / CPA</span><strong>${campaign.targetCAC === null ? 'Not set' : formatCurrency(campaign.targetCAC, campaign.currency)}</strong></div>
      <div><span>Location / language</span><strong>${escapeHtml(campaign.location || 'Missing')}</strong></div>
      <div><span>Audience</span><strong>${escapeHtml(campaign.audience || 'Missing')}</strong></div>
    </div>
     <p class="campaign-note"><strong>Campaign ID ${escapeHtml(String(campaign.id))}.</strong> Creator comparisons and planning economics below use this active campaign. ${missing.length ? `Missing brief data: ${escapeHtml(missing.join(', '))}.` : 'Brief inputs are available for planning.'}</p>`;
}

function renderPerformance() {
  const loading = document.querySelector('#performance-loading');
  const missing = document.querySelector('#performance-missing');
  const error = document.querySelector('#performance-error');
  const empty = document.querySelector('#performance-empty');
  const campaign = state.activeCampaign;

  loading.classList.toggle('is-hidden', state.performanceStatus !== 'loading');
  missing.classList.toggle('is-hidden', Boolean(campaign));
  error.classList.toggle('is-hidden', state.performanceStatus !== 'error' || !campaign);
  performanceContent.classList.toggle('is-hidden', !campaign || state.performanceStatus === 'loading');

  if (state.performanceStatus === 'error' && campaign) {
    error.textContent = `${state.performanceError || 'Campaign performance could not be loaded.'} You can still use the local test-data loop below.`;
  } else {
    error.textContent = '';
  }

  if (!campaign || state.performanceStatus === 'loading') return;

  const performance = state.performance || normalizePerformance({});
  const hasTrackedData = hasTrackedPerformance(performance);
  empty.classList.toggle('is-hidden', hasTrackedData);
  performanceMetrics.innerHTML = renderPerformanceMetrics(performance);
  planActualCard.innerHTML = renderPlanActual(performance);
  renderTrackingLinks();
  renderDemoLinkSelect();
}

function hasTrackedPerformance(performance) {
  const tracked = performance?.tracked || {};
  return [tracked.clicks, tracked.leads, tracked.purchases, tracked.revenue, tracked.refunds, performance?.actualCAC]
    .some((value) => value !== null && value !== undefined && Number(value) > 0);
}

function renderPerformanceMetrics(performance) {
  const tracked = performance.tracked || {};
  const currency = state.activeCampaign?.currency || 'USD';
  const metrics = [
    ['Tracked clicks', formatOptionalNumber(tracked.clicks, 0), 'link activity'],
    ['Tracked leads', formatOptionalNumber(tracked.leads, 0), 'attributed leads'],
    ['Purchases', formatOptionalNumber(tracked.purchases, 0), 'attributed orders'],
    ['Revenue', tracked.revenue === null ? '—' : formatCurrency(tracked.revenue, currency), 'gross attributed revenue'],
    ['Refunds', tracked.refunds === null ? '—' : formatCurrency(tracked.refunds, currency), 'attributed refunds'],
    ['Actual CAC', performance.actualCAC === null ? '—' : formatCurrency(performance.actualCAC, currency), performance.actualCAC === null ? 'needs spend + purchases' : 'actual spend / purchases']
  ];
  return metrics.map(([label, value, note]) => `<div class="performance-metric"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span><small>${escapeHtml(note)}</small></div>`).join('');
}

function renderPlanActual(performance) {
  const planned = performance.planned || {};
  const tracked = performance.tracked || {};
  const currency = state.activeCampaign?.currency || 'USD';
  const targetCAC = planned.targetCAC ?? state.activeCampaign?.targetCAC ?? null;
  const status = getPlanActualStatus(performance, targetCAC);
  const rows = [
    ['Clicks', planned.clicks, tracked.clicks, false],
    ['Leads', planned.leads, tracked.leads, false],
    ['Purchases', planned.purchases, tracked.purchases, false],
    ['Revenue', planned.revenue, tracked.revenue, true],
    ['CAC', targetCAC, performance.actualCAC, true]
  ];

  return `<div class="plan-actual-heading"><div><p class="eyebrow">PLANNED VS ACTUAL</p><h3>Is the campaign on track?</h3></div><span class="outcome-status ${status.tone}">${escapeHtml(status.label)}</span></div>
    <div class="plan-actual-table"><div class="plan-actual-table-head"><span>Metric</span><span>Planned</span><span>Actual</span></div>${rows.map(([label, plan, actual, currencyValue]) => `<div class="plan-actual-row"><strong>${escapeHtml(label)}</strong><span>${formatPlanValue(plan, currencyValue, currency)}</span><span>${formatPlanValue(actual, currencyValue, currency)}</span></div>`).join('')}</div>
    <p class="plan-actual-note">${escapeHtml(status.note)}</p>`;
}

function formatPlanValue(value, currencyValue, currency) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return currencyValue ? formatCurrency(value, currency) : formatOptionalNumber(value, 0);
}

function getPlanActualStatus(performance, targetCAC) {
  const tracked = performance.tracked || {};
  if (performance.status) {
    return { label: formatStatus(performance.status), tone: statusTone(performance.status), note: 'Status supplied by the campaign performance summary.' };
  }
  if (performance.actualCAC !== null && targetCAC !== null) {
    const onTarget = performance.actualCAC <= targetCAC;
    return {
      label: onTarget ? 'On target' : 'Above target',
      tone: onTarget ? 'positive' : 'warning',
      note: onTarget ? 'Actual CAC is at or below the campaign target.' : 'Actual CAC is above the campaign target; keep the test controlled while more data arrives.'
    };
  }
  if ([tracked.clicks, tracked.leads, tracked.purchases, tracked.revenue, tracked.refunds].some((value) => value !== null && value > 0)) {
    return { label: 'Tracking in progress', tone: 'neutral', note: 'Actual outcomes are arriving; a full CAC comparison needs spend and purchases.' };
  }
  return { label: 'Awaiting data', tone: 'neutral', note: 'Add a creator link and record a test event to compare the campaign plan with outcomes.' };
}

function statusTone(status) {
  const normalized = String(status || '').toLowerCase();
  return normalized.includes('target') || normalized.includes('beat') || normalized.includes('ahead') ? 'positive' : normalized.includes('above') || normalized.includes('behind') || normalized.includes('risk') ? 'warning' : 'neutral';
}

function renderTrackingLinks() {
  const links = [...state.trackingLinks.values()];
  document.querySelector('#tracking-link-count').textContent = String(links.length);
  trackingLinkList.innerHTML = links.length
    ? links.map((link) => `<div class="tracking-link-item"><div><strong>${escapeHtml(link.creatorName || 'Creator link')}</strong><span>${escapeHtml(link.code || 'No code returned')}</span></div><div class="tracking-link-actions">${link.url ? `<a href="${escapeHtml(safeUrl(link.url))}" target="_blank" rel="noreferrer">Open</a><button class="copy-button" type="button" data-copy-label="Copy link" data-copy-tracking="${escapeHtml(link.url)}">Copy link</button>` : ''}${link.code ? `<button class="copy-button" type="button" data-copy-label="Copy code" data-copy-tracking="${escapeHtml(link.code)}">Copy code</button>` : ''}</div></div>`).join('')
    : '<div class="tracking-links-empty">No creator links yet. Use “Create tracking link” on a creator card.</div>';
}

function renderDemoLinkSelect() {
  const select = document.querySelector('#demo-link-select');
  const links = [...state.trackingLinks.entries()];
  select.innerHTML = links.length
    ? links.map(([key, link]) => `<option value="${escapeHtml(key)}">${escapeHtml(link.creatorName || key)}${link.code ? ` · ${escapeHtml(link.code)}` : ''}</option>`).join('')
    : '<option value="">Create a creator tracking link first</option>';
  select.disabled = links.length === 0;
}

function renderCreators() {
  const creators = [...state.creators.values()];
  creatorState.classList.toggle('is-hidden', creators.length > 0);
  creatorGrid.innerHTML = creators.map(renderCreatorCard).join('');
}

function renderCreatorIntelligence(summary, creatorKey) {
  const requestKey = `${creatorKey}:demographics`;
  const demographics = summary.audienceDemographics;
  const quality = summary.audienceQuality;
  const sponsorships = summary.publicSponsorshipSignals || summary.sponsorshipHistory || [];
  const requestPending = state.intelligenceRequests.has(requestKey);
  const evidenceRequestPending = state.intelligenceRequests.has(`${creatorKey}:sponsorship`);

  const demographicsMarkup = demographics
    ? `<div class="intelligence-module"><div class="intelligence-module-heading"><h5>Audience demographics</h5><span class="intelligence-state has-data">API data</span></div><div class="demographic-groups">${demographics.groups.map((group) => `<div class="demographic-group"><span>${escapeHtml(group.label)}</span><div>${group.items.map((item) => `<span class="demographic-value">${item.label ? `${escapeHtml(item.label)} ` : ''}<b>${escapeHtml(item.value)}</b></span>`).join('')}</div></div>`).join('')}</div><p class="intelligence-source">Source: ${escapeHtml(demographics.source || 'Not provided by API')}</p></div>`
    : `<div class="intelligence-module intelligence-empty"><div class="intelligence-module-heading"><h5>Audience demographics</h5><span class="intelligence-state ${requestPending ? 'is-pending' : 'needs-connection'}">${requestPending ? 'Connection drafted' : 'Connect provider'}</span></div><strong>${requestPending ? 'Audience provider connection is drafted' : 'No audience provider connected'}</strong><p>${requestPending ? 'No audience data was added. Connect an authorized provider before using age, gender, location, or language signals.' : 'Connect an audience provider owned by your brand before using age, gender, location, or language signals.'}</p>${requestPending ? '' : `<div class="intelligence-next-steps"><span>Connect audience provider</span><span>Brand-owned source</span></div><button class="intelligence-request-button" type="button" data-request-intelligence="${escapeHtml(encodeURIComponent(creatorKey))}" data-intelligence-kind="demographics">Connect audience provider</button>`}</div>`;

  const qualityMarkup = quality
    ? `<div class="intelligence-module"><div class="intelligence-module-heading"><h5>Audience quality</h5><span class="intelligence-state has-data">Data available</span></div><div class="quality-value">${escapeHtml(quality.value)}</div><div class="intelligence-meta"><span>Source: <b>${escapeHtml(quality.source || 'Not provided')}</b></span><span>Confidence: <b>${escapeHtml(quality.confidence || 'Not provided')}</b></span></div></div>`
    : `<div class="intelligence-module intelligence-empty"><div class="intelligence-module-heading"><h5>Audience quality</h5><span class="intelligence-state needs-data">Awaiting data</span></div><strong>No audience quality signal yet</strong><p>Quality will appear only when the API returns a signal with its source and confidence.</p><div class="intelligence-meta"><span>Source: <b>Not available</b></span><span>Confidence: <b>Not available</b></span></div></div>`;

  const sponsorshipMarkup = sponsorships.length
    ? `<div class="intelligence-module"><div class="intelligence-module-heading"><h5>Public sponsorship signals</h5><span class="intelligence-state has-data">${sponsorships.length} signal${sponsorships.length === 1 ? '' : 's'}</span></div><p class="intelligence-disclaimer">Signals come from official YouTube video descriptions. They are not verified sponsorship history.</p><ul class="sponsorship-list">${sponsorships.slice(0, 5).map(renderPublicSponsorshipSignal).join('')}</ul></div>`
    : `<div class="intelligence-module intelligence-empty"><div class="intelligence-module-heading"><h5>Public sponsorship signals</h5><span class="intelligence-state ${evidenceRequestPending ? 'is-pending' : 'needs-data'}">${evidenceRequestPending ? 'Evidence drafted' : 'No signals'}</span></div><strong>${evidenceRequestPending ? 'Evidence entry is drafted' : 'No public sponsorship signals returned'}</strong><p>Signals come from official YouTube video descriptions and are not verified sponsorship history. Scan the public descriptions first, then add brand evidence only when your team has a source to review.</p>${evidenceRequestPending ? '' : `<div class="intelligence-next-steps"><span>Official API scan</span><span>Brand evidence</span></div><div class="intelligence-action-row"><button class="intelligence-request-button" type="button" data-scan-public-signals="${escapeHtml(encodeURIComponent(creatorKey))}">Scan public descriptions</button><button class="intelligence-request-button secondary" type="button" data-request-intelligence="${escapeHtml(encodeURIComponent(creatorKey))}" data-intelligence-kind="sponsorship">Add brand evidence</button></div>`}</div>`;

  return `<section class="creator-intelligence" aria-label="Brand intelligence"><div class="intelligence-heading"><div><p class="eyebrow">BRAND INTELLIGENCE</p><h4>Audience, quality, and public evidence</h4></div><span class="intelligence-note">No inferred data</span></div><div class="intelligence-grid">${demographicsMarkup}${qualityMarkup}${sponsorshipMarkup}</div></section>`;
}

function renderPublicSponsorshipSignal(record) {
  const evidence = (record.evidenceLinks || []).map((link) => {
    const url = safeUrl(link.url, '');
    return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label || 'View YouTube description')}</a>` : '';
  }).filter(Boolean).join('');
  const confidence = formatSignalConfidence(record.confidence);
  return `<li><div><strong>${escapeHtml(record.brand || 'Brand not named')}</strong>${record.campaign ? `<span>${escapeHtml(record.campaign)}</span>` : ''}${record.date ? `<small>${escapeHtml(record.date)}</small>` : ''}${record.status ? `<small>${escapeHtml(record.status)}</small>` : ''}${record.matchedKeywords?.length ? `<small>Matched: ${escapeHtml(record.matchedKeywords.join(', '))}</small>` : ''}${record.detectedDomains?.length ? `<small>Domains: ${escapeHtml(record.detectedDomains.join(', '))}</small>` : ''}<div class="signal-meta"><span>Confidence: <b>${escapeHtml(confidence)}</b></span><span>Source: <b>${escapeHtml(record.source || 'Official YouTube video description')}</b></span></div>${evidence ? `<div class="signal-evidence">${evidence}</div>` : '<small class="signal-evidence-missing">Evidence link not provided</small>'}</div></li>`;
}

function formatSignalConfidence(value) {
  if (value === null || value === undefined || value === '') return 'Not provided';
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0 && number <= 1) return `${Math.round(number * 100)}%`;
  return String(value);
}

function renderCreatorCard(creator) {
  const { summary } = creator;
  const encodedKey = encodeURIComponent(creator.key);
  const isSelected = state.selected.has(creator.key);
  const initials = summary.channelName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const videos = creator.videos.slice(0, 3).map((video) => `
    <li><a href="${escapeHtml(safeUrl(video.url))}" target="_blank" rel="noreferrer">${escapeHtml(video.title || 'Untitled video')}</a><span>${formatNumber(video.views)} views</span></li>
  `).join('');
  const trackingLink = state.trackingLinks.get(creator.key);
  const trackingAction = state.activeCampaign
    ? `<button class="tracking-button" type="button" data-create-tracking-link="${escapeHtml(encodedKey)}">${trackingLink ? 'Create new tracking link' : 'Create tracking link'} <span aria-hidden="true">↗</span></button>${trackingLink ? renderCreatorTrackingLink(trackingLink) : ''}`
    : '<p class="tracking-link-note">Save a campaign to create an attributed link for this creator.</p>';

  return `
    <article class="creator-card ${isSelected ? 'is-selected' : ''}" data-creator-card="${escapeHtml(encodedKey)}">
      <div class="creator-avatar ${avatarTone(summary.channelName)}">${escapeHtml(initials)}</div>
      <div class="creator-main">
        <div class="creator-title">
          <div><h3>${escapeHtml(summary.channelName)}</h3><p>${creator.source === 'live' ? 'Fresh YouTube API snapshot' : 'Saved YouTube snapshot'}${state.activeCampaign ? ` · ${escapeHtml(state.activeCampaign.name)}` : ''}</p></div>
          <span class="source-badge ${creator.source === 'live' ? 'live' : ''}">${creator.source === 'live' ? 'Live' : 'Saved'}</span>
        </div>
        <div class="creator-stats">
          <div><b>${formatNumber(summary.subscribers)}</b><span>subscribers <em>YouTube</em></span></div>
          <div><b>${formatNumber(summary.medianRecentViews)}</b><span>median views <em>YouTube</em></span></div>
          <div><b>${formatRatio(summary.viewsToSubscriberRatio)}</b><span>views / subscriber <em>YouTube</em></span></div>
        </div>
          <p class="reason">${summary.videoCount ? `${summary.videoCount} recent videos sampled.` : 'Recent video count was not available.'} Retrieved ${formatDate(summary.retrievedAt)}. Public performance is not a conversion guarantee.</p>
          ${renderEstimateStrip(summary)}
          ${renderCreatorIntelligence(summary, creator.key)}
          ${videos ? `<div class="video-evidence"><span class="subheading">Recent video evidence</span><ul class="video-list">${videos}</ul></div>` : ''}
         <div class="creator-actions"><button class="compare-button" type="button" data-select-creator="${escapeHtml(encodedKey)}" aria-pressed="${isSelected}">${isSelected ? '✓ Added to compare' : '+ Add to compare'}</button>${trackingAction}</div>
       </div>
     </article>`;
}

function renderCreatorTrackingLink(link) {
  return `<div class="creator-tracking-link"><span class="subheading">Tracking link ready</span>${link.url ? `<div class="tracking-link-value"><a href="${escapeHtml(safeUrl(link.url))}" target="_blank" rel="noreferrer">${escapeHtml(link.url)}</a><button class="copy-button" type="button" data-copy-label="Copy" data-copy-tracking="${escapeHtml(link.url)}">Copy</button></div>` : ''}${link.code ? `<span class="tracking-code">Code: <strong>${escapeHtml(link.code)}</strong><button class="copy-button" type="button" data-copy-label="Copy code" data-copy-tracking="${escapeHtml(link.code)}">Copy code</button></span>` : ''}<span class="tracking-copy-status" aria-live="polite"></span></div>`;
}

function renderHistory() {
  document.querySelector('#history-count').textContent = String(state.history.length);
  historyList.innerHTML = state.history.map((rawSummary) => {
    const summary = normalizeSummary(rawSummary);
    const key = summary.channelId || summary.channelName;
    const context = summary.campaignId && state.activeCampaign && String(summary.campaignId) === String(state.activeCampaign.id)
      ? ' · active campaign'
      : '';
    return `<div class="history-item"><div><strong>${escapeHtml(summary.channelName)}</strong><span>${formatNumber(summary.medianRecentViews)} median views · ${formatDate(summary.retrievedAt)}${context}</span></div><button type="button" class="text-button" data-focus-key="${escapeHtml(encodeURIComponent(key))}">View</button></div>`;
  }).join('');
}

function renderComparison() {
  const selectedCreators = [...state.selected]
    .map((key) => state.creators.get(key))
    .filter(Boolean);
  const tableWrap = document.querySelector('#comparison-table-wrap');
  const empty = document.querySelector('#comparison-empty');

  document.querySelector('#selection-count').textContent = `${selectedCreators.length} selected${state.activeCampaign ? ` · ${state.activeCampaign.name}` : ''}`;
  empty.classList.toggle('is-hidden', selectedCreators.length > 0);
  tableWrap.classList.toggle('is-hidden', selectedCreators.length === 0);
  comparisonBody.innerHTML = selectedCreators.map(({ summary }) => {
    const economics = getPlanningEconomics(summary);
    return `
      <tr>
        <th scope="row"><strong>${escapeHtml(summary.channelName)}</strong><small>${formatDate(summary.retrievedAt)}</small></th>
        <td>${formatNumber(summary.subscribers)}<small class="metric-label youtube-label">YouTube</small></td>
        <td>${formatNumber(summary.medianRecentViews)}<small class="metric-label youtube-label">YouTube</small></td>
        <td>${formatRatio(summary.viewsToSubscriberRatio)}<small class="metric-label youtube-label">YouTube</small></td>
        <td>${formatOptionalNumber(summary.estimates.expectedRelevantViews)}<small class="metric-label estimate-label">Planning estimate</small></td>
        <td>${formatFeeRange(summary.estimates.feeRange)}<small class="metric-label estimate-label">Planning estimate</small></td>
        <td>${formatOptionalNumber(economics.expectedPurchases, 1)}<small class="metric-label estimate-label">${escapeHtml(economics.purchaseLabel)}</small></td>
        <td>${formatFeeRange(economics.expectedCACRange)}<small class="metric-label estimate-label">${escapeHtml(economics.cacLabel)}</small></td>
      </tr>`;
  }).join('');
}

function renderEstimateStrip(summary) {
  const estimates = summary.estimates;
  const economics = getPlanningEconomics(summary);
  const relevantViews = estimates.expectedRelevantViews === null ? '—' : formatNumber(estimates.expectedRelevantViews);
  const fee = formatFeeRange(estimates.feeRange);
  const confidence = estimates.confidence ? `${estimates.confidence} confidence` : 'not available';

  return `<div class="estimate-strip">
    <div><b>${relevantViews}</b><span>expected relevant views</span></div>
    <div><b>${fee}</b><span>planning fee range</span></div>
    <div><b>${formatOptionalNumber(economics.expectedPurchases, 1)}</b><span>expected purchases · ${escapeHtml(economics.purchaseLabel)}</span></div>
    <div><b>${formatFeeRange(economics.expectedCACRange)}</b><span>expected CAC · ${escapeHtml(economics.cacLabel)}</span></div>
    <div><b>${escapeHtml(confidence)}</b><span>YouTube estimate confidence</span></div>
  </div>`;
}

function getPlanningEconomics(summary) {
  const estimates = summary.estimates || {};
  const campaign = state.activeCampaign;
  const missing = Array.isArray(estimates.missingData) ? [...estimates.missingData] : [];
  if (!campaign) {
    return { expectedPurchases: null, expectedCACRange: null, purchaseLabel: 'campaign required', cacLabel: 'campaign required' };
  }

  let expectedPurchases = estimates.expectedPurchases;
  let purchaseLabel = 'campaign estimate';
  const purchaseRate = estimates.expectedPurchaseRate ?? campaign.expectedPurchaseRate;

  if (expectedPurchases === null && estimates.expectedRelevantViews !== null) {
    if (purchaseRate !== null && purchaseRate !== undefined) {
      expectedPurchases = estimates.expectedRelevantViews * normalizeRate(purchaseRate);
      purchaseLabel = 'modeled from rate';
    } else if (String(campaign.goal).toLowerCase().includes('purchase')) {
      expectedPurchases = estimates.expectedRelevantViews * DEFAULT_PURCHASE_RATE;
      purchaseLabel = 'modeled at 1% rate';
      missing.push('tracked conversion rate');
    } else {
      missing.push('purchase goal / conversion rate');
    }
  }

  if (expectedPurchases === null) missing.push('expected relevant views');
  let expectedCACRange = estimates.expectedCACRange;
  let cacLabel = expectedCACRange ? 'campaign estimate' : 'needs fee + purchases';
  if (!expectedCACRange && expectedPurchases > 0 && Number.isFinite(Number(estimates.feeRange?.min)) && Number.isFinite(Number(estimates.feeRange?.max))) {
    const feeCurrency = estimates.feeRange.currency || 'USD';
    const conversionRate = campaign.currency === 'INR' && feeCurrency === 'USD'
      ? USD_TO_INR_PLANNING_RATE
      : 1;
    expectedCACRange = {
      min: (estimates.feeRange.min * conversionRate) / expectedPurchases,
      max: (estimates.feeRange.max * conversionRate) / expectedPurchases,
      currency: campaign.currency || feeCurrency
    };
    cacLabel = purchaseLabel === 'modeled at 1% rate' ? 'modeled estimate' : 'calculated estimate';
  }

  return {
    expectedPurchases: expectedPurchases === null ? null : Math.max(0, expectedPurchases),
    expectedCACRange,
    purchaseLabel: missing.length && purchaseLabel === 'campaign estimate' ? 'missing data' : purchaseLabel,
    cacLabel: missing.length && !expectedCACRange ? 'missing data' : cacLabel
  };
}

function handleCreatorAction(event) {
  const scanAction = event.target.closest('[data-scan-public-signals]');
  if (scanAction) {
    const key = decodeKey(scanAction.dataset.scanPublicSignals);
    if (state.creators.has(key)) scanPublicSponsorshipSignals(key, scanAction);
    return;
  }

  const intelligenceAction = event.target.closest('[data-request-intelligence]');
  if (intelligenceAction) {
    const key = decodeKey(intelligenceAction.dataset.requestIntelligence);
    const creator = state.creators.get(key);
    if (!creator) return;
    state.intelligenceRequests.add(`${key}:${intelligenceAction.dataset.intelligenceKind || 'demographics'}`);
    renderCreators();
    const intelligenceKind = intelligenceAction.dataset.intelligenceKind || 'demographics';
    setFormStatus('success', intelligenceKind === 'sponsorship'
      ? `Brand evidence entry drafted for ${creator.summary.channelName}. No signal was added.`
      : `Audience provider connection drafted for ${creator.summary.channelName}. No data was added.`);
    return;
  }

  const createAction = event.target.closest('[data-create-tracking-link]');
  if (createAction) {
    const key = decodeKey(createAction.dataset.createTrackingLink);
    if (state.creators.has(key)) createTrackingLink(key, createAction);
    return;
  }

  const copyAction = event.target.closest('[data-copy-tracking]');
  if (copyAction) {
    copyTrackingValue(copyAction.dataset.copyTracking, copyAction);
    return;
  }

  const action = event.target.closest('[data-select-creator]');
  if (!action) return;

  const key = decodeKey(action.dataset.selectCreator);
  if (!state.creators.has(key)) return;

  if (state.selected.has(key)) {
    state.selected.delete(key);
  } else if (state.selected.size < 4) {
    state.selected.add(key);
  } else {
    setFormStatus('error', 'You can compare up to four creators at a time.');
    return;
  }

  renderCreators();
  renderComparison();
}

async function scanPublicSponsorshipSignals(creatorKey, button) {
  const creator = state.creators.get(creatorKey);
  if (!creator?.summary?.channelId) {
    setFormStatus('error', 'This creator does not have a usable YouTube channel ID.');
    return;
  }

  button.disabled = true;
  button.classList.add('is-loading');
  setFormStatus('loading', `Scanning public YouTube descriptions for ${creator.summary.channelName}…`);

  try {
    const result = await fetchJson(`${API_BASE}/api/brands/sponsorship-signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelUrl: creator.summary.channelId, forceRefresh: true })
    });
    const signals = extractPublicSponsorshipSignals(result);
    creator.summary.publicSponsorshipSignals = normalizePublicSponsorshipSignals(signals);
    creator.summary.sponsorshipHistory = creator.summary.publicSponsorshipSignals;
    renderCreators();
    setFormStatus('success', `${signals.length} public sponsorship signal${signals.length === 1 ? '' : 's'} found for ${creator.summary.channelName}. These are review signals, not verified sponsorship history.`);
  } catch (error) {
    setFormStatus('error', error.message || 'The public description scan failed.');
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
}

function handlePerformanceAction(event) {
  const copyAction = event.target.closest('[data-copy-tracking]');
  if (copyAction) copyTrackingValue(copyAction.dataset.copyTracking, copyAction);
}

async function createTrackingLink(creatorKey, button) {
  const creator = state.creators.get(creatorKey);
  if (!creator || !state.activeCampaign?.id) {
    setFormStatus('error', 'Save an active campaign before creating a tracking link.');
    return;
  }

  const summary = creator.summary;
  const payload = {
    campaignId: state.activeCampaign.id,
    destinationUrl: state.activeCampaign.destinationUrl,
    creatorId: summary.channelId || null,
    creatorName: summary.channelName,
    channelId: summary.channelId || null,
    channelName: summary.channelName
  };
  button.disabled = true;
  button.classList.add('is-loading');

  try {
    const result = await fetchJsonWithFallback([
      `${API_BASE}/api/campaigns/${encodeURIComponent(state.activeCampaign.id)}/tracking-links`,
      `${API_BASE}/api/tracking-links`
    ], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const link = normalizeTrackingLink(result.trackingLink || result.tracking_link || result.link || result);
    if (!link) throw new Error('The API returned no tracking link or code.');
    state.trackingLinks.set(creatorKey, { ...link, creatorKey, creatorName: link.creatorName || summary.channelName });
    persistAttributionState();
    setFormStatus('success', `Tracking link created for ${summary.channelName}.`);
  } catch (error) {
    if (!isOptionalAttributionError(error)) {
      setFormStatus('error', error.message || 'Could not create a tracking link.');
      return;
    }
    const localLink = createLocalTrackingLink(creatorKey, summary);
    state.trackingLinks.set(creatorKey, localLink);
    persistAttributionState();
    setFormStatus('success', `Local test link created for ${summary.channelName}. It is labelled test data in this browser.`);
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
    renderCreators();
    renderPerformance();
  }
}

function createLocalTrackingLink(creatorKey, summary) {
  const campaignId = encodeURIComponent(state.activeCampaign.id);
  const creatorId = encodeURIComponent(summary.channelId || creatorKey);
  const origin = window.location.origin && window.location.origin !== 'null' ? window.location.origin : 'http://127.0.0.1:4173';
  const code = `MK-${String(state.activeCampaign.id).replace(/[^a-z0-9]/gi, '')}-${String(summary.channelId || creatorKey).replace(/[^a-z0-9]/gi, '').slice(-8)}`;
  return {
    id: `local-${Date.now()}`,
    url: `${origin}/?mk_campaign=${campaignId}&mk_creator=${creatorId}`,
    code,
    creatorId: summary.channelId || null,
    creatorName: summary.channelName,
    creatorKey,
    local: true
  };
}

async function copyTrackingValue(value, button) {
  if (!value) return;
  try {
    await copyText(value);
    button.textContent = 'Copied';
    const status = button.closest('.creator-tracking-link')?.querySelector('.tracking-copy-status');
    if (status) status.textContent = 'Copied to clipboard.';
    window.setTimeout(() => {
      button.textContent = button.dataset.copyLabel || (button.closest('.tracking-link-value') ? 'Copy' : 'Copy code');
      if (status) status.textContent = '';
    }, 1400);
  } catch (error) {
    const status = button.closest('.creator-tracking-link')?.querySelector('.tracking-copy-status');
    if (status) status.textContent = 'Copy failed — select the value manually.';
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard is unavailable.');
}

async function recordDemoEvent(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const creatorKey = String(data.get('trackingLink') || '');
  const type = String(data.get('eventType') || 'click');
  const amount = numberOrNull(data.get('amount'));
  const link = state.trackingLinks.get(creatorKey);

  if (!state.activeCampaign?.id) {
    setDemoEventStatus('error', 'Save a campaign before recording test data.');
    return;
  }
  if (!link) {
    setDemoEventStatus('error', 'Create a creator tracking link first.');
    return;
  }
  if ((type === 'purchase' || type === 'refund') && amount === null) {
    setDemoEventStatus('error', 'Enter an amount for purchase or refund test data.');
    return;
  }

  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  const payload = {
    campaignId: state.activeCampaign.id,
    trackingLinkId: link.id,
    trackingCode: link.code || null,
    eventType: type,
    type,
    amount,
    idempotencyKey: `demo-${state.activeCampaign.id}-${link.id}-${type}-${Date.now()}`,
    currency: state.activeCampaign.currency || 'USD',
    testData: true
  };

  try {
    const result = await fetchJsonWithFallback([
      `${API_BASE}/api/tracking-links/${encodeURIComponent(link.id)}/events`,
      `${API_BASE}/api/attribution/events`
    ], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const summary = result.summary || result.performance || result.attribution;
    if (summary) {
      state.performance = normalizePerformance(result);
      state.performanceStatus = 'ready';
      state.performanceUsesLocalFallback = false;
    } else if (result.event || result.trackingEvent || result.tracking_event) {
      state.localDemoEvents.push({ campaignId: state.activeCampaign.id, trackingLinkId: link.id, type, amount, createdAt: new Date().toISOString() });
      state.performanceUsesLocalFallback = true;
      state.performanceStatus = 'ready';
      state.performance = mergeLocalPerformance(state.performance || normalizePerformance({}));
      persistAttributionState();
    } else {
      state.performanceStatus = 'ready';
      state.performanceUsesLocalFallback = false;
      loadCampaignPerformance();
    }
    setDemoEventStatus('success', `${formatStatus(type)} recorded as test data.`);
  } catch (error) {
    if (!isOptionalAttributionError(error)) {
      setDemoEventStatus('error', error.message || 'Could not record the test event.');
      submit.disabled = false;
      return;
    }
    state.localDemoEvents.push({ campaignId: state.activeCampaign.id, trackingLinkId: link.id, type, amount, createdAt: new Date().toISOString() });
    state.performanceUsesLocalFallback = true;
    state.performanceStatus = 'ready';
    state.performance = mergeLocalPerformance(state.performance || normalizePerformance({}));
    persistAttributionState();
    setDemoEventStatus('success', `${formatStatus(type)} recorded as local test data.`);
  } finally {
    submit.disabled = false;
    renderPerformance();
  }
}

function setDemoEventStatus(type, message) {
  if (message === undefined) {
    message = type;
    type = 'success';
  }
  demoEventStatus.className = `demo-event-status ${type}`;
  demoEventStatus.textContent = message;
}

function isOptionalAttributionError(error) {
  return error?.status === 404 || error?.status === 405 || !error?.status;
}

function attributionStorageKey() {
  return state.activeCampaign?.id ? `mangokast.attribution.${state.activeCampaign.id}` : null;
}

function loadLocalAttribution(campaignId) {
  try {
    const value = localStorage.getItem(`mangokast.attribution.${campaignId}`);
    const parsed = value ? JSON.parse(value) : {};
    const links = Array.isArray(parsed.links) ? parsed.links.map(normalizeTrackingLink).filter(Boolean) : [];
    const events = Array.isArray(parsed.events) ? parsed.events.filter((event) => event && typeof event.type === 'string') : [];
    return { links, events };
  } catch (error) {
    return { links: [], events: [] };
  }
}

function persistAttributionState() {
  const key = attributionStorageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      links: [...state.trackingLinks.values()],
      events: state.localDemoEvents
    }));
  } catch (error) {
    // Browser storage is an enhancement for the local demo, not a blocker for API data.
  }
}

function handleHistoryAction(event) {
  const action = event.target.closest('[data-focus-key]');
  if (!action) return;
  const card = document.querySelector(`[data-creator-card="${CSS.escape(action.dataset.focusKey)}"]`);
  card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card?.classList.add('pulse');
  window.setTimeout(() => card?.classList.remove('pulse'), 900);
}

function setHistoryState(mode, message) {
  document.querySelector('#history-loading').classList.toggle('is-hidden', mode !== 'loading');
  document.querySelector('#history-empty').classList.toggle('is-hidden', mode !== 'empty');
  const error = document.querySelector('#history-error');
  error.classList.toggle('is-hidden', mode !== 'error');
  if (mode === 'error') error.firstChild.textContent = message || 'Could not load local history. ';
}

function setFormStatus(type, message) {
  formStatus.className = `form-status ${type}`;
  formStatus.textContent = message;
}

function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits }).format(numberOrZero(value));
}

function formatOptionalNumber(value, maximumFractionDigits = 1) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : formatNumber(value, maximumFractionDigits);
}

function formatRatio(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function formatCurrency(value, currency = 'USD') {
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(numberOrZero(value))}`;
}

function formatDate(value) {
  if (!value) return 'unknown time';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatStatus(value) {
  return String(value || 'active').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatFeeRange(range) {
  if (!range || range.min === null || range.min === undefined || range.max === null || range.max === undefined) return '—';
  return `${formatCurrency(range.min, range.currency)}–${formatCurrency(range.max, range.currency)}`;
}

function normalizeRange(range) {
  if (!range || range.min === undefined || range.min === null || range.max === undefined || range.max === null) return null;
  const min = numberOrNull(range.min);
  const max = numberOrNull(range.max);
  return min === null || max === null ? null : { min, max, currency: range.currency || 'USD' };
}

function normalizeRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) ? (rate > 1 ? rate / 100 : rate) : DEFAULT_PURCHASE_RATE;
}

function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = String(value).replace(/[^0-9.,-]/g, '');
  const number = Number(cleaned.replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function avatarTone(name) {
  return ['orange', 'purple', 'blue', 'yellow'][name.length % 4];
}

function decodeKey(value) {
  try { return decodeURIComponent(value); } catch (error) { return value; }
}

function safeUrl(value, fallback = '#') {
  try {
    const url = new URL(String(value || ''), window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : fallback;
  } catch (error) {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// Landing-page motion is intentionally dependency-free so the product workspace
// remains portable when it is served as a static app.
window.setTimeout(() => document.body.classList.add('is-loaded'), 850);

const revealItems = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window) {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.14 });
  revealItems.forEach((item) => revealObserver.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add('is-visible'));
}

const mapCopy = {
  discover: {
    title: 'Signal becomes a shortlist.',
    copy: 'Start with a public channel snapshot. See reach, recent performance, and public evidence without asking creators to create an account.'
  },
  plan: {
    title: 'The brief sets the lens.',
    copy: 'Budget, target CAC, price, margin, audience, and location turn a creator snapshot into a campaign-specific planning range.'
  },
  measure: {
    title: 'The outcome writes the next brief.',
    copy: 'Tracking links, purchases, refunds, and actual CAC make the next creator decision more accountable than the last one.'
  }
};

function activateMapRoute(key) {
  const detailTitle = document.querySelector('#map-detail-title');
  const detailCopy = document.querySelector('#map-detail-copy');
  const description = mapCopy[key] || mapCopy.discover;
  document.querySelectorAll('[data-map-route], [data-map-node]').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.mapRoute === key || item.dataset.mapNode === key);
  });
  document.querySelectorAll('[data-traveller]').forEach((traveller) => {
    traveller.classList.remove('is-travelling');
    if (traveller.dataset.traveller !== key) return;
    const motion = traveller.querySelector('animateMotion');
    traveller.classList.add('is-travelling');
    if (motion && typeof motion.beginElement === 'function') {
      try { motion.beginElement(); } catch (error) { /* SVG animation is decorative. */ }
    }
  });
  if (detailTitle) detailTitle.textContent = description.title;
  if (detailCopy) detailCopy.textContent = description.copy;
}

document.querySelectorAll('[data-map-route], [data-map-node]').forEach((item) => {
  const key = item.dataset.mapRoute || item.dataset.mapNode;
  item.addEventListener('click', () => activateMapRoute(key));
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateMapRoute(key);
    }
  });
});

document.querySelectorAll('[data-image-focus]').forEach((button) => {
  button.addEventListener('click', () => {
    const key = button.dataset.imageFocus;
    const card = document.querySelector(`[data-image-card="${key}"]`);
    const isFocused = card?.classList.toggle('is-focused');
    button.setAttribute('aria-pressed', String(Boolean(isFocused)));
  });
});

activateMapRoute('discover');

const topbar = document.querySelector('.topbar');
window.addEventListener('scroll', () => {
  topbar?.classList.toggle('is-scrolled', window.scrollY > 18);
}, { passive: true });
