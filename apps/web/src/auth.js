const crypto = require('node:crypto');

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cognitoDomain() {
  const d = process.env.COGNITO_DOMAIN;
  if (!d) throw new Error('COGNITO_DOMAIN env var is required');
  return d.replace(/\/$/, '');
}

function clientId() {
  const c = process.env.COGNITO_CLIENT_ID;
  if (!c) throw new Error('COGNITO_CLIENT_ID env var is required');
  return c;
}

function appUrl() {
  return (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
}

function callbackUrl() {
  return `${appUrl()}/auth/callback`;
}

function beginLogin() {
  const now = Date.now();
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    scope: 'openid email',
    redirect_uri: callbackUrl(),
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge
  });

  return {
    url: `${cognitoDomain()}/oauth2/authorize?${params}`,
    loginState: { state, verifier, ts: now }
  };
}

async function completeLogin(code, state, loginState) {
  if (!loginState || loginState.state !== state || !loginState.verifier || !loginState.ts) {
    throw new Error('Login state expired or invalid - please try signing in again.');
  }
  if (Date.now() - Number(loginState.ts) > STATE_TTL_MS) {
    throw new Error('Login state expired or invalid - please try signing in again.');
  }

  const response = await fetch(`${cognitoDomain()}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId(),
      code,
      redirect_uri: callbackUrl(),
      code_verifier: loginState.verifier
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Token exchange failed (${response.status}): ${body}`);
  return JSON.parse(body);
}

function logoutUrl() {
  const params = new URLSearchParams({
    client_id: clientId(),
    logout_uri: `${appUrl()}/`
  });
  return `${cognitoDomain()}/logout?${params}`;
}

module.exports = { beginLogin, completeLogin, logoutUrl };
