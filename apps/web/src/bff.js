const multer = require('multer');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { CloudApiClient } = require('./cloud-api.js');

const upload = multer({ dest: path.join(os.tmpdir(), 'career-ops-web') });

// ─── Constants matching desktop app-core.js ────────────────────────────────

const CRM_COLUMNS = [
  { id: 'need_to_apply', label: 'Need to Apply' },
  { id: 'applied', label: 'Applied' },
  { id: 'online_assessment', label: 'Online Assessment' },
  { id: 'interview', label: 'Interview' },
  { id: 'offer', label: 'Offer' },
  { id: 'rejected_archived', label: 'Rejected / Archived' }
];

const STATES = [
  'Evaluated', 'Applied', 'Online Assessment', 'Responded',
  'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'
];

const OPENAI_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5 - best quality' },
  { id: 'gpt-5.4', label: 'GPT-5.4 - balanced' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini - recommended' }
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function appToNumber(applicationId) {
  // Deterministic stable integer for a given applicationId UUID.
  return parseInt(applicationId.slice(0, 8), 16) % 2147483647;
}

function mapStatusToCRM(status) {
  const s = String(status || '').toLowerCase().trim();
  if (s.includes('online assessment') || s === 'oa') return 'online_assessment';
  if (s.includes('applied') || s.includes('responded')) return 'applied';
  if (s.includes('interview')) return 'interview';
  if (s.includes('offer')) return 'offer';
  if (s.includes('rejected') || s.includes('discarded') || s.includes('skip') || s.includes('archived')) return 'rejected_archived';
  return 'need_to_apply';
}

function crmStatusToCareerOps(crmStatus) {
  const map = {
    need_to_apply: 'Evaluated',
    applied: 'Applied',
    online_assessment: 'Online Assessment',
    interview: 'Interview',
    offer: 'Offer',
    rejected_archived: 'Discarded'
  };
  return map[String(crmStatus || '')] || 'Evaluated';
}

function mapCloudAppToRow(item) {
  return {
    number: appToNumber(item.applicationId),
    applicationId: item.applicationId,
    company: item.company || '',
    role: item.role || '',
    url: item.url || '',
    status: item.status || 'Evaluated',
    crmStatus: mapStatusToCRM(item.status),
    notes: item.notes || '',
    score: item.score || 0,
    scoreRaw: null,
    date: item.createdAt ? item.createdAt.slice(0, 10) : null,
    appliedAt: item.appliedAt || null,
    jobDescription: item.jobDescription || '',
    jobUrl: item.url || '',
    // Fields desktop expects — null/false in the web version
    resumePath: null,
    coverLetterPath: null,
    reportPath: null,
    hasCoverLetter: false,
    hasReport: false,
    reportSummary: null,
    nextAction: null
  };
}

function mapCloudKnowledge(items) {
  return (items || []).map(item => ({
    id: item.factId,
    factId: item.factId,
    category: item.category || 'career-goals',
    content: item.content || '',
    createdAt: item.createdAt,
    status: 'active'
  }));
}

function postedDaysAgo(datePosted) {
  if (!datePosted) return null;
  const posted = new Date(`${datePosted}T00:00:00Z`);
  if (Number.isNaN(posted.getTime())) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((today - posted.getTime()) / 86400000));
}

function mapPendingJobs(items, applications) {
  const tracked = new Set((applications || [])
    .map(item => item.url)
    .filter(Boolean)
    .map(url => String(url).replace(/\/$/, '').toLowerCase()));
  return (items || []).map(item => {
    const urlKey = String(item.url || '').replace(/\/$/, '').toLowerCase();
    return {
      ...item,
      portal: item.portal || 'web',
      sourceLabel: item.sourceLabel || '',
      recommendation: item.recommendation || 'Imported',
      recommendationScore: Number(item.recommendationScore || 0),
      relevanceScore: Number(item.relevanceScore || 0),
      isRelevant: item.isRelevant !== false,
      postedDaysAgo: postedDaysAgo(item.datePosted),
      alreadyTracked: tracked.has(urlKey)
    };
  });
}

async function buildDashboard(cloudApi) {
  const [profileResult, appsResult, knowledgeResult, variantsResult] = await Promise.allSettled([
    cloudApi.get('/v1/profile'),
    cloudApi.get('/v1/applications'),
    cloudApi.get('/v1/knowledge'),
    cloudApi.get('/v1/resume-variants')
  ]);

  const profile = profileResult.status === 'fulfilled' ? profileResult.value : null;
  const applications = appsResult.status === 'fulfilled' ? (appsResult.value?.items || []) : [];
  const knowledge = knowledgeResult.status === 'fulfilled' ? (knowledgeResult.value?.items || []) : [];
  const variants = variantsResult.status === 'fulfilled' ? (variantsResult.value?.items || []) : [];

  const rows = applications.map(mapCloudAppToRow);
  const appliedCount = rows.filter(r => r.crmStatus !== 'need_to_apply' && r.crmStatus !== 'rejected_archived').length;
  const interviewCount = rows.filter(r => r.crmStatus === 'interview').length;
  const offerCount = rows.filter(r => r.crmStatus === 'offer').length;

  const setup = profile ? {
    profile: {
      fullName: profile.name || '',
      email: profile.email || '',
      headline: profile.headline || profile.currentTitle || ''
    },
    careerGoals: {
      targetRoles: profile.targetRoles || [],
      targetLocations: profile.targetLocations || []
    },
    jobPreferences: {
      workModes: profile.workModes || [],
      acceptedSeniorities: profile.acceptedSeniorities || [],
      compensationMin: profile.compensationMin || '',
      compensationCurrency: profile.compensationCurrency || 'USD',
      employmentTypes: profile.employmentTypes || [],
      authorizedCountries: profile.authorizedCountries || [],
      remoteLocationPolicy: profile.remoteLocationPolicy || 'worldwide',
      excludedTitles: profile.excludedTitles || [],
      hardConstraints: profile.hardConstraints || {}
    }
  } : {};

  return {
    careerRoot: 'Cloud (AWS)',
    diagnostics: { valid: true, node: null, dataRoot: 'AWS', checks: {} },
    states: STATES,
    crmColumns: CRM_COLUMNS,
    applications: rows,
    metrics: { total: rows.length, applied: appliedCount },
    progress: {
      total: rows.length,
      applied: appliedCount,
      interviews: interviewCount,
      offers: offerCount
    },
    analytics: null,
    followUpQueue: [],
    scanSummary: { runCount: 0, lastRun: null, newJobs: 0 },
    settings: {
      titleKeywords: profile?.targetRoles || [],
      targetRoles: profile?.targetRoles || [],
      resume: {
        sourceName: profile?.resumeText ? 'Resume on file' : null,
        pdfName: null,
        sourcePath: null
      },
      resumes: variants.map(v => ({
        id: v.variantId,
        name: v.name || `Variant ${v.variantId.slice(0, 8)}`,
        isPrimary: v.isPrimary || false
      })),
      ai: {
        hasApiKey: true,
        models: OPENAI_MODELS,
        coverLetterModel: 'gpt-5.4',
        internalModel: 'gpt-5.4-mini',
        envModel: null
      },
      coverLetters: { outputDir: '', examplePaths: [] },
      setup,
      candidate: {
        full_name: profile?.name || '',
        email: profile?.email || '',
        headline: profile?.headline || profile?.currentTitle || ''
      },
      profileDefaults: profile || {}
    },
    pendingJobs: mapPendingJobs(profile?.pendingJobs || [], applications),
    discoverySources: profile?.discoverySources || [],
    coverLetters: [],
    resume: profile?.resumeText || '',
    resumeBuilder: {
      variants: variants.map(v => ({
        id: v.variantId,
        name: v.name || `Variant ${v.variantId.slice(0, 8)}`,
        baseResumeId: v.baseResumeId || null,
        status: v.status || 'draft'
      })),
      resumes: [],
      jobs: []
    },
    knowledgeCenter: {
      records: [],
      facts: mapCloudKnowledge(knowledge)
    }
  };
}

async function findApplicationId(cloudApi, number) {
  const result = await cloudApi.get('/v1/applications');
  const items = result?.items || [];
  const item = items.find(app => appToNumber(app.applicationId) === Number(number));
  return item?.applicationId || null;
}

function mimeType(ext) {
  const map = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    txt: 'text/plain',
    md: 'text/markdown'
  };
  return map[String(ext).toLowerCase()] || 'application/octet-stream';
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function sanitizeSlug(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'untitled';
}

function titleCase(str) {
  return String(str || '').replace(/\b\w/g, l => l.toUpperCase());
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function api(req) {
  return new CloudApiClient(req.cookies.co_access_token);
}

function coverLetterStreamUrl() {
  const url = process.env.COVER_LETTER_STREAM_URL;
  if (!url) throw new Error('COVER_LETTER_STREAM_URL env var is required');
  return url;
}

// ─── Route registration ───────────────────────────────────────────────────

function registerRoutes(app) {
  // ─── Health ───────────────────────────────────────────────────────────────

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, careerRoot: 'Cloud (AWS)', diagnostics: { valid: true, checks: {} } });
  });

  // ─── Dashboard ────────────────────────────────────────────────────────────

  app.get('/api/dashboard', asyncRoute(async (req, res) => {
    res.json(await buildDashboard(api(req)));
  }));

  // ─── Cloud status (maps to auth status for the renderer) ─────────────────

  app.get('/api/cloud/status', (req, res) => {
    res.json({
      configured: Boolean(req.cookies.co_access_token),
      authenticated: Boolean(req.cookies.co_access_token),
      apiUrl: process.env.CLOUD_API_URL || '',
      syncedAt: null,
      cachedCount: 0,
      pendingActions: 0
    });
  });
  app.post('/api/cloud/sync', asyncRoute(async (req, res) => {
    res.json({ ...(await buildDashboard(api(req))), status: { authenticated: true }, offline: false });
  }));
  app.post('/api/cloud/logout', (req, res) => {
    res.clearCookie('co_access_token');
    res.clearCookie('co_refresh_token');
    res.clearCookie('co_onboarded');
    res.json({ configured: false, authenticated: false });
  });
  app.post('/api/cloud/feedback', (_req, res) => res.json({ ok: true }));
  app.post('/api/cloud/login', (_req, res) => {
    const { beginLogin } = require('./auth.js');
    res.json({ url: beginLogin() });
  });

  // ─── Add job to dashboard ─────────────────────────────────────────────────

  app.post('/api/dashboard-job', asyncRoute(async (req, res) => {
    const { url, crmStatus, role, notes, jobDescription } = req.body;
    if (!url) {
      const err = new Error('URL is required'); err.status = 400; throw err;
    }
    let company = '';
    try { company = new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch {}

    const cloudApi = api(req);
    await cloudApi.post('/v1/applications', {
      url,
      company: titleCase(company),
      role: role || '',
      status: crmStatusToCareerOps(crmStatus || 'need_to_apply'),
      notes: notes || '',
      jobDescription: jobDescription || ''
    });
    res.json(await buildDashboard(cloudApi));
  }));

  app.post('/api/pending-job', asyncRoute(async (req, res) => {
    const { url, role, company } = req.body;
    const cloudApi = api(req);
    await cloudApi.post('/v1/applications', {
      url: url || '',
      company: company || titleCase((url ? new URL(url).hostname.replace(/^www\./, '').split('.')[0] : '') || ''),
      role: role || '',
      status: 'Evaluated',
      notes: ''
    });
    res.json(await buildDashboard(cloudApi));
  }));

  // ─── Application mutations ────────────────────────────────────────────────

  app.post('/api/update-status', asyncRoute(async (req, res) => {
    const { number, status, crmStatus } = req.body;
    const cloudApi = api(req);
    const applicationId = await findApplicationId(cloudApi, number);
    if (applicationId) {
      const newStatus = status || crmStatusToCareerOps(crmStatus || 'need_to_apply');
      // PATCH is not yet fully implemented in api-handler.ts; best-effort
      await cloudApi.patch(`/v1/applications/${applicationId}`, { status: newStatus }).catch(() => {});
    }
    res.json(await buildDashboard(cloudApi));
  }));

  app.post('/api/application-notes', asyncRoute(async (req, res) => {
    const { number, notes } = req.body;
    const cloudApi = api(req);
    const applicationId = await findApplicationId(cloudApi, number);
    if (applicationId) {
      await cloudApi.patch(`/v1/applications/${applicationId}`, { notes }).catch(() => {});
    }
    res.json(await buildDashboard(cloudApi));
  }));

  app.post('/api/application-report', (_req, res) => {
    res.json({ ok: false, error: 'Application reports are not available in the web version.' });
  });

  // ─── Resume upload ────────────────────────────────────────────────────────

  app.post('/api/resume/upload', upload.single('resume'), asyncRoute(async (req, res) => {
    if (!req.file) {
      const err = new Error('No resume file uploaded.'); err.status = 400; throw err;
    }
    const ext = path.extname(req.file.originalname || '').toLowerCase().replace('.', '') || 'pdf';
    const cloudApi = api(req);

    // Fall back to the generic file endpoint so older cloud deployments can still onboard resumes.
    let uploadTarget;
    try {
      uploadTarget = await cloudApi.get(`/v1/onboarding/resume/upload-url?ext=${ext}`);
    } catch (error) {
      if (error?.status !== 404) throw error;
      uploadTarget = await cloudApi.get(`/v1/files/upload-url?type=resume&ext=${ext}`);
    }
    const { url: uploadUrl, key } = uploadTarget;

    // Upload file bytes to S3
    const fileBuffer = fs.readFileSync(req.file.path);
    try {
      const s3Res = await fetch(uploadUrl, {
        method: 'PUT',
        body: fileBuffer,
        headers: { 'content-type': mimeType(ext) }
      });
      if (!s3Res.ok) throw new Error(`S3 upload returned ${s3Res.status}`);
    } finally {
      fs.unlinkSync(req.file.path);
    }

    // Parse resume via Lambda
    const parsed = await cloudApi.post('/v1/onboarding/resume', { s3Key: key });
    const profile = parsed?.profile || {};

    res.json({
      profile,
      resume: profile.resumeText || '',
      roleChips: parsed?.roleChips || [],
      locationChips: parsed?.locationChips || [],
      settings: {
        resume: { sourceName: req.file.originalname || 'Resume', pdfName: null, sourcePath: null },
        resumes: [{ id: key, name: req.file.originalname || 'Resume', isPrimary: true }]
      },
      resumes: [{ id: key, name: req.file.originalname || 'Resume', isPrimary: true }],
      message: `Resume parsed. Found ${parsed?.roleChips?.length || 0} role suggestions.`
    });
  }));

  app.post('/api/resume', asyncRoute(async (req, res) => {
    if (req.body.text !== undefined) {
      await api(req).put('/v1/profile', { resumeText: req.body.text }).catch(() => {});
    }
    res.json({ ok: true });
  }));

  app.get('/api/resumes/:id', (_req, res) => res.json({ id: _req.params.id, content: '' }));
  app.post('/api/resumes/primary', (_req, res) => res.json({ ok: true }));
  app.post('/api/resumes/rename', (_req, res) => res.json({ ok: true }));
  app.post('/api/resumes/delete', (_req, res) => res.json({ ok: true }));

  // ─── Cover letter generation ──────────────────────────────────────────────

  app.post('/api/cover-letter', asyncRoute(async (req, res) => {
    const { number, company, role } = req.body;
    const cloudApi = api(req);
    const applicationId = await findApplicationId(cloudApi, number);
    if (!applicationId) {
      const err = new Error('Application not found'); err.status = 404; throw err;
    }

    const token = req.cookies.co_access_token;
    const upstream = await fetch(coverLetterStreamUrl(), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ applicationId })
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      const data = safeJson(text) || {};
      const err = new Error(data.error || 'Cover letter generation failed');
      err.status = upstream.status;
      throw err;
    }

    const slug = `${sanitizeSlug(company)}-${sanitizeSlug(role)}`;
    res.json({
      content: text,
      relativePath: `${slug}-cover-letter.txt`,
      path: `${slug}-cover-letter.txt`,
      applicationNumber: number,
      company,
      role
    });
  }));

  app.post('/api/cover-letter/save', (_req, res) => res.json({ ok: true }));
  app.post('/api/cover-letter-folder', (_req, res) => {
    res.json({ outputDir: '', examplePaths: [] });
  });
  app.post('/api/cover-letter/pdf', (_req, res) => {
    res.json({ ok: false, error: 'PDF export is not available in the web version.' });
  });

  // ─── Onboarding cover letter preview (streaming) ──────────────────────────

  app.post('/api/onboarding/cover-letter/preview', asyncRoute(async (req, res) => {
    const token = req.cookies.co_access_token;
    const upstream = await fetch(coverLetterStreamUrl(), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...req.body, preview: true })
    });
    res.status(upstream.status);
    res.set('content-type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
    const readable = Readable.fromWeb(upstream.body);
    readable.pipe(res);
  }));

  // ─── Onboarding resume + profile (direct proxies) ────────────────────────

  app.get('/api/onboarding/state', asyncRoute(async (req, res) => {
    res.json(await api(req).get('/v1/onboarding/state'));
  }));

  app.put('/api/onboarding/state', asyncRoute(async (req, res) => {
    res.json(await api(req).put('/v1/onboarding/state', req.body));
  }));

  app.get('/api/onboarding/resume/upload-url', asyncRoute(async (req, res) => {
    const { ext = 'pdf' } = req.query;
    try {
      res.json(await api(req).get(`/v1/onboarding/resume/upload-url?ext=${encodeURIComponent(ext)}`));
    } catch (error) {
      if (error?.status !== 404) throw error;
      res.json(await api(req).get(`/v1/files/upload-url?type=resume&ext=${encodeURIComponent(ext)}`));
    }
  }));

  app.post('/api/onboarding/resume', asyncRoute(async (req, res) => {
    res.json(await api(req).post('/v1/onboarding/resume', req.body));
  }));

  app.post('/api/onboarding/profile', asyncRoute(async (req, res) => {
    res.json(await api(req).post('/v1/onboarding/profile', req.body));
  }));

  // ─── Knowledge center ─────────────────────────────────────────────────────

  app.get('/api/knowledge', asyncRoute(async (req, res) => {
    const { items } = await api(req).get('/v1/knowledge');
    res.json({ records: [], facts: mapCloudKnowledge(items) });
  }));

  app.post('/api/knowledge/facts', asyncRoute(async (req, res) => {
    const { category, content } = req.body;
    const cloudApi = api(req);
    await cloudApi.post('/v1/knowledge', { category, content });
    const { items } = await cloudApi.get('/v1/knowledge');
    res.json({ knowledgeCenter: { records: [], facts: mapCloudKnowledge(items) } });
  }));

  app.post('/api/knowledge/facts/delete', asyncRoute(async (req, res) => {
    const { id } = req.body;
    const cloudApi = api(req);
    await cloudApi.delete(`/v1/knowledge/${id}`);
    const { items } = await cloudApi.get('/v1/knowledge');
    res.json({ knowledgeCenter: { records: [], facts: mapCloudKnowledge(items) } });
  }));

  app.post('/api/knowledge/facts/update', asyncRoute(async (req, res) => {
    // No PATCH for knowledge yet — optimistic no-op
    res.json({ ok: true });
  }));
  app.post('/api/knowledge/facts/status', (_req, res) => res.json({ ok: true }));
  app.post('/api/knowledge/records/update', (_req, res) => res.json({ ok: true }));
  app.post('/api/knowledge/chat', (_req, res) => {
    res.json({ response: 'AI knowledge chat is not yet available in the web version.' });
  });
  app.post('/api/knowledge/clear', (_req, res) => {
    res.json({ ok: true, knowledgeCenter: { records: [], facts: [] } });
  });
  app.post('/api/knowledge/rebuild', (_req, res) => {
    res.json({ ok: true, knowledgeCenter: { records: [], facts: [] } });
  });

  app.post('/api/knowledge/upload', upload.single('document'), asyncRoute(async (req, res) => {
    if (!req.file) {
      const err = new Error('No document uploaded.'); err.status = 400; throw err;
    }
    const ext = path.extname(req.file.originalname || '').toLowerCase().replace('.', '') || 'pdf';
    const cloudApi = api(req);

    const { url: uploadUrl, key } = await cloudApi.get(`/v1/files/upload-url?type=knowledge&ext=${ext}`);
    const fileBuffer = fs.readFileSync(req.file.path);
    try {
      const s3Res = await fetch(uploadUrl, {
        method: 'PUT', body: fileBuffer, headers: { 'content-type': mimeType(ext) }
      });
      if (!s3Res.ok) throw new Error(`S3 upload returned ${s3Res.status}`);
    } finally {
      fs.unlinkSync(req.file.path);
    }

    // Record as a knowledge fact referencing the S3 key
    await cloudApi.post('/v1/knowledge', {
      category: 'portfolio',
      content: req.file.originalname || 'Uploaded document',
      s3Key: key
    });

    const { items } = await cloudApi.get('/v1/knowledge');
    res.json({ knowledgeCenter: { records: [], facts: mapCloudKnowledge(items) } });
  }));

  // ─── Settings / profile ───────────────────────────────────────────────────

  app.post('/api/settings', asyncRoute(async (req, res) => {
    const cloudApi = api(req);
    const update = settingsBodyToProfileUpdate(req.body);
    if (Object.keys(update).length > 0) {
      await cloudApi.put('/v1/profile', update).catch(() => {});
    }
    res.json(await buildDashboard(cloudApi));
  }));

  app.post('/api/setup-settings', asyncRoute(async (req, res) => {
    const cloudApi = api(req);
    const update = settingsBodyToProfileUpdate(req.body);
    if (Object.keys(update).length > 0) {
      await cloudApi.put('/v1/profile', update).catch(() => {});
    }
    const dashboard = await buildDashboard(cloudApi);
    res.json({ ok: true, setup: dashboard.settings.setup, knowledgeCenter: dashboard.knowledgeCenter });
  }));

  app.post('/api/ai-settings', (_req, res) => res.json({ ok: true }));
  app.post('/api/test-ai', (_req, res) => res.json({ ok: true, message: 'AI is configured server-side.' }));
  app.post('/api/test-setup', (_req, res) => res.json({ ok: true }));

  // ─── Resume builder ───────────────────────────────────────────────────────
  // Resume builder AI features (tailoring, review, generation) are desktop-only.
  // The variants list and basic CRUD work via the cloud API.

  app.get('/api/resume-builder', asyncRoute(async (req, res) => {
    const { items } = await api(req).get('/v1/resume-variants');
    res.json({
      variants: (items || []).map(v => ({
        id: v.variantId,
        name: v.name || `Variant ${v.variantId.slice(0, 8)}`,
        baseResumeId: v.baseResumeId || null,
        status: v.status || 'draft'
      })),
      resumes: [],
      jobs: []
    });
  }));

  app.get('/api/resume-builder/:id', (_req, res) => res.json({ id: _req.params.id, content: '' }));

  app.post('/api/resume-builder/delete', asyncRoute(async (req, res) => {
    const cloudApi = api(req);
    if (req.body.id) await cloudApi.delete(`/v1/resume-variants/${req.body.id}`).catch(() => {});
    const { items } = await cloudApi.get('/v1/resume-variants');
    res.json({ ok: true, resumeBuilder: { variants: items || [], resumes: [], jobs: [] } });
  }));

  const resumeBuilderStub = (_req, res) => res.json({ ok: false, error: 'AI resume building is not available in the web version. Use the desktop app.' });
  app.post('/api/resume-builder/master', resumeBuilderStub);
  app.post('/api/resume-builder/tailored', resumeBuilderStub);
  app.post('/api/resume-builder/review', resumeBuilderStub);
  app.post('/api/resume-builder/generate', resumeBuilderStub);
  app.post('/api/resume-builder/save', (_req, res) => res.json({ ok: true }));
  app.post('/api/resume-builder/suggestion', (_req, res) => res.json({ ok: true }));
  app.post('/api/resume-builder/export', (_req, res) => {
    res.json({ ok: false, error: 'PDF export is not available in the web version.' });
  });

  // ─── Discovery (stubs — no auto-scanner in cloud v1) ─────────────────────

  app.post('/api/scan', (_req, res) => {
    res.status(409).json({ ok: false, code: 409, output: 'Auto-scan is not available in the web version.', dashboard: null });
  });
  app.post('/api/discovery-source', asyncRoute(async (req, res) => {
    const { url, saveSource = true } = req.body || {};
    if (!url) {
      const err = new Error('URL is required'); err.status = 400; throw err;
    }
    const cloudApi = api(req);
    const imported = await cloudApi.post('/v1/discovery/import', { url, saveSource });
    const dashboard = await buildDashboard(cloudApi);
    res.json({ ...imported, dashboard });
  }));
  app.post('/api/discovery-source/delete', (_req, res) => res.json({ ok: true }));
  app.post('/api/discovery-source/update', (_req, res) => res.json({ ok: true }));
  app.post('/api/discovery-refresh', (_req, res) => res.json({ ok: true }));
  app.post('/api/discard-pending', (_req, res) => res.json({ ok: true }));
  app.post('/api/check-pending-availability', (_req, res) => res.json({ ok: true, available: false }));
  app.post('/api/evaluate-pending', (_req, res) => {
    res.json({ ok: false, error: 'Evaluation is not available in the web version.' });
  });
  app.post('/api/bulk-queue', (_req, res) => res.json({ ok: false }));
  app.get('/api/bulk-events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.write('\n');
    req.on('close', () => {});
  });

  // ─── Misc ─────────────────────────────────────────────────────────────────

  app.post('/api/autofill-prompt', (_req, res) => res.json({ content: '', copied: false }));
  app.post('/api/root', (_req, res) => res.json({ root: 'Cloud (AWS)' }));
  app.get('/api/open-path', (req, res) => {
    const target = String(req.query.path || '');
    if (target.startsWith('https://') || target.startsWith('http://')) return res.redirect(target);
    res.status(400).json({ error: 'Cannot open local path in web version.' });
  });

  // Extension (used by browser extension, not the renderer)
  app.get('/api/extension/context', (_req, res) => res.json({ ok: true }));
  app.post('/api/extension/settings', (_req, res) => res.json({ ok: true, settings: {} }));

  // Account delete
  app.delete('/api/account', asyncRoute(async (req, res) => {
    await api(req).delete('/v1/account');
    res.clearCookie('co_access_token');
    res.clearCookie('co_refresh_token');
    res.clearCookie('co_onboarded');
    res.json({ ok: true });
  }));
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function settingsBodyToProfileUpdate(body) {
  const update = {};
  const s = body.setup || body;
  if (s.profile?.fullName)  update.name = s.profile.fullName;
  if (s.profile?.email)     update.email = s.profile.email;
  if (s.profile?.headline)  update.headline = s.profile.headline;
  if (s.careerGoals?.targetRoles)     update.targetRoles = s.careerGoals.targetRoles;
  if (s.careerGoals?.targetLocations) update.targetLocations = s.careerGoals.targetLocations;
  if (s.jobPreferences) {
    const jp = s.jobPreferences;
    if (jp.workModes)             update.workModes = jp.workModes;
    if (jp.acceptedSeniorities)   update.acceptedSeniorities = jp.acceptedSeniorities;
    if (jp.compensationMin !== undefined) update.compensationMin = jp.compensationMin;
    if (jp.compensationCurrency)  update.compensationCurrency = jp.compensationCurrency;
    if (jp.employmentTypes)       update.employmentTypes = jp.employmentTypes;
    if (jp.authorizedCountries)   update.authorizedCountries = jp.authorizedCountries;
    if (jp.remoteLocationPolicy)  update.remoteLocationPolicy = jp.remoteLocationPolicy;
    if (jp.excludedTitles)        update.excludedTitles = jp.excludedTitles;
    if (jp.hardConstraints)       update.hardConstraints = jp.hardConstraints;
  }
  return update;
}

module.exports = { registerRoutes };
