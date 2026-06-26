const DEFAULT_API_BASE = 'http://localhost:3000';

chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id)) return;
  try {
    await ensurePageAccess(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_COMPANION_PANEL' }, { frameId: 0 });
  } catch (error) {
    console.warn('Could not open the Career Ops companion.', error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

async function handleMessage(message = {}, sender = {}) {
  if (message.type === 'GET_CONTEXT') return api('/api/extension/context');
  if (message.type === 'SAVE_SETTINGS') return api('/api/extension/settings', message.payload);
  if (message.type === 'GET_AUTOFILL_CONTEXT') return api('/api/extension/autofill-context', message.payload);
  if (message.type === 'GET_AUTOFILL_DOCUMENT') return apiDocument(message.kind, message.payload);
  if (message.type === 'LOG_APPLIED') return api('/api/extension/log-applied', message.payload);
  if (message.type === 'ENSURE_PAGE_ACCESS') return ensurePageAccess(message.tabId);
  if (message.type === 'AUTOFILL_TAB') return autofillTab(message.tabId);
  if (message.type === 'AUTOFILL_CURRENT_TAB') return autofillTab(sender.tab?.id);
  if (message.type === 'SHOW_LOG_PANEL') {
    if (!Number.isInteger(sender.tab?.id)) throw new Error('No active browser tab was found.');
    return chrome.tabs.sendMessage(sender.tab.id, { type: 'SHOW_LOG_PROMPT' }, { frameId: 0 });
  }
  if (message.type === 'OPEN_OPTIONS') {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  throw new Error(`Unknown Career Ops message: ${message.type}`);
}

async function ensurePageAccess(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('No active browser tab was found.');
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['shared.js', 'content-script.js']
    });
    return { ok: true };
  } catch (error) {
    throw new Error(pageAccessError(error));
  }
}

async function autofillTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('No active browser tab was found.');
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const results = await Promise.all((frames || []).map(async ({ frameId }) => {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'AUTOFILL_PAGE', showNotice: false }, { frameId });
    } catch {
      return null;
    }
  }));
  const accessible = results.filter(Boolean);
  if (!accessible.length) throw new Error('Chrome could not access any frames on this page.');

  const filled = accessible.flatMap((result) => result.filled || []);
  const skipped = accessible.flatMap((result) => result.skipped || []);
  const matchedCount = accessible.reduce((sum, result) => sum + (result.matchedCount || 0), 0);
  const scannedCount = accessible.reduce((sum, result) => sum + (result.scannedCount || 0), 0);
  if (matchedCount === 0) {
    return {
      ok: false,
      code: 'NO_MATCHING_FIELDS',
      error: 'No supported application form fields were found on this page.',
      filled,
      skipped,
      matchedCount,
      scannedCount
    };
  }
  if (filled.length === 0) {
    return {
      ok: false,
      code: 'NO_SAVED_VALUES',
      error: `${skipped.length} matching fields were found, but no saved values could be filled. Check extension preferences.`,
      filled,
      skipped,
      matchedCount,
      scannedCount
    };
  }
  return { ok: true, filled, skipped, matchedCount, scannedCount };
}

function pageAccessError(error) {
  const message = error?.message || String(error);
  if (/Cannot access contents of url|The extensions gallery cannot be scripted|Missing host permission/i.test(message)) {
    return 'Chrome does not allow extensions to run on this page. Open a normal website and try again.';
  }
  return `Could not access this page: ${message}`;
}

async function api(path, payload) {
  const response = await fetch(`${await apiBase()}${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Career Ops returned HTTP ${response.status}`);
  return data;
}

async function apiDocument(kind, payload) {
  if (!['resume', 'coverLetter'].includes(kind)) throw new Error('Unsupported application document type.');
  const response = await fetch(`${await apiBase()}/api/extension/document/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `Career Ops returned HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    ok: true,
    name: decodeURIComponent(response.headers.get('X-Career-Ops-Filename') || `${kind}.pdf`),
    mediaType: response.headers.get('Content-Type') || 'application/octet-stream',
    base64: bytesToBase64(bytes)
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function apiBase() {
  const stored = await chrome.storage.local.get('apiBaseUrl');
  return String(stored.apiBaseUrl || DEFAULT_API_BASE).replace(/\/$/, '');
}
