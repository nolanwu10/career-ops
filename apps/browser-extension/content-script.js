(function startCareerOpsContentScript() {
  if (globalThis.__careerOpsContentScriptLoaded) return;
  globalThis.__careerOpsContentScriptLoaded = true;

  const api = globalThis.CareerOpsExtension;
  if (!api) return;
  const signals = api.pageSignals(document, location.href);

  let companionRoot;
  let companionShadow;
  let companionDismissed = false;
  let lastSubmissionIntent = 0;

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('button, input[type="submit"], [role="button"]');
    if (button && /\b(submit|send|complete).*(application)?\b/i.test(button.textContent || button.value || '')) {
      lastSubmissionIntent = Date.now();
      setTimeout(checkForSuccess, 1500);
    }
  }, true);

  const observer = new MutationObserver(() => {
    if (Date.now() - lastSubmissionIntent < 120000) checkForSuccess();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'AUTOFILL_PAGE') {
      autofillPage(message.showNotice !== false).then(sendResponse);
      return true;
    }
    if (message.type === 'SHOW_LOG_PROMPT') {
      showLogPrompt();
      sendResponse({ ok: true });
    }
    if (message.type === 'TOGGLE_COMPANION_PANEL') {
      toggleCompanionPanel();
      sendResponse({ ok: true });
    }
    if (message.type === 'PAGE_INFO') {
      sendResponse({ ok: true, signals: api.pageSignals(document, location.href), metadata: api.pageMetadata(document, location.href) });
    }
    return false;
  });

  if (signals.success) {
    send({ type: 'GET_CONTEXT' }).then((context) => {
      if (context.ok && context.settings?.showLogPrompt !== false) showLogPrompt();
    });
  }

  async function autofillPage(shouldShowNotice = true) {
    const metadata = api.pageMetadata(document, location.href);
    const context = await send({ type: 'GET_AUTOFILL_CONTEXT', payload: metadata });
    if (!context.ok) return context;
    const result = await api.fillPage(document, context);
    const documentResult = await fillDocumentFields(metadata, context.autofill?.documents || {});
    result.filled.push(...documentResult.filled);
    result.skipped.push(...documentResult.skipped);
    result.matchedCount += documentResult.matchedCount;
    result.scannedCount += documentResult.scannedCount;
    if (result.matchedCount === 0) {
      const error = 'No supported application form fields were found on this page.';
      if (shouldShowNotice) showNotice(error, true);
      return { ok: false, error, code: 'NO_MATCHING_FIELDS', ...result };
    }
    if (result.filled.length === 0) {
      const error = `${result.skipped.length} matching fields were found, but no saved values could be filled. Check extension preferences.`;
      if (shouldShowNotice) showNotice(error, true);
      return { ok: false, error, code: 'NO_SAVED_VALUES', ...result };
    }
    if (shouldShowNotice) showNotice(`Filled ${result.filled.length} fields. ${result.skipped.length} need review.`);
    return { ok: true, ...result };
  }

  async function fillDocumentFields(metadata, availableDocuments) {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    const filled = [];
    const skipped = [];
    let matchedCount = 0;
    const documentCache = new Map();

    for (const input of inputs) {
      const kind = api.classifyDocumentField(input);
      if (!kind) continue;
      matchedCount += 1;
      if (!availableDocuments[kind]?.available) {
        skipped.push({ key: kind, label: api.fieldDescriptor(input), reason: kind === 'resume'
          ? 'No supported primary resume file is available'
          : 'No cover letter is associated with this job' });
        continue;
      }
      let documentFile = documentCache.get(kind);
      if (!documentFile) {
        const result = await send({ type: 'GET_AUTOFILL_DOCUMENT', kind, payload: metadata });
        if (!result.ok) {
          skipped.push({ key: kind, label: api.fieldDescriptor(input), reason: result.error || 'Document could not be loaded' });
          continue;
        }
        documentFile = fileFromBase64(result);
        documentCache.set(kind, documentFile);
      }
      try {
        const transfer = new DataTransfer();
        transfer.items.add(documentFile);
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        filled.push({ key: kind, label: api.fieldDescriptor(input), fileName: documentFile.name });
      } catch {
        skipped.push({ key: kind, label: api.fieldDescriptor(input), reason: 'This site requires manual document selection' });
      }
    }
    return { filled, skipped, matchedCount, scannedCount: inputs.length };
  }

  function fileFromBase64(result) {
    const binary = atob(result.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], result.name, { type: result.mediaType });
  }

  function checkForSuccess() {
    if (api.pageSignals(document, location.href).success && companionRoot?.isConnected) showLogPrompt();
  }

  function toggleCompanionPanel() {
    if (companionRoot?.isConnected) {
      companionDismissed = true;
      companionRoot.remove();
    } else {
      companionDismissed = false;
      showCompanionPanel();
    }
  }

  function showCompanionPanel() {
    if (window !== window.top || companionRoot?.isConnected) return;
    const metadata = api.pageMetadata(document, location.href);
    companionRoot = document.createElement('div');
    companionRoot.id = 'career-ops-companion-panel';
    const shadow = companionRoot.attachShadow({ mode: 'closed' });
    companionShadow = shadow;
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed; top: 80px; right: 24px; z-index: 2147483647; width: 340px; max-width: calc(100vw - 32px);
          box-sizing: border-box; padding: 16px; border: 1px solid #cfd5df; border-radius: 12px;
          background: #fff; color: #17202a; box-shadow: 0 14px 42px rgba(23,32,42,.2);
          font: 14px/1.4 Arial, sans-serif;
        }
        .header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
        .brand { font-size:16px; font-weight:700; }
        .connection { font-size:12px; color:#687482; }
        .connection.connected { color:#176b54; }
        .connection.offline { color:#a4372a; }
        .close { width:28px; height:28px; padding:0; border:0; border-radius:6px; background:#edf0f4; color:#26313d;
          cursor:pointer; font:20px/1 Arial, sans-serif; }
        .job { min-height:38px; margin-bottom:12px; font-weight:600; }
        button.action { width:100%; margin-top:8px; padding:10px 12px; border:1px solid #b9c1cc; border-radius:6px;
          background:#fff; color:#17202a; cursor:pointer; font:600 14px Arial, sans-serif; }
        button.action.primary { border-color:#176b54; background:#176b54; color:#fff; }
        button.action.link { border:0; background:transparent; color:#176b54; }
        button:disabled { cursor:not-allowed; opacity:.5; }
        .status { min-height:18px; margin:10px 0 0; color:#596675; font-size:12px; }
        .log-form { margin-top:14px; padding-top:14px; border-top:1px solid #dce1e8; }
        .log-form[hidden] { display:none; }
        .log-title { display:block; margin-bottom:8px; font-size:15px; }
        .log-form label { display:block; margin-top:8px; color:#445; font-size:12px; }
        .log-form input { width:100%; box-sizing:border-box; margin-top:4px; padding:8px; border:1px solid #b8c0cc;
          border-radius:5px; background:#fff; color:#17202a; font:14px Arial, sans-serif; }
        .log-actions { display:flex; gap:8px; margin-top:12px; }
        .log-actions button { margin-top:0; }
        .log-save { flex:1; }
        .log-cancel { width:auto !important; background:#edf0f4 !important; border-color:#edf0f4 !important; }
        .log-status { min-height:17px; margin-top:8px; color:#596675; font-size:12px; }
        @media (max-width: 700px) { .panel { top:16px; right:16px; } }
      </style>
      <section class="panel" role="complementary" aria-label="Career Ops Companion">
        <div class="header">
          <span class="brand">Career Ops</span>
          <span class="connection">Checking...</span>
          <button class="close" aria-label="Close Career Ops">&times;</button>
        </div>
        <div class="job">${escapeHtml([metadata.role, metadata.company].filter(Boolean).join(' at ') || 'Application page detected')}</div>
        <button class="action primary autofill" disabled>Autofill application</button>
        <button class="action log" disabled>Log as applied</button>
        <button class="action link settings">Demographic preferences</button>
        <p class="status"></p>
        <section class="log-form" hidden aria-label="Log application to Career Ops">
          <strong class="log-title">Log this application as applied?</strong>
          <label>Company<input name="company" value="${escapeAttr(metadata.company)}"></label>
          <label>Role<input name="role" value="${escapeAttr(metadata.role)}"></label>
          <div class="log-actions">
            <button class="action primary log-save">Log applied</button>
            <button class="action log-cancel">Cancel</button>
          </div>
          <div class="log-status"></div>
        </section>
      </section>`;
    document.documentElement.appendChild(companionRoot);

    const connection = shadow.querySelector('.connection');
    const autofill = shadow.querySelector('.autofill');
    const log = shadow.querySelector('.log');
    const status = shadow.querySelector('.status');

    shadow.querySelector('.close').addEventListener('click', () => {
      companionDismissed = true;
      companionRoot.remove();
    });
    shadow.querySelector('.settings').addEventListener('click', () => send({ type: 'OPEN_OPTIONS' }));
    autofill.addEventListener('click', async () => {
      status.textContent = 'Scanning for supported form fields...';
      const result = await send({ type: 'AUTOFILL_CURRENT_TAB' });
      status.textContent = result.ok
        ? `${result.filled.length} filled; ${result.skipped.length} need review.`
        : result.error || 'Autofill could not run on this page.';
    });
    log.addEventListener('click', () => showLogPrompt());
    shadow.querySelector('.log-cancel').addEventListener('click', () => {
      shadow.querySelector('.log-form').hidden = true;
    });
    shadow.querySelector('.log-save').addEventListener('click', async () => {
      const logStatus = shadow.querySelector('.log-status');
      logStatus.textContent = 'Saving...';
      const result = await send({
        type: 'LOG_APPLIED',
        payload: {
          url: location.href,
          company: shadow.querySelector('[name="company"]').value,
          role: shadow.querySelector('[name="role"]').value,
          source: location.hostname,
          appliedAt: new Date().toISOString().slice(0, 10)
        }
      });
      logStatus.textContent = result.ok ? result.message : result.error;
      if (result.ok) {
        status.textContent = result.message;
        setTimeout(() => {
          if (companionRoot?.isConnected) shadow.querySelector('.log-form').hidden = true;
        }, 1800);
      }
    });

    send({ type: 'GET_CONTEXT' }).then((context) => {
      if (!companionRoot?.isConnected) return;
      connection.textContent = context.ok ? 'Connected' : 'App offline';
      connection.className = `connection ${context.ok ? 'connected' : 'offline'}`;
      autofill.disabled = !context.ok;
      log.disabled = !context.ok;
      if (!context.ok) status.textContent = context.error || 'Start the Career Ops app.';
    });
  }

  function showLogPrompt() {
    if (window !== window.top) {
      send({ type: 'SHOW_LOG_PANEL' });
      return;
    }
    if (!companionRoot?.isConnected) return;
    const form = companionShadow?.querySelector('.log-form');
    if (!form) return;
    const metadata = api.pageMetadata(document, location.href);
    companionShadow.querySelector('[name="company"]').value = metadata.company;
    companionShadow.querySelector('[name="role"]').value = metadata.role;
    companionShadow.querySelector('.log-status').textContent = '';
    form.hidden = false;
  }

  function showNotice(text, isError = false) {
    const notice = document.createElement('div');
    notice.textContent = text;
    Object.assign(notice.style, {
      position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647',
      background: isError ? '#9f2d20' : '#17202a', color: '#fff', padding: '10px 12px', borderRadius: '6px',
      font: '13px Arial, sans-serif', boxShadow: '0 8px 24px rgba(0,0,0,.2)'
    });
    document.documentElement.appendChild(notice);
    setTimeout(() => notice.remove(), 5000);
  }

  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function escapeAttr(value) {
    return String(value || '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  function escapeHtml(value) {
    return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }
})();
