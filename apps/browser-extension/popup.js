const connection = document.querySelector('#connection');
const job = document.querySelector('#job');
const status = document.querySelector('#status');
const autofill = document.querySelector('#autofill');
const log = document.querySelector('#log');
let activeTabId;
let refreshSequence = 0;

autofill.addEventListener('click', autofillActiveTab);
log.addEventListener('click', logActiveTab);
document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && (changeInfo.status === 'complete' || changeInfo.url)) refresh();
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) refresh();
});

refresh();

async function refresh() {
  const sequence = ++refreshSequence;
  setControlsEnabled(false);
  status.textContent = '';
  const context = await chrome.runtime.sendMessage({ type: 'GET_CONTEXT' });
  if (sequence !== refreshSequence) return;
  connection.textContent = context.ok ? 'Connected' : 'App offline';
  connection.className = context.ok ? 'connected' : 'offline';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (sequence !== refreshSequence) return;
  activeTabId = tab?.id;
  if (!activeTabId) {
    job.textContent = 'Open a page containing an application form.';
    return;
  }
  const info = await getPageInfo(activeTabId);
  if (sequence !== refreshSequence) return;
  if (!info?.ok) {
    job.textContent = 'This page cannot be scanned.';
    status.textContent = info?.error || 'Chrome does not allow extensions to run on this page.';
    return;
  }
  job.textContent = [info.metadata.role, info.metadata.company].filter(Boolean).join(' at ')
    || (info.signals.isApplicationPage ? 'Application page detected' : 'Ready to scan this page');
  setControlsEnabled(context.ok);
}

async function autofillActiveTab() {
  if (!activeTabId) return;
  const tabId = activeTabId;
  status.textContent = 'Scanning for supported form fields...';
  const result = await chrome.runtime.sendMessage({ type: 'AUTOFILL_TAB', tabId }).catch((error) => ({
    ok: false,
    error: error.message || String(error)
  }));
  if (tabId !== activeTabId) return;
  status.textContent = result.ok
    ? `${result.filled.length} filled; ${result.skipped.length} need review.`
    : result.error || 'Autofill could not run on this page.';
}

async function logActiveTab() {
  if (!activeTabId) return;
  const result = await chrome.tabs.sendMessage(activeTabId, { type: 'SHOW_LOG_PROMPT' }).catch((error) => ({
    ok: false,
    error: error.message || String(error)
  }));
  if (!result?.ok) status.textContent = result?.error || 'Could not open the application log prompt.';
}

function setControlsEnabled(enabled) {
  autofill.disabled = !enabled;
  log.disabled = !enabled;
}

async function getPageInfo(tabId) {
  const initial = await chrome.tabs.sendMessage(tabId, { type: 'PAGE_INFO' }).catch(() => null);
  if (initial?.ok) return initial;

  const access = await chrome.runtime.sendMessage({ type: 'ENSURE_PAGE_ACCESS', tabId }).catch((error) => ({
    ok: false,
    error: error.message || String(error)
  }));
  if (!access?.ok) return access;

  return chrome.tabs.sendMessage(tabId, { type: 'PAGE_INFO' }).catch((error) => ({
    ok: false,
    error: error.message || String(error)
  }));
}
