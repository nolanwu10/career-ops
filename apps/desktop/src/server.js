const express = require('express');
require('dotenv/config');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const core = require('./app-core');
const cloudSync = require('./cloud-sync');

function createServer() {
const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), 'career-ops-uploads') });
const sseClients = new Set();
let scanPromise = null;
let discoveryRefreshPromise = null;

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));
app.get('/vendor/jszip.min.js', (_req, res) => {
  res.sendFile(require.resolve('jszip/dist/jszip.min.js'));
});
app.get('/vendor/docx-preview.min.js', (_req, res) => {
  res.sendFile(require.resolve('docx-preview'));
});
app.get('/vendor/pdf.mjs', (_req, res) => {
  res.type('text/javascript').sendFile(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
});
app.get('/vendor/pdf.worker.mjs', (_req, res) => {
  res.type('text/javascript').sendFile(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'));
});
app.use(express.static(path.join(__dirname, 'renderer')));

app.use('/api/extension', (req, res, next) => {
  const origin = String(req.get('Origin') || '');
  if (origin && !origin.startsWith('chrome-extension://')) {
    res.status(403).json({ ok: false, error: 'Extension API requests must come from the Career Ops Chrome extension.' });
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-Career-Ops-Filename, Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function emitBulkProgress(update) {
  const payload = `data: ${JSON.stringify(update)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  const diagnostics = core.rootDiagnostics();
  res.json({ ok: true, careerRoot: diagnostics.dataRoot || core.getCareerRoot(), diagnostics });
}));

app.get('/api/dashboard', asyncRoute(async (_req, res) => {
  res.json(await core.loadDashboard());
}));

app.get('/api/cloud/status', asyncRoute(async (_req, res) => {
  res.json(cloudSync.status());
}));

app.post('/api/cloud/login', asyncRoute(async (_req, res) => {
  res.json({ url: cloudSync.beginLogin() });
}));

app.get('/auth/callback', asyncRoute(async (req, res) => {
  await cloudSync.completeLogin({ code: String(req.query.code || ''), state: String(req.query.state || '') });
  res.type('html').send('<!doctype html><title>Career Ops</title><h1>Sign-in complete</h1><p>You can return to Career Ops.</p><script>window.close()</script>');
}));

app.post('/api/cloud/logout', asyncRoute(async (_req, res) => {
  res.json(cloudSync.logout());
}));

app.post('/api/cloud/sync', asyncRoute(async (_req, res) => {
  res.json(await cloudSync.sync());
}));

app.post('/api/cloud/feedback', asyncRoute(async (req, res) => {
  res.json(await cloudSync.feedback(req.body));
}));

app.post('/api/scan', asyncRoute(async (_req, res) => {
  if (scanPromise) {
    res.status(409).json({
      ok: false,
      code: 409,
      output: 'A scan is already running. Wait for it to finish before starting another.',
      dashboard: await core.loadDashboard()
    });
    return;
  }
  scanPromise = core.runScan();
  try {
    res.json(await scanPromise);
  } finally {
    scanPromise = null;
  }
}));

app.post('/api/pending-job', asyncRoute(async (req, res) => {
  res.json(await core.addPendingJobLink(req.body));
}));

app.post('/api/discovery-source', asyncRoute(async (req, res) => {
  res.json(await core.importDiscoverySource(req.body));
}));

app.post('/api/discovery-source/delete', asyncRoute(async (req, res) => {
  res.json(await core.deleteDiscoverySource(req.body));
}));

app.post('/api/discovery-source/update', asyncRoute(async (req, res) => {
  res.json(await core.updateDiscoverySource(req.body));
}));

app.post('/api/discovery-refresh', asyncRoute(async (_req, res) => {
  if (discoveryRefreshPromise || scanPromise) {
    res.status(409).json({
      ok: false,
      error: 'A Discovery refresh is already running.'
    });
    return;
  }
  discoveryRefreshPromise = core.refreshDiscovery((update) => emitBulkProgress({ channel: 'discovery-refresh', ...update }));
  try {
    res.json(await discoveryRefreshPromise);
  } finally {
    discoveryRefreshPromise = null;
  }
}));

app.post('/api/dashboard-job', asyncRoute(async (req, res) => {
  res.json(await core.addDashboardJobLink(req.body));
}));

app.post('/api/update-status', asyncRoute(async (req, res) => {
  res.json(await core.updateStatus(req.body));
}));

app.post('/api/application-notes', asyncRoute(async (req, res) => {
  res.json(await core.updateApplicationNotes(req.body));
}));

app.post('/api/application-report', asyncRoute(async (req, res) => {
  res.json(await core.generateApplicationReport(req.body));
}));

app.post('/api/settings', asyncRoute(async (req, res) => {
  res.json(await core.saveSettings(req.body));
}));

app.post('/api/setup-settings', asyncRoute(async (req, res) => {
  res.json({
    ok: true,
    setup: core.saveSetupSettings(req.body),
    knowledgeCenter: core.loadKnowledgeCenter()
  });
}));

app.post('/api/test-setup', asyncRoute(async (_req, res) => {
  res.json(core.testSetup());
}));

app.post('/api/resume', asyncRoute(async (req, res) => {
  res.json(await core.saveResume(req.body));
}));

app.post('/api/resume/upload', upload.single('resume'), asyncRoute(async (req, res) => {
  if (!req.file) throw new Error('No resume file uploaded.');
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  const sourcePath = `${req.file.path}${ext}`;
  fs.renameSync(req.file.path, sourcePath);
  res.json(await core.uploadResumeFromPath(sourcePath, req.file.originalname));
}));

app.get('/api/resumes/:id', asyncRoute(async (req, res) => {
  res.json(core.getResume(req.params.id));
}));

app.post('/api/resumes/primary', asyncRoute(async (req, res) => {
  res.json(core.setPrimaryResume(req.body));
}));

app.post('/api/resumes/rename', asyncRoute(async (req, res) => {
  res.json(core.renameResume(req.body));
}));

app.post('/api/resumes/delete', asyncRoute(async (req, res) => {
  res.json(core.deleteResume(req.body));
}));

app.get('/api/resume-builder', asyncRoute(async (_req, res) => {
  res.json(core.loadResumeBuilder());
}));

app.get('/api/resume-builder/:id', asyncRoute(async (req, res) => {
  res.json(core.getResumeBuilderVariant(req.params.id));
}));

app.get('/api/resume-builder/:id/preview', asyncRoute(async (req, res) => {
  const preview = await core.getResumeBuilderPreview(req.params.id);
  res.type(preview.mediaType);
  res.setHeader('X-Resume-Source-Format', preview.sourceFormat);
  res.setHeader('X-Resume-Exact-Source', preview.exactSource ? 'true' : 'false');
  res.setHeader('X-Resume-Layout-Aware', preview.layoutAware ? 'true' : 'false');
  res.sendFile(preview.path);
}));

app.post('/api/resume-builder/master', asyncRoute(async (req, res) => {
  res.json(core.createMasterResume(req.body));
}));

app.post('/api/resume-builder/tailored', asyncRoute(async (req, res) => {
  res.json(await core.createTailoredResume(req.body));
}));

app.post('/api/resume-builder/review', asyncRoute(async (req, res) => {
  res.json(await core.analyzeResumeForJob(req.body));
}));

app.post('/api/resume-builder/generate', asyncRoute(async (req, res) => {
  res.json(await core.generateAiTailoredResume(req.body));
}));

app.post('/api/resume-builder/save', asyncRoute(async (req, res) => {
  res.json(core.saveResumeBuilderVariant(req.body));
}));

app.post('/api/resume-builder/suggestion', asyncRoute(async (req, res) => {
  res.json(core.decideResumeBuilderSuggestion(req.body));
}));

app.post('/api/resume-builder/delete', asyncRoute(async (req, res) => {
  res.json(core.deleteResumeBuilderVariant(req.body));
}));

app.post('/api/resume-builder/export', asyncRoute(async (req, res) => {
  res.json(await core.exportResumeBuilderVariant(req.body));
}));

app.get('/api/knowledge', asyncRoute(async (_req, res) => {
  res.json(core.loadKnowledgeCenter());
}));

app.post('/api/knowledge/upload', upload.single('document'), asyncRoute(async (req, res) => {
  if (!req.file) throw new Error('No document uploaded.');
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  const sourcePath = `${req.file.path}${ext}`;
  fs.renameSync(req.file.path, sourcePath);
  res.json(await core.uploadKnowledgeDocumentFromPath(sourcePath, req.file.originalname));
}));

app.post('/api/knowledge/facts', asyncRoute(async (req, res) => {
  res.json(core.saveKnowledgeFact(req.body));
}));

app.post('/api/knowledge/facts/update', asyncRoute(async (req, res) => {
  res.json(core.updateKnowledgeFact(req.body));
}));

app.post('/api/knowledge/records/update', asyncRoute(async (req, res) => {
  res.json(core.updateKnowledgeRecord(req.body));
}));

app.post('/api/knowledge/chat', asyncRoute(async (req, res) => {
  res.json(await core.chatKnowledge(req.body));
}));

app.post('/api/knowledge/facts/status', asyncRoute(async (req, res) => {
  res.json(core.setKnowledgeFactStatus(req.body));
}));

app.post('/api/knowledge/facts/delete', asyncRoute(async (req, res) => {
  res.json(core.removeKnowledgeFact(req.body));
}));

app.post('/api/knowledge/clear', asyncRoute(async (_req, res) => {
  res.json(core.clearKnowledgeCenter());
}));

app.post('/api/knowledge/rebuild', asyncRoute(async (_req, res) => {
  res.json(await core.rebuildKnowledgeCenter());
}));

app.post('/api/ai-settings', asyncRoute(async (req, res) => {
  res.json(await core.saveAiSettings(req.body));
}));

app.post('/api/test-ai', asyncRoute(async (_req, res) => {
  res.json(await core.testAi());
}));

app.post('/api/cover-letter-folder', asyncRoute(async (req, res) => {
  res.json(await core.pickCoverLetterFolder(req.body.outputDir));
}));

app.post('/api/cover-letter', asyncRoute(async (req, res) => {
  res.json(await core.generateCoverLetter(req.body));
}));

app.post('/api/cover-letter/save', asyncRoute(async (req, res) => {
  res.json(await core.saveCoverLetter(req.body));
}));

app.post('/api/cover-letter/pdf', asyncRoute(async (req, res) => {
  res.json(await core.exportCoverLetterPdf(req.body));
}));

app.post('/api/autofill-prompt', asyncRoute(async (req, res) => {
  const result = core.generateAutofillPrompt(req.body);
  res.json({ ...result, copied: false });
}));

app.get('/api/extension/context', asyncRoute(async (_req, res) => {
  res.json(core.extensionContext());
}));

app.post('/api/extension/settings', asyncRoute(async (req, res) => {
  res.json({ ok: true, settings: core.saveExtensionSettings(req.body) });
}));

app.post('/api/extension/autofill-context', asyncRoute(async (req, res) => {
  res.json(core.extensionAutofillContext(req.body));
}));

app.post('/api/extension/document/:kind', asyncRoute(async (req, res) => {
  const document = core.extensionDocument(req.body, req.params.kind);
  res.setHeader('Content-Type', document.mediaType);
  res.setHeader('X-Career-Ops-Filename', encodeURIComponent(document.name));
  res.sendFile(document.path);
}));

app.post('/api/extension/log-applied', asyncRoute(async (req, res) => {
  res.json(await core.logExternalApplication(req.body));
}));

app.post('/api/evaluate-pending', asyncRoute(async (req, res) => {
  res.json(await core.evaluatePending(req.body));
}));

app.post('/api/bulk-queue', asyncRoute(async (req, res) => {
  const eventShim = {
    sender: {
      send(_channel, payload) {
        emitBulkProgress(payload);
      }
    }
  };
  res.json(await core.runBulkQueue(eventShim, req.body));
}));

app.get('/api/bulk-events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/discard-pending', asyncRoute(async (req, res) => {
  res.json(await core.discardPending(req.body));
}));

app.post('/api/check-pending-availability', asyncRoute(async (req, res) => {
  res.json(await core.checkPendingAvailability(req.body));
}));

app.post('/api/root', asyncRoute(async (req, res) => {
  res.json({ root: await core.pickRoot(req.body.rootPath), dashboard: await core.loadDashboard() });
}));

app.get('/api/open-path', asyncRoute(async (req, res) => {
  const targetPath = path.resolve(String(req.query.path || ''));
  const diagnostics = core.rootDiagnostics();
  const allowedRoot = diagnostics.dataRoot || core.getCareerRoot();
  if (!core.isInsidePath(targetPath, allowedRoot)) {
    res.status(403).send('This server only serves files inside the configured application data folder.');
    return;
  }
  if (!fs.existsSync(targetPath)) {
    res.status(404).send('File not found.');
    return;
  }
  res.sendFile(targetPath);
}));

app.use((err, _req, res, _next) => {
  res.status(500).json({ ok: false, error: err.message || String(err) });
});

return app;
}

function startServer({ port = Number(process.env.PORT || 3000), host = '127.0.0.1' } = {}) {
  const app = createServer();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      console.log(`Career Ops web app running at ${url}`);
      console.log(`CAREER_OPS_ROOT=${core.getCareerRoot()}`);
      resolve({ app, server, url });
    });
    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { createServer, startServer };
