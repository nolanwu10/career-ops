import { ProviderError, type HttpClient, type HttpRequestOptions } from './types.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_USER_AGENT = 'career-ops-cloud/0.1';

export function createHttpClient(fetchImpl: typeof fetch = fetch): HttpClient {
  async function request(url: string, options: HttpRequestOptions = {}): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new ProviderError(`Only HTTPS provider endpoints are allowed: ${url}`, {
        code: 'UNSAFE_URL',
        retryable: false
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(parsed, {
        method: options.method ?? 'GET',
        headers: { 'user-agent': DEFAULT_USER_AGENT, ...options.headers },
        body: options.body,
        redirect: options.redirect ?? 'error',
        signal: controller.signal
      });
      if (!response.ok) {
        throw new ProviderError(`Provider request failed with HTTP ${response.status}`, {
          code: `HTTP_${response.status}`,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          status: response.status
        });
      }
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > (options.maxBytes ?? DEFAULT_MAX_BYTES)) {
        throw new ProviderError(`Provider response exceeds ${options.maxBytes ?? DEFAULT_MAX_BYTES} bytes`, {
          code: 'RESPONSE_TOO_LARGE',
          retryable: false
        });
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError(`Provider request timed out: ${url}`, {
          code: 'TIMEOUT',
          retryable: true,
          cause: error
        });
      }
      throw new ProviderError(`Provider request failed: ${url}`, { code: 'NETWORK_ERROR', cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readBounded(response: Response, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ProviderError(`Provider response exceeds ${maxBytes} bytes`, {
        code: 'RESPONSE_TOO_LARGE',
        retryable: false
      });
    }
    return buffer.toString('utf8');
  }

  return {
    async fetchJson<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {
      const text = await readBounded(await request(url, options), options.maxBytes);
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new ProviderError(`Provider returned invalid JSON: ${url}`, {
          code: 'INVALID_JSON',
          retryable: false,
          cause: error
        });
      }
    },
    async fetchText(url: string, options: HttpRequestOptions = {}): Promise<string> {
      return readBounded(await request(url, options), options.maxBytes);
    }
  };
}
