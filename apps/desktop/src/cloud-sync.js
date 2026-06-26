const sqliteStore = require('./storage/sqlite-store');
const appCore = require('./app-core');
const crypto = require('node:crypto');

let tokens = null;
let pendingLogin = null;

function configuration() {
  return {
    apiUrl: String(process.env.CAREER_OPS_API_URL || 'https://k6itrrzudf.execute-api.us-east-1.amazonaws.com').replace(/\/$/, ''),
    accessToken: String(process.env.CAREER_OPS_ACCESS_TOKEN || tokens?.access_token || ''),
    cognitoDomain: String(process.env.CAREER_OPS_COGNITO_DOMAIN || 'https://career-ops-dev-054526846770.auth.us-east-1.amazoncognito.com').replace(/\/$/, ''),
    clientId: String(process.env.CAREER_OPS_COGNITO_CLIENT_ID || '2lpqgctrrn706nibmqs1bvgv7i'),
    callbackUrl: String(process.env.CAREER_OPS_CALLBACK_URL || 'http://127.0.0.1:43119/auth/callback')
  };
}

function status() {
  const config = configuration();
  const cached = sqliteStore.loadCloudFeed();
  return {
    configured: Boolean(config.apiUrl && config.accessToken),
    authenticated: Boolean(config.accessToken),
    apiUrl: config.apiUrl,
    syncedAt: cached.syncedAt,
    cachedCount: cached.items.length,
    pendingActions: sqliteStore.pendingCloudActions().length
  };
}

function beginLogin() {
  const config = configuration();
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pendingLogin = { state, verifier };
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: 'openid email',
    redirect_uri: config.callbackUrl,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge
  });
  return `${config.cognitoDomain}/oauth2/authorize?${query}`;
}

async function completeLogin({ code, state }) {
  if (!pendingLogin || state !== pendingLogin.state) throw new Error('Login state could not be verified.');
  const config = configuration();
  const response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code,
      redirect_uri: config.callbackUrl,
      code_verifier: pendingLogin.verifier
    })
  });
  tokens = await readResponse(response);
  pendingLogin = null;
  return status();
}

function logout() {
  tokens = null;
  pendingLogin = null;
  return status();
}

async function sync() {
  const config = configuration();
  if (!config.apiUrl || !config.accessToken) {
    return { ...sqliteStore.loadCloudFeed(), status: status(), offline: true };
  }
  const profileSync = await ensureCloudProfile(config);
  if (profileSync.changed) sqliteStore.clearCloudFeed();
  const cached = sqliteStore.loadCloudFeed();
  const actions = sqliteStore.pendingCloudActions();
  const response = await fetch(`${config.apiUrl}/v1/sync`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ cursor: cached.cursor || undefined, actions, includeNeedsReview: true })
  });
  const body = await readResponse(response);
  sqliteStore.markCloudActionsSent(body.acceptedActionIds || []);
  sqliteStore.cacheCloudFeed(body.feed);
  return { ...body.feed, status: status(), offline: false };
}

async function ensureCloudProfile(config) {
  const existing = await fetch(`${config.apiUrl}/v1/profile`, {
    headers: { authorization: `Bearer ${config.accessToken}` }
  });
  const remoteProfile = existing.ok ? await readResponse(existing) : null;
  if (!existing.ok && existing.status !== 404) await readResponse(existing);
  const profile = appCore.buildCloudMatchingProfile();
  if (!profile.targetRoles.length) throw new Error('Add at least one target role in Settings before AWS sync.');
  if (!profile.acceptedSeniorities.length) throw new Error('Choose at least one accepted seniority in Settings before AWS sync.');
  if (!profile.acceptedEmploymentTypes.length) throw new Error('Choose at least one employment type in Settings before AWS sync.');
  if (!profile.acceptedWorkModes.length) throw new Error('Choose at least one work mode in Settings before AWS sync.');
  if (!profile.authorizedCountries.length && profile.hardConstraints.geography) {
    throw new Error('Add at least one authorized country in Settings before AWS sync.');
  }
  if (remoteProfile && profilesEqual(remoteProfile, profile)) return { changed: false, profile: remoteProfile };
  const created = await fetch(`${config.apiUrl}/v1/profile`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(profile)
  });
  return { changed: true, profile: await readResponse(created) };
}

async function feedback(input) {
  const action = sqliteStore.queueCloudAction(input);
  try {
    return await sync();
  } catch (error) {
    return {
      ...sqliteStore.loadCloudFeed(),
      status: status(),
      offline: true,
      warning: error.message,
      queuedAction: action.idempotencyKey
    };
  }
}

async function readResponse(response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || `Cloud API returned HTTP ${response.status}`);
  return body;
}

function profilesEqual(remote, local) {
  const ignored = new Set(['userId', 'profileVersion', 'updatedAt', 'feedbackAffinity']);
  const clean = (value) => Object.fromEntries(Object.entries(value || {})
    .filter(([key, item]) => !ignored.has(key) && item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify(clean(remote)) === JSON.stringify(clean(local));
}

module.exports = { configuration, status, beginLogin, completeLogin, logout, sync, feedback };
