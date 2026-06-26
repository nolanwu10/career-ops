function apiUrl() {
  const u = process.env.CLOUD_API_URL;
  if (!u) throw new Error('CLOUD_API_URL env var is required');
  return u.replace(/\/$/, '');
}

class CloudApiClient {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  async request(method, path, body) {
    const headers = { authorization: `Bearer ${this.accessToken}` };
    let fetchBody;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      fetchBody = JSON.stringify(body);
    }
    const response = await fetch(`${apiUrl()}${path}`, { method, headers, body: fetchBody });
    if (response.status === 204) return null;
    const text = await response.text();
    const data = text ? safeJson(text) : null;
    if (!response.ok) {
      const err = new Error(data?.error || `Cloud API returned ${response.status} for ${method} ${path}`);
      err.status = response.status;
      err.upstream = response.status;
      throw err;
    }
    return data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }
  delete(path) { return this.request('DELETE', path); }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

module.exports = { CloudApiClient };
