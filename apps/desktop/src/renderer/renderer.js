let state = {
  data: null,
  selectedNumber: null,
  view: 'dashboard',
  filter: 'all',
  sort: 'score',
  query: '',
  dashboardMode: localStorage.getItem('dashboardMode') === 'list' ? 'list' : 'board',
  pendingSelection: new Set(),
  availability: new Map(),
  bulkQueue: {
    running: false,
    message: 'Idle',
    items: new Map()
  },
  coverLetter: null,
  coverLetterJobNumber: null,
  viewedResumeId: null,
  resumeBuilderVariant: null,
  resumeBuilderMode: 'preview',
  resumePreviewObjectUrl: '',
  resumePreviewRequest: 0,
  resumePdfEditorRequest: 0,
  resumePdfEdits: {},
  resumeTailorReview: null,
  pdfJs: null,
  knowledgeQuery: '',
  discoveryQuery: '',
  discoverySource: 'all',
  discoveryLocationCountry: 'all',
  discoveryLocationAllInCountry: true,
  discoveryLocationCity: '',
  discoveryDateRange: 'all',
  discoveryFit: 'relevant',
  discoverySort: 'recommended',
  editingKnowledgeFactId: null,
  editingKnowledgeRecordId: null,
  draggedNumber: null,
  sidebarCollapsed: localStorage.getItem('sidebarCollapsed') === 'true',
  setupStep: 'resume',
  setupEditing: false,
  advancedMode: localStorage.getItem('advancedMode') === 'true'
  ,
  cloud: { items: [], status: null, offline: true }
};

let activeAiTasks = 0;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function runAiTask(label, task) {
  const overlay = $('#aiGenerationOverlay');
  activeAiTasks += 1;
  $('#aiGenerationTitle').textContent = label;
  overlay.hidden = false;
  document.body.setAttribute('aria-busy', 'true');
  try {
    return await task();
  } finally {
    activeAiTasks = Math.max(0, activeAiTasks - 1);
    if (activeAiTasks === 0) {
      overlay.hidden = true;
      document.body.removeAttribute('aria-busy');
    }
  }
}

let bgTaskCount = 0;

function showBgTask(label) {
  bgTaskCount += 1;
  $('#bgTaskLabel').textContent = label;
  $('#bgTaskPill').hidden = false;
}

function updateBgTask(label) {
  if (!$('#bgTaskPill').hidden) $('#bgTaskLabel').textContent = label;
}

function hideBgTask() {
  bgTaskCount = Math.max(0, bgTaskCount - 1);
  if (bgTaskCount === 0) $('#bgTaskPill').hidden = true;
}

document.addEventListener('DOMContentLoaded', async () => {
  wireEvents();
  if (window.careerOps?.onBulkQueueProgress) {
    window.careerOps.onBulkQueueProgress(handleBulkQueueProgress);
  }
  if (window.careerOps?.load) {
    await load();
  } else {
    setStatus('Electron preload unavailable. Static preview mode.');
  }
});

function wireEvents() {
  applySidebarState();
  $('#sidebarToggleBtn').addEventListener('click', toggleSidebar);
  $$('.nav-item').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });
  $('#refreshBtn').addEventListener('click', load);
  $('#discoverySourceForm').addEventListener('submit', importDiscoverySource);
  $('#refreshDiscoveryBtn').addEventListener('click', refreshDiscovery);
  $('#toggleAddSourceBtn').addEventListener('click', toggleAddSource);
  $('#toggleListsCollapseBtn').addEventListener('click', toggleListsCollapsed);
  applyListsCollapsed();
  $('#closeDiscoveryImportBtn').addEventListener('click', closeAddSource);
  $('#discoverySearchInput').addEventListener('input', (event) => {
    state.discoveryQuery = event.target.value.toLowerCase().trim();
    renderPending();
  });
  $('#discoverySourceFilter').addEventListener('change', (event) => {
    state.discoverySource = event.target.value;
    renderPending();
  });
  wireLocationPopover();
  $('#discoveryDateFilter').addEventListener('change', (event) => {
    state.discoveryDateRange = event.target.value;
    renderPending();
  });
  $('#discoveryFitFilter').addEventListener('change', (event) => {
    state.discoveryFit = event.target.value;
    renderPending();
  });
  $('#discoverySortSelect').addEventListener('change', (event) => {
    state.discoverySort = event.target.value;
    renderPending();
  });
  $('#discardPendingBtn').addEventListener('click', discardSelectedPending);
  $('#evaluateSelectedBtn').addEventListener('click', () => evaluatePending(selectedPendingUrls()));
  $('#syncCloudBtn').addEventListener('click', syncCloudFeed);
  $('#cloudLoginBtn').addEventListener('click', loginCloud);
  $('#addJobBtn').addEventListener('click', openAddJobDialog);
  $('#dashboardAddJobBtn').addEventListener('click', openAddJobDialog);
  $('#addJobForm').addEventListener('submit', addJobLink);
  $('#cancelAddJobBtn').addEventListener('click', closeAddJobDialog);
  $('#cancelAddJobFooterBtn').addEventListener('click', closeAddJobDialog);
  $('#chooseRootBtn').addEventListener('click', chooseRoot);
  $('#rootWarningButton').addEventListener('click', chooseRoot);
  $('#drawerCloseBtn').addEventListener('click', closeDrawer);
  $('#reportOverlayCloseBtn').addEventListener('click', closeReportOverlay);
  wireArchiveDropZone();
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if ($('#reportOverlay').classList.contains('open')) closeReportOverlay();
      else closeDrawer();
    }
  });
  $('#searchInput').addEventListener('input', (event) => {
    state.query = event.target.value.toLowerCase();
    renderDashboardContent();
  });
  $('#dashboardBoardViewBtn').addEventListener('click', () => setDashboardMode('board'));
  $('#dashboardListViewBtn').addEventListener('click', () => setDashboardMode('list'));
  $('#statusFilter').addEventListener('change', (event) => {
    state.filter = event.target.value;
    renderDashboardContent();
  });
  $('#sortSelect').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderDashboardContent();
  });
  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#uploadResumeBtn').addEventListener('click', uploadResume);
  $('#addResumeBtn').addEventListener('click', uploadResume);
  $('#addKnowledgeFactBtn').addEventListener('click', openKnowledgeChatDialog);
  $('#manualKnowledgeFactBtn').addEventListener('click', openKnowledgeFactDialog);
  $('#uploadKnowledgeDocumentBtn').addEventListener('click', uploadKnowledgeDocument);
  $('#rebuildKnowledgeBtn').addEventListener('click', rebuildKnowledge);
  $('#clearKnowledgeBtn').addEventListener('click', clearKnowledge);
  $('#closeKnowledgeFactDialogBtn').addEventListener('click', closeKnowledgeFactDialog);
  $('#cancelKnowledgeFactBtn').addEventListener('click', closeKnowledgeFactDialog);
  $('#knowledgeFactForm').addEventListener('submit', addKnowledgeFact);
  $('#knowledgeChatForm').addEventListener('submit', sendKnowledgeChat);
  $('#closeKnowledgeChatDialogBtn').addEventListener('click', closeKnowledgeChatDialog);
  $('#cancelKnowledgeChatBtn').addEventListener('click', closeKnowledgeChatDialog);
  $('#knowledgeRecordForm').addEventListener('submit', saveKnowledgeRecord);
  $('#closeKnowledgeRecordDialogBtn').addEventListener('click', closeKnowledgeRecordDialog);
  $('#cancelKnowledgeRecordBtn').addEventListener('click', closeKnowledgeRecordDialog);
  $('#closeResumeViewerBtn').addEventListener('click', closeResumeViewer);
  $('#makeViewedResumePrimaryBtn').addEventListener('click', () => state.viewedResumeId && setPrimaryResume(state.viewedResumeId));
  $('#createMasterResumeBtn').addEventListener('click', () => openResumeBuilderDialog('master'));
  $('#createTailoredResumeBtn').addEventListener('click', () => openResumeBuilderDialog('tailored'));
  $('#closeResumeBuilderDialogBtn').addEventListener('click', closeResumeBuilderDialog);
  $('#cancelResumeBuilderBtn').addEventListener('click', closeResumeBuilderDialog);
  $('#resumeBuilderForm').addEventListener('submit', submitResumeBuilder);
  $('#resumeBuilderJob').addEventListener('change', updateTailoredResumeNameFromJob);
  $('#createAiTailoredResumeBtn').addEventListener('click', createAiTailoredResumeFromReview);
  $('#saveResumeVariantBtn').addEventListener('click', saveResumeBuilderVariant);
  $('#deleteResumeVariantBtn').addEventListener('click', deleteResumeBuilderVariant);
  $('#exportResumeDocxBtn').addEventListener('click', () => exportResumeBuilderVariant('docx'));
  $('#exportResumePdfBtn').addEventListener('click', () => exportResumeBuilderVariant('pdf'));
  $('#openResumeDocxBtn').addEventListener('click', openResumeBuilderSource);
  $('#resumePreviewModeBtn').addEventListener('click', () => setResumeBuilderMode('preview'));
  $('#resumeEditModeBtn').addEventListener('click', () => setResumeBuilderMode('edit'));
  $('#saveAiSettingsBtn').addEventListener('click', saveAiSettings);
  $('#testAiBtn').addEventListener('click', testAi);
  $('#testSetupBtn').addEventListener('click', testSetup);
  $('#closeSetupEditorBtn').addEventListener('click', closeSetupEditor);
  $('#testExtensionBtn').addEventListener('click', testExtension);
  $('#runSampleRecommendationBtn').addEventListener('click', runSampleRecommendation);
  $('#finishSetupBtn').addEventListener('click', finishSetup);
  $('#savePrivacyBtn').addEventListener('click', saveGuidedSetup);
  $('#toggleArchivedJobsBtn').addEventListener('click', toggleArchivedJobs);
  $('#advancedModeToggle').addEventListener('change', toggleAdvancedMode);
  $$('.setup-step').forEach((button) => button.addEventListener('click', () => showSetupStep(button.dataset.setupStep)));
  $$('.setup-next').forEach((button) => button.addEventListener('click', () => continueSetup(button.dataset.nextStep)));
  $$('.jump-to-step').forEach((button) => button.addEventListener('click', () => openSetupEditor(button.dataset.step)));
  $('#chooseCoverLetterFolderBtn').addEventListener('click', chooseCoverLetterFolder);
  $('#coverLetterSearch').addEventListener('input', renderCoverLetter);
  $('#saveCoverLetterBtn').addEventListener('click', saveCoverLetter);
  $('#openCoverLetterBtn').addEventListener('click', () => state.coverLetter?.path && window.careerOps.openPath(state.coverLetter.path));
  $('#generateSelectedCoverLetterBtn').addEventListener('click', () => {
    const row = state.data.applications.find((item) => item.number === state.coverLetterJobNumber);
    if (row) createCoverLetter(row);
  });
  $('#openResumeSourceBtn').addEventListener('click', () => {
    const sourcePath = state.data.settings.resume?.sourcePath;
    if (sourcePath) window.careerOps.openPath(sourcePath);
  });
}

async function load() {
  setStatus('Loading dashboard...');
  try {
    applyDashboardData(await window.careerOps.load(), { render: true });
  } catch (error) {
    setStatus(`Load failed: ${error.message}`);
    throw error;
  }
  setStatus(state.data.diagnostics.valid ? 'Ready.' : 'Application data is not initialized.');
  syncCloudFeed({ quiet: true });
}

async function importDiscoverySource(event) {
  event.preventDefault();
  const input = $('#discoverySourceUrl');
  const button = $('#importDiscoverySourceBtn');
  const status = $('#discoveryImportStatus');
  const url = input.value.trim();
  if (!url) return;

  button.disabled = true;
  status.textContent = '';
  status.hidden = false;
  try {
    const result = await runAiTask('Importing jobs…', () => window.careerOps.importDiscoverySource({ url }));
    applyDashboardData(result.dashboard, { render: true });
    input.value = '';
    closeAddSource();
    setStatus(result.message);
  } catch (error) {
    status.textContent = error.message;
    setStatus(`Import failed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Import';
  }
}

async function refreshDiscovery() {
  const progress = $('#discoveryRefreshProgress');
  if (progress) { progress.textContent = 'Starting scan...'; progress.hidden = false; }
  try {
    const result = await window.careerOps.refreshDiscovery();
    applyDashboardData(result.dashboard, { render: true });
    setStatus(result.message);
  } catch (error) {
    setStatus(`Discovery refresh failed: ${error.message}`);
  } finally {
    if (progress) { progress.hidden = true; progress.textContent = ''; }
  }
}

function applyListsCollapsed() {
  const collapsed = localStorage.getItem('jobListsCollapsed') === 'true';
  const bar = $('#discoveryListsBar');
  const btn = $('#toggleListsCollapseBtn');
  if (!bar || !btn) return;
  bar.classList.toggle('lists-collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
}

function toggleListsCollapsed() {
  const collapsed = localStorage.getItem('jobListsCollapsed') === 'true';
  localStorage.setItem('jobListsCollapsed', String(!collapsed));
  if (!collapsed) closeAddSource();
  applyListsCollapsed();
}

function toggleAddSource() {
  const form = $('#discoverySourceForm');
  const btn = $('#toggleAddSourceBtn');
  const willOpen = form.hidden;
  form.hidden = !willOpen;
  btn.setAttribute('aria-expanded', String(willOpen));
  btn.textContent = willOpen ? '✕' : '+';
  if (willOpen) $('#discoverySourceUrl').focus();
}

function closeAddSource() {
  const form = $('#discoverySourceForm');
  const btn = $('#toggleAddSourceBtn');
  form.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = '+';
  $('#discoveryImportStatus').textContent = '';
}

function applyDashboardData(dashboard, options = {}) {
  if (!dashboard) return;
  const { render = false } = options;
  state.data = dashboard;

  const pendingUrls = new Set((dashboard.pendingJobs || []).map((job) => job.url));
  state.pendingSelection = new Set([...state.pendingSelection].filter((url) => pendingUrls.has(url)));

  const selectedCoverLetterPath = state.coverLetter?.relativePath;
  if (selectedCoverLetterPath) {
    state.coverLetter = (dashboard.coverLetters || []).find((letter) => letter.relativePath === selectedCoverLetterPath) || null;
  }

  if ((!state.selectedNumber || !dashboard.applications.some((row) => row.number === state.selectedNumber)) && dashboard.applications.length > 0) {
    state.selectedNumber = dashboard.applications[0].number;
  }
  if (dashboard.applications.length === 0) {
    state.selectedNumber = null;
  }

  if (render) {
    $('#workspacePath').textContent = dashboard.diagnostics.valid ? 'Local data connected' : 'Setup required';
    $('#chooseRootBtn').hidden = dashboard.diagnostics.storage === 'sqlite';
    renderRootWarning();
    renderAll();
  }
}

function renderAll() {
  renderFilters();
  renderDashboardContent();
  renderPending();
  renderBulkQueue();
  renderArchivedJobs();
  renderSettings();
  renderKnowledgeCenter();
  renderCoverLetter();
  renderResumeBuilder();
  renderStorageCapabilities();
  renderCloudRecommendations();
  renderDiscoverySources();
}

let editingSourceUrl = null;

function renderDiscoverySources() {
  const container = $('#discoverySourcesList');
  if (!container) return;
  const sources = state.data?.discoverySources || [];

  if (sources.length === 0) {
    container.innerHTML = '<span class="discovery-lists-empty">No lists yet</span>';
    return;
  }

  container.innerHTML = sources.map((source) => {
    const isEditing = editingSourceUrl === source.url;
    const hasError = !!source.lastError;
    if (isEditing) {
      return `
        <form class="source-chip-edit-form" data-url="${escapeAttr(source.url)}">
          <input class="source-chip-edit-input" type="text" value="${escapeAttr(source.label || '')}" placeholder="Display name" maxlength="120" required />
          <button class="button primary small" type="submit">Save</button>
          <button class="button secondary small source-chip-cancel" type="button">✕</button>
        </form>
      `;
    }
    return `
      <div class="source-chip${hasError ? ' has-error' : ''}" data-url="${escapeAttr(source.url)}" title="${escapeAttr(source.url)}">
        <span class="source-chip-label">${escapeHtml(source.label || source.url)}</span>
        <span class="source-chip-actions">
          <button class="source-chip-btn discovery-source-open" data-url="${escapeAttr(source.url)}" title="Open">↗</button>
          <button class="source-chip-btn discovery-source-edit" data-url="${escapeAttr(source.url)}" data-label="${escapeAttr(source.label || '')}" title="Edit name">✎</button>
          <button class="source-chip-btn discovery-source-delete" data-url="${escapeAttr(source.url)}" data-label="${escapeAttr(source.label || source.url)}" title="Remove">✕</button>
        </span>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.discovery-source-open').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); window.careerOps.openExternal(btn.dataset.url); });
  });

  container.querySelectorAll('.discovery-source-edit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      editingSourceUrl = btn.dataset.url;
      renderDiscoverySources();
      const input = container.querySelector('.source-chip-edit-input');
      if (input) { input.focus(); input.select(); }
    });
  });

  container.querySelectorAll('.source-chip-cancel').forEach((btn) => {
    btn.addEventListener('click', () => { editingSourceUrl = null; renderDiscoverySources(); });
  });

  container.querySelectorAll('.source-chip-edit-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const url = form.dataset.url;
      const label = form.querySelector('.source-chip-edit-input')?.value.trim();
      if (!label) return;
      const saveBtn = form.querySelector('[type="submit"]');
      saveBtn.disabled = true;
      try {
        const result = await window.careerOps.updateDiscoverySource({ url, label });
        editingSourceUrl = null;
        applyDashboardData(result.dashboard, { render: true });
        setStatus(`Updated "${label}".`);
      } catch (error) {
        setStatus(`Update failed: ${error.message}`);
        saveBtn.disabled = false;
      }
    });
  });

  container.querySelectorAll('.discovery-source-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { url, label } = btn.dataset;
      if (!confirm(`Remove "${label}" from connected job lists?`)) return;
      btn.disabled = true;
      try {
        const result = await window.careerOps.deleteDiscoverySource({ url });
        if (editingSourceUrl === url) editingSourceUrl = null;
        applyDashboardData(result.dashboard, { render: true });
        setStatus(`Removed "${label}".`);
      } catch (error) {
        setStatus(`Delete failed: ${error.message}`);
        btn.disabled = false;
      }
    });
  });
}

function relativeTime(isoString) {
  const ms = Date.now() - new Date(isoString).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function syncCloudFeed(options = {}) {
  if (!options.quiet) setStatus('Syncing AWS recommendations...');
  try {
    state.cloud = await window.careerOps.syncCloudFeed();
    renderCloudRecommendations();
    if (!options.quiet) setStatus(state.cloud.offline ? 'Using cached AWS recommendations.' : 'AWS recommendations synchronized.');
  } catch (error) {
    state.cloud.status = await window.careerOps.cloudStatus();
    state.cloud.offline = true;
    renderCloudRecommendations();
    if (!options.quiet) setStatus(`AWS sync failed: ${error.message}`);
  }
}

function renderCloudRecommendations() {
  const container = $('#cloudRecommendationList');
  if (!container) return;
  const status = state.cloud.status || {};
  $('#cloudSyncStatus').textContent = status.configured
    ? `${state.cloud.offline ? 'Cached' : 'Connected'} · ${state.cloud.items.length} jobs${status.syncedAt ? ` · ${formatDateTime(status.syncedAt)}` : ''}`
    : 'Set CAREER_OPS_API_URL and CAREER_OPS_ACCESS_TOKEN';
  $('#cloudLoginBtn').textContent = status.authenticated ? 'Signed in' : 'Sign in';
  $('#cloudLoginBtn').disabled = Boolean(status.authenticated);
  const groups = [
    { disposition: 'recommended', label: 'Recommended' },
    { disposition: 'needs_review', label: 'Needs review' }
  ].map((group) => ({
    ...group,
    items: state.cloud.items.filter(({ recommendation }) =>
      (recommendation.matchDisposition || 'recommended') === group.disposition)
  })).filter((group) => group.items.length);
  container.innerHTML = groups.length
    ? groups.map((group) => `
      <section class="cloud-recommendation-group">
        <div class="panel-header"><h3>${escapeHtml(group.label)}</h3><span>${group.items.length}</span></div>
        ${group.items.map(({ recommendation, job }) => `
      <article class="cloud-recommendation" data-id="${escapeAttr(recommendation.recommendationId)}">
        <div class="cloud-score">${recommendation.fitScore}</div>
        <div class="cloud-recommendation-body">
          <span class="eyebrow">${escapeHtml(recommendation.matchDisposition === 'needs_review' ? 'Needs review' : `${recommendation.scoreBand} match`)}</span>
          <h3>${escapeHtml(job.title)}</h3>
          <p>${escapeHtml(job.company)} · ${escapeHtml(job.locations.join(', ') || job.workMode)}</p>
          <div class="cloud-reasons">${recommendation.strongMatches.slice(0, 3).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
          ${recommendation.reviewReasons?.length ? `<p class="cloud-concern">${escapeHtml(recommendation.reviewReasons[0])}</p>` : ''}
          ${recommendation.concerns.length ? `<p class="cloud-concern">${escapeHtml(recommendation.concerns[0])}</p>` : ''}
          <div class="inline-actions">
            <button class="button secondary small cloud-action" data-action="saved">Save</button>
            <button class="button secondary small cloud-action" data-action="dismissed">Dismiss</button>
            <button class="button secondary small cloud-action" data-action="not_interested">Not interested</button>
            <button class="button primary small cloud-action" data-action="applied">Applied</button>
            <button class="button secondary small cloud-open">Open job</button>
          </div>
        </div>
      </article>
        `).join('')}
      </section>
    `).join('')
    : '<div class="empty-state">No hosted recommendations are cached yet.</div>';
  $$('.cloud-recommendation').forEach((card) => {
    const item = state.cloud.items.find(({ recommendation }) => recommendation.recommendationId === card.dataset.id);
    card.querySelector('.cloud-open').addEventListener('click', () => window.careerOps.openExternal(item.job.canonicalUrl));
    card.querySelectorAll('.cloud-action').forEach((button) => button.addEventListener('click', async () => {
      state.cloud = await window.careerOps.cloudFeedback({
        recommendationId: item.recommendation.recommendationId,
        jobKey: item.recommendation.jobKey,
        action: button.dataset.action
      });
      renderCloudRecommendations();
    }));
  });
}

async function loginCloud() {
  const result = await window.careerOps.cloudLogin();
  await window.careerOps.openExternal(result.url);
  setStatus('Complete sign-in in your browser, then click Sync now.');
}

function renderStorageCapabilities() {
  // Discovery scanning and evaluation controls are intentionally not exposed
  // in the simplified list-first interface.
}

function renderRootWarning() {
  const warning = $('#rootWarning');
  if (state.data.diagnostics.valid) {
    warning.hidden = true;
    return;
  }
  const missing = Object.entries(state.data.diagnostics.checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
    .join(', ');
  $('#rootWarningText').textContent = `The selected data source is missing: ${missing || 'required files'}.`;
  warning.hidden = false;
}

function setView(view) {
  if (state.view === 'dashboard' && view !== 'dashboard') {
    closeDrawer();
    closeReportOverlay();
  }
  state.view = view;
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `${view}View`));
  $('#pageTitle').textContent = viewTitle(view);
  $('#dashboardHeaderActions').hidden = view !== 'dashboard';
  if (view === 'settings') showSetupStep(state.setupStep);
}

function renderFilters() {
  const statuses = ['all', ...state.data.states.filter((status) => !['Rejected', 'Discarded', 'SKIP'].includes(status))];
  if (!statuses.includes(state.filter)) state.filter = 'all';
  $('#statusFilter').innerHTML = statuses
    .map((status) => `<option value="${escapeAttr(status)}">${escapeHtml(status === 'all' ? 'All statuses' : status)}</option>`)
    .join('');
  $('#statusFilter').value = state.filter;
}

function filteredJobs() {
  const query = state.query;
  let rows = state.data.applications.filter((row) => {
    const statusMatch = state.filter === 'all' || normalizeStatus(row.status) === normalizeStatus(state.filter);
    const queryText = `${row.company} ${row.role} ${row.notes}`.toLowerCase();
    return statusMatch && (!query || queryText.includes(query));
  });
  rows = [...rows].sort((a, b) => {
    if (state.sort === 'date') return String(b.date).localeCompare(String(a.date));
    if (state.sort === 'company') return String(a.company).localeCompare(String(b.company));
    if (state.sort === 'status') return statusRank(a.status) - statusRank(b.status);
    return Number(b.score) - Number(a.score);
  });
  return rows;
}

function renderCRMBoard() {
  const rows = filteredJobs().filter((row) => (row.crmStatus || mapCareerOpsStatusToCRM(row.status)) !== 'rejected_archived');
  $('#shownCount').textContent = `${rows.length} applications`;
  const columns = activeCrmColumns();
  const grouped = Object.fromEntries(columns.map((column) => [column.id, []]));
  for (const row of rows) {
    const crmStatus = row.crmStatus || mapCareerOpsStatusToCRM(row.status);
    if (!grouped[crmStatus]) grouped[crmStatus] = [];
    grouped[crmStatus].push(row);
  }
  $('#crmBoard').innerHTML = columns.map((column) => renderCRMColumn(column, grouped[column.id] || [])).join('');
  wireCRMBoard();
}

function setDashboardMode(mode) {
  state.dashboardMode = mode === 'list' ? 'list' : 'board';
  localStorage.setItem('dashboardMode', state.dashboardMode);
  renderDashboardContent();
}

function renderDashboardContent() {
  const listMode = state.dashboardMode === 'list';
  $('#dashboardBoardViewBtn').classList.toggle('active', !listMode);
  $('#dashboardListViewBtn').classList.toggle('active', listMode);
  $('.crm-panel').hidden = listMode;
  $('#needToApplyListPanel').hidden = !listMode;
  if (listMode) renderNeedToApplyList();
  else renderCRMBoard();
}

function renderNeedToApplyList() {
  const rows = filteredJobs().filter((row) =>
    (row.crmStatus || mapCareerOpsStatusToCRM(row.status)) === 'need_to_apply');
  $('#shownCount').textContent = `${rows.length} applications`;
  $('#needToApplyListCount').textContent = `${rows.length} job${rows.length === 1 ? '' : 's'}`;
  $('#needToApplyList').innerHTML = rows.length
    ? rows.map(renderNeedToApplyListRow).join('')
    : '<div class="empty-state">No Need to Apply jobs match your search.</div>';
  $$('.need-list-action').forEach((button) => {
    button.addEventListener('click', () => handleNeedListAction(button));
  });
}

function renderNeedToApplyListRow(row) {
  return `
    <article class="need-list-row" data-number="${row.number}">
      <div class="need-list-main">
        <div>
          <span>${escapeHtml(row.company)}</span>
          <strong>${escapeHtml(row.role)}</strong>
        </div>
        <div class="need-list-meta">
          <span class="score ${scoreClass(row.score)}">${formatScore(row)}</span>
          ${(row.location || row.workMode) ? `<em>${escapeHtml(row.location || row.workMode)}</em>` : ''}
        </div>
      </div>
      <div class="need-list-actions">
        <button class="button primary small need-list-action" data-action="posting" data-number="${row.number}" ${row.jobUrl ? '' : 'disabled'}>Open job</button>
        <button class="button secondary small need-list-action" data-action="cover" data-number="${row.number}">
          ${row.coverLetterPath ? 'Open cover letter' : 'Generate cover letter'}
        </button>
        <button class="button secondary small need-list-action" data-action="report" data-number="${row.number}">
          ${row.reportPath ? 'View report' : 'Generate report'}
        </button>
        <button class="button secondary small need-list-action" data-action="details" data-number="${row.number}">Details</button>
      </div>
    </article>
  `;
}

async function handleNeedListAction(button) {
  const row = state.data.applications.find((item) => item.number === Number(button.dataset.number));
  if (!row) return;
  const action = button.dataset.action;
  if (action === 'posting') {
    if (row.jobUrl) window.careerOps.openExternal(row.jobUrl);
    return;
  }
  if (action === 'cover') {
    if (row.coverLetterPath) {
      state.coverLetterJobNumber = row.number;
      setView('coverLetter');
      renderCoverLetter();
    } else {
      await createCoverLetter(row);
    }
    return;
  }
  if (action === 'report') {
    if (row.reportPath) {
      renderReport(row);
      return;
    }
    button.disabled = true;
    button.textContent = 'Generating…';
    try {
      const result = await runAiTask(
        `Generating report for ${row.company}…`,
        () => window.careerOps.generateApplicationReport({ number: row.number })
      );
      applyDashboardData(result.dashboard, { render: true });
      const updated = state.data.applications.find((item) => item.number === row.number);
      if (updated) renderReport(updated);
    } catch (error) {
      setStatus(`Report generation failed: ${error.message}`);
      renderNeedToApplyList();
    }
    return;
  }
  openDrawer(row.number);
}

function activeCrmColumns() {
  return (state.data.crmColumns || []).filter((column) => column.id !== 'rejected_archived');
}

function renderCRMColumn(column, cards) {
  return `
    <section class="crm-column" data-crm-status="${escapeAttr(column.id)}">
      <header class="crm-column-header"><strong>${escapeHtml(column.label)}</strong><span>${cards.length}</span></header>
      <div class="crm-card-list" data-crm-status="${escapeAttr(column.id)}">
        ${cards.length ? cards.map(renderCRMCard).join('') : '<div class="crm-empty">No applications</div>'}
      </div>
    </section>
  `;
}

function renderCRMCard(row) {
  const locationText = row.workMode || row.location || '';
  return `
    <article class="crm-card" draggable="true" data-number="${row.number}">
      <div class="crm-card-top"><strong>${escapeHtml(row.company)}</strong><span class="score ${scoreClass(row.score)}">${formatScore(row)}</span></div>
      <p>${escapeHtml(row.role)}</p>
      ${locationText ? `<div class="crm-meta">${escapeHtml(locationText)}</div>` : ''}
    </article>
  `;
}

function wireCRMBoard() {
  $$('.crm-card').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      const number = Number(card.dataset.number);
      state.draggedNumber = number;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(number));
      $('#app').classList.add('card-dragging');
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      $('#app').classList.remove('card-dragging');
      $('#archiveDropZone').classList.remove('drag-over');
    });
    card.addEventListener('click', () => openDrawer(Number(card.dataset.number)));
  });
  $$('.crm-card-list').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (!list.classList.contains('drag-over')) list.classList.add('drag-over');
    });
    list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drag-over');
      const number = draggedNumberFromEvent(event);
      const nextCrm = list.dataset.crmStatus;
      await moveCardToCRMStatus(number, nextCrm);
    });
  });
}

function wireArchiveDropZone() {
  const zone = $('#archiveDropZone');
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (!zone.classList.contains('drag-over')) zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', async (event) => {
    event.preventDefault();
    zone.classList.remove('drag-over');
    $('#app').classList.remove('card-dragging');
    const number = draggedNumberFromEvent(event);
    if (!number) return;
    await moveCardToCRMStatus(number, 'rejected_archived');
  });
}

function draggedNumberFromEvent(event) {
  const transferred = Number(event.dataTransfer?.getData('text/plain'));
  return transferred || state.draggedNumber;
}

async function moveCardToCRMStatus(number, nextCrm) {
  const row = state.data.applications.find((item) => item.number === number);
  if (!row || !nextCrm) return;
  const previousCrm = row.crmStatus || mapCareerOpsStatusToCRM(row.status);
  const previousStatus = row.status;
  row.crmStatus = nextCrm;
  row.status = crmStatusToCareerOps(nextCrm);

  const cardEl = $(`.crm-card[data-number="${number}"]`);
  const targetList = $(`.crm-card-list[data-crm-status="${nextCrm}"]`);
  if (cardEl && targetList) {
    targetList.querySelector('.crm-empty')?.remove();
    targetList.appendChild(cardEl);
    const sourceList = $(`.crm-card-list[data-crm-status="${previousCrm}"]`);
    if (sourceList && !sourceList.querySelector('.crm-card')) {
      sourceList.innerHTML = '<div class="crm-empty">No applications</div>';
    }
    $$('.crm-column').forEach((col) => {
      col.querySelector('.crm-column-header span').textContent = col.querySelectorAll('.crm-card').length;
    });
  } else {
    renderDashboardContent();
  }

  try {
    applyDashboardData(await window.careerOps.updateStatus({ number, status: nextCrm }), { render: false });
    setStatus(`${row.company} moved to ${crmStatusLabel(nextCrm)}.`);
  } catch (error) {
    row.crmStatus = previousCrm;
    row.status = previousStatus;
    renderAll();
    setStatus(`Status update failed: ${error.message}`);
  }
}

function jobMatchesLocation(job) {
  if (state.discoveryLocationCountry === 'all') return true;
  const loc = String(job.location || '').toLowerCase();
  const isUS = /\b(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|usa|u\.s\.a|united states)\b/.test(loc);
  const isCA = /\b(canada|bc|ontario|on\b|alberta|ab\b|qc|quebec|sk|mb|nova scotia|ns\b|nb\b|nl\b|pe\b|yt|nt\b|nu\b)\b/.test(loc);
  if (state.discoveryLocationCountry === 'US' && !isUS) return false;
  if (state.discoveryLocationCountry === 'CA' && !isCA) return false;
  if (!state.discoveryLocationAllInCountry && state.discoveryLocationCity.trim()) {
    return loc.includes(state.discoveryLocationCity.toLowerCase().trim());
  }
  return true;
}

function locationBtnLabel() {
  if (state.discoveryLocationCountry === 'all') return 'All locations';
  const country = state.discoveryLocationCountry === 'US' ? 'United States' : 'Canada';
  if (state.discoveryLocationAllInCountry || !state.discoveryLocationCity.trim()) return country;
  return `${country} · ${state.discoveryLocationCity.trim()}`;
}

function wireLocationPopover() {
  const btn = $('#discoveryLocationBtn');
  const popover = $('#discoveryLocationPopover');
  if (!btn || !popover) return;

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = popover.hidden;
    popover.hidden = !opening;
    btn.setAttribute('aria-expanded', String(opening));
    if (opening) syncLocationPopoverToState();
  });

  document.addEventListener('click', (event) => {
    if (!popover.hidden && !popover.contains(event.target) && event.target !== btn) {
      popover.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  $$('[name="locCountry"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const countrySection = $('#locationSection');
      if (countrySection) countrySection.hidden = radio.value === 'all';
      updateLocationToggleText(radio.value);
    });
  });

  $('#locationAllToggle').addEventListener('change', (event) => {
    const cityInput = $('#locationCityInput');
    if (cityInput) cityInput.hidden = event.target.checked;
  });

  $('#locationResetBtn').addEventListener('click', () => {
    state.discoveryLocationCountry = 'all';
    state.discoveryLocationAllInCountry = true;
    state.discoveryLocationCity = '';
    popover.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    $('#discoveryLocationBtnLabel').textContent = locationBtnLabel();
    renderPending();
  });

  $('#locationConfirmBtn').addEventListener('click', () => {
    const selectedCountry = $$('[name="locCountry"]').find((r) => r.checked)?.value || 'all';
    const allToggle = $('#locationAllToggle');
    const cityInput = $('#locationCityInput');
    state.discoveryLocationCountry = selectedCountry;
    state.discoveryLocationAllInCountry = allToggle?.checked ?? true;
    state.discoveryLocationCity = cityInput?.value.trim() || '';
    popover.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    $('#discoveryLocationBtnLabel').textContent = locationBtnLabel();
    renderPending();
  });
}

function syncLocationPopoverToState() {
  $$('[name="locCountry"]').forEach((radio) => {
    radio.checked = radio.value === state.discoveryLocationCountry;
  });
  const countrySection = $('#locationSection');
  if (countrySection) countrySection.hidden = state.discoveryLocationCountry === 'all';
  updateLocationToggleText(state.discoveryLocationCountry);
  const allToggle = $('#locationAllToggle');
  if (allToggle) allToggle.checked = state.discoveryLocationAllInCountry;
  const cityInput = $('#locationCityInput');
  if (cityInput) {
    cityInput.value = state.discoveryLocationCity;
    cityInput.hidden = state.discoveryLocationAllInCountry;
  }
}

function updateLocationToggleText(country) {
  const el = $('#locationToggleText');
  if (!el) return;
  if (country === 'US') el.textContent = 'All locations within the US';
  else if (country === 'CA') el.textContent = 'All locations within Canada';
  else el.textContent = 'All locations';
}

function renderDiscoverySourceFilter(allRows) {
  const select = $('#discoverySourceFilter');
  if (!select) return;
  const sources = state.data?.discoverySources || [];
  const portals = [...new Set(allRows.map((job) => String(job.portal || '').trim()).filter(Boolean))].sort();
  const prevValue = state.discoverySource;

  const options = ['<option value="all">All sources</option>'];
  if (sources.length) {
    options.push('<optgroup label="Your job lists">');
    sources.forEach((s) => options.push(`<option value="src:${escapeAttr(s.url)}">${escapeHtml(s.label || s.url)}</option>`));
    options.push('</optgroup>');
  }
  if (portals.length) {
    options.push('<optgroup label="Job boards">');
    portals.forEach((p) => options.push(`<option value="portal:${escapeAttr(p)}">${escapeHtml(p)}</option>`));
    options.push('</optgroup>');
  }
  select.innerHTML = options.join('');

  const allValues = ['all', ...sources.map((s) => `src:${s.url}`), ...portals.map((p) => `portal:${p}`)];
  select.value = allValues.includes(prevValue) ? prevValue : 'all';
  if (select.value !== prevValue) state.discoverySource = 'all';
}

function renderPending() {
  const allRows = state.data.pendingJobs || [];
  renderDiscoverySourceFilter(allRows);
  const dateLimit = state.discoveryDateRange === 'all' ? null : Number(state.discoveryDateRange);
  const sources = state.data?.discoverySources || [];

  const rows = allRows.filter((job) => {
    const matchesQuery = !state.discoveryQuery
      || `${job.company} ${job.role} ${job.location} ${job.portal} ${job.recommendation}`
        .toLowerCase()
        .includes(state.discoveryQuery);
    const matchesLocation = jobMatchesLocation(job);
    const matchesDate = dateLimit == null
      || (job.postedDaysAgo != null && job.postedDaysAgo <= dateLimit);
    const matchesFit = state.discoveryFit === 'all'
      || (state.discoveryFit === 'strong'
        ? job.isRelevant && Number(job.relevanceScore || 0) >= 20
        : job.isRelevant);
    const matchesSource = (() => {
      if (state.discoverySource === 'all') return true;
      if (state.discoverySource.startsWith('portal:')) {
        return String(job.portal || '') === state.discoverySource.slice(7);
      }
      if (state.discoverySource.startsWith('src:')) {
        const srcUrl = state.discoverySource.slice(4);
        const src = sources.find((s) => s.url === srcUrl);
        if (!src) return false;
        const srcHost = (() => { try { return new URL(src.url).hostname; } catch { return ''; } })();
        return srcHost && String(job.url || '').includes(srcHost);
      }
      return true;
    })();
    return matchesQuery && matchesLocation && matchesDate && matchesFit && matchesSource;
  }).sort((left, right) => {
    if (state.discoverySort === 'newest') {
      return (left.postedDaysAgo ?? Number.MAX_SAFE_INTEGER)
        - (right.postedDaysAgo ?? Number.MAX_SAFE_INTEGER);
    }
    if (state.discoverySort === 'company') return left.company.localeCompare(right.company);
    return Number(right.recommendationScore || 0) - Number(left.recommendationScore || 0)
      || (left.postedDaysAgo ?? Number.MAX_SAFE_INTEGER)
        - (right.postedDaysAgo ?? Number.MAX_SAFE_INTEGER);
  });

  const hasActiveFilter = state.discoveryQuery
    || state.discoveryLocationCountry !== 'all'
    || dateLimit != null
    || state.discoveryFit !== 'all'
    || state.discoverySource !== 'all';

  $('#pendingCount').textContent = `${rows.length} jobs`;
  const selCount = state.pendingSelection.size;
  const selEl = $('#selectedPendingCount');
  if (selEl) selEl.textContent = selCount > 0 ? `${selCount} selected` : '';
  const selActions = $('#discoverySelectionActions');
  if (selActions) selActions.hidden = selCount === 0;
  $('#pendingBody').innerHTML = rows.length
    ? rows.map(renderPendingRow).join('')
    : `<tr><td colspan="7"><div class="empty-state">${hasActiveFilter ? 'No jobs match the current filters.' : 'No jobs in Discovery.'}</div></td></tr>`;
  $$('.pending-check').forEach((check) => {
    check.addEventListener('change', () => {
      if (check.checked) state.pendingSelection.add(check.dataset.url);
      else state.pendingSelection.delete(check.dataset.url);
      renderPending();
    });
  });
  $$('.pending-open').forEach((button) => {
    button.addEventListener('click', () => window.careerOps.openExternal(button.dataset.url));
  });
  $$('.pending-evaluate').forEach((button) => {
    button.addEventListener('click', () => evaluatePending([button.dataset.url]));
  });
}

function renderPendingRow(job) {
  const checked = state.pendingSelection.has(job.url) ? 'checked' : '';
  const availability = state.availability.get(job.url);
  const queueItem = state.bulkQueue.items.get(job.url);
  return `
    <tr>
      <td><input class="pending-check" data-url="${escapeAttr(job.url)}" type="checkbox" ${checked} aria-label="Select ${escapeAttr(job.company)} ${escapeAttr(job.role)}" /></td>
      <td><strong>${escapeHtml(job.company)}</strong>${job.alreadyTracked ? '<div class="tiny-warn">already tracked</div>' : ''}</td>
      <td>
        ${escapeHtml(job.role)}
        ${availability ? `<div class="${availability.available ? 'tiny-ok' : 'tiny-warn'}">${escapeHtml(availability.reason)}</div>` : ''}
        ${queueItem ? `<div class="tiny-queue ${escapeAttr(queueItem.status || '')}">${escapeHtml(queueItem.stage || 'queue')}: ${escapeHtml(queueItem.message || '')}</div>` : ''}
      </td>
      <td>${escapeHtml(job.location || 'Not provided')}</td>
      <td>${escapeHtml(sourceLabel(job))}</td>
      <td>${escapeHtml(postedAgoLabel(job.postedDaysAgo))}</td>
      <td class="pending-row-actions">
        <button class="icon-button pending-open" data-url="${escapeAttr(job.url)}">Open</button>
        <button class="icon-button pending-evaluate" data-url="${escapeAttr(job.url)}">Evaluate</button>
      </td>
    </tr>
  `;
}

function sourceLabel(job) {
  if (job.sourceLabel) return job.sourceLabel;
  const portal = String(job.portal || '').toLowerCase();
  if (portal && portal !== 'web') {
    return portal.charAt(0).toUpperCase() + portal.slice(1);
  }
  return 'Web';
}

function postedAgoLabel(days) {
  if (days == null) return 'Not provided';
  if (days === 0) return 'Today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}


function renderBulkQueue() {
  const panel = $('#bulkQueuePanel');
  const items = [...state.bulkQueue.items.values()];
  panel.hidden = !state.bulkQueue.running && items.length === 0;
  $('#bulkQueueList').innerHTML = items.length
    ? items.map((item) => `
        <article class="bulk-queue-item ${escapeAttr(item.status || '')}">
          <div class="bulk-queue-item-info">
            <strong>${escapeHtml(item.company || 'Unknown company')}</strong>
            <span>${escapeHtml(item.role || '')}</span>
          </div>
          ${renderBulkQueueActions(item)}
        </article>
      `).join('')
    : '';
  $$('.bulk-queue-action').forEach((button) => {
    button.addEventListener('click', () => handleBulkQueueAction(button));
  });
}

function renderBulkQueueActions(item) {
  if (item.status === 'running') {
    const label = item.message
      || (item.stage === 'verify' ? 'Checking availability…' : 'Evaluating…');
    return `<div class="bulk-queue-item-loading">
      <span class="bulk-queue-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(label)}</span>
    </div>`;
  }
  const actions = [];
  if (item.number) {
    actions.push(`<button class="button secondary small bulk-queue-action" data-action="report" data-number="${item.number}">View report</button>`);
  }
  if (item.url) {
    actions.push(`<button class="button secondary small bulk-queue-action" data-action="posting" data-url="${escapeAttr(item.url)}">Open posting</button>`);
  }
  if (actions.length === 0) return '';
  return `<div class="detail-actions wrap">${actions.join('')}</div>`;
}

function handleBulkQueueAction(button) {
  const action = button.dataset.action;
  const number = Number(button.dataset.number);
  if (action === 'posting' && button.dataset.url) {
    window.careerOps.openExternal(button.dataset.url);
    return;
  }
  const row = state.data.applications.find((item) => item.number === number);
  if (!row) {
    setStatus(`Evaluation #${number} is no longer available in the dashboard.`);
    return;
  }
  state.selectedNumber = number;
  if (action === 'evaluation') {
    setView('dashboard');
    openDrawer(number);
    return;
  }
  if (action === 'report') {
    setView('dashboard');
    openDrawer(number);
    renderReport(row);
  }
}

function handleBulkQueueProgress(update) {
  if (update.channel === 'discovery-refresh') {
    const progress = $('#discoveryRefreshProgress');
    if (!progress) return;
    if (update.type === 'source-start' || update.type === 'api-scan-start') {
      progress.textContent = `Scanning ${update.label}...`;
      progress.hidden = false;
    } else if (update.type === 'source-done' || update.type === 'api-scan-done') {
      const suffix = update.added ? ` — ${update.added} new` : '';
      progress.textContent = `Done: ${update.label}${suffix}`;
    } else if (update.type === 'source-error' || update.type === 'api-scan-error') {
      progress.textContent = `Error scanning ${update.label}`;
    }
    return;
  }
  if (update.type === 'queue-started') {
    state.bulkQueue.running = true;
    state.bulkQueue.items.clear();
  }
  if (update.dashboard) {
    applyDashboardData(update.dashboard);
  }
  if (update.url) {
    const application = update.result?.application || null;
    const previous = state.bulkQueue.items.get(update.url) || {};
    state.bulkQueue.items.set(update.url, {
      ...previous,
      url: update.url,
      company: update.company,
      role: update.role,
      stage: update.stage || previous.stage,
      status: update.status || previous.status,
      message: update.message || previous.message,
      number: application?.number || update.result?.evaluation?.reportNum || previous.number,
      reportPath: application?.reportPath || update.result?.evaluation?.reportPath || previous.reportPath
    });
    if (update.availability) state.availability.set(update.url, { url: update.url, ...update.availability });
  }
  if (update.type === 'queue-complete') {
    state.bulkQueue.running = false;
  }
  state.bulkQueue.message = update.message || state.bulkQueue.message;
  if (update.message && state.bulkQueue.running) updateBgTask(update.message);
  if (update.dashboard) {
    renderAll();
  } else {
    renderBulkQueue();
    renderPending();
  }
  if (update.message) setStatus(update.message);
}

function renderJobRow(row) {
  const selected = row.number === state.selectedNumber ? 'selected' : '';
  return `
    <tr class="${selected}" data-number="${row.number}">
      <td class="muted">#${row.number}</td>
      <td><span class="score ${scoreClass(row.score)}">${formatScore(row, false)}</span></td>
      <td><strong>${escapeHtml(row.company)}</strong></td>
      <td>${escapeHtml(row.role)}</td>
      <td><span class="pill ${normalizeStatus(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>${escapeHtml(row.workMode || row.location || 'Unknown')}</td>
      <td>${escapeHtml(row.payRange || '')}</td>
      <td class="actions-cell">
        <button class="icon-button row-action" data-action="letter">Draft</button>
        <button class="icon-button row-action" data-action="report">Report</button>
        <button class="icon-button row-action" data-action="open" ${row.jobUrl ? '' : 'disabled'}>Open</button>
      </td>
    </tr>
  `;
}

function openDrawer(number) {
  const row = state.data.applications.find((item) => item.number === number);
  if (!row) return;
  state.selectedNumber = number;
  $('#drawerTitle').textContent = `${row.company} - ${row.role}`;
  $('#drawerContent').innerHTML = `
    <section class="drawer-primary-actions" aria-label="Job actions">
      <div class="drawer-action-group">
        <span class="drawer-action-label">Job posting</span>
        <button class="drawer-action primary" id="detailOpen" ${row.jobUrl ? '' : 'disabled'}>
          <strong>Open job posting</strong>
          <span>View the original role in your browser</span>
        </button>
      </div>
      <div class="drawer-action-group">
        <span class="drawer-action-label">Cover letter</span>
        <div class="drawer-action-row">
          <button class="drawer-action primary" id="detailGenerateCover">
            <strong>Generate cover letter</strong>
            <span>Create a tailored document</span>
          </button>
          <button class="drawer-action" id="detailCover" ${row.coverLetterPath ? '' : 'disabled'}>
            <strong>Open cover letter</strong>
            <span>${row.coverLetterPath ? 'Open the generated document' : 'No document generated yet'}</span>
          </button>
        </div>
      </div>
      <div class="drawer-action-group">
        <span class="drawer-action-label">Job report</span>
        <div class="drawer-action-row">
          <button class="drawer-action report" id="detailGenerateReport">
            <strong>Generate report</strong>
            <span>${row.reportPath ? 'Refresh the job evaluation' : 'Create a fit evaluation'}</span>
          </button>
          <button class="drawer-action" id="detailReport" ${row.reportPath ? '' : 'disabled'}>
            <strong>Open existing report</strong>
            <span>${row.reportPath ? 'Read the current evaluation' : 'No report generated yet'}</span>
          </button>
        </div>
      </div>
    </section>
    <section class="drawer-notes">
      <div class="drawer-section-heading">
        <div><span>Notes</span><p>Add your own context, follow-ups, or reminders.</p></div>
        <button class="button primary small" id="detailSaveNotes">Save notes</button>
      </div>
      <textarea id="detailNotes" maxlength="4000" placeholder="Add notes about this job…">${escapeHtml(row.notes || '')}</textarea>
      <p id="detailNotesFeedback" class="drawer-feedback" role="status" aria-live="polite"></p>
    </section>
    <section class="drawer-meta">
      <h4>Job details</h4>
      <div class="drawer-meta-grid">
        ${drawerField('Score', formatScore(row))}
        ${drawerField('Status', row.status)}
        ${drawerField('Location', row.location || row.workMode || 'Unknown')}
        ${drawerField('Pay', row.payRange || 'Unknown')}
        ${drawerField('Last contact', row.lastContact || row.date || 'Unknown')}
        ${drawerField('Next action', row.nextAction || nextActionForRow(row))}
      </div>
    </section>
  `;
  $('#detailDrawer').classList.add('open');
  $('#detailDrawer').setAttribute('aria-hidden', 'false');
  if ($('#reportOverlay').classList.contains('open')) $('#reportOverlay').classList.add('alongside-drawer');
  $('#detailOpen').addEventListener('click', () => row.jobUrl && window.careerOps.openExternal(row.jobUrl));
  $('#detailGenerateCover').addEventListener('click', () => createCoverLetter(row));
  $('#detailCover').addEventListener('click', () => {
    if (!row.coverLetterPath) return;
    state.coverLetterJobNumber = row.number;
    closeDrawer();
    setView('coverLetter');
    renderCoverLetter();
  });
  $('#detailGenerateReport').addEventListener('click', async () => {
    const button = $('#detailGenerateReport');
    button.disabled = true;
    button.querySelector('strong').textContent = 'Generating report…';
    setStatus(`Generating report for ${row.company}...`);
    showBgTask(`Generating report for ${row.company}…`);
    try {
      const result = await window.careerOps.generateApplicationReport({ number: row.number });
      applyDashboardData(result.dashboard, { render: true });
      openDrawer(row.number);
      setStatus(result.message || 'Report generated.');
    } catch (error) {
      button.disabled = false;
      button.querySelector('strong').textContent = 'Generate report';
      setStatus(`Report generation failed: ${error.message}`);
    } finally {
      hideBgTask();
    }
  });
  $('#detailReport').addEventListener('click', () => row.reportPath && renderReport(row));
  $('#detailSaveNotes').addEventListener('click', async () => {
    const button = $('#detailSaveNotes');
    const feedback = $('#detailNotesFeedback');
    button.disabled = true;
    feedback.textContent = 'Saving…';
    try {
      applyDashboardData(await window.careerOps.updateApplicationNotes({
        number: row.number,
        notes: $('#detailNotes').value
      }), { render: true });
      feedback.textContent = 'Notes saved.';
      setStatus('Notes saved.');
    } catch (error) {
      feedback.textContent = `Could not save notes: ${error.message}`;
      feedback.classList.add('error');
    } finally {
      button.disabled = false;
    }
  });
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem('sidebarCollapsed', String(state.sidebarCollapsed));
  applySidebarState();
}

function applySidebarState() {
  $('#app').classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  const button = $('#sidebarToggleBtn');
  button.setAttribute('aria-label', state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
  button.setAttribute('title', state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
}

function closeDrawer() {
  $('#detailDrawer').classList.remove('open');
  $('#detailDrawer').setAttribute('aria-hidden', 'true');
  $('#reportOverlay').classList.remove('alongside-drawer');
}

function drawerField(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '')}</strong></div>`;
}

async function updateRowStatus(number, status) {
  const row = state.data.applications.find((item) => item.number === number);
  setStatus(`Updating ${row?.company || 'application'} status...`);
  applyDashboardData(await window.careerOps.updateStatus({ number, status }), { render: true });
  if ($('#detailDrawer').classList.contains('open')) openDrawer(number);
  setStatus('Status updated.');
}

function preprocessReportMarkdown(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);

  // Strip job number prefix from H1: "# 044 - Company - Role" → "# Company - Role"
  if (/^#\s+\d+\s+-\s+/.test(lines[0] || '')) {
    lines[0] = lines[0].replace(/^(#\s+)\d+\s+-\s+/, '$1');
  }

  // Remove PDF and Legitimacy field lines
  const filtered = lines.filter(
    (line) => !/^\*\*PDF:\*\*/.test(line) && !/^\*\*Legitimacy:\*\*/.test(line)
  );

  // Find the TL;DR section heading
  const tldrIdx = filtered.findIndex((line) => /^##\s+TL;DR\s*$/i.test(line.trim()));
  if (tldrIdx === -1) return filtered.join('\n');

  // Find the end of the TL;DR section (next ## heading)
  let tldrEnd = filtered.length;
  for (let i = tldrIdx + 1; i < filtered.length; i++) {
    if (/^##\s+/.test(filtered[i])) {
      tldrEnd = i;
      break;
    }
  }

  // Rename heading to Summary and extract the section
  const summaryLines = filtered
    .slice(tldrIdx, tldrEnd)
    .map((line) => line.replace(/^(##\s+)TL;DR\s*$/i, '$1Summary'));

  // Rebuild without TL;DR in its original position
  const withoutTldr = [...filtered.slice(0, tldrIdx), ...filtered.slice(tldrEnd)];

  // Insert Summary right after the H1, before the metadata fields
  let insertAt = 1;
  while (insertAt < withoutTldr.length && !withoutTldr[insertAt].trim()) insertAt++;

  return [
    ...withoutTldr.slice(0, insertAt),
    '',
    ...summaryLines,
    '',
    ...withoutTldr.slice(insertAt),
  ].join('\n');
}

function renderReport(row) {
  const summary = row.reportSummary || {};
  $('#reportTitle').textContent = `${row.company} — ${row.role}`;
  const content = preprocessReportMarkdown(summary.content || 'No report content found for this job.');
  $('#reportContent').innerHTML = formatMarkdownReport(content);
  $('#reportOverlay').classList.add('open');
  $('#reportOverlay').classList.toggle('alongside-drawer', $('#detailDrawer').classList.contains('open'));
  $('#reportOverlay').setAttribute('aria-hidden', 'false');
  $('#reportOverlayCloseBtn').focus();
}

function closeReportOverlay() {
  $('#reportOverlay').classList.remove('open');
  $('#reportOverlay').setAttribute('aria-hidden', 'true');
}

function renderProgress() {
  const progress = state.data.progress;
  $('#funnelList').innerHTML = progress.funnel.map((item) => barItem(item.label, item.count, item.pct)).join('');
  const maxBucket = Math.max(1, ...progress.buckets.map((item) => item.count));
  $('#bucketList').innerHTML = progress.buckets.map((item) => barItem(item.label, item.count, (item.count / maxBucket) * 100)).join('');
  $('#rateCards').innerHTML = [
    ['Response', progress.responseRate],
    ['Interview', progress.interviewRate],
    ['Offer', progress.offerRate]
  ].map(([label, value]) => `<article class="rate"><span>${label}</span><strong>${value.toFixed(0)}%</strong></article>`).join('');
  renderFollowUpQueue();
  renderArchivedJobs();
  renderAdvancedAnalytics();
}

function renderAdvancedAnalytics() {
  const advanced = state.data.analytics?.advanced || {};
  renderSourceQuality('sourceQualityPortal', advanced.sourceQuality?.byPortal || [], 'Portal');
  renderSourceQuality('sourceQualityCompany', advanced.sourceQuality?.byCompany || [], 'Company');
  renderResponseByScore(advanced.responseByScore || []);
  renderStaleHighFit(advanced.staleHighFit || []);
  renderRejectionReasons(advanced.rejectionReasons || []);
  renderApplyRecommendations(advanced.recommendations || []);
}

function renderSourceQuality(targetId, rows, label) {
  const target = $(`#${targetId}`);
  target.innerHTML = rows.length
    ? `
      <table class="mini-table">
        <thead><tr><th>${escapeHtml(label)}</th><th>Avg</th><th>High fit</th><th>Resp</th><th>Seen</th></tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td><strong>${escapeHtml(row.label)}</strong><span>${row.evaluated} evaluated · ${row.pending} pending</span></td>
              <td>${row.avgScore ? row.avgScore.toFixed(1) : '-'}</td>
              <td>${row.highFitRate.toFixed(0)}%</td>
              <td>${row.responseRate.toFixed(0)}%</td>
              <td>${row.seen}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `
    : '<div class="empty-state">No source history yet.</div>';
}

function renderResponseByScore(rows) {
  $('#responseByScore').innerHTML = rows.length
    ? `
      <table class="mini-table">
        <thead><tr><th>Score</th><th>Evaluated</th><th>Applied</th><th>Responded</th><th>Rate</th></tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td><strong>${escapeHtml(row.label)}</strong></td>
              <td>${row.evaluated}</td>
              <td>${row.applied}</td>
              <td>${row.responded}</td>
              <td>${row.responseRate.toFixed(0)}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `
    : '<div class="empty-state">No scored applications yet.</div>';
}

function renderStaleHighFit(rows) {
  $('#staleHighFitList').innerHTML = rows.length
    ? rows.map((row) => `
        <button class="queue-item stale-high-fit-item" data-number="${row.number}">
          <span>${Number(row.score || 0).toFixed(1)}/5 · ${row.ageDays}d old</span>
          <strong>${escapeHtml(row.company)}</strong>
          <em>${escapeHtml(row.role)}</em>
        </button>
      `).join('')
    : '<div class="empty-state">No stale high-fit evaluated jobs.</div>';
  $$('.stale-high-fit-item').forEach((button) => {
    button.addEventListener('click', () => {
      setView('dashboard');
      openDrawer(Number(button.dataset.number));
    });
  });
}

function renderRejectionReasons(rows) {
  $('#rejectionReasons').innerHTML = rows.length
    ? `
      <table class="mini-table">
        <thead><tr><th>Reason</th><th>Count</th><th>Example</th></tr></thead>
        <tbody>
          ${rows.map((row) => {
            const example = row.examples?.[0];
            return `
              <tr>
                <td><strong>${escapeHtml(row.label)}</strong></td>
                <td>${row.count}</td>
                <td>${example ? `${escapeHtml(example.company)} · ${escapeHtml(example.role)}` : '-'}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `
    : '<div class="empty-state">No rejected or archived jobs to analyze.</div>';
}

function renderApplyRecommendations(rows) {
  $('#applyRecommendations').innerHTML = rows.length
    ? rows.map((rec) => `
        <article class="recommendation">
          <h4>${escapeHtml(rec.title)}</h4>
          <p>${escapeHtml(rec.reason)}</p>
          <div class="recommendation-items">
            ${(rec.items || []).length ? rec.items.map((item) => `
              <button class="recommendation-item" data-number="${escapeAttr(item.number || '')}" ${item.number ? '' : 'disabled'}>
                <strong>${escapeHtml(item.company)}</strong>
                <span>${escapeHtml(item.role || '')}</span>
                <em>${escapeHtml(item.meta || (item.score ? `${Number(item.score).toFixed(1)}/5` : ''))}</em>
              </button>
            `).join('') : '<div class="empty-state compact">No matching pending jobs in this bucket.</div>'}
          </div>
        </article>
      `).join('')
    : '<div class="empty-state">No recommendations yet.</div>';
  $$('.recommendation-item[data-number]').forEach((button) => {
    if (!button.dataset.number) return;
    button.addEventListener('click', () => {
      setView('dashboard');
      openDrawer(Number(button.dataset.number));
    });
  });
}

function renderFollowUpQueue() {
  const queue = state.data.followUpQueue || [];
  const rows = Array.isArray(queue)
    ? queue
    : [
        ...(queue.applySoon || []).map((row) => ({ ...row, reason: 'Apply soon' })),
        ...(queue.followUp || []).map((row) => ({ ...row, reason: 'Follow up' })),
        ...(queue.onlineAssessment || []).map((row) => ({ ...row, reason: 'Complete assessment' })),
        ...(queue.interviewPrep || []).map((row) => ({ ...row, reason: 'Prepare interview' })),
        ...(queue.stale || []).map((row) => ({ ...row, reason: 'Review stale lead' }))
      ];
  $('#followUpQueue').innerHTML = rows.length
    ? rows.map((row) => `
        <button class="queue-item ${row.overdue ? 'overdue' : ''}" data-number="${row.number}">
          <span>${escapeHtml(row.reason || 'Follow up')}</span>
          <strong>${escapeHtml(row.company)}</strong>
          <em>${escapeHtml(row.role)}</em>
        </button>
      `).join('')
    : '<div class="empty-state">No follow-ups due.</div>';
  $$('.queue-item').forEach((button) => {
    button.addEventListener('click', () => {
      setView('dashboard');
      openDrawer(Number(button.dataset.number));
    });
  });
}

function renderArchivedJobs() {
  const rows = (state.data.applications || [])
    .filter((row) => (row.crmStatus || mapCareerOpsStatusToCRM(row.status)) === 'rejected_archived')
    .sort((a, b) => String(b.archivedAt || b.date).localeCompare(String(a.archivedAt || a.date)));
  $('#archivedCount').textContent = `${rows.length} archived`;
  $('#archivedList').innerHTML = rows.length
    ? rows.map((row) => `
        <button class="queue-item archived-item" data-number="${row.number}">
          <span>${escapeHtml(row.status || 'Archived')}${row.archivedAt ? ` · ${archiveDaysRemaining(row.archivedAt)} days left` : ''}</span>
          <strong>${escapeHtml(row.company)}</strong>
          <em>${escapeHtml(row.role)}</em>
        </button>
      `).join('')
    : '<div class="empty-state">No rejected or archived jobs.</div>';
  $$('.archived-item').forEach((button) => {
    button.addEventListener('click', () => openDrawer(Number(button.dataset.number)));
  });
}

function toggleArchivedJobs() {
  const panel = $('#archivedJobsPanel');
  const button = $('#toggleArchivedJobsBtn');
  const willExpand = panel.hidden;
  panel.hidden = !willExpand;
  button.setAttribute('aria-expanded', String(willExpand));
  button.textContent = willExpand ? 'Hide archived jobs' : 'Show archived jobs';
}

function archiveDaysRemaining(archivedAt) {
  const archivedTime = new Date(archivedAt).getTime();
  if (Number.isNaN(archivedTime)) return 21;
  return Math.max(0, 21 - Math.floor((Date.now() - archivedTime) / 86400000));
}

function renderSettings() {
  $('#titleKeywords').value = (state.data.settings.titleKeywords || []).join('\n');
  const resumeSettings = state.data.settings.resume || {};
  $('#resumeSourcePath').value = resumeSettings.sourcePath || '';
  $('#resumePdfPath').value = resumeSettings.pdfPath || '';
  $('#resumeFileName').textContent = resumeSettings.sourceName || resumeSettings.pdfName || (state.data.resume?.trim() ? 'Resume imported' : 'No resume imported');
  $('#uploadResumeBtn').textContent = state.data.resume?.trim() ? 'Choose another resume' : 'Choose resume';
  $('#addResumeBtn').textContent = state.data.resume?.trim() ? 'Upload and use new resume' : 'Add resume';
  $('#openResumeSourceBtn').disabled = !resumeSettings.sourcePath;
  $('#resumeUploadStatus').textContent = resumeSettings.pdfPath
    ? `${resumeSettings.pdfName || 'Your PDF'} is the primary resume for recommendations and autofill.`
    : (state.data.resume?.trim() ? 'This is your primary resume. Uploading another file will make the new one primary.' : 'Choose your current resume to begin.');
  $('#openAiModel').innerHTML = state.data.settings.ai.models
    .map((model) => `<option value="${escapeAttr(model.id)}">${escapeHtml(model.label)}</option>`)
    .join('');
  $('#openAiModel').value = state.data.settings.ai.coverLetterModel;
  $('#openAiKey').value = '';
  const modelNote = state.data.settings.ai.envModel && state.data.settings.ai.envModel !== state.data.settings.ai.coverLetterModel
    ? ` Env OPENAI_MODEL is set to ${state.data.settings.ai.envModel}, but the saved cover-letter model is used.`
    : '';
  $('#aiKeyStatus').textContent = state.data.settings.ai.hasApiKey
    ? `API key configured. Internal model: ${state.data.settings.ai.internalModel}. Cover-letter model: ${state.data.settings.ai.coverLetterModel}.${modelNote}`
    : `No API key configured. AI features need one. Internal model: ${state.data.settings.ai.internalModel}. Cover-letter model: ${state.data.settings.ai.coverLetterModel}.${modelNote}`;
  $('#coverLetterOutputDir').value = state.data.settings.coverLetters.outputDir;
  $('#coverLetterExamplesStatus').textContent = `${state.data.settings.coverLetters.examplePaths.length} PDF style examples loaded for generation.`;
  $('#advancedWorkspacePath').value = state.data.careerRoot || '';
  const setup = state.data.settings.setup || {};
  const candidate = state.data.settings.candidate || {};
  const defaults = state.data.settings.profileDefaults || {};
  $('#profileFullName').value = setup.profile?.fullName || candidate.full_name || '';
  $('#profileEmail').value = setup.profile?.email || candidate.email || '';
  $('#profileHeadline').value = setup.profile?.headline || defaults.headline || candidate.headline || candidate.current_title || '';
  $('#targetRolesInput').value = (setup.careerGoals?.targetRoles?.length ? setup.careerGoals.targetRoles : state.data.settings.targetRoles || []).join(', ');
  $('#targetLocationsInput').value = (setup.careerGoals?.targetLocations?.length ? setup.careerGoals.targetLocations : defaults.targetLocations || []).join(', ');
  $('#compensationMin').value = setup.jobPreferences?.compensationMin || defaults.compensationMin || '';
  $('#compensationCurrency').value = setup.jobPreferences?.compensationCurrency || defaults.compensationCurrency || 'USD';
  setCheckedValues('workMode', setup.jobPreferences?.workModes?.length ? setup.jobPreferences.workModes : (defaults.workModes?.length ? defaults.workModes : ['Remote', 'Hybrid']));
  setCheckedValues('employmentType', setup.jobPreferences?.employmentTypes?.length ? setup.jobPreferences.employmentTypes : (defaults.employmentTypes || []));
  setCheckedValues('seniority', setup.jobPreferences?.acceptedSeniorities?.length ? setup.jobPreferences.acceptedSeniorities : (defaults.acceptedSeniorities || []));
  $('#authorizedCountriesInput').value = (setup.jobPreferences?.authorizedCountries?.length ? setup.jobPreferences.authorizedCountries : defaults.authorizedCountries || []).join(', ');
  $('#remoteLocationPolicy').value = setup.jobPreferences?.remoteLocationPolicy || defaults.remoteLocationPolicy || 'authorized_only';
  $('#excludedTitlesInput').value = (setup.jobPreferences?.excludedTitles?.length ? setup.jobPreferences.excludedTitles : defaults.excludedTitles || []).join(', ');
  setCheckedValues('hardConstraint', Object.entries(setup.jobPreferences?.hardConstraints || defaults.hardConstraints || {})
    .filter(([, enabled]) => enabled).map(([key]) => key));
  $('#matchingExceptionsInput').value = formatMatchingExceptions(setup.jobPreferences?.exceptions || defaults.exceptions || []);
  $('#requiresSponsorship').checked = Boolean(setup.jobPreferences?.requiresSponsorship || defaults.requiresSponsorship);
  $('#localOnlyToggle').checked = setup.privacy?.localOnly !== false;
  $('#analyticsToggle').checked = Boolean(setup.privacy?.analytics);
  $('#profileResumePreview').textContent = resumeSummary(state.data.resume);
  $('#advancedModeToggle').checked = state.advancedMode;
  document.body.classList.toggle('advanced-mode', state.advancedMode);
  document.body.classList.toggle('setup-required', shouldShowGuidedSetup() || state.setupEditing);
  document.body.classList.toggle('setup-editing', state.setupEditing);
  renderCurrentSettings();
  renderResumeLibrary();
  renderSetupProgress();
}

function renderKnowledgeCenter() {
  const center = state.data.knowledgeCenter || {
    facts: [],
    records: [],
    categoryOptions: []
  };
  const options = center.categoryOptions || [];
  $('#knowledgeFactCategory').innerHTML = options
    .map((category) => `<option value="${escapeAttr(category)}">${escapeHtml(knowledgeCategoryLabel(category))}</option>`)
    .join('');
  $('#knowledgeRecordCategory').innerHTML = options
    .map((category) => `<option value="${escapeAttr(category)}">${escapeHtml(knowledgeCategoryLabel(category))}</option>`)
    .join('');

  const records = center.records || [];
  const grouped = groupKnowledgeRecords(records, options);
  $('#knowledgeCategoryList').innerHTML = grouped.length
    ? grouped.map(renderKnowledgeCategory).join('')
    : '<div class="empty-state">No professional records yet. Upload a document, rebuild from your resumes, or add a fact.</div>';
  $$('.knowledge-delete-action').forEach((button) => {
    button.addEventListener('click', () => deleteKnowledgeFact(button.dataset.id));
  });
  $$('.knowledge-edit-action').forEach((button) => {
    button.addEventListener('click', () => editKnowledgeFact(button.dataset.id));
  });
  $$('.knowledge-record-edit-action').forEach((button) => {
    button.addEventListener('click', () => editKnowledgeRecord(button.dataset.recordId));
  });
}

function groupKnowledgeRecords(records, categoryOrder) {
  const byCategory = new Map();
  for (const record of records) {
    if (!byCategory.has(record.category)) byCategory.set(record.category, []);
    byCategory.get(record.category).push(record);
  }
  return [...byCategory.entries()]
    .sort(([left], [right]) => categoryOrder.indexOf(left) - categoryOrder.indexOf(right))
    .map(([category, categoryRecords]) => ({
      category,
      entities: categoryRecords
    }));
}

function renderKnowledgeCategory(group) {
  return `
    <section class="knowledge-category-section">
      <div class="knowledge-category-heading">
        <span>${escapeHtml(knowledgeCategoryLabel(group.category))}</span>
      </div>
      <div class="knowledge-entity-list">
        ${group.entities.map((entity) => {
          const role = Array.isArray(entity.metadata?.Role) ? entity.metadata.Role.join(', ') : (entity.metadata?.Role || '');
          const dates = Array.isArray(entity.metadata?.Dates) ? entity.metadata.Dates.join(', ') : (entity.metadata?.Dates || '');
          const subtitle = [role, dates].filter(Boolean).join(' · ');
          return `
          <details class="knowledge-entity-card">
            <summary>
              <div class="knowledge-entity-summary">
                <span class="knowledge-entity-name">${escapeHtml(entity.name)}</span>
                ${subtitle ? `<span class="knowledge-entity-subtitle">${escapeHtml(subtitle)}</span>` : ''}
              </div>
            </summary>
            <div class="knowledge-entity-facts">
              <div class="knowledge-record-actions"><button class="button secondary small knowledge-record-edit-action" data-record-id="${escapeAttr(entity.id)}" type="button">Edit fields</button></div>
              ${renderKnowledgeMetadata(entity.metadata)}
              ${entity.facts.map(renderKnowledgeFact).join('')}
              ${entity.facts.length === 0 ? '<p class="knowledge-no-details">No additional details</p>' : ''}
              ${entity.sources?.length ? `<small class="knowledge-record-sources">Sources: ${escapeHtml(entity.sources.join(', '))}</small>` : ''}
            </div>
          </details>
        `}).join('')}
      </div>
    </section>
  `;
}

function openKnowledgeChatDialog() {
  $('#knowledgeChatInput').value = '';
  $('#knowledgeChatMessages').innerHTML = '<p>Describe an experience, accomplishment, preference, course, skill, or other professional fact. The AI will compare it with your existing knowledge before adding it.</p>';
  $('#knowledgeChatDialog').showModal();
}

function closeKnowledgeChatDialog() {
  $('#knowledgeChatDialog').close();
}

async function sendKnowledgeChat(event) {
  event.preventDefault();
  const message = $('#knowledgeChatInput').value.trim();
  if (!message) return;
  $('#sendKnowledgeChatBtn').disabled = true;
  setStatus('AI is reviewing your existing knowledge...');
  try {
    const result = await runAiTask(
      'Reviewing your professional knowledge…',
      () => window.careerOps.chatKnowledge({ message })
    );
    state.data.knowledgeCenter = result.knowledgeCenter;
    $('#knowledgeChatMessages').innerHTML += `<div class="knowledge-chat-user">${escapeHtml(message)}</div><div class="knowledge-chat-assistant">${escapeHtml(result.assistantMessage)}</div>`;
    $('#knowledgeChatInput').value = '';
    renderKnowledgeCenter();
    setStatus(result.added ? `${result.added} new fact(s) added.` : 'AI response ready.');
  } catch (error) {
    setStatus(`Knowledge chat failed: ${error.message}`);
  } finally {
    $('#sendKnowledgeChatBtn').disabled = false;
  }
}

function editKnowledgeRecord(recordId) {
  const record = (state.data.knowledgeCenter?.records || []).find((item) => item.id === recordId);
  if (!record) return;
  state.editingKnowledgeRecordId = recordId;
  $('#knowledgeRecordCategory').value = record.category;
  $('#knowledgeRecordName').value = record.name || '';
  $('#knowledgeRecordRole').value = metadataValue(record.metadata, 'Role');
  $('#knowledgeRecordDegree').value = metadataValue(record.metadata, 'Degree');
  $('#knowledgeRecordField').value = metadataValue(record.metadata, 'Field');
  $('#knowledgeRecordLocation').value = metadataValue(record.metadata, 'Location');
  $('#knowledgeRecordWorkMode').value = metadataValue(record.metadata, 'Work mode');
  $('#knowledgeRecordDates').value = metadataValue(record.metadata, 'Dates');
  $('#knowledgeRecordDialog').showModal();
}

function metadataValue(metadata, key) {
  const value = metadata?.[key];
  return Array.isArray(value) ? value.join(', ') : (value || '');
}

function closeKnowledgeRecordDialog() {
  $('#knowledgeRecordDialog').close();
  state.editingKnowledgeRecordId = null;
}

async function saveKnowledgeRecord(event) {
  event.preventDefault();
  const record = (state.data.knowledgeCenter?.records || []).find((item) => item.id === state.editingKnowledgeRecordId);
  if (!record) return;
  try {
    const result = await window.careerOps.updateKnowledgeRecord({
      factIds: record.factIds,
      category: $('#knowledgeRecordCategory').value,
      name: $('#knowledgeRecordName').value,
      metadata: {
        role: $('#knowledgeRecordRole').value.trim(),
        degree: $('#knowledgeRecordDegree').value.trim(),
        field: $('#knowledgeRecordField').value.trim(),
        location: $('#knowledgeRecordLocation').value.trim(),
        workMode: $('#knowledgeRecordWorkMode').value.trim(),
        dates: $('#knowledgeRecordDates').value.trim()
      }
    });
    state.data.knowledgeCenter = result.knowledgeCenter;
    closeKnowledgeRecordDialog();
    renderKnowledgeCenter();
    setStatus('Record fields updated.');
  } catch (error) {
    setStatus(`Could not update record: ${error.message}`);
  }
}

function knowledgeRecordSummary(record) {
  const metadataCount = Object.values(record.metadata || {}).filter((value) => value && (!Array.isArray(value) || value.length)).length;
  const detailCount = (record.facts || []).length;
  const count = metadataCount + detailCount;
  return `${count} ${count === 1 ? 'detail' : 'details'}`;
}

function renderKnowledgeMetadata(metadata = {}) {
  const entries = Object.entries(metadata).filter(([, value]) => value && (!Array.isArray(value) || value.length));
  if (!entries.length) return '';
  return `
    <dl class="knowledge-metadata">
      ${entries.map(([label, value]) => `
        <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(Array.isArray(value) ? value.join(', ') : value)}</dd></div>
      `).join('')}
    </dl>
  `;
}

function renderKnowledgeFact(fact) {
  const compactSummary = String(fact.summary || '').trim();
  const showTitle = fact.title && !compactSummary.toLowerCase().startsWith(`${String(fact.title).toLowerCase()}:`);
  return `
    <article class="knowledge-detail-row">
      <div>
        ${showTitle ? `<strong>${escapeHtml(fact.title)}</strong>` : ''}
        <p>${escapeHtml(compactSummary)}</p>
      </div>
      <button class="knowledge-delete-action" data-id="${escapeAttr(fact.id)}" type="button" aria-label="Delete ${escapeAttr(fact.title || 'fact')}">Delete</button>
      <button class="knowledge-edit-action" data-id="${escapeAttr(fact.id)}" type="button" aria-label="Edit ${escapeAttr(fact.title || 'fact')}">Edit</button>
    </article>
  `;
}

function knowledgeCategoryLabel(category) {
  return String(category || '').split('-').map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ');
}

function openKnowledgeFactDialog() {
  state.editingKnowledgeFactId = null;
  $('#knowledgeFactForm').reset();
  $('#knowledgeFactDialogTitle').textContent = 'Add a professional fact';
  $('#saveKnowledgeFactBtn').textContent = 'Save fact';
  $('#knowledgeFactDialog').showModal();
}

function closeKnowledgeFactDialog() {
  $('#knowledgeFactDialog').close();
  state.editingKnowledgeFactId = null;
}

async function addKnowledgeFact(event) {
  event.preventDefault();
  setStatus('Saving professional fact...');
  try {
    const isEditing = Boolean(state.editingKnowledgeFactId);
    const payload = {
      id: state.editingKnowledgeFactId,
      category: $('#knowledgeFactCategory').value,
      factType: $('#knowledgeFactType').value,
      title: $('#knowledgeFactTitle').value,
      summary: $('#knowledgeFactSummary').value,
      details: { entity: $('#knowledgeFactEntity').value.trim() }
    };
    const result = state.editingKnowledgeFactId
      ? await window.careerOps.updateKnowledgeFact(payload)
      : await window.careerOps.addKnowledgeFact(payload);
    state.data.knowledgeCenter = result.knowledgeCenter;
    closeKnowledgeFactDialog();
    renderKnowledgeCenter();
    setStatus(isEditing ? 'Fact updated.' : 'Fact added to the Knowledge Center.');
  } catch (error) {
    setStatus(`Could not save fact: ${error.message}`);
  }
}

function editKnowledgeFact(id) {
  const fact = (state.data.knowledgeCenter?.facts || []).find((item) => item.id === id);
  if (!fact) return;
  state.editingKnowledgeFactId = id;
  $('#knowledgeFactCategory').value = fact.category;
  $('#knowledgeFactEntity').value = fact.details?.entity || '';
  $('#knowledgeFactType').value = fact.factType || '';
  $('#knowledgeFactTitle').value = fact.title || '';
  $('#knowledgeFactSummary').value = fact.summary || '';
  $('#knowledgeFactDialogTitle').textContent = 'Edit professional fact';
  $('#saveKnowledgeFactBtn').textContent = 'Save changes';
  $('#knowledgeFactDialog').showModal();
}

async function uploadKnowledgeDocument() {
  setStatus('Choosing a document for AI parsing...');
  try {
    const result = await window.careerOps.uploadKnowledgeDocument();
    if (!result) return setStatus('Document upload canceled.');
    state.data.knowledgeCenter = result.knowledgeCenter;
    renderKnowledgeCenter();
    setStatus(result.message);
  } catch (error) {
    setStatus(`Document parsing failed: ${error.message}`);
  }
}

async function rebuildKnowledge() {
  setStatus('Rebuilding the Knowledge Center with AI...');
  try {
    const result = await runAiTask(
      'Rebuilding your Knowledge Center…',
      () => window.careerOps.rebuildKnowledge()
    );
    state.data.knowledgeCenter = result.knowledgeCenter;
    renderKnowledgeCenter();
    setStatus(result.message);
  } catch (error) {
    setStatus(`Knowledge rebuild failed: ${error.message}`);
  }
}

async function clearKnowledge() {
  if (!window.confirm('Clear all Knowledge Center records? Resumes and uploaded files will remain.')) return;
  const result = await window.careerOps.clearKnowledge();
  state.data.knowledgeCenter = result.knowledgeCenter;
  renderKnowledgeCenter();
  setStatus('Knowledge Center cleared.');
}

async function deleteKnowledgeFact(id) {
  if (!window.confirm('Delete this professional fact?')) return;
  try {
    const result = await window.careerOps.deleteKnowledgeFact({ id });
    state.data.knowledgeCenter = result.knowledgeCenter;
    renderKnowledgeCenter();
    setStatus('Fact deleted.');
  } catch (error) {
    setStatus(`Could not delete fact: ${error.message}`);
  }
}

function renderCurrentSettings() {
  const name = $('#profileFullName').value.trim();
  const email = $('#profileEmail').value.trim();
  const headline = $('#profileHeadline').value.trim();
  const roles = listFromInput($('#targetRolesInput').value);
  const locations = listFromInput($('#targetLocationsInput').value);
  const workModes = checkedValues('workMode');
  const employmentTypes = checkedValues('employmentType');
  const seniorities = checkedValues('seniority');
  const compensation = Number($('#compensationMin').value);
  const currency = $('#compensationCurrency').value;
  const resumeSettings = state.data.settings.resume || {};

  $('#profileCurrentInfo').innerHTML = [
    currentSetting('Name', name),
    currentSetting('Email', email),
    currentSetting('Headline', headline)
  ].join('');
  $('#goalsCurrentInfo').innerHTML = [
    currentSetting('Target roles', roles.join(', ')),
    currentSetting('Locations', locations.join(', '))
  ].join('');
  $('#preferencesCurrentInfo').innerHTML = [
    currentSetting('Minimum compensation', compensation ? `${currency} ${compensation.toLocaleString()}` : ''),
    currentSetting('Work mode', workModes.join(', ')),
    currentSetting('Employment type', employmentTypes.join(', ')),
    currentSetting('Seniority', seniorities.join(', ')),
    currentSetting('Authorized countries', $('#authorizedCountriesInput').value.trim()),
    currentSetting('Remote geography', $('#remoteLocationPolicy').selectedOptions[0]?.textContent || ''),
    currentSetting('Visa sponsorship', $('#requiresSponsorship').checked ? 'May be required' : 'Not required')
  ].join('');
  $('#documentsCurrentInfo').innerHTML = [
    currentSetting('Primary resume', resumeSettings.sourceName || resumeSettings.pdfName || (state.data.resume?.trim() ? 'Resume on file' : '')),
    currentSetting('Extracted content', state.data.resume?.trim() ? 'Ready' : '')
  ].join('');
  $('#integrationsCurrentInfo').innerHTML = [
    currentSetting('Browser extension', state.data.settings.setup?.extensionTestedAt ? 'Connection tested' : 'Not tested'),
    currentSetting('AI provider', state.data.settings.ai.hasApiKey ? `Connected · cover letters: ${state.data.settings.ai.coverLetterModel}` : 'Not connected (optional)')
  ].join('');
}

function currentSetting(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong class="${value ? '' : 'unset'}">${escapeHtml(value || 'Not set')}</strong></div>`;
}

function renderResumeLibrary() {
  const resumes = state.data.settings.resumes || [];
  $('#resumeLibraryList').innerHTML = resumes.length
    ? resumes.map((resume) => `
        <article class="resume-library-item ${resume.isPrimary ? 'primary' : ''}">
          <button class="resume-library-view" data-resume-id="${escapeAttr(resume.id)}">
            <span class="resume-file-icon">${escapeHtml(resumeExtension(resume))}</span>
            <span class="resume-library-copy">
              <strong>${escapeHtml(resume.name)}</strong>
              <small>${resume.isPrimary ? 'Primary resume' : `Added ${escapeHtml(formatResumeDate(resume.createdAt))}`}</small>
            </span>
          </button>
          <div class="resume-library-actions">
            ${resume.isPrimary ? '<span class="primary-badge">Primary</span>' : `<button class="button secondary small resume-make-primary" data-resume-id="${escapeAttr(resume.id)}">Make primary</button>`}
            <button class="button secondary small resume-rename-button" data-resume-id="${escapeAttr(resume.id)}">Rename</button>
            <button class="button secondary small resume-delete-button" data-resume-id="${escapeAttr(resume.id)}">Delete</button>
            <button class="icon-button resume-view-button" data-resume-id="${escapeAttr(resume.id)}">View</button>
          </div>
        </article>
      `).join('')
    : '<div class="empty-state">No resumes uploaded yet.</div>';
  $$('.resume-library-view, .resume-view-button').forEach((button) => {
    button.addEventListener('click', () => viewResume(button.dataset.resumeId));
  });
  $$('.resume-make-primary').forEach((button) => {
    button.addEventListener('click', () => setPrimaryResume(button.dataset.resumeId));
  });
  $$('.resume-rename-button').forEach((button) => {
    button.addEventListener('click', () => renameResume(button.dataset.resumeId));
  });
  $$('.resume-delete-button').forEach((button) => {
    button.addEventListener('click', () => deleteResume(button.dataset.resumeId));
  });
}

function renderResumeBuilder() {
  const builder = state.data.resumeBuilder || { variants: [], resumes: [], jobs: [] };
  const variants = builder.variants || [];
  $('#resumeVariantList').innerHTML = variants.length
    ? variants.map((variant) => `
      <button class="resume-variant-button ${state.resumeBuilderVariant?.id === variant.id ? 'active' : ''}" data-variant-id="${escapeAttr(variant.id)}">
        <span>${escapeHtml(variant.kind === 'master' ? 'Master resume' : `${variant.company || 'Tailored'} · ${variant.role || 'Job specific'}`)}</span>
        <strong>${escapeHtml(variant.name)}</strong>
        <small>${variant.versionCount || 1} immutable version${(variant.versionCount || 1) === 1 ? '' : 's'} · Updated ${escapeHtml(formatResumeDate(variant.updatedAt))}</small>
      </button>
    `).join('')
    : '<div class="empty-state">No builder resumes yet. Create a master from an imported resume.</div>';
  $$('.resume-variant-button').forEach((button) => {
    button.addEventListener('click', () => loadResumeBuilderVariant(button.dataset.variantId));
  });
  $('#createMasterResumeBtn').disabled = !(builder.resumes || []).length;
  $('#createTailoredResumeBtn').disabled = !variants.some((variant) => variant.kind === 'master') || !(builder.jobs || []).length;
  renderActiveResumeBuilderVariant();
}

function renderActiveResumeBuilderVariant() {
  const variant = state.resumeBuilderVariant;
  $('#resumeBuilderEmpty').hidden = Boolean(variant);
  $('#resumeBuilderEditorShell').hidden = !variant;
  for (const id of ['exportResumeDocxBtn', 'exportResumePdfBtn', 'deleteResumeVariantBtn']) {
    $(id.startsWith('#') ? id : `#${id}`).disabled = !variant;
  }
  $('#saveResumeVariantBtn').disabled = !variant || state.resumeBuilderMode !== 'edit';
  $('#resumePreviewModeBtn').disabled = !variant;
  $('#resumeEditModeBtn').disabled = !variant;
  if (!variant) {
    $('#resumeBuilderTitle').textContent = 'Choose a resume';
    $('#resumeBuilderMeta').textContent = 'Create a master resume to begin.';
    $('#openResumeDocxBtn').disabled = true;
    clearResumePreview();
    return;
  }
  $('#resumeBuilderTitle').textContent = variant.name;
  $('#resumeBuilderMeta').textContent = variant.kind === 'master'
    ? 'Complete professional record'
    : `${variant.company} · ${variant.role}`;
  $('#resumeBuilderEditor').value = variant.content || '';
  state.resumePdfEdits = { ...(variant.jobContext?.pdfEdits || {}) };
  $('#resumeVersionLabel').textContent = `Version ${variant.versions?.[0]?.number || variant.versionCount || 1}`;
  $('#openResumeDocxBtn').disabled = !resumeBuilderSourcePath(variant);
  const sourcePath = resumeBuilderSourcePath(variant);
  const sourceFormat = String(sourcePath).match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase() || '';
  $('#openResumeDocxBtn').textContent = sourceFormat ? `Open source ${sourceFormat}` : 'Open source';
  renderResumeCoverage(variant.keywordReport || {});
  renderResumeSuggestions(variant);
  $('#resumeVersionHistory').innerHTML = (variant.versions || []).map((version) => `
    <div class="resume-version-row">
      <span>Version ${version.number} · ${escapeHtml(String(version.metadata?.action || 'saved').replaceAll('_', ' '))}</span>
      <time>${escapeHtml(formatResumeDate(version.createdAt))}</time>
    </div>
  `).join('') || '<div class="empty-state">Version history starts when this resume is created.</div>';
  applyResumeBuilderMode();
}

function renderResumeCoverage(report) {
  $('#resumeCoveragePanel').innerHTML = '';
  $('#resumeCoveragePanel').hidden = true;
}

function renderResumeSuggestions(variant) {
  const suggestions = variant.suggestions || [];
  const changeSummary = variant.jobContext?.aiChangeSummary || [];
  const tradeoffs = variant.jobContext?.aiTradeoffs || [];
  $('#resumeSuggestionPanel').hidden = !variant || (!suggestions.length && !changeSummary.length && variant.kind === 'master');
  if (!suggestions.length && changeSummary.length) {
    $('#resumeSuggestionList').innerHTML = `
      <article class="resume-suggestion-card accepted">
        <strong>AI tailored draft summary</strong>
        <ul>${changeSummary.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        ${tradeoffs.length ? `<p>${escapeHtml(`Tradeoffs: ${tradeoffs.join(' ')}`)}</p>` : ''}
      </article>
    `;
    return;
  }
  $('#resumeSuggestionList').innerHTML = suggestions.length
    ? suggestions.map((suggestion) => `
      <article class="resume-suggestion-card ${escapeAttr(suggestion.status)}">
        <strong>${suggestion.status === 'pending' ? 'Targeted resume edit' : escapeHtml(suggestion.status)}</strong>
        <p>${escapeHtml(suggestion.reason)}</p>
        <div class="resume-diff">
          <div class="resume-diff-before"><small>Current</small><br>${escapeHtml(suggestion.originalText || 'Not included')}</div>
          <div class="resume-diff-after"><small>Proposed</small><br>${escapeHtml(suggestion.proposedText)}</div>
        </div>
        <div class="resume-evidence">${(suggestion.evidence || []).map((evidence) => `Source: ${escapeHtml(evidence.source)} · ${escapeHtml(evidence.excerpt)}`).join('<br>')}</div>
        ${suggestion.status === 'pending' ? `<div class="inline-actions"><button class="button primary small resume-approve-suggestion" data-suggestion-id="${escapeAttr(suggestion.id)}">Approve</button><button class="button secondary small resume-reject-suggestion" data-suggestion-id="${escapeAttr(suggestion.id)}">Reject</button></div>` : ''}
      </article>
    `).join('')
    : '<div class="empty-state">No safe in-place edits found for this job. The app skipped low-confidence fragment matches instead of making noisy changes.</div>';
  $$('.resume-approve-suggestion').forEach((button) => {
    button.addEventListener('click', () => decideResumeSuggestion(button.dataset.suggestionId, 'accepted'));
  });
  $$('.resume-reject-suggestion').forEach((button) => {
    button.addEventListener('click', () => decideResumeSuggestion(button.dataset.suggestionId, 'rejected'));
  });
}

async function loadResumeBuilderVariant(id) {
  setStatus('Loading resume version…');
  try {
    state.resumeBuilderVariant = await window.careerOps.getResumeBuilderVariant(id);
    state.resumeBuilderMode = 'preview';
    renderResumeBuilder();
    setStatus('Resume ready.');
  } catch (error) {
    setStatus(`Could not load resume: ${error.message}`);
  }
}

function setResumeBuilderMode(mode) {
  if (!state.resumeBuilderVariant || !['preview', 'edit'].includes(mode)) return;
  state.resumeBuilderMode = mode;
  applyResumeBuilderMode();
}

function applyResumeBuilderMode() {
  const isPreview = state.resumeBuilderMode !== 'edit';
  $('#resumeBuilderPreview').hidden = !isPreview;
  $('#resumeBuilderEditView').hidden = isPreview;
  $('#resumePreviewModeBtn').classList.toggle('active', isPreview);
  $('#resumeEditModeBtn').classList.toggle('active', !isPreview);
  $('#saveResumeVariantBtn').disabled = !state.resumeBuilderVariant || isPreview;
  if (isPreview) {
    renderResumeDocumentPreview();
  } else if (isPdfResumeVariant(state.resumeBuilderVariant)) {
    renderResumePdfEditor();
  } else {
    $('#resumePdfEditor').hidden = true;
    $('#resumeBuilderEditor').hidden = false;
  }
}

async function renderResumeDocumentPreview() {
  const variant = state.resumeBuilderVariant;
  if (!variant) return;
  const requestId = ++state.resumePreviewRequest;
  const container = $('#resumeBuilderPreview');
  clearResumePreview();
  container.innerHTML = '<div class="resume-preview-loading">Rendering document…</div>';
  try {
    const response = await fetch(`/api/resume-builder/${encodeURIComponent(variant.id)}/preview`);
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (requestId !== state.resumePreviewRequest) return;
    const mediaType = response.headers.get('Content-Type') || blob.type;
    const exactSource = response.headers.get('X-Resume-Exact-Source') === 'true';
    const layoutAware = response.headers.get('X-Resume-Layout-Aware') === 'true';
    container.innerHTML = '';
    container.dataset.exactSource = exactSource ? 'true' : 'false';
    if (mediaType.includes('pdf')) {
      if (layoutAware && Object.keys(state.resumePdfEdits).length) {
        await renderPdfLayout(container, blob, {
          editable: false,
          edits: state.resumePdfEdits
        });
        return;
      }
      state.resumePreviewObjectUrl = URL.createObjectURL(blob);
      const frame = document.createElement('iframe');
      frame.className = 'resume-pdf-preview';
      frame.title = `${variant.name} formatted preview`;
      frame.src = `${state.resumePreviewObjectUrl}#toolbar=0&navpanes=0&view=FitH`;
      container.appendChild(frame);
      return;
    }
    if (!window.docx?.renderAsync) throw new Error('The DOCX renderer is unavailable.');
    await window.docx.renderAsync(blob, container, null, {
      className: 'docx',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true
    });
  } catch (error) {
    if (requestId !== state.resumePreviewRequest) return;
    container.innerHTML = `<div class="empty-state">Could not render the formatted document: ${escapeHtml(error.message)}</div>`;
  }
}

function isPdfResumeVariant(variant) {
  const sourcePath = resumeBuilderSourcePath(variant || {});
  return variant?.jobContext?.sourceFormat === 'pdf' || /\.pdf$/i.test(sourcePath);
}

async function loadPdfJs() {
  if (!state.pdfJs) {
    state.pdfJs = await import('/vendor/pdf.mjs');
    state.pdfJs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
  }
  return state.pdfJs;
}

async function fetchResumePreviewBlob(variant) {
  const response = await fetch(`/api/resume-builder/${encodeURIComponent(variant.id)}/preview`);
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response.blob();
}

async function renderResumePdfEditor() {
  const variant = state.resumeBuilderVariant;
  if (!variant) return;
  const requestId = ++state.resumePdfEditorRequest;
  const container = $('#resumePdfEditor');
  container.dataset.requestId = String(requestId);
  container.hidden = false;
  $('#resumeBuilderEditor').hidden = true;
  container.innerHTML = '<div class="resume-preview-loading">Loading the original PDF layout…</div>';
  try {
    const blob = await fetchResumePreviewBlob(variant);
    if (requestId !== state.resumePdfEditorRequest) return;
    await renderPdfLayout(container, blob, {
      editable: true,
      edits: state.resumePdfEdits,
      isCurrent: () => container.dataset.requestId === String(requestId)
    });
    if (requestId !== state.resumePdfEditorRequest) return;
  } catch (error) {
    if (requestId !== state.resumePdfEditorRequest) return;
    container.innerHTML = `<div class="empty-state">Could not load the PDF layout editor: ${escapeHtml(error.message)}</div>`;
  }
}

async function renderPdfLayout(container, blob, { editable, edits, isCurrent = () => true }) {
  const pdfJs = await loadPdfJs();
  const pdfDocument = await pdfJs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  container.innerHTML = '';
  const scale = editable ? 1.2 : 1.35;
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    if (!isCurrent()) break;
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const pageElement = document.createElement('div');
    pageElement.className = 'pdf-layout-page';
    pageElement.dataset.pageNumber = String(pageNumber);
    pageElement.style.width = `${viewport.width}px`;
    pageElement.style.height = `${viewport.height}px`;
    pageElement.style.setProperty('--scale-factor', String(scale));
    pageElement.style.setProperty('--user-unit', '1');
    pageElement.style.setProperty('--total-scale-factor', String(scale));

    const canvas = document.createElement('canvas');
    const outputScale = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    pageElement.appendChild(canvas);
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
    }).promise;
    if (!isCurrent()) break;

    const textContent = await page.getTextContent();
    const textLayerElement = document.createElement('div');
    textLayerElement.className = `textLayer pdf-layout-text${editable ? ' editable' : ''}`;
    pageElement.appendChild(textLayerElement);
    const textLayer = new pdfJs.TextLayer({
      textContentSource: textContent,
      container: textLayerElement,
      viewport
    });
    await textLayer.render();
    if (!isCurrent()) break;
    textLayer.textDivs.forEach((span, itemIndex) => {
      const key = `${pageNumber}:${itemIndex}`;
      const original = textLayer.textContentItemsStr[itemIndex] || '';
      const textItem = textContent.items[itemIndex];
      const font = pdfFontMetadata(page, textItem?.fontName);
      if (font) {
        span.style.fontFamily = `"${font.loadedName}", ${font.fallbackName || 'serif'}`;
        span.style.fontWeight = /bold|black|heavy/i.test(font.name || '') ? '700' : '400';
        span.style.fontStyle = /italic|oblique/i.test(font.name || '') ? 'italic' : 'normal';
      }
      span.dataset.pdfTextKey = key;
      span.dataset.originalText = original;
      if (Object.hasOwn(edits, key)) {
        span.textContent = edits[key];
        span.classList.add('pdf-text-changed');
      }
      if (editable && original.trim()) {
        span.contentEditable = 'plaintext-only';
        span.spellcheck = true;
        span.addEventListener('input', () => {
          const value = span.textContent || '';
          if (value === original) {
            delete state.resumePdfEdits[key];
            span.classList.remove('pdf-text-changed');
          } else {
            state.resumePdfEdits[key] = value;
            span.classList.add('pdf-text-changed');
          }
          syncPdfEditorTextContent();
        });
      }
    });
    if (!isCurrent()) break;
    container.appendChild(pageElement);
  }
  await pdfDocument.destroy();
}

function pdfFontMetadata(page, fontName) {
  if (!fontName) return null;
  try {
    return page.commonObjs.get(fontName);
  } catch {
    return null;
  }
}

function syncPdfEditorTextContent() {
  const lines = $$('#resumePdfEditor .pdf-layout-text span')
    .map((span) => String(span.textContent || '').trim())
    .filter(Boolean);
  $('#resumeBuilderEditor').value = `# Resume\n\n${lines.join('\n')}\n`;
}

function renderedPdfPages() {
  return $$('#resumePdfEditor .pdf-layout-page').map((pageElement) => {
    const sourceCanvas = pageElement.querySelector('canvas');
    const canvas = document.createElement('canvas');
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const context = canvas.getContext('2d');
    context.drawImage(sourceCanvas, 0, 0);
    const pageRect = pageElement.getBoundingClientRect();
    const pixelScaleX = canvas.width / pageRect.width;
    const pixelScaleY = canvas.height / pageRect.height;
    pageElement.querySelectorAll('.pdf-text-changed').forEach((span) => {
      const rect = span.getBoundingClientRect();
      const style = getComputedStyle(span);
      const x = (rect.left - pageRect.left) * pixelScaleX;
      const y = (rect.top - pageRect.top) * pixelScaleY;
      const width = Math.max(rect.width, 4) * pixelScaleX;
      const height = Math.max(rect.height, Number.parseFloat(style.fontSize) || 12) * pixelScaleY;
      context.fillStyle = '#fff';
      context.fillRect(x - 2, y - 1, width + 4, height + 2);
      context.fillStyle = '#111';
      context.textBaseline = 'top';
      context.font = `${style.fontStyle} ${style.fontWeight} ${Number.parseFloat(style.fontSize) * pixelScaleY}px ${style.fontFamily}`;
      context.fillText(span.textContent || '', x, y);
    });
    return canvas.toDataURL('image/png');
  });
}

function clearResumePreview() {
  if (state.resumePreviewObjectUrl) {
    URL.revokeObjectURL(state.resumePreviewObjectUrl);
    state.resumePreviewObjectUrl = '';
  }
  const container = $('#resumeBuilderPreview');
  if (container) container.innerHTML = '';
}

function openResumeBuilderDialog(mode) {
  const builder = state.data.resumeBuilder || { variants: [], resumes: [], jobs: [] };
  state.resumeTailorReview = null;
  $('#resumeBuilderMode').value = mode;
  $('#resumeBuilderDialogTitle').textContent = mode === 'master' ? 'Create master resume' : 'Tailor a resume for a job';
  $('#resumeBuilderSourceField').hidden = mode !== 'master';
  $('#resumeBuilderMasterField').hidden = mode !== 'tailored';
  $('#resumeBuilderJobField').hidden = mode !== 'tailored';
  $('#resumeBuilderSource').innerHTML = (builder.resumes || []).map((resume) => `<option value="${escapeAttr(resume.id)}">${escapeHtml(resume.name)}</option>`).join('');
  $('#resumeBuilderMaster').innerHTML = (builder.variants || []).filter((variant) => variant.kind === 'master')
    .map((variant) => `<option value="${escapeAttr(variant.id)}">${escapeHtml(variant.name)}</option>`).join('');
  $('#resumeBuilderJob').innerHTML = (builder.jobs || [])
    .map((job) => `<option value="${escapeAttr(job.id)}">${escapeHtml(job.company)} — ${escapeHtml(job.role)}</option>`).join('');
  const sourceName = (builder.resumes || [])[0]?.name || 'Resume';
  const targetJob = (builder.jobs || [])[0];
  $('#resumeBuilderName').value = mode === 'master'
    ? `${sourceName.replace(/\.[a-z0-9]+$/i, '')} Master`
    : (targetJob ? `${targetJob.company} - ${targetJob.role}` : 'Tailored Resume');
  $('#submitResumeBuilderBtn').textContent = mode === 'master' ? 'Create master' : 'Get recruiter feedback';
  $('#submitResumeBuilderBtn').hidden = false;
  $('#createAiTailoredResumeBtn').hidden = true;
  $('#resumeTailorReviewPanel').hidden = true;
  $('#resumeTailorReviewPanel').innerHTML = '';
  setResumeAiLoading(false);
  $('#resumeBuilderDialog').showModal();
}

function updateTailoredResumeNameFromJob() {
  if ($('#resumeBuilderMode').value !== 'tailored') return;
  const builder = state.data.resumeBuilder || { jobs: [] };
  const job = (builder.jobs || []).find((item) => item.id === $('#resumeBuilderJob').value);
  $('#resumeBuilderName').value = job ? `${job.company} - ${job.role}` : 'Tailored Resume';
  state.resumeTailorReview = null;
  $('#resumeTailorReviewPanel').hidden = true;
  $('#createAiTailoredResumeBtn').hidden = true;
  $('#submitResumeBuilderBtn').hidden = false;
}

function setResumeAiLoading(isLoading, title = 'Working with GPT-5.4…', detail = 'Reading the resume, job description, and approved knowledge.') {
  const loader = $('#resumeAiLoading');
  if (!loader) return;
  loader.hidden = !isLoading;
  $('#resumeAiLoadingTitle').textContent = title;
  $('#resumeAiLoadingDetail').textContent = detail;
  $('#resumeBuilderDialog').classList.toggle('is-ai-loading', isLoading);
  for (const selector of [
    '#resumeBuilderName',
    '#resumeBuilderSource',
    '#resumeBuilderMaster',
    '#resumeBuilderJob',
    '#submitResumeBuilderBtn',
    '#createAiTailoredResumeBtn',
    '#cancelResumeBuilderBtn',
    '#closeResumeBuilderDialogBtn'
  ]) {
    const element = $(selector);
    if (element) element.disabled = isLoading;
  }
}

function closeResumeBuilderDialog() {
  $('#resumeBuilderDialog').close();
}

async function submitResumeBuilder(event) {
  event.preventDefault();
  const mode = $('#resumeBuilderMode').value;
  setStatus(mode === 'master' ? 'Creating master resume…' : 'Analyzing job fit and approved evidence…');
  try {
    const result = await runAiTask(
      mode === 'master' ? 'Creating your master resume…' : 'Analyzing and tailoring your resume…',
      () => mode === 'master'
        ? window.careerOps.createMasterResume({
          baseResumeId: $('#resumeBuilderSource').value,
          name: $('#resumeBuilderName').value
        })
        : window.careerOps.createTailoredResume({
          masterVariantId: $('#resumeBuilderMaster').value,
          applicationId: $('#resumeBuilderJob').value,
          name: $('#resumeBuilderName').value
        })
    );
    state.data.resumeBuilder = result.resumeBuilder;
    state.resumeBuilderVariant = result.variant;
    state.resumeBuilderMode = 'preview';
    closeResumeBuilderDialog();
    renderResumeBuilder();
    setStatus(mode === 'master' ? 'Master resume created.' : 'Tailored resume ready for review.');
  } catch (error) {
    setStatus(`Could not create resume: ${error.message}`);
  }
}

function renderResumeTailorReview(result) {
  const review = result.review || {};
  $('#resumeTailorReviewPanel').hidden = false;
  $('#resumeTailorReviewPanel').innerHTML = `
    <div class="resume-review-header">
      <strong>Recruiter feedback for ${escapeHtml(result.job?.company || 'this company')}</strong>
      <span>${escapeHtml(result.job?.role || '')}</span>
    </div>
    ${review.summary ? `<p>${escapeHtml(review.summary)}</p>` : ''}
    <div class="resume-review-grid">
      ${resumeReviewList('Strong parts', review.goodParts)}
      ${resumeReviewList('Pitfalls', review.pitfalls)}
      ${resumeReviewList('Recommended strategy', review.recommendedStrategy)}
      ${resumeReviewList('Missing / useful if true', review.missingButUseful)}
    </div>
    ${review.verdict ? `<p class="muted-block">${escapeHtml(review.verdict)}</p>` : ''}
  `;
}

function resumeReviewList(title, items = []) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  return `
    <section>
      <h4>${escapeHtml(title)}</h4>
      ${safeItems.length ? `<ul>${safeItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="muted">No major notes.</p>'}
    </section>
  `;
}

async function createAiTailoredResumeFromReview() {
  const review = state.resumeTailorReview;
  if (!review) return;
  setResumeAiLoading(
    true,
    'Creating tailored resume with GPT-5.4…',
    'Using the recruiter feedback and Knowledge Center to draft the new resume.'
  );
  setStatus('Creating tailored resume with GPT-5.4…');
  try {
    const result = await runAiTask('Creating tailored resume from recruiter feedback…', () => window.careerOps.generateTailoredResume({
      masterVariantId: review.masterVariantId,
      applicationId: review.applicationId,
      name: $('#resumeBuilderName').value || review.suggestedName,
      review: review.review
    }));
    state.data.resumeBuilder = result.resumeBuilder;
    state.resumeBuilderVariant = result.variant;
    state.resumeBuilderMode = 'preview';
    state.resumeTailorReview = null;
    closeResumeBuilderDialog();
    renderResumeBuilder();
    setStatus('AI-tailored resume created.');
  } catch (error) {
    setStatus(`Could not create tailored resume: ${error.message}`);
  } finally {
    setResumeAiLoading(false);
  }
}

async function submitResumeBuilder(event) {
  event.preventDefault();
  const mode = $('#resumeBuilderMode').value;
  setStatus(mode === 'master' ? 'Creating master resume…' : 'Getting recruiter feedback…');
  try {
    if (mode === 'master') {
      const result = await runAiTask('Creating your master resume…', () => window.careerOps.createMasterResume({
        baseResumeId: $('#resumeBuilderSource').value,
        name: $('#resumeBuilderName').value
      }));
      state.data.resumeBuilder = result.resumeBuilder;
      state.resumeBuilderVariant = result.variant;
      state.resumeBuilderMode = 'preview';
      closeResumeBuilderDialog();
      renderResumeBuilder();
      setStatus('Master resume created.');
      return;
    }
    setResumeAiLoading(
      true,
      'Asking GPT-5.4 for recruiter feedback…',
      'Reviewing the resume against the selected job description.'
    );
    const result = await runAiTask('Asking GPT-5.4 for recruiter feedback…', () => window.careerOps.reviewResumeForJob({
      masterVariantId: $('#resumeBuilderMaster').value,
      applicationId: $('#resumeBuilderJob').value,
      name: $('#resumeBuilderName').value
    }));
    state.resumeTailorReview = result;
    renderResumeTailorReview(result);
    $('#submitResumeBuilderBtn').hidden = true;
    $('#createAiTailoredResumeBtn').hidden = false;
    setStatus('Recruiter feedback ready. Review it before creating a tailored resume.');
  } catch (error) {
    setStatus(`Could not create resume: ${error.message}`);
  } finally {
    setResumeAiLoading(false);
  }
}

async function saveResumeBuilderVariant() {
  if (!state.resumeBuilderVariant) return;
  setStatus('Saving immutable resume version…');
  try {
    const result = await window.careerOps.saveResumeBuilderVariant({
      id: state.resumeBuilderVariant.id,
      content: $('#resumeBuilderEditor').value,
      pdfEdits: isPdfResumeVariant(state.resumeBuilderVariant) ? state.resumePdfEdits : undefined
    });
    state.data.resumeBuilder = result.resumeBuilder;
    state.resumeBuilderVariant = result.variant;
    state.resumeBuilderMode = 'preview';
    renderResumeBuilder();
    setStatus('Resume version saved.');
  } catch (error) {
    setStatus(`Could not save resume: ${error.message}`);
  }
}

async function decideResumeSuggestion(suggestionId, decision) {
  setStatus(`${decision === 'accepted' ? 'Approving' : 'Rejecting'} suggested change…`);
  try {
    const result = await window.careerOps.decideResumeBuilderSuggestion({
      variantId: state.resumeBuilderVariant.id,
      suggestionId,
      decision
    });
    state.data.resumeBuilder = result.resumeBuilder;
    state.resumeBuilderVariant = result.variant;
    renderResumeBuilder();
    setStatus(`Suggestion ${decision}.`);
  } catch (error) {
    setStatus(`Could not update suggestion: ${error.message}`);
  }
}

async function deleteResumeBuilderVariant() {
  const variant = state.resumeBuilderVariant;
  if (!variant) return;
  if (!window.confirm(`Delete "${variant.name}" from Resume Builder? The uploaded source resume will stay in Settings.`)) return;
  setStatus('Deleting resume builder variant…');
  try {
    const result = await window.careerOps.deleteResumeBuilderVariant({ id: variant.id });
    state.data.resumeBuilder = result.resumeBuilder;
    state.resumeBuilderVariant = (result.resumeBuilder.variants || [])[0] || null;
    state.resumeBuilderMode = 'preview';
    renderResumeBuilder();
    setStatus('Resume builder variant deleted.');
  } catch (error) {
    setStatus(`Could not delete resume builder variant: ${error.message}`);
  }
}

async function exportResumeBuilderVariant(format) {
  if (!state.resumeBuilderVariant) return;
  setStatus(`Exporting ${format.toUpperCase()}…`);
  try {
    if (format === 'pdf' && isPdfResumeVariant(state.resumeBuilderVariant) && $('#resumePdfEditor').hidden) {
      state.resumeBuilderMode = 'edit';
      applyResumeBuilderMode();
      await waitForPdfEditor();
    }
    const result = await window.careerOps.exportResumeBuilderVariant({
      id: state.resumeBuilderVariant.id,
      format,
      renderedPages: format === 'pdf' && isPdfResumeVariant(state.resumeBuilderVariant)
        ? renderedPdfPages()
        : undefined
    });
    await window.careerOps.openPath(result.path);
    setStatus(result.preservedOriginalFormatting
      ? `${format.toUpperCase()} exported with the original DOCX formatting preserved.`
      : `${format.toUpperCase()} exported using the standard resume layout.`);
  } catch (error) {
    setStatus(`Could not export resume: ${error.message}`);
  }
}

async function waitForPdfEditor() {
  const container = $('#resumePdfEditor');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (container.querySelector('.pdf-layout-page')) return;
    if (container.querySelector('.empty-state')) throw new Error(container.textContent.trim());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The PDF layout editor did not finish rendering.');
}

function resumeBuilderSourcePath(variant) {
  if (variant.jobContext?.sourcePath) return variant.jobContext.sourcePath;
  const resume = (state.data.resumeBuilder?.resumes || []).find((item) => item.id === variant.baseResumeId);
  return resume?.path || '';
}

function openResumeBuilderSource() {
  const sourcePath = resumeBuilderSourcePath(state.resumeBuilderVariant || {});
  if (sourcePath) window.careerOps.openPath(sourcePath);
}

async function renameResume(id) {
  const resume = (state.data.settings.resumes || []).find((item) => item.id === id);
  const name = window.prompt('Rename resume', resume?.name || '');
  if (!name?.trim() || name.trim() === resume?.name) return;
  try {
    const result = await window.careerOps.renameResume({ id, name: name.trim() });
    state.data.settings.resumes = result.resumes;
    state.data.settings.resume = result.settings;
    state.data.knowledgeCenter = result.knowledgeCenter;
    renderSettings();
    renderKnowledgeCenter();
    setStatus('Resume renamed.');
  } catch (error) {
    setStatus(`Could not rename resume: ${error.message}`);
  }
}

async function deleteResume(id) {
  const resume = (state.data.settings.resumes || []).find((item) => item.id === id);
  if (!window.confirm(`Delete "${resume?.name || 'this resume'}"? Its extracted knowledge will also be removed.`)) return;
  try {
    const result = await window.careerOps.deleteResume({ id });
    state.data.settings.resumes = result.resumes;
    state.data.settings.resume = result.settings;
    state.data.resume = result.resume;
    state.data.knowledgeCenter = result.knowledgeCenter;
    renderSettings();
    renderKnowledgeCenter();
    setStatus('Resume deleted.');
  } catch (error) {
    setStatus(`Could not delete resume: ${error.message}`);
  }
}

function resumeExtension(resume) {
  const match = String(resume.path || resume.name || '').match(/\.([a-z0-9]+)$/i);
  return (match?.[1] || 'DOC').toUpperCase().slice(0, 4);
}

function formatResumeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'recently' : date.toLocaleDateString();
}

async function viewResume(id) {
  setStatus('Loading resume preview…');
  try {
    const resume = await window.careerOps.getResume(id);
    state.viewedResumeId = id;
    $('#resumeViewerTitle').textContent = resume.name;
    $('#resumeViewerStatus').textContent = resume.isPrimary ? 'Currently used as your primary resume' : 'Saved in your resume library';
    $('#makeViewedResumePrimaryBtn').hidden = resume.isPrimary;
    $('#resumeViewerContent').innerHTML = formatMarkdownReport(resume.content || '');
    $('#resumeViewerDialog').showModal();
    setStatus('Resume preview ready.');
  } catch (error) {
    setStatus(`Could not open resume: ${error.message}`);
  }
}

function closeResumeViewer() {
  $('#resumeViewerDialog').close();
  state.viewedResumeId = null;
}

async function setPrimaryResume(id) {
  setStatus('Updating primary resume…');
  try {
    const result = await window.careerOps.setPrimaryResume({ id });
    state.data.settings.resumes = result.resumes;
    state.data.settings.resume = result.settings;
    state.data.resume = result.resume;
    renderSettings();
    if ($('#resumeViewerDialog').open) closeResumeViewer();
    setStatus('Primary resume updated.');
  } catch (error) {
    setStatus(`Could not update primary resume: ${error.message}`);
  }
}

function shouldShowGuidedSetup() {
  const setup = state.data.settings.setup || {};
  const candidate = state.data.settings.candidate || {};
  const hasResume = Boolean(state.data.resume?.trim());
  const hasProfile = Boolean(
    setup.profile?.fullName
    || candidate.full_name
    || setup.profile?.email
    || candidate.email
  );
  const hasCareerGoals = Boolean(
    setup.careerGoals?.targetRoles?.length
    || state.data.settings.targetRoles?.length
    || state.data.settings.titleKeywords?.length
  );
  return !(hasResume && hasProfile && hasCareerGoals);
}

function setCheckedValues(name, values) {
  const selected = new Set(values || []);
  $$(`input[name="${name}"]`).forEach((input) => {
    input.checked = selected.has(input.value);
  });
}

function resumeSummary(resume) {
  const text = String(resume || '').replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim();
  return text ? `${text.slice(0, 280)}${text.length > 280 ? '…' : ''}` : 'Import a resume to generate a profile preview.';
}

function renderCoverLetter() {
  const letters = state.data.coverLetters || [];
  const allJobs = state.data.applications.filter((row) =>
    (row.crmStatus || mapCareerOpsStatusToCRM(row.status)) === 'need_to_apply');

  const query = ($('#coverLetterSearch')?.value || '').trim().toLowerCase();
  const jobs = query
    ? allJobs.filter((row) =>
        row.company.toLowerCase().includes(query) || row.role.toLowerCase().includes(query))
    : allJobs;

  const withLetter = jobs.filter((row) => coverLetterForJob(row, letters));
  const withoutLetter = jobs.filter((row) => !coverLetterForJob(row, letters));
  const sortedJobs = [...withLetter, ...withoutLetter];

  if (!sortedJobs.some((row) => row.number === state.coverLetterJobNumber)) {
    state.coverLetterJobNumber = sortedJobs[0]?.number || null;
  }
  $('#coverLetterJobCount').textContent = `${allJobs.length} job${allJobs.length === 1 ? '' : 's'}`;

  const jobButton = (row) => {
    const letter = coverLetterForJob(row, letters);
    return `<button class="cover-letter-job ${row.number === state.coverLetterJobNumber ? 'active' : ''}" data-number="${row.number}">
      <span>${escapeHtml(row.company)}</span>
      <strong>${escapeHtml(row.role)}</strong>
      <em class="${letter ? 'ready' : ''}">${letter ? 'Cover letter ready' : 'Not generated'}</em>
    </button>`;
  };

  let listHtml = '';
  if (!sortedJobs.length) {
    listHtml = query
      ? '<div class="empty-state">No jobs match your search.</div>'
      : '<div class="empty-state">No jobs are currently in Need to Apply.</div>';
  } else {
    if (withLetter.length) {
      listHtml += `<div class="cover-letter-group-label">Generated</div>${withLetter.map(jobButton).join('')}`;
    }
    if (withoutLetter.length) {
      listHtml += `<div class="cover-letter-group-label">Not yet generated</div>${withoutLetter.map(jobButton).join('')}`;
    }
  }
  $('#coverLetterJobList').innerHTML = listHtml;

  $$('.cover-letter-job').forEach((button) => {
    button.addEventListener('click', () => {
      state.coverLetterJobNumber = Number(button.dataset.number);
      renderCoverLetter();
    });
  });

  const row = sortedJobs.find((item) => item.number === state.coverLetterJobNumber) || null;
  const letter = row ? coverLetterForJob(row, letters) : null;
  state.coverLetter = letter;
  $('#coverLetterEditorTitle').textContent = row ? `${row.company} — ${row.role}` : 'Cover letter editor';
  $('#coverLetterPath').textContent = row
    ? (letter ? 'Linked cover letter ready' : 'No cover letter generated for this job')
    : 'Choose a job from the left';
  $('#coverLetterEditor').value = letter?.content || '';
  $('#coverLetterEmpty').hidden = Boolean(row);
  $('#coverLetterWorkspace').hidden = !row;
  $('#generateSelectedCoverLetterBtn').hidden = Boolean(letter);
  $('#generateSelectedCoverLetterBtn').disabled = !row;
  $('#generateSelectedCoverLetterBtn').textContent = 'Generate cover letter';
  $('#saveCoverLetterBtn').disabled = !letter;
  $('#openCoverLetterBtn').disabled = !letter;
}

function coverLetterForJob(row, letters = state.data.coverLetters || []) {
  return letters.find((letter) => Number(letter.applicationNumber) === row.number)
    || letters.find((letter) => letter.path === row.coverLetterPath)
    || letters.find((letter) => String(letter.name || '').startsWith(`${String(row.number).padStart(3, '0')}-`))
    || null;
}

async function runScan() {
  if (!state.data.diagnostics.valid) {
    setStatus('Scan needs initialized application data first.');
    return;
  }
  setStatus('Scanning job portals. This may take a bit...');
  $('#scanBtn').disabled = true;
  try {
    const result = await window.careerOps.scan();
    applyDashboardData(result.dashboard, { render: true });
    setStatus(result.ok ? `Scan complete. ${scanSummaryLine(result.output)}`.trim() : `Scan failed: ${scanSummaryLine(result.output) || `exit ${result.code}`}`);
  } finally {
    $('#scanBtn').disabled = false;
  }
}

function openAddJobDialog() {
  const dialog = $('#addJobDialog');
  $('#jobLinkInput').value = '';
  $('#jobStageSelect').value = 'need_to_apply';
  $('#addJobFeedback').textContent = '';
  $('#addJobFeedback').classList.remove('error');
  dialog.showModal();
  requestAnimationFrame(() => $('#jobLinkInput').focus());
}

function closeAddJobDialog() {
  $('#addJobDialog').close();
}

async function addJobLink(event) {
  event.preventDefault();
  const url = $('#jobLinkInput').value.trim();
  const crmStatus = $('#jobStageSelect').value;
  if (!url) return;
  $('#submitAddJobBtn').disabled = true;
  $('#addJobFeedback').textContent = 'Reading the job posting and adding it…';
  $('#addJobFeedback').classList.remove('error');
  setStatus('Adding job link and identifying the posting...');
  try {
    const result = await window.careerOps.addDashboardJob({ url, crmStatus });
    applyDashboardData(result.dashboard, { render: true });
    closeAddJobDialog();
    setView('dashboard');
    setStatus(result.message || 'Job added to the dashboard.');
  } catch (error) {
    setStatus(`Could not add job: ${error.message}`);
    $('#addJobFeedback').textContent = `Could not add job: ${error.message}`;
    $('#addJobFeedback').classList.add('error');
    $('#jobLinkInput').focus();
  } finally {
    $('#submitAddJobBtn').disabled = false;
  }
}

async function chooseRoot() {
  const picked = await window.careerOps.pickRoot();
  if (!picked) return;
  setStatus(`Connected to ${picked}`);
  state.selectedNumber = null;
  await load();
}

async function saveSettings() {
  setStatus('Saving scanner titles...');
  const settings = await window.careerOps.saveSettings({ titleKeywords: $('#titleKeywords').value });
  state.data.settings = settings;
  renderSettings();
  setStatus('Scanner titles saved.');
}

function showSetupStep(step, scroll = false) {
  state.setupStep = step;
  $$('.setup-step').forEach((button) => button.classList.toggle('active', button.dataset.setupStep === step));
  $$('.setup-pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.setupPane === step));
  if (scroll) $('.setup-workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openSetupEditor(step) {
  state.setupEditing = true;
  document.body.classList.add('setup-required', 'setup-editing');
  showSetupStep(step);
  $$('.setup-next').forEach((button) => {
    button.dataset.defaultLabel ||= button.textContent;
    button.textContent = 'Save changes';
  });
  $('.setup-workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeSetupEditor() {
  state.setupEditing = false;
  document.body.classList.remove('setup-editing');
  document.body.classList.toggle('setup-required', shouldShowGuidedSetup());
  $$('.setup-next').forEach((button) => {
    button.textContent = button.dataset.defaultLabel || button.textContent;
  });
  $('.advanced-settings').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function continueSetup(nextStep) {
  const current = state.setupStep;
  const error = validateSetupStep(current);
  const validation = $(`#${current}Validation`);
  if (validation) validation.textContent = error || '';
  if (error) return;
  await saveGuidedSetup();
  if (state.setupEditing) {
    closeSetupEditor();
    return;
  }
  showSetupStep(nextStep);
}

function validateSetupStep(step) {
  if (step === 'resume' && !state.data.resume?.trim()) return 'Import a resume before continuing.';
  if (step === 'profile') {
    if (!$('#profileFullName').value.trim()) return 'Enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($('#profileEmail').value.trim())) return 'Enter a valid email address.';
  }
  if (step === 'goals') {
    if (listFromInput($('#targetRolesInput').value).length === 0) return 'Add at least one target role.';
    if (listFromInput($('#targetLocationsInput').value).length === 0) return 'Add at least one target location.';
  }
  if (step === 'preferences') {
    if (checkedValues('workMode').length === 0) return 'Choose at least one work mode.';
    if (checkedValues('seniority').length === 0) return 'Choose at least one seniority.';
    if (checkedValues('employmentType').length === 0) return 'Choose at least one employment type.';
    if (listFromInput($('#authorizedCountriesInput').value).length === 0 && checkedValues('hardConstraint').includes('geography')) {
      return 'Add at least one authorized country, such as US.';
    }
  }
  return '';
}

function setupPayload(overrides = {}) {
  const current = state.data.settings.setup || {};
  return {
    profile: {
      fullName: $('#profileFullName').value.trim(),
      email: $('#profileEmail').value.trim(),
      headline: $('#profileHeadline').value.trim()
    },
    careerGoals: {
      targetRoles: listFromInput($('#targetRolesInput').value),
      targetLocations: listFromInput($('#targetLocationsInput').value)
    },
    jobPreferences: {
      compensationMin: Number($('#compensationMin').value) || 0,
      compensationCurrency: $('#compensationCurrency').value,
      workModes: checkedValues('workMode'),
      employmentTypes: checkedValues('employmentType'),
      acceptedSeniorities: checkedValues('seniority'),
      authorizedCountries: listFromInput($('#authorizedCountriesInput').value).map((value) => value.toUpperCase()),
      remoteLocationPolicy: $('#remoteLocationPolicy').value,
      excludedTitles: listFromInput($('#excludedTitlesInput').value),
      hardConstraints: Object.fromEntries(['targetRole', 'seniority', 'employmentType', 'workMode', 'geography', 'compensation']
        .map((key) => [key, checkedValues('hardConstraint').includes(key)])),
      exceptions: parseMatchingExceptions($('#matchingExceptionsInput').value),
      requiresSponsorship: $('#requiresSponsorship').checked
    },
    privacy: {
      localOnly: $('#localOnlyToggle').checked,
      analytics: $('#analyticsToggle').checked
    },
    onboardingComplete: Boolean(overrides.onboardingComplete ?? current.onboardingComplete),
    extensionTestedAt: overrides.extensionTestedAt ?? current.extensionTestedAt ?? '',
    sampleRecommendationRunAt: overrides.sampleRecommendationRunAt ?? current.sampleRecommendationRunAt ?? ''
  };
}

async function saveGuidedSetup(overrides = {}) {
  const result = await window.careerOps.saveSetupSettings(setupPayload(overrides));
  state.data.settings.setup = result.setup;
  if (result.knowledgeCenter) state.data.knowledgeCenter = result.knowledgeCenter;
  renderCurrentSettings();
  renderSetupProgress();
  renderKnowledgeCenter();
  setStatus('Settings saved.');
  return result.setup;
}

function listFromInput(value) {
  return [...new Set(String(value || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function checkedValues(name) {
  return $$(`input[name="${name}"]:checked`).map((input) => input.value);
}

function parseMatchingExceptions(value) {
  return String(value || '').split(/\r?\n/).flatMap((line) => {
    const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
    const subject = parts.shift()?.match(/^(company|title)\s*:\s*(.+)$/i);
    if (!subject) return [];
    const fields = Object.fromEntries(parts.map((part) => {
      const [key, raw = ''] = part.split('=');
      return [key.trim().toLowerCase(), raw.split(',').map((item) => item.trim()).filter(Boolean)];
    }));
    return [{
      kind: subject[1].toLowerCase() === 'title' ? 'title_pattern' : 'company',
      value: subject[2].trim(),
      allowSeniorities: fields.seniority || [],
      allowEmploymentTypes: fields.employment || [],
      allowCountries: (fields.countries || []).map((country) => country.toUpperCase())
    }];
  });
}

function formatMatchingExceptions(exceptions) {
  return (exceptions || []).map((exception) => [
    `${exception.kind === 'title_pattern' ? 'title' : 'company'}: ${exception.value}`,
    exception.allowSeniorities?.length ? `seniority=${exception.allowSeniorities.join(',')}` : '',
    exception.allowEmploymentTypes?.length ? `employment=${exception.allowEmploymentTypes.join(',')}` : '',
    exception.allowCountries?.length ? `countries=${exception.allowCountries.join(',')}` : ''
  ].filter(Boolean).join(' | ')).join('\n');
}

function setupCompletion() {
  const setup = state.data.settings.setup || {};
  return {
    resume: Boolean(state.data.resume?.trim()),
    profile: Boolean((setup.profile?.fullName || $('#profileFullName').value.trim()) && (setup.profile?.email || $('#profileEmail').value.trim())),
    goals: (setup.careerGoals?.targetRoles?.length || listFromInput($('#targetRolesInput').value).length) > 0
      && (setup.careerGoals?.targetLocations?.length || listFromInput($('#targetLocationsInput').value).length) > 0,
    preferences: (setup.jobPreferences?.workModes?.length || checkedValues('workMode').length) > 0
      && (setup.jobPreferences?.acceptedSeniorities?.length || checkedValues('seniority').length) > 0
      && (setup.jobPreferences?.employmentTypes?.length || checkedValues('employmentType').length) > 0,
    extension: Boolean(setup.extensionTestedAt),
    recommendation: Boolean(setup.sampleRecommendationRunAt)
  };
}

function renderSetupProgress() {
  const completion = setupCompletion();
  const completeCount = Object.values(completion).filter(Boolean).length;
  $('#setupProgressText').textContent = `${completeCount} of 6 setup steps complete`;
  $('#setupProgressBar').style.width = `${(completeCount / 6) * 100}%`;
  const labels = {
    resume: completion.resume ? 'Complete' : 'Required',
    profile: completion.profile ? 'Complete' : 'Required',
    goals: completion.goals ? 'Complete' : 'Required',
    preferences: completion.preferences ? 'Complete' : 'Required',
    extension: completion.extension ? 'Tested' : 'Recommended',
    recommendation: completion.recommendation ? 'Complete' : 'Final check'
  };
  Object.entries(labels).forEach(([key, value]) => {
    $(`#${key}StepStatus`).textContent = value;
    $(`.setup-step[data-setup-step="${key}"]`).classList.toggle('complete', completion[key]);
  });
  $('#profileSectionStatus').textContent = completion.profile ? 'Complete' : 'Needs review';
  $('#goalsSectionStatus').textContent = completion.goals ? 'Configured' : 'Not set';
  $('#preferencesSectionStatus').textContent = completion.preferences ? 'Configured' : 'Not set';
  $('#documentsSectionStatus').textContent = completion.resume ? 'Resume ready' : 'No resume';
  $('#integrationsSectionStatus').textContent = completion.extension ? 'Extension tested' : 'Extension not tested';
  const testedAt = state.data.settings.setup?.extensionTestedAt;
  if (testedAt) {
    $('#extensionStatusDot').classList.add('connected');
    $('#extensionConnectionTitle').textContent = 'Local connection available';
    $('#extensionConnectionDetail').textContent = `Last tested ${new Date(testedAt).toLocaleString()}.`;
  }
}

function toggleAdvancedMode(event) {
  state.advancedMode = event.target.checked;
  localStorage.setItem('advancedMode', String(state.advancedMode));
  document.body.classList.toggle('advanced-mode', state.advancedMode);
}

async function testExtension() {
  $('#testExtensionBtn').disabled = true;
  $('#extensionConnectionTitle').textContent = 'Testing local connection…';
  try {
    const result = await window.careerOps.extensionContext();
    if (!result.ok || !result.connected) throw new Error('Extension API did not respond.');
    const testedAt = new Date().toISOString();
    await saveGuidedSetup({ extensionTestedAt: testedAt });
    $('#extensionStatusDot').classList.add('connected');
    $('#extensionConnectionTitle').textContent = 'Local connection available';
    $('#extensionConnectionDetail').textContent = 'The extension API is ready. Open the extension in Chrome to verify installation.';
    setStatus('Extension connection test passed.');
  } catch (error) {
    $('#extensionStatusDot').classList.remove('connected');
    $('#extensionConnectionTitle').textContent = 'Connection test failed';
    $('#extensionConnectionDetail').textContent = error.message;
    setStatus(`Extension test failed: ${error.message}`);
  } finally {
    $('#testExtensionBtn').disabled = false;
  }
}

async function runSampleRecommendation() {
  const error = ['resume', 'profile', 'goals', 'preferences'].map(validateSetupStep).find(Boolean);
  if (error) {
    $('#recommendationValidation').textContent = error;
    return;
  }
  await saveGuidedSetup({ sampleRecommendationRunAt: new Date().toISOString() });
  const roles = listFromInput($('#targetRolesInput').value);
  const locations = listFromInput($('#targetLocationsInput').value);
  const modes = checkedValues('workMode');
  const compensation = Number($('#compensationMin').value);
  const candidate = state.data.applications
    .filter((row) => row.isScored)
    .sort((a, b) => b.score - a.score)[0];
  $('#sampleRecommendation').classList.remove('empty-state');
  $('#sampleRecommendation').innerHTML = `
    <span class="recommendation-kicker">Your search strategy</span>
    <h4>Prioritize ${escapeHtml(roles.slice(0, 2).join(' and '))}</h4>
    <p>Focus on ${escapeHtml(locations.slice(0, 3).join(', '))} opportunities with ${escapeHtml(modes.join(' or ').toLowerCase())} flexibility${compensation ? ` and base compensation from ${escapeHtml($('#compensationCurrency').value)} ${compensation.toLocaleString()}` : ''}.</p>
    ${candidate ? `<div class="sample-match"><span>Example from your pipeline</span><strong>${escapeHtml(candidate.company)} — ${escapeHtml(candidate.role)}</strong><em>${formatScore(candidate)} fit</em></div>` : '<div class="sample-match"><span>Next action</span><strong>Run your first scan to find matching roles</strong></div>'}
  `;
  $('#recommendationValidation').textContent = '';
  renderSetupProgress();
  setStatus('Sample recommendation generated.');
}

async function finishSetup() {
  const error = ['resume', 'profile', 'goals', 'preferences'].map(validateSetupStep).find(Boolean);
  if (error) {
    $('#recommendationValidation').textContent = error;
    return;
  }
  if (!state.data.settings.setup?.sampleRecommendationRunAt) await runSampleRecommendation();
  await saveGuidedSetup({ onboardingComplete: true });
  setStatus('Setup complete. Career Ops is ready.');
  await testSetup();
}

async function testSetup() {
  $('#testSetupBtn').disabled = true;
  setStatus('Running setup diagnostics…');
  try {
    const result = await window.careerOps.testSetup();
    const failed = result.checks.filter((check) => !check.ok && !check.optional);
    const details = result.checks.map((check) => `${check.ok ? '✓' : check.optional ? '○' : '×'} ${check.label}: ${check.detail}`).join('\n');
    window.alert(`Setup diagnostic\n\n${details}`);
    setStatus(failed.length ? `${failed.length} required setup check(s) need attention.` : 'Setup diagnostic passed.');
  } catch (error) {
    setStatus(`Setup diagnostic failed: ${error.message}`);
  } finally {
    $('#testSetupBtn').disabled = false;
  }
}

async function saveAiSettings() {
  setStatus('Saving AI settings...');
  state.data.settings = await window.careerOps.saveAiSettings({
    apiKey: $('#openAiKey').value,
    coverLetterModel: $('#openAiModel').value
  });
  renderSettings();
  setStatus('AI settings saved.');
}

async function testAi() {
  setStatus('Testing OpenAI API...');
  $('#testAiBtn').disabled = true;
  try {
    const result = await runAiTask(
      'Testing the AI connection…',
      () => window.careerOps.testAi()
    );
    $('#aiTestStatus').textContent = `Cover-letter model OK. Requested: ${result.requestedModel}. Response model: ${result.responseModel || 'not reported'}. Internal tasks remain on ${result.internalModel}.`;
    setStatus('OpenAI API test succeeded.');
  } catch (error) {
    $('#aiTestStatus').textContent = `API test failed: ${error.message}`;
    setStatus(`OpenAI API test failed: ${error.message}`);
  } finally {
    $('#testAiBtn').disabled = false;
  }
}

async function chooseCoverLetterFolder() {
  setStatus('Choosing cover letter output folder...');
  const result = await window.careerOps.pickCoverLetterFolder();
  if (!result) {
    setStatus('Cover letter output folder unchanged.');
    return;
  }
  state.data.settings.coverLetters = result;
  $('#coverLetterOutputDir').value = result.outputDir;
  applyDashboardData(await window.careerOps.load(), { render: true });
  setStatus(`Cover letters will be generated in ${result.outputDir}`);
}

async function uploadResume() {
  setStatus('Choosing resume file...');
  try {
    const result = await window.careerOps.uploadResume();
    if (!result) {
      setStatus('Resume upload canceled.');
      return;
    }
    state.data.resume = result.resume;
    state.data.settings.resume = result.settings;
    state.data.settings.resumes = result.resumes || state.data.settings.resumes || [];
    if (result.knowledgeCenter) state.data.knowledgeCenter = result.knowledgeCenter;
    renderSettings();
    renderKnowledgeCenter();
    setStatus(result.message || 'Resume uploaded.');
  } catch (error) {
    setStatus(`Resume upload failed: ${error.message}`);
  }
}

async function createCoverLetter(row) {
  setStatus(`Generating DOCX cover letter for ${row.company}...`);
  try {
    const result = await runAiTask(
      `Generating cover letter for ${row.company}…`,
      () => window.careerOps.coverLetter(row)
    );
    state.coverLetterJobNumber = row.number;
    state.coverLetter = result;
    state.data.coverLetters = [result, ...(state.data.coverLetters || []).filter((letter) => letter.relativePath !== result.relativePath)];
    renderCoverLetter();
    closeDrawer();
    setView('coverLetter');
    setStatus(`DOCX cover letter ready: ${result.relativePath}`);
  } catch (error) {
    setStatus(`Cover letter failed: ${error.message}`);
  }
}

async function saveCoverLetter() {
  if (!state.coverLetter) return;
  setStatus('Saving DOCX cover letter...');
  await window.careerOps.saveCoverLetter({
    path: state.coverLetter.path,
    content: $('#coverLetterEditor').value
  });
  state.coverLetter.content = $('#coverLetterEditor').value;
  setStatus('DOCX cover letter saved.');
}

function toggleAllPending(event) {
  const visibleUrls = $$('.pending-check').map((check) => check.dataset.url).filter(Boolean);
  if (event.target.checked) visibleUrls.forEach((url) => state.pendingSelection.add(url));
  else visibleUrls.forEach((url) => state.pendingSelection.delete(url));
  renderPending();
}

function selectOldPending() {
  for (const job of state.data.pendingJobs || []) {
    if ((job.ageDays || 0) >= 30) state.pendingSelection.add(job.url);
  }
  renderPending();
  setStatus('Selected pending jobs first seen 30+ days ago.');
}

async function checkSelectedPending() {
  const urls = selectedPendingUrls();
  if (urls.length === 0) {
    setStatus('Select pending jobs to check first.');
    return;
  }
  setStatus(`Checking ${urls.length} selected jobs...`);
  const result = await window.careerOps.checkPendingAvailability({ urls });
  for (const item of result.results || []) {
    state.availability.set(item.url, item);
    if (!item.available) state.pendingSelection.add(item.url);
  }
  renderPending();
  setStatus('Availability check complete. Unavailable jobs were selected.');
}

async function discardSelectedPending() {
  const urls = selectedPendingUrls();
  if (urls.length === 0) {
    setStatus('Select pending jobs to discard first.');
    return;
  }
  setStatus(`Discarding ${urls.length} pending jobs...`);
  const result = await window.careerOps.discardPending({ urls });
  state.pendingSelection.clear();
  applyDashboardData(result.dashboard, { render: true });
  setStatus(result.message);
}

async function evaluatePending(urls) {
  const selected = urls.filter(Boolean);
  if (selected.length === 0) {
    setStatus('Select pending jobs to evaluate first.');
    return;
  }
  setStatus(`Running bulk workflow for ${selected.length} pending jobs...`);
  $('#evaluateSelectedBtn').disabled = true;
  $('#discardPendingBtn').disabled = true;
  try {
    state.bulkQueue.running = true;
    state.bulkQueue.message = `Queued ${selected.length} job(s).`;
    state.bulkQueue.items.clear();
    renderBulkQueue();
    showBgTask(`Evaluating ${selected.length} job${selected.length === 1 ? '' : 's'}…`);
    const result = await window.careerOps.runBulkQueue({
      urls: selected,
      includeCoverLetter: false
    });
    state.pendingSelection.clear();
    applyDashboardData(result.dashboard, { render: true });
    setStatus(result.message || 'Evaluation complete.');
  } catch (error) {
    state.bulkQueue.running = false;
    renderBulkQueue();
    setStatus(`Bulk workflow failed: ${error.message}`);
  } finally {
    $('#evaluateSelectedBtn').disabled = false;
    $('#discardPendingBtn').disabled = false;
    hideBgTask();
  }
}

function selectedPendingUrls() {
  return [...state.pendingSelection];
}

function barItem(label, count, pct) {
  return `
    <div class="bar-item">
      <div class="bar-meta"><span>${escapeHtml(label)}</span><strong>${count}</strong></div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, Math.min(100, pct))}%"></div></div>
    </div>
  `;
}

function formatMarkdownReport(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const html = [];
  let inList = false;
  let inTable = false;
  let seenFirstHeading = false;
  let inMetaBlock = false;
  let metaBlockDone = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      html.push('</tbody></table>');
      inTable = false;
    }
  };
  const closeMetaBlock = () => {
    if (inMetaBlock) {
      html.push('</div></details>');
      inMetaBlock = false;
      metaBlockDone = true;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      closeList();
      closeTable();
      closeMetaBlock();
      const headers = splitTable(line);
      html.push('<table class="report-table"><thead><tr>');
      html.push(headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join(''));
      html.push('</tr></thead><tbody>');
      inTable = true;
      i += 1;
      continue;
    }
    if (inTable && /^\s*\|/.test(line)) {
      const cells = splitTable(line);
      html.push(`<tr>${cells.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`);
      continue;
    }
    closeTable();

    if (!line.trim()) {
      closeList();
      closeMetaBlock();
      html.push('<div class="report-space"></div>');
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      closeMetaBlock();
      seenFirstHeading = true;
      const level = Math.min(3, heading[1].length);
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const field = line.match(/^\*\*([^:*]+):\*\*\s*(.*)$/);
    if (field) {
      closeList();
      if (seenFirstHeading && !metaBlockDone && !inMetaBlock) {
        html.push('<details class="report-meta"><summary>Details</summary><div>');
        inMetaBlock = true;
      }
      html.push(`<div class="report-field"><span>${escapeHtml(field[1])}</span><strong>${inlineMarkdown(field[2])}</strong></div>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      closeMetaBlock();
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    closeList();
    closeMetaBlock();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  closeTable();
  closeMetaBlock();
  return html.join('');
}

function splitTable(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="report-link">$1</span>');
}

function setStatus(message) {
  $('#statusStrip').textContent = message;
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).find(Boolean) || '';
}

function scanSummaryLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const keys = [
    'New offers added:',
    'Duplicates:',
    'Filtered by title:',
    'Portal search results:',
    'Portal searches run:',
    'Verification deferred:',
    'Total jobs found:',
    'Companies scanned:'
  ];
  const summary = keys
    .map((key) => lines.find((line) => line.startsWith(key)))
    .filter(Boolean)
    .join(' ');
  return summary || firstLine(text);
}

function scoreClass(score) {
  if (!Number.isFinite(score)) return 'unscored';
  if (score >= 4.2) return 'great';
  if (score >= 3.8) return 'good';
  if (score >= 3.0) return 'ok';
  return 'low';
}

function formatScore(row, includeScale = true) {
  if (!row?.isScored || !Number.isFinite(row.score)) return 'N/A';
  return `${Number(row.score).toFixed(1)}${includeScale ? '/5' : ''}`;
}

function statusRank(status) {
  const order = ['interview', 'offer', 'responded', 'online assessment', 'applied', 'evaluated', 'skip', 'rejected', 'discarded'];
  const idx = order.indexOf(normalizeStatus(status));
  return idx >= 0 ? idx : 99;
}

function normalizeStatus(status) {
  return String(status || '').toLowerCase().replaceAll('*', '').trim();
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function viewTitle(value) {
  const labels = {
    dashboard: 'Dashboard',
    discovery: 'Discovery',
    recommended: 'Recommended',
    reports: 'Reports',
    coverLetter: 'Cover Letter',
    resumeBuilder: 'Resume Builder',
    knowledge: 'Knowledge Center',
    settings: 'Settings'
  };
  return labels[value] || value.slice(0, 1).toUpperCase() + value.slice(1);
}

function mapCareerOpsStatusToCRM(status) {
  const normalized = normalizeStatus(status);
  if (normalized === 'applied' || normalized === 'responded') return 'applied';
  if (normalized === 'online assessment') return 'online_assessment';
  if (normalized === 'interview') return 'interview';
  if (normalized === 'offer') return 'offer';
  if (['rejected', 'discarded', 'skip'].includes(normalized)) return 'rejected_archived';
  return 'need_to_apply';
}

function crmStatusToCareerOps(status) {
  const mapping = {
    need_to_apply: 'Evaluated',
    applied: 'Applied',
    online_assessment: 'Online Assessment',
    interview: 'Interview',
    offer: 'Offer',
    rejected_archived: 'Discarded'
  };
  return mapping[status] || status;
}

function crmStatusLabel(status) {
  const column = state.data.crmColumns?.find((item) => item.id === status);
  return column?.label || crmStatusToCareerOps(status);
}

function nextActionForRow(row) {
  const crm = row.crmStatus || mapCareerOpsStatusToCRM(row.status);
  if (crm === 'need_to_apply') return row.coverLetterPath ? 'Submit application' : 'Generate cover letter';
  if (crm === 'applied') return 'Track response';
  if (crm === 'online_assessment') return 'Complete assessment';
  if (crm === 'interview') return 'Prepare interview';
  if (crm === 'offer') return 'Review offer';
  return 'Archive complete';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
