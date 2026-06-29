const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const yaml = require('js-yaml');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const JSZip = require('jszip');
const {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} = require('docx');
const { computeAdvancedAnalytics } = require('./analytics');
const sqliteStore = require('./storage/sqlite-store');
const os = require('os');
const app = {
  isPackaged: false,
  getPath(name) {
    if (name === 'userData') {
      const base = process.env.CAREER_OPS_USER_DATA || path.join(os.homedir(), '.career-ops-dashboard');
      fs.mkdirSync(base, { recursive: true });
      return base;
    }
    return process.cwd();
  },
  getAppPath() {
    return process.cwd();
  }
};
const clipboard = {
  writeText() {}
};

let careerRoot = findCareerRoot();
const states = ['Evaluated', 'Applied', 'Online Assessment', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];
const crmColumns = [
  { id: 'need_to_apply', label: 'Need to Apply' },
  { id: 'applied', label: 'Applied' },
  { id: 'online_assessment', label: 'Online Assessment' },
  { id: 'interview', label: 'Interview' },
  { id: 'offer', label: 'Offer' },
  { id: 'rejected_archived', label: 'Rejected / Archived' }
];
const openAiModels = [
  { id: 'gpt-5.5', label: 'GPT-5.5 - best quality' },
  { id: 'gpt-5.4', label: 'GPT-5.4 - balanced' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini - recommended' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano - cheapest' },
  { id: 'gpt-4.1', label: 'GPT-4.1 - legacy' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini - legacy' }
];
const internalOpenAiModel = 'gpt-5.4-mini';
const defaultCoverLetterModel = 'gpt-5.4-mini';
const coverLetterExamplePaths = String(process.env.COVER_LETTER_EXAMPLES || '')
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean);
const knowledgeCategories = [
  'employment',
  'education',
  'projects',
  'skills',
  'accomplishments',
  'star-stories',
  'attributes',
  'portfolio',
  'role-preferences',
  'career-goals',
  'application-answers'
];

async function loadDashboard() {
  if (sqliteStore.available()) {
    sqliteStore.purgeExpiredArchivedApplications();
    let snapshot = sqliteStore.loadSnapshot();
    if (reconcileStoredCoverLetters(snapshot.applications)) {
      snapshot = sqliteStore.loadSnapshot();
    }
    const effectiveProfile = applySetupToProfile(snapshot.profile);
    const applications = snapshot.applications.map((row) => ({
      ...row,
      crmStatus: mapCareerOpsStatusToCRM(row.status),
      nextAction: nextActionForApplication(row),
      reportSummary: reportSummary(row.reportContent)
    }));
    const pendingJobs = rankDiscoveryJobs(snapshot.pendingJobs, {
      profile: effectiveProfile,
      titleKeywords: snapshot.targeting.title_filter?.positive || [],
      resume: snapshot.resume,
      acceptedRoles: applications.map((row) => row.role),
      discardedRoles: snapshot.discoveryDecisions
        .filter((decision) => decision.decision === 'discarded')
        .map((decision) => decision.role)
    });
    const coverLetters = await Promise.all(applications
      .filter((row) => row.coverLetterPath)
      .map(async (row) => ({
        applicationNumber: row.number,
        company: row.company,
        role: row.role,
        name: path.basename(row.coverLetterPath),
        path: row.coverLetterPath,
        relativePath: displayPath(row.coverLetterPath),
        updatedAt: fs.statSync(row.coverLetterPath).mtime.toISOString(),
        content: await readDocxText(row.coverLetterPath)
      })));
    return {
      careerRoot: sqliteStore.dataRoot,
      diagnostics: { ...sqliteStore.diagnostics(), node: findNodeExecutable() },
      states,
      crmColumns,
      applications,
      metrics: computeMetrics(applications),
      progress: computeProgress(applications),
      analytics: computeAnalytics(applications, snapshot.scanHistory, pendingJobs),
      followUpQueue: computeFollowUpQueue(applications),
      scanSummary: computeScanSummary(snapshot.scanHistory, pendingJobs),
      settings: {
        portalsPath: '',
        profilePath: '',
        titleKeywords: snapshot.targeting.title_filter?.positive || [],
        targetRoles: effectiveProfile.target_roles?.primary || [],
        candidate: effectiveProfile.candidate || {},
        profileDefaults: profileDefaults(effectiveProfile),
        resume: loadResumeSettings(),
        resumes: listResumes(),
        ai: loadAiSettings(),
        coverLetters: loadCoverLetterSettings(),
        extension: loadExtensionSettings(),
        setup: loadSetupSettings()
      },
      pendingJobs,
      discoverySources: snapshot.discoverySources || [],
      coverLetters,
      resume: snapshot.resume,
      resumeBuilder: loadResumeBuilder(),
      knowledgeCenter: loadKnowledgeCenter()
    };
  }
  const diagnostics = rootDiagnostics();
  const applications = parseApplications();
  const reports = loadReports(applications);
  const settings = loadSettings();
  const resume = currentResume();
  const pendingJobs = rankDiscoveryJobs(parsePendingJobs(), {
    profile: loadProfile(),
    titleKeywords: settings.titleKeywords || [],
    resume,
    acceptedRoles: applications.map((row) => row.role),
    discardedRoles: []
  });
  const coverLetters = await loadCoverLetters();
  const scanHistory = scanHistoryRows();
  return {
    careerRoot,
    diagnostics,
    states,
    crmColumns,
    applications: applications.map((row) => ({
      ...row,
      ...deriveMaterials(row),
      crmStatus: mapCareerOpsStatusToCRM(row.status),
      nextAction: nextActionForApplication(row),
      reportSummary: reports[row.reportPath] || null
    })),
    metrics: computeMetrics(applications),
    progress: computeProgress(applications),
    analytics: computeAnalytics(applications, scanHistory, pendingJobs),
    followUpQueue: computeFollowUpQueue(applications),
    scanSummary: computeScanSummary(scanHistory, pendingJobs),
    settings,
    pendingJobs,
    discoverySources: loadDiscoverySources(),
    coverLetters,
    resume,
    resumeBuilder: loadResumeBuilder(),
    knowledgeCenter: loadKnowledgeCenter()
  };
}

function reconcileStoredCoverLetters(applications) {
  const dir = path.join(sqliteStore.dataRoot, 'files', 'generated', 'cover-letters');
  if (!fs.existsSync(dir)) return false;
  const unlinked = applications.filter((row) => !row.coverLetterPath);
  if (unlinked.length === 0) return false;
  const files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.docx'));
  let changed = false;
  for (const row of unlinked) {
    const prefix = `${String(row.number).padStart(3, '0')}-`;
    const match = files.find((name) => name.startsWith(prefix));
    if (!match) continue;
    sqliteStore.linkApplicationDocument(
      row.number,
      'cover-letter',
      path.join(dir, match),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    changed = true;
  }
  return changed;
}

function rankDiscoveryJobs(jobs, {
  profile = {},
  titleKeywords = [],
  resume = '',
  acceptedRoles = [],
  discardedRoles = []
} = {}) {
  const targetRoles = normalizeStringList(profile.target_roles?.primary);
  const targetLocations = normalizeStringList(profile.location?.target_locations);
  const excludedTitles = normalizeStringList(profile.job_preferences?.excluded_titles);
  const desiredTerms = discoveryTerms([...targetRoles, ...titleKeywords]);
  const resumeTerms = new Set(discoveryTerms([resume]));
  const targetFingerprints = [...targetRoles, ...titleKeywords].map(roleFingerprint).filter((terms) => terms.length);
  const acceptedFingerprints = normalizeStringList(acceptedRoles).map(roleFingerprint).filter((terms) => terms.length);
  const discardedFingerprints = normalizeStringList(discardedRoles).map(roleFingerprint).filter((terms) => terms.length);
  const today = new Date();

  return jobs.map((job) => {
    const postedDaysAgo = daysAgoFromDate(job.datePosted, today);
    const roleText = String(job.role || '').toLowerCase();
    const roleTerms = discoveryTerms([job.role]);
    const roleMatches = roleTerms.filter((term) => desiredTerms.includes(term));
    const resumeMatches = roleTerms.filter((term) => resumeTerms.has(term));
    const fingerprint = roleFingerprint(job.role);
    const targetSimilarity = maxRoleSimilarity(fingerprint, targetFingerprints);
    const acceptedSimilarity = maxRoleSimilarity(fingerprint, acceptedFingerprints);
    const discardedSimilarity = maxRoleSimilarity(fingerprint, discardedFingerprints);
    const explicitExclusion = excludedTitles.find((title) => (
      roleText.includes(String(title).toLowerCase())
    )) || '';
    const locationText = String(job.location || '').toLowerCase();
    const locationMatch = targetLocations.some((location) => (
      locationText.includes(String(location).toLowerCase())
      || /remote/i.test(locationText)
    ));

    const recencyScore = postedDaysAgo == null
      ? 5
      : postedDaysAgo <= 1 ? 60
        : postedDaysAgo <= 3 ? 54
          : postedDaysAgo <= 7 ? 46
            : postedDaysAgo <= 14 ? 34
              : postedDaysAgo <= 30 ? 20
                : 5;
    const roleScore = Math.min(40, Math.round(targetSimilarity * 35) + roleMatches.length * 5);
    const resumeScore = Math.min(10, resumeMatches.length * 2);
    const historyScore = Math.round(acceptedSimilarity * 12) - Math.round(discardedSimilarity * 30);
    const relevanceScore = Math.max(0, roleScore + resumeScore + historyScore);
    const isRelevant = !explicitExclusion
      && discardedSimilarity < 0.58
      && (targetSimilarity >= 0.25 || acceptedSimilarity >= 0.35);
    const recommendationScore = isRelevant
      ? Math.min(100, recencyScore + roleScore + resumeScore)
      : Math.min(24, recencyScore);
    const recommendation = recommendationScore >= 75
      ? 'Top pick'
      : recommendationScore >= 55 ? 'Recommended'
        : recommendationScore >= 35 ? 'Possible fit'
          : 'Low priority';
    const reasons = [];
    if (postedDaysAgo != null) reasons.push(postedDaysAgo <= 3 ? 'Recently posted' : `Posted ${postedDaysAgo} days ago`);
    if (roleMatches.length) reasons.push(`Matches ${roleMatches.slice(0, 3).join(', ')}`);
    if (resumeMatches.length) reasons.push('Resume overlap');
    if (locationMatch) reasons.push('Location match');

    return {
      ...job,
      postedDaysAgo,
      recommendationScore,
      relevanceScore,
      isRelevant,
      exclusionReason: explicitExclusion
        ? `Excluded title: ${explicitExclusion}`
        : discardedSimilarity >= 0.72 ? 'Similar to discarded roles' : '',
      recommendation,
      recommendationReason: reasons.join(' · ') || 'Limited source details'
    };
  }).sort((left, right) => (
    right.recommendationScore - left.recommendationScore
    || (left.postedDaysAgo ?? Number.MAX_SAFE_INTEGER) - (right.postedDaysAgo ?? Number.MAX_SAFE_INTEGER)
  ));
}

function discoveryTerms(values) {
  const ignored = new Set([
    'and', 'analyst', 'associate', 'co-op', 'entry', 'for', 'intern', 'internship',
    'junior', 'new', 'of', 'role', 'summer', 'the', 'with'
  ]);
  return [...new Set(values
    .flatMap((value) => String(value || '').toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [])
    .filter((term) => !ignored.has(term)))];
}

function roleFingerprint(value) {
  const terms = discoveryTerms([value]);
  const bigrams = terms.slice(0, -1).map((term, index) => `${term}:${terms[index + 1]}`);
  return [...new Set([...terms, ...bigrams])];
}

function maxRoleSimilarity(roleTerms, referenceFingerprints) {
  if (!roleTerms.length || !referenceFingerprints.length) return 0;
  return Math.max(...referenceFingerprints.map((reference) => roleSimilarity(roleTerms, reference)));
}

function roleSimilarity(left, right) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  const overlap = left.filter((term) => rightSet.has(term)).length;
  const union = new Set([...left, ...right]).size;
  return union ? overlap / union : 0;
}

function daysAgoFromDate(value, now = new Date()) {
  if (!value) return null;
  const posted = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(posted.getTime())) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((today - posted.getTime()) / 86400000));
}

function loadResumeBuilder() {
  if (!sqliteStore.available()) {
    return { available: false, variants: [], resumes: listResumes(), jobs: [] };
  }
  const snapshot = sqliteStore.loadSnapshot();
  return {
    available: true,
    variants: sqliteStore.listResumeVariants(),
    resumes: listResumes(),
    jobs: snapshot.applications
      .filter((row) => !['SKIP', 'Discarded', 'Rejected'].includes(row.status))
      .map((row) => ({
        id: row.id,
        number: row.number,
        company: row.company,
        role: row.role,
        score: row.score,
        jobUrl: row.jobUrl,
        jobDescriptionPath: row.jobDescriptionPath,
        reportContent: row.reportContent
      }))
  };
}

function getResumeBuilderVariant(id) {
  if (!sqliteStore.available()) throw new Error('Resume Builder requires initialized application data.');
  return sqliteStore.getResumeVariant(String(id || ''));
}

function createMasterResume(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Resume Builder requires initialized application data.');
  const baseResumeId = String(payload.baseResumeId || loadResumeSettings().primaryId || '');
  const base = sqliteStore.getResume(baseResumeId);
  const id = sqliteStore.createResumeVariant({
    baseResumeId,
    kind: 'master',
    name: cleanResumeName(payload.name || `${base.name} Master`),
    content: base.content,
    jobContext: {
      sourceName: base.name,
      sourcePath: base.path,
      sourceFormat: path.extname(base.path || '').slice(1).toLowerCase(),
      pdfEdits: {}
    }
  });
  return { ok: true, variant: sqliteStore.getResumeVariant(id), resumeBuilder: loadResumeBuilder() };
}

async function createTailoredResume(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Resume Builder requires initialized application data.');
  const baseVariant = sqliteStore.getResumeVariant(String(payload.masterVariantId || ''));
  if (baseVariant.kind !== 'master') throw new Error('Choose a master resume as the source.');
  const snapshot = sqliteStore.loadSnapshot();
  const job = snapshot.applications.find((row) => row.id === String(payload.applicationId || ''));
  if (!job) throw new Error('Choose a job from the pipeline.');
  const jobDescription = await getJobDescription(job);
  const analysis = analyzeResumeFit(baseVariant.content, jobDescription, {
    company: job.company,
    role: job.role
  });
  const suggestions = buildEvidenceSuggestions(baseVariant.content, jobDescription);
  const id = sqliteStore.createResumeVariant({
    baseResumeId: baseVariant.baseResumeId,
    applicationId: job.id,
    kind: 'tailored',
    name: cleanResumeName(payload.name || `${job.company} - ${job.role}`),
    content: baseVariant.content,
    jobContext: {
      sourceName: baseVariant.jobContext?.sourceName || '',
      sourcePath: baseVariant.jobContext?.sourcePath || '',
      sourceFormat: baseVariant.jobContext?.sourceFormat || '',
      pdfEdits: baseVariant.jobContext?.pdfEdits || {},
      company: job.company,
      role: job.role,
      jobUrl: job.jobUrl,
      fitScore: job.score,
      analysisNote: 'Coverage is directional. Relevant, supported evidence matters more than repeating every term.'
    },
    keywordReport: analysis,
    suggestions
  });
  return { ok: true, variant: sqliteStore.getResumeVariant(id), resumeBuilder: loadResumeBuilder() };
}

async function analyzeResumeForJob(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Resume Builder requires initialized application data.');
  const baseVariant = sqliteStore.getResumeVariant(String(payload.masterVariantId || ''));
  if (baseVariant.kind !== 'master') throw new Error('Choose a master resume as the source.');
  const snapshot = sqliteStore.loadSnapshot();
  const job = snapshot.applications.find((row) => row.id === String(payload.applicationId || ''));
  if (!job) throw new Error('Choose a job from the pipeline.');
  const jobDescription = await getJobDescription(job);
  const review = normalizeResumeRecruiterReview(await aiJson([
    `You are the recruiter for ${job.company || 'the company'}.`,
    `The applicant is applying for this role: ${job.role || 'Unknown role'}.`,
    '',
    'Review the resume for this specific job. Do not rewrite the resume yet.',
    'Give direct recruiter feedback: what is strong, what is risky, what is missing, and what should be changed before applying.',
    'Focus on fit, credibility, relevance, ordering, missing proof, and potential red flags.',
    'Do not keyword-stuff. Do not invent experience. Do not suggest moving unrelated bullets into unrelated roles.',
    '',
    'Return JSON with this shape:',
    '{"summary":"string","goodParts":["string"],"pitfalls":["string"],"recommendedStrategy":["string"],"missingButUseful":["string"],"verdict":"string"}',
    '',
    'RESUME:',
    baseVariant.content.slice(0, 30000),
    '',
    'JOB DESCRIPTION:',
    String(jobDescription || '').slice(0, 30000)
  ].join('\n'), { modelPurpose: 'resume', modelOverride: 'gpt-5.4' }));
  return {
    ok: true,
    review,
    masterVariantId: baseVariant.id,
    applicationId: job.id,
    suggestedName: cleanResumeName(payload.name || `${job.company} - ${job.role}`),
    job: {
      id: job.id,
      company: job.company,
      role: job.role,
      jobUrl: job.jobUrl
    }
  };
}

async function generateAiTailoredResume(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Resume Builder requires initialized application data.');
  const baseVariant = sqliteStore.getResumeVariant(String(payload.masterVariantId || ''));
  if (baseVariant.kind !== 'master') throw new Error('Choose a master resume as the source.');
  const snapshot = sqliteStore.loadSnapshot();
  const job = snapshot.applications.find((row) => row.id === String(payload.applicationId || ''));
  if (!job) throw new Error('Choose a job from the pipeline.');
  const jobDescription = await getJobDescription(job);
  const review = payload.review && typeof payload.review === 'object'
    ? normalizeResumeRecruiterReview(payload.review)
    : null;
  const result = await aiJson([
    'Create a tailored resume draft for this exact job.',
    '',
    'Hard rules:',
    '- Use the uploaded/base resume as the structure and style guide.',
    '- Keep the resume close to the original unless the job fit clearly improves.',
    '- You may pick and choose relevant experiences from the approved Knowledge Center.',
    '- Do not place a bullet under the wrong company, role, project, or activity.',
    '- Do not copy an unrelated bullet from one experience into another experience.',
    '- Do not invent employers, titles, dates, metrics, technologies, or credentials.',
    '- Prefer rewriting/reordering existing bullets and swapping in genuinely more relevant approved bullets.',
    '- Preserve Markdown headings and bullet format.',
    '- Return a complete resume, not a diff.',
    '',
    'Return JSON with this shape:',
    '{"resumeMarkdown":"string","changeSummary":["string"],"tradeoffs":["string"]}',
    '',
    'RECRUITER FEEDBACK JSON:',
    JSON.stringify(review || {}, null, 2),
    '',
    'BASE RESUME:',
    baseVariant.content.slice(0, 30000),
    '',
    'APPROVED KNOWLEDGE CENTER:',
    trustedKnowledgeContext().slice(0, 30000),
    '',
    'JOB DESCRIPTION:',
    String(jobDescription || '').slice(0, 30000)
  ].join('\n'), { modelPurpose: 'resume', modelOverride: 'gpt-5.4' });
  const content = String(result.resumeMarkdown || '').trim();
  if (!content) throw new Error('The AI did not return a resume draft.');
  const analysis = analyzeResumeFit(content, jobDescription, {
    company: job.company,
    role: job.role
  });
  const id = sqliteStore.createResumeVariant({
    baseResumeId: baseVariant.baseResumeId,
    applicationId: job.id,
    kind: 'tailored',
    name: cleanResumeName(payload.name || `${job.company} - ${job.role}`),
    content,
    jobContext: {
      sourceName: baseVariant.jobContext?.sourceName || '',
      sourcePath: baseVariant.jobContext?.sourcePath || '',
      sourceFormat: baseVariant.jobContext?.sourceFormat || '',
      pdfEdits: {},
      company: job.company,
      role: job.role,
      jobUrl: job.jobUrl,
      fitScore: job.score,
      recruiterFeedback: review,
      aiChangeSummary: Array.isArray(result.changeSummary) ? result.changeSummary : [],
      aiTradeoffs: Array.isArray(result.tradeoffs) ? result.tradeoffs : []
    },
    keywordReport: analysis,
    suggestions: []
  });
  return { ok: true, variant: sqliteStore.getResumeVariant(id), resumeBuilder: loadResumeBuilder() };
}

function normalizeResumeRecruiterReview(value = {}) {
  return {
    summary: String(value.summary || '').trim(),
    goodParts: normalizeStringList(value.goodParts),
    pitfalls: normalizeStringList(value.pitfalls),
    recommendedStrategy: normalizeStringList(value.recommendedStrategy),
    missingButUseful: normalizeStringList(value.missingButUseful),
    verdict: String(value.verdict || '').trim()
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8);
}

function saveResumeBuilderVariant(payload = {}) {
  const id = String(payload.id || '');
  const content = String(payload.content || '').trim();
  if (!content) throw new Error('Resume content cannot be empty.');
  sqliteStore.saveResumeVariant(id, content, {
    action: 'manual_edit',
    pdfEdits: payload.pdfEdits && typeof payload.pdfEdits === 'object' ? payload.pdfEdits : undefined
  });
  return { ok: true, variant: sqliteStore.getResumeVariant(id), resumeBuilder: loadResumeBuilder() };
}

function decideResumeBuilderSuggestion(payload = {}) {
  const decision = String(payload.decision || '');
  if (!['accepted', 'rejected'].includes(decision)) throw new Error('Invalid suggestion decision.');
  const variant = sqliteStore.decideResumeSuggestion(
    String(payload.variantId || ''),
    String(payload.suggestionId || ''),
    decision
  );
  return { ok: true, variant, resumeBuilder: loadResumeBuilder() };
}

function deleteResumeBuilderVariant(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Resume Builder requires initialized application data.');
  sqliteStore.deleteResumeVariant(String(payload.id || ''));
  return { ok: true, resumeBuilder: loadResumeBuilder() };
}

async function exportResumeBuilderVariant(payload = {}) {
  const variant = sqliteStore.getResumeVariant(String(payload.id || ''));
  const format = String(payload.format || 'docx').toLowerCase();
  if (!['docx', 'pdf'].includes(format)) throw new Error('Export format must be DOCX or PDF.');
  const outputDir = path.join(sqliteStore.dataRoot, 'files', 'generated', 'resumes');
  fs.mkdirSync(outputDir, { recursive: true });
  const stem = `${slug(variant.name)}-v${Math.max(1, variant.versions?.[0]?.number || variant.versionCount || 1)}`;
  const docxPath = path.join(outputDir, `${stem}.docx`);
  const base = variant.baseResumeId ? sqliteStore.getResume(variant.baseResumeId) : null;
  const hasDocxTemplate = base
    && path.extname(base.path || '').toLowerCase() === '.docx'
    && fs.existsSync(base.path);
  const isUnchanged = Boolean(base && base.content.trim() === variant.content.trim());
  if (hasDocxTemplate && isUnchanged) {
    fs.copyFileSync(base.path, docxPath);
  } else {
    await writeResumeDocx(docxPath, variant.content, hasDocxTemplate ? {
      templatePath: base.path,
      originalMarkdown: base.content
    } : {});
  }
  if (format === 'docx') {
    return {
      ok: true,
      path: docxPath,
      preservedOriginalFormatting: Boolean(hasDocxTemplate)
    };
  }
  const pdfPath = path.join(outputDir, `${stem}.pdf`);
  if (Array.isArray(payload.renderedPages) && payload.renderedPages.length) {
    await renderResumeImagePagesPdf(pdfPath, payload.renderedPages);
  } else {
    await renderResumePdf(pdfPath, variant.content);
  }
  return {
    ok: true,
    path: pdfPath,
    docxPath,
    preservedOriginalFormatting: false
  };
}

async function getResumeBuilderPreview(id) {
  if (!sqliteStore.available()) throw new Error('Resume Builder requires initialized application data.');
  const variant = sqliteStore.getResumeVariant(String(id || ''));
  const base = variant.baseResumeId ? sqliteStore.getResume(variant.baseResumeId) : null;
  const sourceExt = path.extname(base?.path || '').toLowerCase();
  const isUnchanged = Boolean(base && base.content.trim() === variant.content.trim());
  if ((isUnchanged || sourceExt === '.pdf') && ['.pdf', '.docx'].includes(sourceExt) && fs.existsSync(base.path)) {
    return {
      path: base.path,
      mediaType: sourceExt === '.pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceFormat: sourceExt.slice(1).toUpperCase(),
      exactSource: isUnchanged,
      layoutAware: sourceExt === '.pdf'
    };
  }
  const previewDir = path.join(sqliteStore.dataRoot, 'files', 'generated', 'resume-previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const version = variant.versions?.[0]?.number || variant.versionCount || 1;
  const previewPath = path.join(previewDir, `${slug(variant.id)}-v${version}.docx`);
  const hasDocxTemplate = sourceExt === '.docx' && fs.existsSync(base.path);
  await writeResumeDocx(previewPath, variant.content, hasDocxTemplate ? {
    templatePath: base.path,
    originalMarkdown: base.content
  } : {});
  return {
    path: previewPath,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sourceFormat: 'DOCX',
    exactSource: false,
    layoutAware: false,
    preservedOriginalFormatting: hasDocxTemplate
  };
}

function analyzeResumeFit(resume, jobDescription, context = {}) {
  const stop = new Set([
    'about', 'after', 'also', 'and', 'apply', 'are', 'attach', 'but', 'capital', 'company',
    'enter', 'firm', 'for', 'from', 'have', 'into', 'job', 'manually', 'new', 'opportunity',
    'our', 'please', 'role', 'select', 'select...', 'summer', 'that', 'the', 'their', 'this',
    'with', 'will', 'work', 'years', 'york', 'you', 'your'
  ]);
  for (const word of `${context.company || ''} ${context.role || ''}`.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || []) {
    if (!['analytics', 'business', 'data', 'engineering', 'machine', 'operations', 'technology'].includes(word)) stop.add(word);
  }
  const skillTerms = new Set([
    'analytics', 'automation', 'aws', 'communication', 'data', 'design', 'engineering',
    'excel', 'forecasting', 'java', 'leadership', 'machine', 'marketing', 'modeling',
    'operations', 'pandas', 'python', 'research', 'scikit-learn', 'sql', 'strategy',
    'tableau', 'technology'
  ]);
  const terms = String(jobDescription || '').toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [];
  const counts = new Map();
  for (const term of terms) {
    if (!stop.has(term) && !/^\d/.test(term)) counts.set(term, (counts.get(term) || 0) + 1);
  }
  const important = [...counts.entries()]
    .filter(([term, count]) => count >= 2 || skillTerms.has(term))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([term]) => term);
  const resumeText = String(resume || '').toLowerCase();
  const covered = important.filter((term) => resumeText.includes(term));
  const missing = important.filter((term) => !resumeText.includes(term));
  return {
    coverage: important.length ? Math.round((covered.length / important.length) * 100) : 0,
    covered,
    missing,
    totalTerms: important.length,
    guidance: 'Use missing terms only when they accurately describe approved experience. Repetition does not improve this score.'
  };
}

function buildEvidenceSuggestions(resume, jobDescription) {
  const resumeText = String(resume || '');
  const lowerResume = resumeText.toLowerCase();
  const resumeBlocks = parseResumeEditableBlocks(resumeText);
  if (!resumeBlocks.length) return [];
  const jobWords = new Set(String(jobDescription || '').toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || []);
  const jobSignalWords = [...jobWords].filter((word) => word.length > 2);
  const suggestions = [];
  const usedOriginals = new Set();

  for (const fact of trustedKnowledgeFacts()) {
    const factText = `${fact.title || ''} ${fact.summary || ''}`.trim();
    const factSummary = normalizeResumeSentence(fact.summary || fact.title || '');
    if (!factSummary || lowerResume.includes(factSummary.toLowerCase())) continue;
    const factWords = new Set(factText.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || []);
    const matches = jobSignalWords.filter((word) => factWords.has(word));
    if (!matches.length) continue;
    const target = chooseResumeEditTarget(resumeBlocks, factWords, new Set(matches));
    if (!target || usedOriginals.has(target.originalText)) continue;
    const proposedText = rewriteResumeLineMinimally(target, factSummary);
    if (!proposedText || proposedText === target.originalText) continue;
    if (lowerResume.includes(stripResumeBulletPrefix(proposedText).toLowerCase())) continue;
    usedOriginals.add(target.originalText);
    suggestions.push({
      originalText: target.originalText,
      proposedText,
      reason: `${target.section ? `${target.section}: ` : ''}small wording update for ${matches.slice(0, 3).join(', ')}.`,
      evidence: [{
        factId: fact.id,
        title: fact.title,
        source: fact.source?.label || 'Professional Knowledge Center',
        excerpt: fact.sourceExcerpt || fact.summary,
        targetSection: target.section,
        action: 'replace_existing_resume_line'
      }],
      score: matches.length + target.score
    });
  }

  return suggestions
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score, ...suggestion }) => suggestion);
}

function parseResumeEditableBlocks(markdown) {
  const blocks = [];
  let section = '';
  let pendingBullet = null;
  const flushBullet = () => {
    if (!pendingBullet) return;
    const text = pendingBullet.text.replace(/\s+/g, ' ').trim();
    const originalText = `${pendingBullet.prefix}${text}`;
    if (isCompleteResumeBullet(text)) {
      blocks.push({
        originalText,
        prefix: pendingBullet.prefix,
        text,
        section: pendingBullet.section,
        words: new Set(text.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [])
      });
    }
    pendingBullet = null;
  };
  for (const rawLine of String(markdown || '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^\s{0,3}#{1,4}\s+(.+?)\s*$/);
    if (heading) {
      flushBullet();
      section = heading[1].trim();
      continue;
    }
    const bareHeading = line.match(/^\s{0,3}([A-Z][A-Z0-9 &/,+.-]{2,})\s*$/);
    if (bareHeading && !line.includes('.') && line.length <= 48) {
      flushBullet();
      section = titleCaseResumeHeading(bareHeading[1]);
      continue;
    }
    const bullet = line.match(/^(\s*(?:[-*•●▪‣]|\d+[.)])\s+)(.+?)\s*$/);
    const text = bullet ? bullet[2].trim() : line.trim();
    if (!text) {
      flushBullet();
      continue;
    }
    if (bullet) {
      flushBullet();
      pendingBullet = { prefix: bullet[1], text, section };
      continue;
    }
    if (pendingBullet && /^\s{2,}\S/.test(line) && isLikelyWrappedResumeLine(text)) {
      pendingBullet.text = `${pendingBullet.text} ${text}`;
    } else {
      flushBullet();
    }
  }
  flushBullet();
  return blocks;
}

function titleCaseResumeHeading(text) {
  return String(text || '').toLowerCase().replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function chooseResumeEditTarget(blocks, factWords, matchedJobWords) {
  let best = null;
  for (const block of blocks) {
    let score = 0;
    let overlap = 0;
    for (const word of block.words) {
      if (factWords.has(word)) {
        score += 2;
        overlap += 1;
      }
      if (matchedJobWords.has(word)) score += 3;
    }
    if (overlap < 2) continue;
    if (/experience|project|work|employment|leadership/i.test(block.section || '')) score += 2;
    if (/skill/i.test(block.section || '')) score -= 1;
    if (!best || score > best.score) best = { ...block, score };
  }
  return best && best.score >= 6 ? best : null;
}

function rewriteResumeLineMinimally(target, approvedSummary) {
  const cleanSummary = normalizeResumeSentence(approvedSummary);
  if (!cleanSummary) return '';
  if (!isCompleteResumeBullet(target.text)) return '';
  const targetWords = new Set(target.text.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || []);
  const summaryWords = new Set(cleanSummary.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || []);
  const overlap = [...targetWords].filter((word) => summaryWords.has(word)).length;
  if (overlap < 2) return '';
  const prefix = target.prefix || '';
  const sourceEndsWithPunctuation = /[.!?]$/.test(target.text);
  const proposedBody = sourceEndsWithPunctuation ? cleanSummary.replace(/[.!?]$/, '') + target.text.match(/[.!?]$/)[0] : cleanSummary.replace(/[.!?]$/, '');
  return `${prefix}${proposedBody}`;
}

function normalizeResumeSentence(text) {
  return String(text || '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripResumeBulletPrefix(text) {
  return String(text || '').replace(/^\s*(?:[-*•●▪‣]|\d+[.)])\s+/, '').trim();
}

function isLikelyWrappedResumeLine(text) {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 180) return false;
  if (/^\s*(?:[-*•●▪‣]|\d+[.)])\s+/.test(clean)) return false;
  if (/^[A-Z][A-Z0-9 &/,+.-]{2,}$/.test(clean)) return false;
  return true;
}

function isCompleteResumeBullet(text) {
  const clean = stripResumeBulletPrefix(text);
  const words = clean.match(/[a-zA-Z0-9+#.-]+/g) || [];
  if (words.length < 6 || words.length > 45) return false;
  if (/^(email|phone|linkedin|github|portfolio|address)\b/i.test(clean)) return false;
  if (!/[a-z]/i.test(clean)) return false;
  return /^(built|created|developed|engineered|implemented|led|managed|designed|analyzed|automated|optimized|improved|increased|reduced|delivered|launched|owned|supported|partnered|collaborated|conducted|modeled|forecasted|generated|streamlined|contributed|scraped|queried|maintained|evaluated|researched|presented|coordinated|trained|deployed|integrated|wrote|produced|drafted|validated|processed|architected|constructed|performed|assisted|worked|used|utilized|leveraged)\b/i.test(clean);
}

async function writeResumeDocx(filePath, markdown, options = {}) {
  if (options.templatePath) {
    await writeResumeDocxFromTemplate(
      filePath,
      options.templatePath,
      options.originalMarkdown,
      markdown
    );
    return;
  }
  const children = [];
  for (const rawLine of String(markdown || '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      children.push(new Paragraph({ spacing: { after: 70 } }));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      children.push(new Paragraph({
        heading: heading[1].length === 1 ? HeadingLevel.TITLE : HeadingLevel.HEADING_2,
        spacing: { before: heading[1].length === 1 ? 0 : 140, after: 55 },
        children: [new TextRun({
          text: heading[2],
          font: 'Arial',
          size: heading[1].length === 1 ? 30 : 22,
          bold: true
        })]
      }));
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    children.push(new Paragraph({
      bullet: bullet ? { level: 0 } : undefined,
      spacing: { after: 45, line: 220 },
      children: [new TextRun({ text: bullet ? bullet[1] : line, font: 'Arial', size: 20 })]
    }));
  }
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 20 },
          paragraph: { spacing: { after: 45, line: 220 } }
        }
      }
    },
    sections: [{
      properties: { page: { margin: { top: 540, right: 630, bottom: 540, left: 630 } } },
      children
    }]
  });
  fs.writeFileSync(filePath, await Packer.toBuffer(doc));
}

async function writeResumeDocxFromTemplate(filePath, templatePath, originalMarkdown, editedMarkdown) {
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('The uploaded DOCX does not contain an editable document body.');
  const documentXml = await documentFile.async('string');
  const patchedXml = patchResumeDocumentXml(documentXml, originalMarkdown, editedMarkdown);
  zip.file('word/document.xml', patchedXml);
  fs.writeFileSync(filePath, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  }));
}

function patchResumeDocumentXml(documentXml, originalMarkdown, editedMarkdown) {
  const paragraphPattern = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  const paragraphs = [];
  let match;
  while ((match = paragraphPattern.exec(documentXml))) {
    const text = wordParagraphText(match[0]);
    if (!text.trim()) continue;
    paragraphs.push({
      start: match.index,
      end: match.index + match[0].length,
      xml: match[0],
      text: normalizeResumeLine(text)
    });
  }

  const originalLines = resumeEditableLines(originalMarkdown);
  const editedLines = resumeEditableLines(editedMarkdown);
  if (!paragraphs.length || !editedLines.length) {
    throw new Error('The uploaded DOCX does not contain editable resume paragraphs.');
  }

  // Mammoth's raw-text extraction maps each non-empty Word paragraph to a
  // resume line. Keep unchanged paragraph XML byte-for-byte and only replace
  // text in paragraphs the user edited, retaining paragraph/run formatting.
  const sourceLines = paragraphs.map((paragraph) => paragraph.text);
  const baseline = originalLines.length === sourceLines.length ? originalLines : sourceLines;
  const aligned = alignResumeLines(baseline, editedLines);
  const replacements = [];
  for (let index = 0; index < paragraphs.length; index += 1) {
    const nextText = aligned[index] ?? '';
    const paragraph = paragraphs[index];
    if (normalizeResumeLine(nextText) === paragraph.text) continue;
    replacements.push({
      start: paragraph.start,
      end: paragraph.end,
      xml: replaceWordParagraphText(paragraph.xml, nextText)
    });
  }

  let output = documentXml;
  for (const replacement of replacements.reverse()) {
    output = `${output.slice(0, replacement.start)}${replacement.xml}${output.slice(replacement.end)}`;
  }
  return output;
}

function resumeEditableLines(markdown) {
  const lines = String(markdown || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(normalizeResumeLine)
    .filter(Boolean);
  if (lines[0]?.toLowerCase() === 'resume') lines.shift();
  return lines;
}

function normalizeResumeLine(value) {
  return decodeXml(String(value || ''))
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordParagraphText(paragraphXml) {
  const parts = [];
  const textPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match;
  while ((match = textPattern.exec(paragraphXml))) parts.push(match[1]);
  return parts.join('');
}

function replaceWordParagraphText(paragraphXml, nextText) {
  const textPattern = /<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g;
  const nodes = [...paragraphXml.matchAll(textPattern)];
  if (!nodes.length) return paragraphXml;
  const originalLengths = nodes.map((node) => decodeXml(wordTextNodeValue(node[0])).length);
  const chunks = distributeTextAcrossRuns(String(nextText || ''), originalLengths);
  let output = paragraphXml;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    const replacement = replaceWordTextNodeValue(node[0], chunks[index] || '');
    output = `${output.slice(0, node.index)}${replacement}${output.slice(node.index + node[0].length)}`;
  }
  return output;
}

function wordTextNodeValue(nodeXml) {
  const match = nodeXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/);
  return match ? match[1] : '';
}

function replaceWordTextNodeValue(nodeXml, value) {
  const escaped = escapeXml(value);
  return nodeXml.replace(
    /<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/,
    `<w:t xml:space="preserve">${escaped}</w:t>`
  );
}

function distributeTextAcrossRuns(text, originalLengths) {
  if (originalLengths.length === 1) return [text];
  const total = originalLengths.reduce((sum, length) => sum + length, 0) || 1;
  const chunks = [];
  let cursor = 0;
  for (let index = 0; index < originalLengths.length; index += 1) {
    if (index === originalLengths.length - 1) {
      chunks.push(text.slice(cursor));
      break;
    }
    const target = Math.round((originalLengths.slice(0, index + 1).reduce((sum, length) => sum + length, 0) / total) * text.length);
    chunks.push(text.slice(cursor, target));
    cursor = target;
  }
  return chunks;
}

function alignResumeLines(originalLines, editedLines) {
  if (originalLines.length === editedLines.length) return editedLines;
  const aligned = new Array(originalLines.length).fill(null);
  const count = Math.min(originalLines.length, editedLines.length);
  for (let index = 0; index < count; index += 1) aligned[index] = editedLines[index];
  if (editedLines.length > originalLines.length && aligned.length) {
    aligned[aligned.length - 1] = editedLines.slice(aligned.length - 1).join(' ');
  }
  return aligned;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function renderResumePdf(filePath, markdown) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>
      @page{size:Letter;margin:.5in}body{font-family:Arial,sans-serif;font-size:10pt;line-height:1.18;color:#111}
      h1{font-size:15pt;text-align:center;margin:0 0 8pt}h2,h3{font-size:11pt;margin:9pt 0 3pt;border-bottom:1px solid #222}
      p{margin:0 0 4pt}ul{margin:0 0 4pt 18pt;padding:0}li{margin:0 0 2pt}
    </style>${markdownToResumeHtml(markdown)}`);
    await page.pdf({ path: filePath, format: 'Letter', printBackground: true });
  } finally {
    await browser.close();
  }
}

async function renderResumeImagePagesPdf(filePath, renderedPages) {
  const pages = renderedPages
    .map((page) => String(page || ''))
    .filter((page) => /^data:image\/png;base64,/.test(page));
  if (!pages.length) throw new Error('No rendered PDF pages were provided.');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>
      @page{size:Letter;margin:0}html,body{margin:0;padding:0}
      .page{width:8.5in;height:11in;page-break-after:always;overflow:hidden}
      .page:last-child{page-break-after:auto}.page img{display:block;width:100%;height:100%}
    </style>${pages.map((image) => `<div class="page"><img src="${image}"></div>`).join('')}`);
    await page.pdf({
      path: filePath,
      width: '8.5in',
      height: '11in',
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      printBackground: true
    });
  } finally {
    await browser.close();
  }
}

function markdownToResumeHtml(markdown) {
  const parts = [];
  let inList = false;
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (!bullet && inList) {
      parts.push('</ul>');
      inList = false;
    }
    if (heading) parts.push(`<h${heading[1].length}>${escapeHtmlServer(heading[2])}</h${heading[1].length}>`);
    else if (bullet) {
      if (!inList) {
        parts.push('<ul>');
        inList = true;
      }
      parts.push(`<li>${escapeHtmlServer(bullet[1])}</li>`);
    } else if (line) parts.push(`<p>${escapeHtmlServer(line)}</p>`);
  }
  if (inList) parts.push('</ul>');
  return parts.join('');
}

function loadKnowledgeCenter() {
  if (!sqliteStore.available()) {
    return {
      available: false,
      facts: [],
      records: [],
      counts: { total: 0, pending: 0, trusted: 0, rejected: 0 },
      categories: {},
      categoryOptions: knowledgeCategories
    };
  }
  const summary = sqliteStore.knowledgeSummary();
  const records = buildKnowledgeRecords(summary.facts.filter((fact) => fact.status !== 'rejected'));
  return {
    available: true,
    ...summary,
    records,
    categoryOptions: knowledgeCategories
  };
}

function trustedKnowledgeFacts() {
  return sqliteStore.available() ? sqliteStore.listKnowledgeFacts({ status: 'trusted' }) : [];
}

function trustedKnowledgeContext() {
  const records = buildKnowledgeRecords(trustedKnowledgeFacts());
  if (!records.length) return 'No professional knowledge facts are available.';
  return records.map((record) => {
    const metadata = Object.entries(record.metadata || {})
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .join('; ');
    const facts = record.facts.map((fact) => `${fact.title}: ${fact.summary}`).join('; ');
    return `- [${record.category}] ${record.name}${metadata ? ` (${metadata})` : ''}${facts ? ` — ${facts}` : ''}`;
  }).join('\n');
}

function relevantKnowledgeContext(jd, jobTitle) {
  const records = buildKnowledgeRecords(trustedKnowledgeFacts());
  if (!records.length) return 'No professional knowledge facts are available.';
  const target = `${jobTitle || ''} ${jd || ''}`.toLowerCase();
  const tokens = new Set(target.match(/\b[a-z][a-z0-9+#.-]{1,}/g) || []);
  const STOP = new Set(['and','the','for','with','this','that','are','have','will','from','your','our','you','can','may','able','their','they','been','also','both','more','such','any','all','not','but','its','use','used','using']);
  for (const w of STOP) tokens.delete(w);

  function score(record) {
    const text = [
      record.name,
      record.category,
      ...record.facts.map((f) => `${f.title} ${f.summary}`),
      ...Object.values(record.metadata || {}).flat()
    ].join(' ').toLowerCase();
    let hits = 0;
    for (const token of tokens) {
      if (text.includes(token)) hits++;
    }
    return hits;
  }

  const scored = records.map((r) => ({ record: r, score: score(r) }));
  scored.sort((a, b) => b.score - a.score);

  const lines = [];
  let chars = 0;
  const BUDGET = 6000;
  for (const { record } of scored) {
    const metadata = Object.entries(record.metadata || {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('; ');
    const facts = record.facts.map((f) => `${f.title}: ${f.summary}`).join('; ');
    const line = `- [${record.category}] ${record.name}${metadata ? ` (${metadata})` : ''}${facts ? ` — ${facts}` : ''}`;
    if (chars + line.length > BUDGET) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.length ? lines.join('\n') : 'No professional knowledge facts are available.';
}

function buildKnowledgeRecords(facts) {
  const expanded = splitSkillFacts(dedupeKnowledgeFacts(reclassifyTranscriptCourses(facts)));
  const projectFamilies = projectFamilyNames(expanded.filter((fact) => fact.category === 'projects'));
  const records = new Map();
  for (const fact of expanded) {
    const descriptor = recordDescriptor(fact, projectFamilies);
    const key = `${fact.category}|${normalizeFactKey(descriptor.name)}`;
    if (!records.has(key)) {
      records.set(key, {
        id: key,
        category: fact.category,
        name: descriptor.name,
        metadata: {},
        facts: [],
        factIds: [],
        sources: []
      });
    }
    const record = records.get(key);
    if (fact.id && !record.factIds.includes(fact.id)) record.factIds.push(fact.id);
    mergeRecordMetadata(record.metadata, descriptor.metadata);
    if (!descriptor.metadataOnly && !record.facts.some((item) => normalizeFactKey(item.summary) === normalizeFactKey(fact.summary))) {
      record.facts.push(fact);
    }
    if (fact.source?.label && !record.sources.includes(fact.source.label)) record.sources.push(fact.source.label);
  }
  return [...records.values()].map(finalizeKnowledgeRecord);
}

function reclassifyTranscriptCourses(facts) {
  const educationBySource = new Map();
  const educationEntities = new Set();
  for (const fact of facts || []) {
    if (fact.category !== 'education') continue;
    const sourceId = fact.source?.id || fact.source?.label;
    const entity = fact.details?.entity || fact.details?.institution || fact.details?.school;
    if (entity) educationEntities.add(entity);
    if (sourceId && entity) educationBySource.set(sourceId, entity);
  }
  return (facts || []).map((fact) => {
    if (fact.category !== 'skills' || !/transcript|academic record|student record|tsrpt/i.test(fact.source?.label || '')) return fact;
    const sourceId = fact.source?.id || fact.source?.label;
    return {
      ...fact,
      category: 'education',
      factType: 'course',
      title: fact.title === 'Skill' ? 'Course' : fact.title,
      details: {
        ...(fact.details || {}),
        entity: educationBySource.get(sourceId)
          || (educationEntities.size === 1 ? [...educationEntities][0] : '')
          || fact.details?.entity
          || 'Education'
      }
    };
  });
}

function dedupeKnowledgeFacts(facts) {
  const seen = new Map();
  for (const fact of facts || []) {
    const key = [
      fact.category,
      fact.factType,
      normalizeFactKey(fact.details?.entity || ''),
      normalizeFactKey(fact.summary)
    ].join('|');
    const current = seen.get(key);
    if (!current || Number(fact.confidence) > Number(current.confidence)) seen.set(key, fact);
  }
  return [...seen.values()];
}

function splitSkillFacts(facts) {
  return facts.flatMap((fact) => {
    if (fact.category !== 'skills') return [fact];
    const summary = String(fact.summary || '');
    const genericSummary = /\b(?:programming|analytics|cloud|design|office software|language)\s+skills?\b/i.test(summary)
      || /^(?:lists?|includes?)\b/i.test(summary);
    const value = String(genericSummary && fact.sourceExcerpt ? fact.sourceExcerpt : summary)
      .replace(/^(?:technical|language|listed)\s+skills?\s*:\s*/i, '')
      .replace(/^skills?\s*:\s*/i, '');
    const items = value.split(/[,;]|\s+\band\b\s+/i)
      .map((item) => item.replace(/^(?:lists?|includes?|proficient in|skilled in)\s+/i, '').trim())
      .filter((item) => item.length > 1 && item.length < 80);
    if (items.length < 2) return [fact];
    return [...new Set(items.map((item) => item.replace(/[.]$/, '')))].map((skill) => ({
      ...fact,
      id: `${fact.id}:${normalizeFactKey(skill)}`,
      factType: 'skill',
      title: 'Skill',
      summary: skill,
      details: { ...(fact.details || {}), entity: 'Skills' }
    }));
  });
}

function projectFamilyNames(facts) {
  const families = new Map();
  for (const fact of facts) {
    const text = `${fact.details?.entity || ''} ${fact.title || ''} ${fact.summary || ''}`.trim();
    const acronym = text.match(/\b[A-Z]{2,6}\b/)?.[0];
    const family = acronym || normalizeFactKey(fact.details?.entity || fact.title).split(' ')[0];
    if (!family) continue;
    const candidate = String(fact.details?.entity || fact.title || '').trim();
    const startsWithVerb = /^(?:analyzed|built|created|developed|improved|increased|designed|implemented|launched|modeled|forecasted)\b/i.test(candidate);
    const score = (startsWithVerb ? 0 : 20) + candidate.length + (/\b(?:project|analysis|market|system|platform)\b/i.test(candidate) ? 15 : 0);
    const current = families.get(family);
    if (!current || score > current.score) families.set(family, { name: candidate, score });
  }
  return families;
}

function recordDescriptor(fact, projectFamilies) {
  const details = fact.details || {};
  if (fact.category === 'employment') return employmentDescriptor(fact);
  if (fact.category === 'projects') {
    const text = `${details.entity || ''} ${fact.title || ''} ${fact.summary || ''}`;
    const family = text.match(/\b[A-Z]{2,6}\b/)?.[0] || normalizeFactKey(details.entity || fact.title).split(' ')[0];
    return { name: details.entity || projectFamilies.get(family)?.name || fact.title || 'Project', metadata: {}, metadataOnly: false };
  }
  if (fact.category === 'education') {
    return { name: details.entity || details.institution || details.school || 'Education', metadata: educationMetadata(fact), metadataOnly: isEducationMetadataFact(fact) };
  }
  if (fact.category === 'skills') return { name: 'Skills', metadata: {}, metadataOnly: false };
  if (fact.category === 'role-preferences') return preferenceDescriptor(fact);
  if (fact.category === 'career-goals') return { name: 'Career goals', metadata: preferenceMetadata(fact), metadataOnly: true };
  if (fact.category === 'application-answers') return { name: 'Application answers', metadata: preferenceMetadata(fact), metadataOnly: true };
  return { name: details.entity || fact.title || knowledgeCategoryName(fact.category), metadata: {}, metadataOnly: false };
}

function employmentDescriptor(fact) {
  const details = fact.details || {};
  const atPattern = /\b(?:at|@)\s+([^,|]+?)(?=,\s*(?:remote|hybrid|on-site|from|\d)|$)/i;
  const atMatch = String(fact.title || '').match(atPattern) || String(fact.summary || '').match(atPattern);
  const company = details.entity || details.employer || details.company || atMatch?.[1]?.trim() || 'Experience';
  const role = details.role || fact.title?.match(/^(.+?)\s+(?:at|@)\s+/i)?.[1]?.trim()
    || fact.summary?.match(/^(?:been\s+)?(?:an?\s+)?(.+?)\s+(?:at|@)\s+/i)?.[1]?.trim();
  const location = details.location || fact.summary?.match(/\b(?:remote|hybrid|on-site)\s+from\s+(.+?)(?=,\s*from\b|$)/i)?.[1]?.trim();
  const workMode = details.workMode || fact.summary?.match(/\b(remote|hybrid|on-site)\b/i)?.[1];
  const dates = details.dates || fact.summary?.match(/\bfrom\s+([A-Z][a-z]+\s+\d{4}\s+to\s+(?:present|[A-Z][a-z]+\s+\d{4}))/i)?.[1];
  const metadata = { Role: role, Location: location, 'Work mode': titleCaseValue(workMode), Dates: dates };
  const metadataOnly = Boolean(role) && !hasImportantDetail(fact.summary, [role, company, location, workMode, dates]);
  return { name: company, metadata, metadataOnly };
}

function educationMetadata(fact) {
  const details = fact.details || {};
  const summary = String(fact.summary || '');
  return {
    Degree: details.degree || (/degree/i.test(fact.factType) ? summary : ''),
    Field: details.field || details.major || '',
    Location: details.location || '',
    Dates: details.dates || details.graduationDate || ''
  };
}

function isEducationMetadataFact(fact) {
  return /^(?:degree|field|major|location|dates?|graduation)$/i.test(fact.factType);
}

function preferenceDescriptor(fact) {
  return { name: 'Role preferences', metadata: preferenceMetadata(fact), metadataOnly: true };
}

function preferenceMetadata(fact) {
  const labels = {
    target_location: 'Locations',
    work_mode: 'Work modes',
    employment_type: 'Employment types',
    minimum_compensation: 'Minimum compensation',
    sponsorship: 'Sponsorship',
    target_role: 'Target roles'
  };
  return { [labels[fact.factType] || fact.title || 'Preference']: fact.summary };
}

function mergeRecordMetadata(target, incoming) {
  for (const [key, value] of Object.entries(incoming || {})) {
    if (!value) continue;
    const values = Array.isArray(value) ? value : [value];
    const current = target[key] ? (Array.isArray(target[key]) ? target[key] : [target[key]]) : [];
    target[key] = [...new Set([...current, ...values].map((item) => String(item).trim()).filter(Boolean))];
  }
}

function finalizeKnowledgeRecord(record) {
  const metadata = {};
  for (const [key, values] of Object.entries(record.metadata)) {
    const deduped = dedupeGeneralizedValues(values);
    metadata[key] = deduped.length === 1 ? deduped[0] : deduped;
  }
  return { ...record, metadata };
}

function dedupeGeneralizedValues(values) {
  const unique = [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))];
  return unique.filter((value, index) => !unique.some((other, otherIndex) => (
    index !== otherIndex
    && normalizeFactKey(other).includes(normalizeFactKey(value))
    && normalizeFactKey(other).length > normalizeFactKey(value).length
  )));
}

function hasImportantDetail(summary, metadataValues) {
  let remainder = normalizeFactKey(summary);
  for (const value of metadataValues.filter(Boolean)) remainder = remainder.replace(normalizeFactKey(value), '');
  remainder = remainder.replace(/\b(?:been|a|an|at|from|to|present|remote|hybrid|on site|in)\b/g, '').trim();
  return /\d+(?:\.\d+)?%|\$[\d,.]+|\b\d+x\b/i.test(summary) || remainder.length > 18;
}

function normalizeFactKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9%$]+/g, ' ').trim();
}

function knowledgeCategoryName(category) {
  return String(category || '').split('-').map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ');
}

function titleCaseValue(value) {
  return value ? String(value).replace(/\b\w/g, (letter) => letter.toUpperCase()) : '';
}

function saveKnowledgeFact(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Professional Knowledge Center requires initialized application data.');
  const category = normalizeKnowledgeCategory(payload.category);
  const title = cleanRequiredText(payload.title, 'title');
  const summary = cleanRequiredText(payload.summary, 'summary');
  const sourceId = sqliteStore.addKnowledgeSource({
    sourceType: 'manual',
    label: 'User-provided fact',
    metadata: { enteredBy: 'user' }
  });
  sqliteStore.addKnowledgeFacts([{
    category,
    factType: cleanSetting(payload.factType || 'general').toLowerCase() || 'general',
    title,
    summary,
    details: payload.details && typeof payload.details === 'object' ? payload.details : {},
    confidence: 1,
    sourceExcerpt: summary
  }], sourceId, 'trusted');
  return { ok: true, knowledgeCenter: loadKnowledgeCenter() };
}

function updateKnowledgeFact(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Professional Knowledge Center requires initialized application data.');
  sqliteStore.updateKnowledgeFact(String(payload.id || ''), {
    category: normalizeKnowledgeCategory(payload.category),
    factType: cleanSetting(payload.factType || 'general').toLowerCase() || 'general',
    title: cleanRequiredText(payload.title, 'title'),
    summary: cleanRequiredText(payload.summary, 'summary'),
    details: payload.details && typeof payload.details === 'object' ? payload.details : {}
  });
  return { ok: true, knowledgeCenter: loadKnowledgeCenter() };
}

function updateKnowledgeRecord(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Professional Knowledge Center requires initialized application data.');
  sqliteStore.updateKnowledgeRecord(payload.factIds, {
    category: normalizeKnowledgeCategory(payload.category),
    name: cleanRequiredText(payload.name, 'record name'),
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
  });
  return { ok: true, knowledgeCenter: loadKnowledgeCenter() };
}

function clearKnowledgeCenter() {
  if (!sqliteStore.available()) throw new Error('Professional Knowledge Center requires initialized application data.');
  sqliteStore.clearKnowledge();
  return { ok: true, knowledgeCenter: loadKnowledgeCenter() };
}

function setKnowledgeFactStatus(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Professional Knowledge Center requires initialized application data.');
  sqliteStore.updateKnowledgeFactStatus(String(payload.id || ''), String(payload.status || ''));
  return { ok: true, knowledgeCenter: loadKnowledgeCenter() };
}

function removeKnowledgeFact(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Professional Knowledge Center requires initialized application data.');
  sqliteStore.deleteKnowledgeFact(String(payload.id || ''));
  return { ok: true, knowledgeCenter: loadKnowledgeCenter() };
}

function renameResume(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Resume renaming requires initialized application data.');
  sqliteStore.renameResume(String(payload.id || ''), cleanResumeName(payload.name));
  return {
    ok: true,
    resumes: listResumes(),
    settings: loadResumeSettings(),
    knowledgeCenter: loadKnowledgeCenter()
  };
}

function deleteResume(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Resume deletion requires initialized application data.');
  sqliteStore.deleteResume(String(payload.id || ''));
  return {
    ok: true,
    resumes: listResumes(),
    settings: loadResumeSettings(),
    resume: currentResume(),
    knowledgeCenter: loadKnowledgeCenter()
  };
}

function normalizeKnowledgeCategory(value) {
  const category = String(value || '').trim().toLowerCase();
  if (!knowledgeCategories.includes(category)) throw new Error('Invalid knowledge category.');
  return category;
}

function trackerPath() {
  const rootTracker = path.join(careerRoot, 'applications.md');
  if (fs.existsSync(rootTracker)) return rootTracker;
  return path.join(careerRoot, 'data', 'applications.md');
}

function parseApplications() {
  const filePath = trackerPath();
  if (!fs.existsSync(filePath)) return [];
  const lines = readText(filePath).split(/\r?\n/);
  const apps = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|') || line.startsWith('|---') || line.startsWith('| #') || line.startsWith('#')) continue;
    const fields = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((part) => part.trim());
    if (fields.length < 8 || Number.isNaN(Number.parseInt(fields[0], 10))) continue;

    const report = parseReport(fields[7], filePath);
    const scoreRaw = fields[4] || '';
    const scoreValue = parseScoreField(scoreRaw);
    const row = {
      number: Number.parseInt(fields[0], 10),
      date: fields[1] || '',
      company: fields[2] || '',
      role: fields[3] || '',
      score: scoreValue.score,
      scoreRaw,
      isScored: scoreValue.isScored,
      status: fields[5] || '',
      pdf: fields[6] || '',
      hasPdf: fields[6]?.includes('✅') || fields[6]?.includes('âœ…'),
      reportLabel: report.label,
      reportPath: report.path,
      notes: fields[8] || '',
      jobUrl: '',
      location: '',
      workMode: '',
      payRange: '',
      lastContact: ''
    };
    deriveNoteFields(row);
    apps.push(row);
  }

  enrichUrls(apps);
  return apps;
}

function parsePendingJobs() {
  if (sqliteStore.available()) return sqliteStore.loadSnapshot().pendingJobs;
  const pipelinePath = path.join(careerRoot, 'data', 'pipeline.md');
  const history = scanHistoryByUrl();
  const apps = parseApplications();
  const seenUrls = new Set(apps.map((row) => row.jobUrl).filter(Boolean));
  const rows = [];
  if (!fs.existsSync(pipelinePath)) return rows;

  for (const raw of readText(pipelinePath).split(/\r?\n/)) {
    const match = raw.match(/^\s*-\s\[\s\]\s+(https?:\/\/\S+)\s+\|\s+([^|]+)\s+\|\s+(.+)$/);
    if (!match) continue;
    const url = match[1].trim();
    const company = match[2].trim();
    const role = match[3].trim();
    const hist = history.get(url) || {};
    rows.push({
      url,
      company,
      role,
      portal: hist.portal || portalFromUrl(url),
      firstSeen: hist.firstSeen || '',
      datePosted: hist.datePosted || '',
      location: hist.location || '',
      alreadyTracked: seenUrls.has(url)
    });
  }
  return rows.sort((left, right) => String(right.datePosted || '').localeCompare(String(left.datePosted || '')));
}

async function addPendingJobLink(payload = {}) {
  const url = normalizeHttpUrl(payload.url, true);
  const normalizedUrl = comparableUrl(url);
  if (sqliteStore.available()) {
    const snapshot = sqliteStore.loadSnapshot();
    if (snapshot.pendingJobs.some((job) => comparableUrl(job.url) === normalizedUrl)) {
      return {
        ok: true,
        duplicate: true,
        message: 'This job is already in Discovery.',
        dashboard: await loadDashboard()
      };
    }
    const tracked = snapshot.applications.find((row) => row.jobUrl && comparableUrl(row.jobUrl) === normalizedUrl);
    if (tracked) {
      return {
        ok: true,
        duplicate: true,
        message: `This job is already tracked as application #${tracked.number}.`,
        dashboard: await loadDashboard()
      };
    }
    const identity = await resolveJobIdentity(url);
    sqliteStore.addPendingJob({ url, ...identity, portal: portalFromUrl(url) });
    return {
      ok: true,
      duplicate: false,
      job: { url, ...identity },
      message: `Added ${identity.company} — ${identity.role} to Discovery.`,
      dashboard: await loadDashboard()
    };
  }
  const pending = parsePendingJobs();
  if (pending.some((job) => comparableUrl(job.url) === normalizedUrl)) {
    return {
      ok: true,
      duplicate: true,
      message: 'This job is already in Discovery.',
      dashboard: await loadDashboard()
    };
  }

  const tracked = parseApplications().find((row) => row.jobUrl && comparableUrl(row.jobUrl) === normalizedUrl);
  if (tracked) {
    return {
      ok: true,
      duplicate: true,
      message: `This job is already tracked as application #${tracked.number}.`,
      dashboard: await loadDashboard()
    };
  }

  const identity = await resolveJobIdentity(url);
  const pipelinePath = path.join(careerRoot, 'data', 'pipeline.md');
  fs.mkdirSync(path.dirname(pipelinePath), { recursive: true });
  let pipeline = readText(pipelinePath);
  if (!pipeline.trim()) {
    pipeline = '# Pipeline — Pending Evaluations\n\n## Pending\n<!-- New URLs added by scanner or desktop app go here -->\n';
  }
  const separator = pipeline.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(
    pipelinePath,
    `${pipeline}${separator}\n- [ ] ${url} | ${identity.company} | ${identity.role}\n`,
    'utf8'
  );
  appendManualScanHistory({ url, ...identity });

  return {
    ok: true,
    duplicate: false,
    job: { url, ...identity },
    message: `Added ${identity.company} — ${identity.role} to Discovery.`,
    dashboard: await loadDashboard()
  };
}

async function importDiscoverySource(payload = {}) {
  const sourceUrl = normalizeHttpUrl(payload.url, true);
  const source = await fetchDiscoverySource(sourceUrl);
  const extracted = parseDiscoverySource(source);
  if (extracted.length === 0) {
    throw new Error('No job listings were found. Use a public GitHub repository, Google Sheet, or webpage with job links.');
  }

  const jobs = deduplicateSourceJobs(extracted).slice(0, 1000);
  let added = 0;
  let recorded = 0;

  if (sqliteStore.available()) {
    const imported = sqliteStore.importScanDiscoveries(jobs.map((job) => ({
      url: job.url,
      company: job.company,
      title: job.role,
      portal: portalFromUrl(job.url),
      sourceLabel: source.label,
      firstSeen: new Date().toISOString().slice(0, 10),
      datePosted: job.datePosted,
      location: job.location,
      status: 'added'
    })));
    added = imported.added;
    recorded = imported.recorded;
    if (payload.saveSource !== false) {
      sqliteStore.saveDiscoverySource({
        url: sourceUrl,
        label: source.label,
        sourceType: source.type
      });
    }
  } else {
    const result = importDiscoveryJobsToFiles(jobs);
    added = result.added;
    recorded = result.recorded;
    if (payload.saveSource !== false) saveDiscoverySourceFile({
      url: sourceUrl,
      label: source.label,
      sourceType: source.type,
      lastRefreshedAt: new Date().toISOString(),
      lastError: ''
    });
  }

  return {
    ok: true,
    sourceType: source.type,
    extracted: extracted.length,
    unique: jobs.length,
    added,
    duplicates: jobs.length - added,
    recorded,
    message: `Imported ${added} new job${added === 1 ? '' : 's'} from ${source.label}.`,
    dashboard: await loadDashboard()
  };
}

async function refreshDiscovery(onProgress) {
  const sources = sqliteStore.available()
    ? sqliteStore.listDiscoverySources()
    : loadDiscoverySources();

  const sourceResults = await Promise.all(sources.map(async (saved) => {
    if (onProgress) onProgress({ type: 'source-start', label: saved.label || saved.url });
    try {
      const result = await importDiscoverySource({ url: saved.url, saveSource: false });
      recordDiscoverySourceRefresh(saved, '');
      if (onProgress) onProgress({ type: 'source-done', label: saved.label || saved.url, added: result.added });
      return { url: saved.url, label: saved.label, ok: true, added: result.added, unique: result.unique };
    } catch (error) {
      recordDiscoverySourceRefresh(saved, error.message);
      if (onProgress) onProgress({ type: 'source-error', label: saved.label || saved.url, error: error.message });
      return { url: saved.url, label: saved.label, ok: false, added: 0, error: error.message };
    }
  }));

  const listAdded = sourceResults.reduce((sum, r) => sum + r.added, 0);
  let apiResult = null;
  try {
    if (onProgress) onProgress({ type: 'api-scan-start', label: 'Job board APIs' });
    apiResult = await runScan();
    if (onProgress) onProgress({ type: 'api-scan-done', label: 'Job board APIs' });
  } catch (error) {
    apiResult = { ok: false, output: error.message, imported: { added: 0 } };
    if (onProgress) onProgress({ type: 'api-scan-error', label: 'Job board APIs', error: error.message });
  }
  const apiAdded = Number(apiResult?.imported?.added || 0);
  const failures = sourceResults.filter((result) => !result.ok).length + (apiResult?.ok === false ? 1 : 0);
  return {
    ok: failures === 0,
    apiResult,
    sourceResults,
    apiAdded,
    listAdded,
    sourceCount: sources.length,
    failures,
    message: `Refresh complete: ${apiAdded + listAdded} new job${apiAdded + listAdded === 1 ? '' : 's'} from APIs and ${sources.length} saved list${sources.length === 1 ? '' : 's'}${failures ? `; ${failures} source${failures === 1 ? '' : 's'} failed` : ''}.`,
    dashboard: await loadDashboard()
  };
}

function recordDiscoverySourceRefresh(source, error) {
  if (sqliteStore.available()) {
    sqliteStore.saveDiscoverySource({ ...source, error });
    return;
  }
  saveDiscoverySourceFile({
    ...source,
    lastRefreshedAt: error ? source.lastRefreshedAt || '' : new Date().toISOString(),
    lastError: error || ''
  });
}

function loadDiscoverySources() {
  const records = readJson(discoverySourcesPath());
  return Array.isArray(records) ? records : [];
}

function saveDiscoverySourceFile(source) {
  const records = loadDiscoverySources();
  const index = records.findIndex((record) => comparableUrl(record.url) === comparableUrl(source.url));
  if (index >= 0) records[index] = { ...records[index], ...source };
  else records.push(source);
  fs.mkdirSync(path.dirname(discoverySourcesPath()), { recursive: true });
  fs.writeFileSync(discoverySourcesPath(), JSON.stringify(records, null, 2), 'utf8');
}

async function deleteDiscoverySource({ url }) {
  if (!url) return { ok: false, error: 'url is required' };
  if (sqliteStore.available()) {
    sqliteStore.deleteDiscoverySource(url);
  } else {
    const records = loadDiscoverySources().filter((r) => comparableUrl(r.url) !== comparableUrl(url));
    fs.mkdirSync(path.dirname(discoverySourcesPath()), { recursive: true });
    fs.writeFileSync(discoverySourcesPath(), JSON.stringify(records, null, 2), 'utf8');
  }
  return { ok: true, dashboard: await loadDashboard() };
}

async function updateDiscoverySource({ url, label }) {
  if (!url) return { ok: false, error: 'url is required' };
  const trimmedLabel = String(label || '').trim();
  if (!trimmedLabel) return { ok: false, error: 'label is required' };
  if (sqliteStore.available()) {
    sqliteStore.updateDiscoverySourceLabel(url, trimmedLabel);
  } else {
    saveDiscoverySourceFile({ url, label: trimmedLabel });
  }
  return { ok: true, dashboard: await loadDashboard() };
}

function discoverySourcesPath() {
  return path.join(app.getPath('userData'), 'discovery-sources.json');
}

async function fetchDiscoverySource(sourceUrl) {
  const parsed = new URL(sourceUrl);
  const headers = {
    'User-Agent': 'Career-Ops/0.1 (+https://github.com/santif/career-ops)',
    Accept: 'text/html,text/plain,application/json'
  };
  let fetchUrl = sourceUrl;
  let type = 'html';
  let label = parsed.hostname;

  if (parsed.hostname === 'github.com') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      fetchUrl = `https://api.github.com/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/readme`;
      headers.Accept = 'application/vnd.github.raw+json';
      type = 'markdown';
      label = `${parts[0]}/${parts[1]}`;
    }
  } else if (parsed.hostname === 'docs.google.com' && parsed.pathname.includes('/spreadsheets/d/')) {
    const sheetId = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/)?.[1];
    const gid = parsed.searchParams.get('gid') || sourceUrl.match(/[?#&]gid=(\d+)/)?.[1] || '0';
    if (sheetId) {
      fetchUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
      headers.Accept = 'text/csv';
      type = 'csv';
      label = 'Google Sheets';
    }
  } else if (/\.csv(?:$|\?)/i.test(parsed.pathname + parsed.search)) {
    type = 'csv';
  } else if (/\.(?:md|markdown)(?:$|\?)/i.test(parsed.pathname + parsed.search)) {
    type = 'markdown';
  }

  const response = await fetch(fetchUrl, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(`Could not read the source (${response.status} ${response.statusText}). Make sure it is public.`);
  }
  const content = await response.text();
  if (!content.trim()) throw new Error('The source was empty.');
  return { type, label, sourceUrl, content };
}

function parseDiscoverySource(source) {
  if (source.type === 'csv') return parseDelimitedJobList(source.content, source.sourceUrl);
  if (source.type === 'markdown') return parseMarkdownJobList(source.content, source.sourceUrl);
  return parseHtmlJobList(source.content, source.sourceUrl);
}

function parseDelimitedJobList(content, sourceUrl) {
  const rows = parseCsvRows(content);
  if (rows.length < 2) return [];
  const headers = rows.shift().map(normalizeHeader);
  return rows.map((cells) => jobFromCells(headers, cells, sourceUrl)).filter(Boolean);
}

function parseMarkdownJobList(content, sourceUrl) {
  const jobs = [];
  let headers = [];
  let previousCompany = '';
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitMarkdownRow(line);
    if (cells.length < 2) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) continue;
    if (headers.length === 0 || looksLikeJobHeader(cells)) {
      headers = cells.map((cell) => normalizeHeader(cleanCellText(cell)));
      continue;
    }
    const job = jobFromCells(headers, cells, sourceUrl, previousCompany);
    if (!job) continue;
    previousCompany = job.company || previousCompany;
    jobs.push(job);
  }
  return jobs;
}

function parseHtmlJobList(content, sourceUrl) {
  const jobs = [];
  const tableMatches = content.match(/<table\b[\s\S]*?<\/table>/gi) || [];
  for (const table of tableMatches) {
    const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < 2) continue;
    let headers = [];
    let previousCompany = '';
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) => match[1]);
      if (cells.length < 2) continue;
      if (headers.length === 0 || /<th\b/i.test(row)) {
        headers = cells.map((cell) => normalizeHeader(cleanCellText(cell)));
        continue;
      }
      const job = jobFromCells(headers, cells, sourceUrl, previousCompany);
      if (!job) continue;
      previousCompany = job.company || previousCompany;
      jobs.push(job);
    }
  }
  if (jobs.length > 0) return jobs;

  for (const match of content.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = cleanCellText(match[2]);
    const url = resolveSourceUrl(match[1], sourceUrl);
    if (!isLikelyJobUrl(url, text)) continue;
    jobs.push({
      url,
      company: companyFromJobUrl(url),
      role: text || 'Job posting',
      datePosted: '',
      location: ''
    });
  }
  return jobs;
}

function jobFromCells(headers, cells, sourceUrl, previousCompany = '') {
  if (!headers.length) return null;
  const linkIndexes = findHeaderIndexes(headers, [
    'full application link', 'application link', 'apply', 'posting', 'job link', 'link', 'url'
  ]);
  const index = {
    company: findHeaderIndex(headers, ['company', 'employer', 'organization']),
    role: findHeaderIndex(headers, ['role', 'role name', 'job title', 'position', 'title']),
    location: findHeaderIndex(headers, ['location', 'locations', 'city', 'region']),
    date: findHeaderIndex(headers, ['date posted', 'posted', 'added', 'date', 'age'])
  };
  if (index.role < 0 && linkIndexes.length === 0) return null;

  const roleCell = index.role >= 0 ? cells[index.role] || '' : '';
  const links = linkIndexes.flatMap((cellIndex) => extractCellLinks(cells[cellIndex] || '', sourceUrl));
  if (links.length === 0) links.push(...extractCellLinks(roleCell, sourceUrl));
  const url = links.find((link) => isLikelyJobUrl(link, cleanCellText(roleCell)))
    || links.find((link) => /^https?:/i.test(link));
  if (!url || !isLikelyJobUrl(url, cleanCellText(roleCell))) return null;

  let company = index.company >= 0 ? cleanCellText(cells[index.company] || '') : '';
  if (!company || /^(?:↳|same|ditto|-|—)$/i.test(company)) company = previousCompany;
  const role = cleanCellText(roleCell) || cleanCellText(cells[1] || '') || 'Job posting';
  return {
    url,
    company: company || companyFromJobUrl(url),
    role,
    datePosted: parsePostedDate(index.date >= 0 ? cleanCellText(cells[index.date] || '') : ''),
    location: index.location >= 0 ? cleanCellText(cells[index.location] || '') : ''
  };
}

function parseCsvRows(content) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"') {
      if (quoted && content[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && content[index + 1] === '\n') index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function splitMarkdownRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function looksLikeJobHeader(cells) {
  const headers = cells.map((cell) => normalizeHeader(cleanCellText(cell)));
  return findHeaderIndex(headers, ['company', 'employer']) >= 0
    && (findHeaderIndex(headers, ['role', 'job title', 'position', 'title']) >= 0
      || findHeaderIndex(headers, ['apply', 'posting', 'link']) >= 0);
}

function findHeaderIndex(headers, candidates) {
  return headers.findIndex((header) => candidates.some((candidate) => (
    header === candidate || header.includes(candidate)
  )));
}

function findHeaderIndexes(headers, candidates) {
  const indexes = [];
  for (const candidate of candidates) {
    headers.forEach((header, index) => {
      if ((header === candidate || header.includes(candidate)) && !indexes.includes(index)) indexes.push(index);
    });
  }
  return indexes;
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanCellText(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim());
}

function extractCellLinks(value, sourceUrl) {
  const links = [];
  for (const match of String(value || '').matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/gi)) {
    links.push(resolveSourceUrl(match[1], sourceUrl));
  }
  for (const match of String(value || '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    links.push(resolveSourceUrl(match[1], sourceUrl));
  }
  const plain = decodeHtmlEntities(String(value || '').trim());
  if (/^https?:\/\//i.test(plain)) links.push(resolveSourceUrl(plain, sourceUrl));
  return [...new Set(links.filter(Boolean))];
}

function resolveSourceUrl(value, sourceUrl) {
  try {
    return normalizeHttpUrl(new URL(decodeHtmlEntities(value), sourceUrl).toString(), true);
  } catch {
    return '';
  }
}

function isLikelyJobUrl(value, label = '') {
  if (!value) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (/\.(?:png|jpe?g|gif|svg|webp|pdf|xlsx?|docx?)(?:$|\?)/i.test(parsed.pathname)) return false;
  if (/^(?:github\.com|raw\.githubusercontent\.com|discord\.gg|linkedin\.com)$/i.test(parsed.hostname.replace(/^www\./, ''))) return false;
  const signal = `${parsed.hostname} ${parsed.pathname} ${label}`.toLowerCase();
  return /(job|career|position|opening|intern|graduate|apply|lever|greenhouse|ashby|workday|smartrecruiters|icims|ripplematch|oraclecloud)/.test(signal);
}

function companyFromJobUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '').split('.')[0];
    return titleCase(host.replace(/[-_]+/g, ' ')) || 'Unknown company';
  } catch {
    return 'Unknown company';
  }
}

function parsePostedDate(value, now = new Date()) {
  const text = String(value || '').trim();
  if (!text || /^(?:-|—|n\/a|unknown)$/i.test(text)) return '';
  if (/^today$/i.test(text)) return now.toISOString().slice(0, 10);
  const ageMatch = text.match(/^(\d+)\s*(?:d|day|days)(?:\s+ago)?$/i);
  if (ageMatch) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - Number(ageMatch[1]));
    return date.toISOString().slice(0, 10);
  }
  const isoMatch = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /\d{4}/.test(text)) return parsed.toISOString().slice(0, 10);
  const monthDay = new Date(`${text}, ${now.getUTCFullYear()} 00:00:00 UTC`);
  if (Number.isNaN(monthDay.getTime())) return '';
  if (monthDay.getTime() > now.getTime() + 7 * 86400000) monthDay.setUTCFullYear(monthDay.getUTCFullYear() - 1);
  return monthDay.toISOString().slice(0, 10);
}

function deduplicateSourceJobs(jobs) {
  const unique = new Map();
  for (const job of jobs) {
    if (!job?.url) continue;
    const key = comparableUrl(job.url);
    const current = unique.get(key);
    if (!current || (!current.datePosted && job.datePosted)) unique.set(key, job);
  }
  return [...unique.values()].sort((left, right) => (
    String(right.datePosted || '').localeCompare(String(left.datePosted || ''))
  ));
}

function importDiscoveryJobsToFiles(jobs) {
  const pending = parsePendingJobs();
  const tracked = parseApplications();
  const known = new Set([
    ...pending.map((job) => comparableUrl(job.url)),
    ...tracked.map((job) => job.jobUrl).filter(Boolean).map(comparableUrl)
  ]);
  const additions = jobs.filter((job) => !known.has(comparableUrl(job.url)));
  if (additions.length === 0) return { added: 0, recorded: 0 };

  const pipelinePath = path.join(careerRoot, 'data', 'pipeline.md');
  const historyPath = path.join(careerRoot, 'data', 'scan-history.tsv');
  fs.mkdirSync(path.dirname(pipelinePath), { recursive: true });
  let pipeline = readText(pipelinePath);
  if (!pipeline.trim()) pipeline = '# Pipeline — Pending Evaluations\n\n## Pending\n';
  const pipelineLines = additions.map((job) => (
    `- [ ] ${job.url} | ${safeTableCell(job.company)} | ${safeTableCell(job.role)}`
  ));
  fs.writeFileSync(pipelinePath, `${pipeline.trimEnd()}\n${pipelineLines.join('\n')}\n`, 'utf8');

  if (!fs.existsSync(historyPath) || !readText(historyPath).trim()) {
    fs.writeFileSync(
      historyPath,
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tdate_posted\n',
      'utf8'
    );
  }
  const historyLines = additions.map((job) => [
    job.url,
    new Date().toISOString().slice(0, 10),
    portalFromUrl(job.url),
    job.role,
    job.company,
    'added',
    job.location || '',
    job.datePosted || ''
  ].map(safeTsvCell).join('\t'));
  fs.appendFileSync(historyPath, `${historyLines.join('\n')}\n`, 'utf8');
  return { added: additions.length, recorded: additions.length };
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const radix = entity[1].toLowerCase() === 'x' ? 16 : 10;
      const code = Number.parseInt(entity.replace(/^#x?/i, ''), radix);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function titleCase(value) {
  return String(value || '').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function addDashboardJobLink(payload = {}) {
  const url = normalizeHttpUrl(payload.url, true);
  const crmStatus = String(payload.crmStatus || 'need_to_apply').trim();
  if (!['need_to_apply', 'applied', 'online_assessment', 'interview', 'offer'].includes(crmStatus)) {
    throw new Error('Choose a valid pipeline stage.');
  }
  const identity = await resolveJobIdentity(url);
  const logged = await logExternalApplication({
    url,
    company: identity.company,
    role: identity.role,
    source: portalFromUrl(url),
    notes: 'Added manually from the Career Ops dashboard.'
  });
  const dashboard = crmStatus === 'applied'
    ? logged.dashboard
    : await updateStatus({ number: logged.number, crmStatus });
  return {
    ok: true,
    duplicate: logged.duplicate,
    number: logged.number,
    job: { url, ...identity, crmStatus },
    message: `${logged.duplicate ? 'Updated' : 'Added'} ${identity.company} — ${identity.role} in ${crmStatusLabel(crmStatus)}.`,
    dashboard
  };
}

async function resolveJobIdentity(url) {
  let title = '';
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'career-ops-dashboard/0.1',
        Accept: 'text/html,application/xhtml+xml'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000)
    });
    if (response.ok) {
      const html = await response.text();
      title = extractPageTitle(html);
    }
  } catch {
    // URL-based inference below keeps manual upload usable when a job board blocks fetches.
  }
  return deriveJobIdentity(url, title);
}

function extractPageTitle(html) {
  const source = String(html || '');
  const metaPatterns = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i
  ];
  for (const pattern of metaPatterns) {
    const match = source.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(stripHtml(match[1])).trim();
  }
  return '';
}

function deriveJobIdentity(url, pageTitle = '') {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  let company = companyFromJobUrl(parsed, segments);
  let role = cleanPageTitle(pageTitle, company);

  if (!role) {
    const candidate = [...segments].reverse().find((segment) => (
      segment.length > 3
      && !/^(jobs?|careers?|positions?|openings?|apply|job-boards?)$/i.test(segment)
      && !/^\d+$/.test(segment)
      && !/^[a-f0-9-]{20,}$/i.test(segment)
      && normalizeCompany(humanizeSlug(segment)) !== normalizeCompany(company)
    ));
    role = candidate ? humanizeSlug(candidate) : 'Job posting';
  }
  if (!company) company = humanizeSlug(parsed.hostname.replace(/^www\./, '').split('.')[0]);

  return {
    company: cleanRequiredText(company || 'Unknown company', 'company'),
    role: cleanRequiredText(role || 'Job posting', 'role')
  };
}

function companyFromJobUrl(parsed, segments) {
  const host = parsed.hostname.toLowerCase();
  if (/greenhouse\.io$/.test(host)) {
    const offset = segments[0] === 'job-boards' ? 1 : 0;
    return humanizeSlug(segments[offset] || '');
  }
  if (/ashbyhq\.com$|lever\.co$/.test(host)) return humanizeSlug(segments[0] || '');
  if (/myworkdayjobs\.com$/.test(host)) return humanizeSlug(parsed.hostname.split('.')[0]);
  if (/smartrecruiters\.com$/.test(host)) return humanizeSlug(segments[0] || '');
  return '';
}

function cleanPageTitle(title, company) {
  let value = decodeHtmlEntities(String(title || '')).replace(/\s+/g, ' ').trim();
  if (!value) return '';
  value = value
    .replace(/\s*[|·]\s*(careers?|jobs?|greenhouse|ashby|lever|workday).*$/i, '')
    .replace(/\s+[-–—]\s+(careers?|jobs?|job application).*$/i, '');
  if (company) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value
      .replace(new RegExp(`^${escaped}\\s*[-–—|:]\\s*`, 'i'), '')
      .replace(new RegExp(`\\s*[-–—|]\\s*${escaped}$`, 'i'), '');
  }
  return value.trim();
}

function humanizeSlug(value) {
  return String(value || '')
    .replace(/\?.*$/, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function appendManualScanHistory(job) {
  const historyPath = path.join(careerRoot, 'data', 'scan-history.tsv');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  if (!fs.existsSync(historyPath) || !readText(historyPath).trim()) {
    fs.writeFileSync(historyPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf8');
  }
  const safe = (value) => String(value || '').replace(/[\t\r\n]+/g, ' ').trim();
  const line = [
    job.url,
    new Date().toISOString().slice(0, 10),
    'manual-link',
    job.role,
    job.company,
    'added'
  ].map(safe).join('\t');
  fs.appendFileSync(historyPath, `${line}\n`, 'utf8');
}

function comparableUrl(value) {
  return normalizeHttpUrl(value, true).replace(/\/$/, '').toLowerCase();
}

function scanHistoryByUrl() {
  const map = new Map();
  for (const row of scanHistoryRows()) {
    map.set(row.url, row);
  }
  return map;
}

function scanHistoryRows() {
  const filePath = path.join(careerRoot, 'data', 'scan-history.tsv');
  const rows = [];
  for (const line of readText(filePath).split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields.length < 6 || fields[0] === 'url') continue;
    rows.push({
      url: fields[0],
      firstSeen: fields[1],
      portal: fields[2],
      title: fields[3],
      company: fields[4],
      status: fields[5],
      location: fields[6] || '',
      datePosted: fields[7] || ''
    });
  }
  return rows;
}

function findApplicationByNumber(number) {
  const target = Number(number);
  const rows = sqliteStore.available() ? sqliteStore.loadSnapshot().applications : parseApplications();
  return rows.find((row) => row.number === target);
}

function deriveMaterials(row) {
  const coverDir = loadCoverLetterSettings().outputDir;
  const resumeSettings = loadResumeSettings();
  const prefixes = [
    `${String(row.number).padStart(3, '0')}-`,
    `${row.number}-`
  ];
  const coverLetterPath = findFirstFile(coverDir, (name) => name.toLowerCase().endsWith('.docx') && prefixes.some((prefix) => name.startsWith(prefix)));
  const pdfPath = resumeSettings.pdfPath || findFirstFile(path.join(careerRoot, 'output'), (name) => name.toLowerCase().endsWith('.pdf') && prefixes.some((prefix) => name.startsWith(prefix)));
  const coverLetterPdfPath = findFirstFile(path.join(careerRoot, 'output', 'cover-letters'), (name) => name.toLowerCase().endsWith('.pdf') && prefixes.some((prefix) => name.startsWith(prefix)));
  const applyPromptPath = findFirstFile(path.join(careerRoot, 'output', 'apply-prompts'), (name) => name.toLowerCase().endsWith('.md') && prefixes.some((prefix) => name.startsWith(prefix)));
  const jobDescriptionPath = row.jobDescriptionPath || findFirstFile(path.join(careerRoot, 'jds'), (name) => name.toLowerCase().endsWith('.md') && prefixes.some((prefix) => name.startsWith(prefix)));
  return {
    pdfPath,
    resumeSourcePath: resumeSettings.sourcePath,
    coverLetterPath,
    coverLetterPdfPath,
    hasCoverLetterPdf: Boolean(coverLetterPdfPath),
    applyPromptPath,
    jobDescriptionPath
  };
}

function findFirstFile(dir, predicate) {
  try {
    if (!fs.existsSync(dir)) return '';
    const match = fs.readdirSync(dir).find(predicate);
    return match ? path.join(dir, match) : '';
  } catch {
    return '';
  }
}

function parseReport(markdown, appTrackerPath) {
  const match = String(markdown || '').match(/\[([^\]]+)\]\(([^)]+)\)/);
  if (!match) return { label: '', path: '' };
  const rawLink = match[2];
  let full = path.resolve(path.dirname(appTrackerPath), rawLink);
  if (!fs.existsSync(full)) {
    full = path.resolve(careerRoot, rawLink);
  }
  return {
    label: match[1],
    path: path.relative(careerRoot, full).replaceAll(path.sep, '/')
  };
}

function deriveNoteFields(row) {
  const notes = row.notes || '';
  const noteUrl = notes.match(/\bURL:\s*(https?:\/\/\S+)/i);
  if (noteUrl) row.jobUrl = noteUrl[1].replace(/[.,;]+$/, '');
  if (/\bremote\b/i.test(notes)) row.workMode = 'Remote';
  else if (/\bhybrid\b/i.test(notes)) row.workMode = 'Hybrid';
  else if (/\bon-?site\b|\bin-office\b/i.test(notes)) row.workMode = 'On-site';

  const pay = notes.match(/\$\s?\d{2,3}(?:[,.]?\d{3})?\s?(?:-|–|to)\s?\$?\s?\d{2,3}(?:[,.]?\d{3})?(?:\s?\/\s?(?:hr|hour|year))?/i);
  if (pay) row.payRange = pay[0];

  const dateMatches = [...notes.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map((m) => m[0]).sort();
  row.lastContact = dateMatches.at(-1) || row.date;

  const city = notes.match(/\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*,\s[A-Z]{2})\b/);
  if (city) row.location = city[1];
}

function enrichUrls(apps) {
  for (const row of apps) {
    if (!row.reportPath) continue;
    const full = path.join(careerRoot, row.reportPath);
    const header = readText(full).slice(0, 1500);
    const match = header.match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/m);
    if (match) row.jobUrl = match[1];
  }

  const scanHistory = path.join(careerRoot, 'data', 'scan-history.tsv');
  if (!fs.existsSync(scanHistory)) return;
  const byCompany = new Map();
  const byUrl = new Map();
  for (const line of readText(scanHistory).split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields.length < 5 || fields[0] === 'url') continue;
    const entry = { url: fields[0], title: fields[3], company: fields[4] };
    const key = normalizeCompany(entry.company);
    byCompany.set(key, [...(byCompany.get(key) || []), entry]);
    if (fields.length >= 7 && fields[6]) byUrl.set(comparableUrl(fields[0]), fields[6]);
  }
  for (const row of apps) {
    if (row.jobUrl) continue;
    const matches = byCompany.get(normalizeCompany(row.company)) || [];
    if (matches.length > 0) row.jobUrl = matches[0].url;
  }
  for (const row of apps) {
    if (row.location || !row.jobUrl) continue;
    const loc = byUrl.get(comparableUrl(row.jobUrl));
    if (loc) row.location = loc;
  }
}

function loadReports(apps) {
  const reports = {};
  for (const row of apps) {
    if (!row.reportPath) continue;
    const full = path.join(careerRoot, row.reportPath);
    const text = readText(full);
    if (!text) continue;
    reports[row.reportPath] = {
      content: text,
      tldr: pick(text, [/\*\*TL;DR\*\*\s*\|\s*(.+)/i, /\*\*TL;DR:\*\*\s*(.+)/i]),
      archetype: pick(text, [/\*\*Arquetipo(?:\s+detectado)?\*\*\s*\|\s*(.+)/i, /\*\*Arquetipo:\*\*\s*(.+)/i]),
      remote: pick(text, [/\*\*Remote\*\*\s*\|\s*(.+)/i]),
      comp: pick(text, [/\*\*Comp\*\*\s*\|\s*(.+)/i])
    };
  }
  return reports;
}

function reportSummary(text) {
  if (!text) return null;
  return {
    content: text,
    tldr: pick(text, [/\*\*TL;DR\*\*\s*\|\s*(.+)/i, /\*\*TL;DR:\*\*\s*(.+)/i]),
    archetype: pick(text, [/\*\*Arquetipo(?:\s+detectado)?\*\*\s*\|\s*(.+)/i, /\*\*Arquetipo:\*\*\s*(.+)/i]),
    remote: pick(text, [/\*\*Remote\*\*\s*\|\s*(.+)/i]),
    comp: pick(text, [/\*\*Comp\*\*\s*\|\s*(.+)/i])
  };
}

function computeMetrics(apps) {
  const byStatus = {};
  let totalScore = 0;
  let scored = 0;
  let topScore = 0;
  let withPdf = 0;
  let actionable = 0;
  for (const row of apps) {
    const status = normalizeStatus(row.status);
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (row.score > 0) {
      totalScore += row.score;
      scored += 1;
      topScore = Math.max(topScore, row.score);
    }
    if (row.hasPdf) withPdf += 1;
    if (!['skip', 'rejected', 'discarded'].includes(status)) actionable += 1;
  }
  return {
    total: apps.length,
    byStatus,
    avgScore: scored ? totalScore / scored : 0,
    topScore,
    withPdf,
    actionable
  };
}

function computeProgress(apps) {
  const counts = {};
  for (const row of apps) {
    const status = normalizeStatus(row.status);
    counts[status] = (counts[status] || 0) + 1;
  }
  const total = apps.length;
  const applied = (counts.applied || 0) + (counts.responded || 0) + (counts.interview || 0) + (counts.offer || 0) + (counts.rejected || 0);
  const responded = (counts.responded || 0) + (counts.interview || 0) + (counts.offer || 0);
  const interview = (counts.interview || 0) + (counts.offer || 0);
  const offer = counts.offer || 0;
  const buckets = [
    { label: '4.5-5.0', count: 0 },
    { label: '4.0-4.4', count: 0 },
    { label: '3.5-3.9', count: 0 },
    { label: '3.0-3.4', count: 0 },
    { label: '<3.0', count: 0 }
  ];
  for (const row of apps) {
    if (row.score >= 4.5) buckets[0].count += 1;
    else if (row.score >= 4.0) buckets[1].count += 1;
    else if (row.score >= 3.5) buckets[2].count += 1;
    else if (row.score >= 3.0) buckets[3].count += 1;
    else if (row.score > 0) buckets[4].count += 1;
  }
  return {
    funnel: [
      { label: 'Evaluated', count: total, pct: 100 },
      { label: 'Applied', count: applied, pct: pct(applied, total) },
      { label: 'Responded', count: responded, pct: pct(responded, applied) },
      { label: 'Interview', count: interview, pct: pct(interview, applied) },
      { label: 'Offer', count: offer, pct: pct(offer, applied) }
    ],
    buckets,
    responseRate: pct(responded, applied),
    interviewRate: pct(interview, applied),
    offerRate: pct(offer, applied)
  };
}

function computeAnalytics(apps, scanHistory = [], pendingJobs = []) {
  const scoreRows = apps.filter((row) => row.score > 0);
  const highScoreNeedApply = apps.filter((row) => row.score >= 4 && mapCareerOpsStatusToCRM(row.status) === 'need_to_apply');
  return {
    byStatus: computeMetrics(apps).byStatus,
    avgScore: scoreRows.length ? scoreRows.reduce((sum, row) => sum + row.score, 0) / scoreRows.length : 0,
    topCompanies: [...scoreRows].sort((a, b) => b.score - a.score).slice(0, 6).map((row) => ({ company: row.company, role: row.role, score: row.score })),
    highScoreNeedApply,
    applicationsPerWeek: apps.reduce((acc, row) => {
      const week = String(row.date || '').slice(0, 7) || 'unknown';
      acc[week] = (acc[week] || 0) + 1;
      return acc;
    }, {}),
    advanced: computeAdvancedAnalytics(apps, { scanHistory, pendingJobs })
  };
}

function computeFollowUpQueue(apps) {
  const buckets = {
    applySoon: [],
    followUp: [],
    onlineAssessment: [],
    interviewPrep: [],
    stale: []
  };
  for (const row of apps) {
    const crm = mapCareerOpsStatusToCRM(row.status);
    const last = row.lastContact || row.date;
    const age = last ? daysSince(last) : null;
    const item = { ...row, crmStatus: crm, ageDays: age, nextAction: nextActionForApplication(row) };
    if (crm === 'need_to_apply' && row.score >= 4) buckets.applySoon.push(item);
    else if (crm === 'applied' && age != null && age > 7) buckets.followUp.push(item);
    else if (crm === 'online_assessment') buckets.onlineAssessment.push(item);
    else if (crm === 'interview') buckets.interviewPrep.push(item);
    else if (crm === 'need_to_apply' && age != null && age > 30) buckets.stale.push(item);
  }
  for (const key of Object.keys(buckets)) buckets[key].sort((a, b) => (b.score || 0) - (a.score || 0));
  return buckets;
}

function computeScanSummary(history = scanHistoryRows(), pending = parsePendingJobs()) {
  const latest = history.map((item) => item.firstSeen).filter(Boolean).sort().at(-1) || '';
  const counts = history.reduce((acc, item) => {
    const key = String(item.status || 'unknown').toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    lastScanTime: latest,
    pendingCount: pending.length,
    newJobsFound: counts.added || 0,
    expiredSkipped: counts.expired || 0,
    duplicatesSkipped: counts.duplicate || counts.duplicates || 0,
    titleSkipped: counts.title_skipped || counts['title-skipped'] || 0,
    errors: counts.error || 0,
    byStatus: counts,
    recent: history.slice(-20).reverse()
  };
}

function loadSettings() {
  if (sqliteStore.available()) {
    const snapshot = sqliteStore.loadSnapshot();
    const configuredKeywords = snapshot.targeting?.title_filter?.positive;
    const effectiveProfile = applySetupToProfile(snapshot.profile);
    return {
      portalsPath: '',
      profilePath: '',
      titleKeywords: Array.isArray(configuredKeywords) ? configuredKeywords : [],
      targetRoles: effectiveProfile.target_roles?.primary || [],
      candidate: effectiveProfile.candidate || {},
      profileDefaults: profileDefaults(effectiveProfile),
      resume: loadResumeSettings(),
      resumes: listResumes(),
      ai: loadAiSettings(),
      coverLetters: loadCoverLetterSettings(),
      extension: loadExtensionSettings(),
      setup: loadSetupSettings()
    };
  }
  const portalsPath = path.join(careerRoot, 'portals.yml');
  const profilePath = path.join(careerRoot, 'config', 'profile.yml');
  const portalsText = readText(portalsPath);
  const profile = loadProfile();
  return {
    portalsPath,
    profilePath,
    titleKeywords: extractPositiveKeywords(portalsText),
    targetRoles: profile.target_roles?.primary || [],
    candidate: profile.candidate || {},
    profileDefaults: profileDefaults(profile),
    resume: loadResumeSettings(),
    resumes: listResumes(),
    ai: loadAiSettings(),
    coverLetters: loadCoverLetterSettings(),
    extension: loadExtensionSettings(),
    setup: loadSetupSettings()
  };
}

function loadSetupSettings() {
  const stored = readJson(setupSettingsPath()) || {};
  return {
    profile: {
      fullName: cleanSetting(stored.profile?.fullName),
      email: cleanSetting(stored.profile?.email),
      headline: cleanSetting(stored.profile?.headline)
    },
    careerGoals: {
      targetRoles: normalizeStringList(stored.careerGoals?.targetRoles),
      targetLocations: normalizeStringList(stored.careerGoals?.targetLocations)
    },
    jobPreferences: {
      compensationMin: Number(stored.jobPreferences?.compensationMin) || 0,
      compensationCurrency: cleanSetting(stored.jobPreferences?.compensationCurrency) || 'USD',
      workModes: normalizeStringList(stored.jobPreferences?.workModes),
      employmentTypes: normalizeEmploymentTypes(stored.jobPreferences?.employmentTypes),
      acceptedSeniorities: normalizeSeniorities(stored.jobPreferences?.acceptedSeniorities),
      authorizedCountries: normalizeCountries(stored.jobPreferences?.authorizedCountries),
      remoteLocationPolicy: ['unrestricted', 'authorized_only', 'target_only'].includes(stored.jobPreferences?.remoteLocationPolicy)
        ? stored.jobPreferences.remoteLocationPolicy
        : 'authorized_only',
      excludedTitles: normalizeStringList(stored.jobPreferences?.excludedTitles),
      hardConstraints: normalizeHardConstraints(stored.jobPreferences?.hardConstraints),
      exceptions: normalizeMatchingExceptions(stored.jobPreferences?.exceptions),
      requiresSponsorship: Boolean(stored.jobPreferences?.requiresSponsorship)
    },
    privacy: {
      localOnly: stored.privacy?.localOnly !== false,
      analytics: Boolean(stored.privacy?.analytics)
    },
    onboardingComplete: Boolean(stored.onboardingComplete),
    extensionTestedAt: cleanSetting(stored.extensionTestedAt),
    sampleRecommendationRunAt: cleanSetting(stored.sampleRecommendationRunAt)
  };
}

function saveSetupSettings(payload = {}) {
  const current = loadSetupSettings();
  const next = {
    profile: {
      fullName: cleanSetting(payload.profile?.fullName ?? current.profile.fullName),
      email: cleanSetting(payload.profile?.email ?? current.profile.email),
      headline: cleanSetting(payload.profile?.headline ?? current.profile.headline)
    },
    careerGoals: {
      targetRoles: normalizeStringList(payload.careerGoals?.targetRoles ?? current.careerGoals.targetRoles),
      targetLocations: normalizeStringList(payload.careerGoals?.targetLocations ?? current.careerGoals.targetLocations)
    },
    jobPreferences: {
      compensationMin: Math.max(0, Number(payload.jobPreferences?.compensationMin ?? current.jobPreferences.compensationMin) || 0),
      compensationCurrency: cleanSetting(payload.jobPreferences?.compensationCurrency ?? current.jobPreferences.compensationCurrency) || 'USD',
      workModes: normalizeStringList(payload.jobPreferences?.workModes ?? current.jobPreferences.workModes),
      employmentTypes: normalizeEmploymentTypes(payload.jobPreferences?.employmentTypes ?? current.jobPreferences.employmentTypes),
      acceptedSeniorities: normalizeSeniorities(payload.jobPreferences?.acceptedSeniorities ?? current.jobPreferences.acceptedSeniorities),
      authorizedCountries: normalizeCountries(payload.jobPreferences?.authorizedCountries ?? current.jobPreferences.authorizedCountries),
      remoteLocationPolicy: ['unrestricted', 'authorized_only', 'target_only'].includes(payload.jobPreferences?.remoteLocationPolicy)
        ? payload.jobPreferences.remoteLocationPolicy
        : current.jobPreferences.remoteLocationPolicy,
      excludedTitles: normalizeStringList(payload.jobPreferences?.excludedTitles ?? current.jobPreferences.excludedTitles),
      hardConstraints: normalizeHardConstraints(payload.jobPreferences?.hardConstraints ?? current.jobPreferences.hardConstraints),
      exceptions: normalizeMatchingExceptions(payload.jobPreferences?.exceptions ?? current.jobPreferences.exceptions),
      requiresSponsorship: Boolean(payload.jobPreferences?.requiresSponsorship ?? current.jobPreferences.requiresSponsorship)
    },
    privacy: {
      localOnly: payload.privacy?.localOnly !== false,
      analytics: Boolean(payload.privacy?.analytics)
    },
    onboardingComplete: Boolean(payload.onboardingComplete),
    extensionTestedAt: cleanSetting(payload.extensionTestedAt ?? current.extensionTestedAt),
    sampleRecommendationRunAt: cleanSetting(payload.sampleRecommendationRunAt ?? current.sampleRecommendationRunAt)
  };
  fs.mkdirSync(path.dirname(setupSettingsPath()), { recursive: true });
  fs.writeFileSync(setupSettingsPath(), JSON.stringify(next, null, 2), 'utf8');
  syncSetupKnowledge(next);
  return next;
}

function syncSetupKnowledge(setup) {
  if (!sqliteStore.available()) return;
  const facts = [];
  for (const role of setup.careerGoals.targetRoles) {
    facts.push({
      category: 'career-goals',
      factType: 'target_role',
      title: `Target role: ${role}`,
      summary: role,
      confidence: 1,
      sourceExcerpt: role
    });
  }
  if (setup.careerGoals.targetLocations.length) {
    facts.push({
      category: 'role-preferences',
      factType: 'target_location',
      title: 'Target locations',
      summary: setup.careerGoals.targetLocations.join(', '),
      confidence: 1,
      sourceExcerpt: setup.careerGoals.targetLocations.join(', ')
    });
  }
  if (setup.jobPreferences.workModes.length) {
    facts.push({
      category: 'role-preferences',
      factType: 'work_mode',
      title: 'Preferred work modes',
      summary: setup.jobPreferences.workModes.join(', '),
      confidence: 1,
      sourceExcerpt: setup.jobPreferences.workModes.join(', ')
    });
  }
  if (setup.jobPreferences.employmentTypes.length) {
    facts.push({
      category: 'role-preferences',
      factType: 'employment_type',
      title: 'Preferred employment types',
      summary: setup.jobPreferences.employmentTypes.join(', '),
      confidence: 1,
      sourceExcerpt: setup.jobPreferences.employmentTypes.join(', ')
    });
  }
  if (setup.jobPreferences.acceptedSeniorities.length) {
    facts.push({
      category: 'role-preferences',
      factType: 'accepted_seniority',
      title: 'Accepted seniority levels',
      summary: setup.jobPreferences.acceptedSeniorities.join(', '),
      confidence: 1,
      sourceExcerpt: setup.jobPreferences.acceptedSeniorities.join(', ')
    });
  }
  if (setup.jobPreferences.authorizedCountries.length) {
    facts.push({
      category: 'role-preferences',
      factType: 'authorized_countries',
      title: 'Authorized work countries',
      summary: setup.jobPreferences.authorizedCountries.join(', '),
      confidence: 1,
      sourceExcerpt: setup.jobPreferences.authorizedCountries.join(', ')
    });
  }
  if (setup.jobPreferences.compensationMin) {
    const compensation = `${setup.jobPreferences.compensationCurrency} ${setup.jobPreferences.compensationMin}`;
    facts.push({
      category: 'role-preferences',
      factType: 'minimum_compensation',
      title: 'Minimum base compensation',
      summary: compensation,
      confidence: 1,
      sourceExcerpt: compensation
    });
  }
  facts.push({
    category: 'application-answers',
    factType: 'sponsorship',
    title: 'Visa sponsorship requirement',
    summary: setup.jobPreferences.requiresSponsorship ? 'Yes' : 'No',
    confidence: 1,
    sourceExcerpt: setup.jobPreferences.requiresSponsorship ? 'May require visa sponsorship' : 'Does not require visa sponsorship'
  });
  sqliteStore.replaceKnowledgeFactsForSourceType('settings', facts, {
    label: 'Career Ops profile and preferences',
    metadata: { enteredBy: 'user', syncedAt: new Date().toISOString() }
  });
}

function normalizeStringList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  return [...new Set(items.map((item) => cleanSetting(item)).filter(Boolean))].slice(0, 30);
}

function normalizeEmploymentTypes(value) {
  const aliases = {
    internship: 'internship',
    intern: 'internship',
    'full-time': 'full_time',
    full_time: 'full_time',
    fulltime: 'full_time',
    'part-time': 'part_time',
    part_time: 'part_time',
    contract: 'contract',
    temporary: 'temporary',
    apprenticeship: 'apprenticeship',
    unknown: 'unknown'
  };
  return normalizeStringList(value).map((item) => aliases[item.toLowerCase()]).filter(Boolean);
}

function normalizeSeniorities(value) {
  const allowed = new Set(['intern', 'entry', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'executive', 'unknown']);
  return normalizeStringList(value).map((item) => item.toLowerCase()).filter((item) => allowed.has(item));
}

function normalizeCountries(value) {
  return [...new Set(normalizeStringList(value).map((item) => item.toUpperCase()).filter((item) => /^[A-Z]{2,3}$/.test(item)))];
}

function normalizeHardConstraints(value = {}) {
  const defaults = {
    targetRole: true,
    seniority: true,
    employmentType: true,
    workMode: true,
    geography: true,
    compensation: true
  };
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [
    key,
    typeof value?.[key] === 'boolean' ? value[key] : fallback
  ]));
}

function normalizeMatchingExceptions(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const kind = item?.kind === 'title_pattern' ? 'title_pattern' : 'company';
    const exceptionValue = cleanSetting(item?.value);
    if (!exceptionValue) return [];
    return [{
      kind,
      value: exceptionValue,
      allowSeniorities: normalizeSeniorities(item.allowSeniorities),
      allowEmploymentTypes: normalizeEmploymentTypes(item.allowEmploymentTypes),
      allowCountries: normalizeCountries(item.allowCountries)
    }];
  }).slice(0, 50);
}

function testSetup() {
  const settings = loadSettings();
  const diagnostics = rootDiagnostics();
  const setup = settings.setup;
  const resumeReady = Boolean(currentResume().trim());
  const profileReady = Boolean(setup.profile.fullName || settings.candidate.full_name);
  const rolesReady = (setup.careerGoals.targetRoles.length || settings.targetRoles.length) > 0;
  const checks = [
    { id: 'storage', label: 'App data', ok: diagnostics.valid, detail: diagnostics.valid ? 'Ready' : 'Application data is not initialized' },
    { id: 'resume', label: 'Resume', ok: resumeReady, detail: resumeReady ? 'Imported and readable' : 'Import a resume' },
    { id: 'profile', label: 'Profile', ok: profileReady, detail: profileReady ? 'Candidate identity confirmed' : 'Confirm your extracted profile' },
    { id: 'roles', label: 'Career goals', ok: rolesReady, detail: rolesReady ? 'Target roles configured' : 'Add at least one target role' },
    {
      id: 'preferences',
      label: 'Job preferences',
      ok: setup.jobPreferences.workModes.length > 0
        && setup.jobPreferences.employmentTypes.length > 0
        && setup.jobPreferences.acceptedSeniorities.length > 0
        && setup.jobPreferences.authorizedCountries.length > 0,
      detail: setup.jobPreferences.workModes.length
        ? 'Seniority, employment, work mode, and geography configured'
        : 'Configure eligibility preferences'
    },
    { id: 'scanner', label: 'Scanner', ok: diagnostics.scannerAvailable !== false, detail: diagnostics.scannerAvailable === false ? diagnostics.scannerReason : 'Scanner runtime available' },
    { id: 'ai', label: 'AI provider', ok: settings.ai.hasApiKey, optional: true, detail: settings.ai.hasApiKey ? 'Provider configured' : 'Not connected (advanced, optional for setup)' },
    { id: 'extension', label: 'Browser extension', ok: Boolean(setup.extensionTestedAt), optional: true, detail: setup.extensionTestedAt ? 'Connection test recorded' : 'Not tested yet' }
  ];
  return {
    ok: checks.filter((check) => !check.optional).every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    checks
  };
}

function parseScoreField(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(?:n\/?a|not applicable)$/i.test(raw)) {
    return { score: null, isScored: false, scoreRaw: raw || 'N/A' };
  }
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(?:\/\s*5)?/);
  if (!match) return { score: null, isScored: false, scoreRaw: raw };
  return { score: Number.parseFloat(match[1]), isScored: true, scoreRaw: raw };
}

function loadProfile() {
  const profile = sqliteStore.available()
    ? sqliteStore.loadSnapshot().profile
    : yaml.load(readText(path.join(careerRoot, 'config', 'profile.yml'))) || {};
  return applySetupToProfile(profile);
}

function applySetupToProfile(profile = {}) {
  const setup = loadSetupSettings();
  const next = structuredClone(profile || {});
  next.candidate ||= {};
  next.target_roles ||= {};
  next.narrative ||= {};
  next.compensation ||= {};
  if (setup.profile.fullName) next.candidate.full_name = setup.profile.fullName;
  if (setup.profile.email) next.candidate.email = setup.profile.email;
  if (setup.profile.headline) next.narrative.headline = setup.profile.headline;
  if (setup.careerGoals.targetRoles.length) next.target_roles.primary = setup.careerGoals.targetRoles;
  if (setup.careerGoals.targetLocations.length) {
    next.location ||= {};
    next.location.target_locations = setup.careerGoals.targetLocations;
  }
  if (setup.jobPreferences.compensationMin) next.compensation.minimum = setup.jobPreferences.compensationMin;
  if (setup.jobPreferences.compensationCurrency) next.compensation.currency = setup.jobPreferences.compensationCurrency;
  if (setup.jobPreferences.workModes.length) next.compensation.location_flexibility = setup.jobPreferences.workModes.join(', ');
  next.job_preferences = {
    ...(next.job_preferences || {}),
    work_modes: setup.jobPreferences.workModes,
    employment_types: setup.jobPreferences.employmentTypes,
    accepted_seniorities: setup.jobPreferences.acceptedSeniorities,
    authorized_countries: setup.jobPreferences.authorizedCountries,
    remote_location_policy: setup.jobPreferences.remoteLocationPolicy,
    excluded_titles: setup.jobPreferences.excludedTitles,
    hard_constraints: setup.jobPreferences.hardConstraints,
    exceptions: setup.jobPreferences.exceptions,
    requires_sponsorship: setup.jobPreferences.requiresSponsorship
  };
  return next;
}

function profileDefaults(profile = {}) {
  const locations = profile.location?.target_locations?.length
    ? profile.location.target_locations
    : [
        profile.candidate?.location,
        [profile.location?.city, profile.location?.country].filter(Boolean).join(', ')
      ].filter(Boolean);
  const minimumMatch = String(profile.compensation?.minimum || '').replaceAll(',', '').match(/\d+(?:\.\d+)?/);
  const flexibility = String(profile.compensation?.location_flexibility || '');
  const workModes = ['Remote', 'Hybrid', 'On-site'].filter((mode) => new RegExp(mode.replace('-', '.?'), 'i').test(flexibility));
  return {
    headline: profile.narrative?.headline || '',
    targetLocations: [...new Set(locations)],
    compensationMin: minimumMatch ? Number(minimumMatch[0]) : 0,
    compensationCurrency: profile.compensation?.currency || 'USD',
    workModes,
    employmentTypes: normalizeEmploymentTypes(profile.job_preferences?.employment_types),
    acceptedSeniorities: normalizeSeniorities(profile.job_preferences?.accepted_seniorities),
    authorizedCountries: normalizeCountries(profile.job_preferences?.authorized_countries),
    remoteLocationPolicy: profile.job_preferences?.remote_location_policy || 'authorized_only',
    excludedTitles: profile.job_preferences?.excluded_titles || [],
    hardConstraints: normalizeHardConstraints(profile.job_preferences?.hard_constraints),
    exceptions: normalizeMatchingExceptions(profile.job_preferences?.exceptions),
    requiresSponsorship: Boolean(profile.job_preferences?.requires_sponsorship)
  };
}

function buildCloudMatchingProfile() {
  const profile = loadProfile();
  const setup = loadSetupSettings();
  const workModeMap = { Remote: 'remote', Hybrid: 'hybrid', 'On-site': 'onsite', remote: 'remote', hybrid: 'hybrid', onsite: 'onsite' };
  const skills = Array.isArray(profile.skills)
    ? profile.skills
    : Object.values(profile.skills || {}).flatMap((value) => Array.isArray(value) ? value : []);
  return {
    active: true,
    targetRoles: setup.careerGoals.targetRoles.length
      ? setup.careerGoals.targetRoles
      : normalizeStringList(profile.target_roles?.primary),
    excludedTitles: setup.jobPreferences.excludedTitles,
    skills: normalizeStringList(skills),
    evidenceKeywords: normalizeStringList(profile.evidenceKeywords || profile.evidence_keywords),
    careerGoals: normalizeStringList(profile.careerGoals || profile.career_goals),
    targetLocations: setup.careerGoals.targetLocations,
    authorizedLocations: setup.careerGoals.targetLocations.filter((value) => !/^(remote|anywhere)$/i.test(value)),
    authorizedCountries: setup.jobPreferences.authorizedCountries,
    remoteLocationPolicy: setup.jobPreferences.remoteLocationPolicy,
    acceptedWorkModes: setup.jobPreferences.workModes.map((value) => workModeMap[value]).filter(Boolean),
    acceptedSeniorities: setup.jobPreferences.acceptedSeniorities,
    acceptedEmploymentTypes: setup.jobPreferences.employmentTypes,
    hardConstraints: setup.jobPreferences.hardConstraints,
    exceptions: setup.jobPreferences.exceptions,
    minimumCompensation: setup.jobPreferences.compensationMin
      ? {
          currency: setup.jobPreferences.compensationCurrency,
          min: setup.jobPreferences.compensationMin,
          interval: 'year'
        }
      : undefined,
    enrichmentDailyLimit: 20
  };
}

function candidateProfile() {
  const profile = loadProfile();
  return profile.candidate || {};
}

function candidateName() {
  return candidateProfile().full_name || 'Candidate';
}

function candidateContactLine() {
  const candidate = candidateProfile();
  return [candidate.location, candidate.phone, candidate.email].filter(Boolean).join(' | ');
}

function loadResumeSettings() {
  const primary = listResumes().find((resume) => resume.isPrimary);
  if (primary) {
    return {
      sourcePath: primary.path || '',
      pdfPath: path.extname(primary.path || '').toLowerCase() === '.pdf' ? primary.path : '',
      sourceName: primary.name,
      pdfName: path.extname(primary.path || '').toLowerCase() === '.pdf' ? primary.name : '',
      primaryId: primary.id
    };
  }
  const stored = readJson(resumeSettingsPath()) || {};
  const sourcePath = fs.existsSync(stored.sourcePath || '') ? stored.sourcePath : '';
  const pdfPath = fs.existsSync(stored.pdfPath || '') ? stored.pdfPath : '';
  return {
    sourcePath,
    pdfPath,
    sourceName: sourcePath ? path.basename(sourcePath) : '',
    pdfName: pdfPath ? path.basename(pdfPath) : ''
  };
}

function listResumes() {
  if (sqliteStore.available()) return sqliteStore.listResumes();
  const stored = readJson(resumeLibraryPath()) || {};
  const records = Array.isArray(stored.resumes) ? stored.resumes : [];
  const existing = records
    .filter((resume) => fs.existsSync(resume.path || ''))
    .map((resume) => ({ ...resume, isPrimary: resume.id === stored.primaryId }));
  const classicPath = path.join(careerRoot, 'cv.md');
  if (fs.existsSync(classicPath) && !existing.some((resume) => resume.id === 'classic-primary')) {
    existing.unshift({
      id: 'classic-primary',
      name: 'Primary resume',
      path: classicPath,
      contentLength: readText(classicPath).length,
      createdAt: fs.statSync(classicPath).mtime.toISOString(),
      isPrimary: !stored.primaryId
    });
  }
  return existing;
}

function getResume(id) {
  if (sqliteStore.available()) return sqliteStore.getResume(id);
  const resume = listResumes().find((item) => item.id === id);
  if (!resume) throw new Error('Resume not found.');
  const contentPath = resume.contentPath || resume.path;
  return { ...resume, content: readText(contentPath) };
}

function setPrimaryResume(payload) {
  const id = String(payload.id || '');
  if (sqliteStore.available()) {
    sqliteStore.setPrimaryResume(id);
  } else {
    const library = readJson(resumeLibraryPath()) || { resumes: [] };
    if (!listResumes().some((resume) => resume.id === id)) throw new Error('Resume not found.');
    library.primaryId = id;
    fs.mkdirSync(path.dirname(resumeLibraryPath()), { recursive: true });
    fs.writeFileSync(resumeLibraryPath(), JSON.stringify(library, null, 2), 'utf8');
  }
  return { ok: true, resumes: listResumes(), settings: loadResumeSettings(), resume: currentResume() };
}

function saveResumeSettings(nextSettings) {
  const current = readJson(resumeSettingsPath()) || {};
  const next = { ...current, ...nextSettings };
  fs.mkdirSync(path.dirname(resumeSettingsPath()), { recursive: true });
  fs.writeFileSync(resumeSettingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return loadResumeSettings();
}

function loadCoverLetterSettings() {
  const stored = readJson(coverLetterSettingsPath()) || {};
  return {
    outputDir: sqliteStore.available()
      ? path.join(sqliteStore.dataRoot, 'files', 'generated', 'cover-letters')
      : (stored.outputDir || path.join(careerRoot, 'output', 'cover-letters')),
    examplePaths: coverLetterExamplePaths.filter((filePath) => fs.existsSync(filePath))
  };
}

function saveCoverLetterSettings(nextSettings) {
  fs.mkdirSync(path.dirname(coverLetterSettingsPath()), { recursive: true });
  fs.writeFileSync(coverLetterSettingsPath(), JSON.stringify(nextSettings, null, 2), 'utf8');
  return loadCoverLetterSettings();
}

function loadAiSettings() {
  const stored = readJson(aiSettingsPath()) || {};
  const coverLetterModel = normalizeOpenAiModel(
    stored.coverLetterModel || stored.model || process.env.OPENAI_MODEL || defaultCoverLetterModel
  );
  return {
    hasApiKey: Boolean(process.env.OPENAI_API_KEY || stored.apiKey),
    internalModel: internalOpenAiModel,
    coverLetterModel,
    model: coverLetterModel,
    envModel: process.env.OPENAI_MODEL || '',
    models: ensureModelOption(coverLetterModel)
  };
}

function saveAiSettings(payload) {
  const current = readJson(aiSettingsPath()) || {};
  const apiKey = String(payload.apiKey || '').trim();
  const coverLetterModel = normalizeOpenAiModel(
    payload.coverLetterModel
      || payload.model
      || current.coverLetterModel
      || current.model
      || defaultCoverLetterModel
  );
  const next = { ...current, coverLetterModel };
  delete next.model;
  if (apiKey) next.apiKey = apiKey;
  fs.mkdirSync(path.dirname(aiSettingsPath()), { recursive: true });
  fs.writeFileSync(aiSettingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return loadSettings();
}

function loadExtensionSettings() {
  const stored = readJson(extensionSettingsPath()) || {};
  return normalizeExtensionSettings(stored);
}

function normalizeExtensionSettings(payload = {}) {
  const demographics = payload.demographics && typeof payload.demographics === 'object'
    ? payload.demographics
    : {};
  const contact = payload.contact && typeof payload.contact === 'object'
    ? payload.contact
    : {};
  return {
    enabled: payload.enabled !== false,
    showLogPrompt: payload.showLogPrompt !== false,
    contact: {
      addressLine1: cleanSetting(contact.addressLine1),
      addressLine2: cleanSetting(contact.addressLine2),
      city: cleanSetting(contact.city),
      state: cleanSetting(contact.state),
      phoneType: cleanSetting(contact.phoneType)
    },
    demographics: {
      workAuthorization: cleanSetting(demographics.workAuthorization),
      sponsorship: cleanSetting(demographics.sponsorship),
      veteranStatus: cleanSetting(demographics.veteranStatus),
      disabilityStatus: cleanSetting(demographics.disabilityStatus),
      gender: cleanSetting(demographics.gender),
      raceEthnicity: cleanSetting(demographics.raceEthnicity),
      pronouns: cleanSetting(demographics.pronouns)
    }
  };
}

function saveExtensionSettings(payload) {
  const settings = normalizeExtensionSettings(payload);
  fs.mkdirSync(path.dirname(extensionSettingsPath()), { recursive: true });
  fs.writeFileSync(extensionSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

function cleanSetting(value) {
  return String(value || '').trim().slice(0, 200);
}

function extensionContext() {
  const candidate = candidateProfile();
  const profile = loadProfile();
  const materials = loadResumeSettings();
  const nameParts = String(candidate.full_name || '').trim().split(/\s+/).filter(Boolean);
  const trustedFacts = trustedKnowledgeFacts();
  const applicationAnswers = Object.fromEntries(
    trustedFacts
      .filter((fact) => fact.category === 'application-answers')
      .map((fact) => [fact.factType, fact.summary])
  );
  return {
    ok: true,
    connected: true,
    candidate: {
      fullName: candidate.full_name || '',
      firstName: nameParts[0] || '',
      lastName: nameParts.slice(1).join(' '),
      email: candidate.email || '',
      phone: candidate.phone || '',
      location: candidate.location || '',
      linkedin: candidate.linkedin || '',
      portfolio: candidate.portfolio_url || '',
      github: candidate.github || '',
      workAuthorization: applicationAnswers.work_authorization || profile.location?.visa_status || ''
    },
    materials: {
      resumeSourcePath: materials.sourcePath || '',
      resumePdfPath: materials.pdfPath || ''
    },
    settings: loadExtensionSettings(),
    knowledge: {
      applicationAnswers,
      trustedFactCount: trustedFacts.length
    }
  };
}

function extensionAutofillContext(payload = {}) {
  const context = extensionContext();
  const knowledgeAnswers = context.knowledge?.applicationAnswers || {};
  const documents = extensionDocuments(payload);
  return {
    ...context,
    job: {
      url: normalizeHttpUrl(payload.url, false),
      company: cleanRequiredText(payload.company || '', 'company', false),
      role: cleanRequiredText(payload.role || '', 'role', false)
    },
    autofill: {
      identity: {
        ...context.candidate,
        ...context.settings.contact
      },
      demographics: {
        ...context.settings.demographics,
        workAuthorization: knowledgeAnswers.work_authorization || context.settings.demographics.workAuthorization,
        sponsorship: knowledgeAnswers.sponsorship || context.settings.demographics.sponsorship
      },
      documents: Object.fromEntries(Object.entries(documents).map(([kind, document]) => [
        kind,
        document ? { available: true, name: document.name, mediaType: document.mediaType } : { available: false }
      ]))
    }
  };
}

function extensionDocuments(payload = {}) {
  const resumeSettings = loadResumeSettings();
  const application = findExtensionApplication(payload);
  const coverLetterPath = application
    ? (application.coverLetterPath || deriveMaterials(application).coverLetterPath)
    : '';
  return {
    resume: extensionDocumentDescriptor(resumeSettings.sourcePath, resumeSettings.sourceName),
    coverLetter: extensionDocumentDescriptor(coverLetterPath)
  };
}

function extensionDocument(payload = {}, kind = '') {
  const documents = extensionDocuments(payload);
  const document = documents[kind];
  if (!document) throw new Error(kind === 'coverLetter'
    ? 'No cover letter is associated with this job.'
    : 'No primary resume file is available.');
  return document;
}

function findExtensionApplication(payload = {}) {
  const applications = sqliteStore.available() ? sqliteStore.loadSnapshot().applications : parseApplications();
  const url = normalizeHttpUrl(payload.url, false);
  if (url) {
    const normalizedUrl = comparableUrl(url);
    const exact = applications.find((row) => row.jobUrl && comparableUrl(row.jobUrl) === normalizedUrl);
    if (exact) return exact;
  }
  const company = normalizeCompany(payload.company);
  const role = normalizeRole(payload.role);
  if (!company || !role) return null;
  return applications.find((row) => normalizeCompany(row.company) === company && normalizeRole(row.role) === role) || null;
}

function extensionDocumentDescriptor(filePath, preferredName = '') {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const extension = path.extname(filePath).toLowerCase();
  const mediaTypes = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.rtf': 'application/rtf',
    '.txt': 'text/plain'
  };
  if (!mediaTypes[extension]) return null;
  const preferredExtension = path.extname(preferredName).toLowerCase();
  const name = preferredName && preferredExtension === extension ? preferredName : path.basename(filePath);
  return { path: filePath, name, mediaType: mediaTypes[extension] };
}

async function logExternalApplication(payload = {}) {
  const application = validateExternalApplication(payload);
  if (sqliteStore.available()) {
    const result = sqliteStore.logExternalApplication(application);
    return {
      ok: true,
      ...result,
      message: result.duplicate
        ? `Updated existing application #${result.number} to Applied.`
        : `Logged ${application.company} - ${application.role} as Applied.`,
      dashboard: await loadDashboard()
    };
  }
  const existing = findExistingApplication(application);
  if (existing) {
    updateExistingApplication(existing.number, application);
    return {
      ok: true,
      duplicate: true,
      number: existing.number,
      message: `Updated existing application #${existing.number} to Applied.`,
      dashboard: await loadDashboard()
    };
  }

  const number = nextReportNumber();
  const dir = path.join(careerRoot, 'batch', 'tracker-additions');
  fs.mkdirSync(dir, { recursive: true });
  const line = [
    number,
    application.appliedAt,
    application.company,
    application.role,
    'Applied',
    'N/A',
    '\u274c',
    '',
    application.notes
  ].join('\t');
  const additionPath = path.join(dir, `${String(number).padStart(3, '0')}-${slug(application.company)}.tsv`);
  fs.writeFileSync(additionPath, `${line}\n`, 'utf8');
  const merge = await runScript('merge-tracker.mjs');
  if (!merge.ok) throw new Error(`Could not merge the application tracker entry: ${merge.output}`);
  return {
    ok: true,
    duplicate: false,
    number,
    message: `Logged ${application.company} - ${application.role} as Applied.`,
    dashboard: merge.dashboard
  };
}

function validateExternalApplication(payload = {}) {
  const url = normalizeHttpUrl(payload.url, true);
  const company = cleanRequiredText(payload.company, 'company');
  const role = cleanRequiredText(payload.role, 'role');
  const appliedAt = String(payload.appliedAt || new Date().toISOString().slice(0, 10)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appliedAt) || Number.isNaN(new Date(`${appliedAt}T00:00:00`).getTime())) {
    throw new Error('appliedAt must be a valid YYYY-MM-DD date.');
  }
  const source = cleanRequiredText(payload.source || 'external', 'source').slice(0, 80);
  const customNotes = String(payload.notes || '').replace(/[\r\n|]+/g, ' ').trim().slice(0, 500);
  const baseNote = `Manually applied via Chrome extension. Source: ${source}. URL: ${url}`;
  return {
    url,
    company,
    role,
    appliedAt,
    source,
    notes: customNotes ? `${baseNote}. ${customNotes}` : `${baseNote}.`
  };
}

function cleanRequiredText(value, name, required = true) {
  const text = String(value || '').replace(/[\r\n\t|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (required && !text) throw new Error(`${name} is required.`);
  return text;
}

function normalizeHttpUrl(value, required = true) {
  const raw = String(value || '').trim();
  if (!raw && !required) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('url must be a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('url must use HTTP or HTTPS.');
  parsed.hash = '';
  return parsed.toString();
}

function findExistingApplication(application) {
  const normalizedUrl = application.url.replace(/\/$/, '').toLowerCase();
  const apps = parseApplications();
  return apps.find((row) => row.jobUrl && row.jobUrl.replace(/\/$/, '').toLowerCase() === normalizedUrl)
    || apps.find((row) => normalizeCompany(row.company) === normalizeCompany(application.company)
      && normalizeRole(row.role) === normalizeRole(application.role));
}

function normalizeRole(role) {
  return String(role || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function updateExistingApplication(number, application) {
  const filePath = trackerPath();
  const next = readText(filePath).split(/\r?\n/).map((line) => {
    if (!line.trim().startsWith('|')) return line;
    const fields = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((part) => part.trim());
    if (Number.parseInt(fields[0], 10) !== Number(number) || fields.length < 8) return line;
    fields[1] = application.appliedAt;
    fields[5] = 'Applied';
    const existingNotes = fields[8] || '';
    fields[8] = existingNotes.includes(application.url)
      ? existingNotes
      : [existingNotes, application.notes].filter(Boolean).join(' ');
    return `| ${fields.join(' | ')} |`;
  });
  fs.writeFileSync(filePath, next.join('\n'), 'utf8');
}

function ensureModelOption(model) {
  if (openAiModels.some((item) => item.id === model)) return openAiModels;
  return [{ id: model, label: `${model} - custom/current` }, ...openAiModels];
}

function extractPositiveKeywords(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'positive:');
  if (start < 0) return [];
  const keywords = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!trimmed.startsWith('- ')) break;
    keywords.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''));
  }
  return keywords;
}

function saveSettings(payload) {
  if (sqliteStore.available()) {
    const keywords = String(payload.titleKeywords || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    sqliteStore.saveTargetKeywords(keywords);
    return loadSettings();
  }
  const portalsPath = path.join(careerRoot, 'portals.yml');
  const text = readText(portalsPath);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'positive:');
  if (start < 0) throw new Error('Could not find title_filter.positive in portals.yml');
  let end = start + 1;
  while (end < lines.length) {
    const trimmed = lines[end].trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('- ')) {
      end += 1;
      continue;
    }
    break;
  }
  const keywords = String(payload.titleKeywords || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `    - ${JSON.stringify(line)}`);
  const next = [...lines.slice(0, start + 1), ...keywords, ...lines.slice(end)].join('\n');
  fs.writeFileSync(portalsPath, next, 'utf8');
  return loadSettings();
}

function saveResume(payload) {
  const resume = String(payload.resume || '');
  if (sqliteStore.available()) {
    sqliteStore.saveResume(resume);
    return { ok: true };
  }
  fs.writeFileSync(path.join(careerRoot, 'cv.md'), resume, 'utf8');
  return { ok: true };
}

async function uploadResume() {
  throw new Error('Browser uploads are handled by uploadResumeFromPath(filePath).');
}

async function uploadResumeFromPath(sourcePath, originalName = '') {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Uploaded resume file was not found.');
  const resume = await resumeMarkdownFromFile(sourcePath);
  if (!resume.trim()) throw new Error('Could not extract resume text from the uploaded file.');
  const ext = path.extname(sourcePath).toLowerCase();
  const displayName = cleanResumeName(originalName || path.basename(sourcePath));
  if (sqliteStore.available()) {
    const uploadDir = path.join(sqliteStore.dataRoot, 'files', 'uploads', 'resumes');
    fs.mkdirSync(uploadDir, { recursive: true });
    const storedPath = path.join(uploadDir, `${Date.now()}-${slug(path.basename(displayName, path.extname(displayName)))}${ext}`);
    fs.copyFileSync(sourcePath, storedPath);
    const relativePath = path.relative(sqliteStore.dataRoot, storedPath).split(path.sep).join('/');
    const id = sqliteStore.addResume({
      name: displayName,
      content: resume,
      storagePath: relativePath
    });
    sqliteStore.setPrimaryResume(id);
    const extraction = await extractKnowledgeFromResume({
      resumeId: id,
      name: displayName,
      content: resume,
      storagePath: relativePath
    });
    return {
      ok: true,
      id,
      resume: currentResume(),
      settings: loadResumeSettings(),
      resumes: listResumes(),
      knowledgeCenter: loadKnowledgeCenter(),
      extraction,
      message: `${displayName} added to your resume library. ${extraction.added} facts were added to your Knowledge Center.`
    };
  }
  const libraryDir = path.join(app.getPath('userData'), 'resumes');
  fs.mkdirSync(libraryDir, { recursive: true });
  const id = `resume-${crypto.randomUUID()}`;
  const storedPath = path.join(libraryDir, `${id}${ext}`);
  const contentPath = path.join(libraryDir, `${id}.md`);
  fs.copyFileSync(sourcePath, storedPath);
  fs.writeFileSync(contentPath, resume, 'utf8');
  const library = readJson(resumeLibraryPath()) || { resumes: [] };
  library.resumes = [...(library.resumes || []), {
    id,
    name: displayName,
    path: storedPath,
    contentPath,
    contentLength: resume.length,
    createdAt: new Date().toISOString()
  }];
  library.primaryId = id;
  fs.writeFileSync(resumeLibraryPath(), JSON.stringify(library, null, 2), 'utf8');
  return {
    ok: true,
    id,
    resume: currentResume(),
    settings: loadResumeSettings(),
    resumes: listResumes(),
    message: `${displayName} added to your resume library.`
  };
}

async function extractKnowledgeFromResume({ resumeId, name, content, storagePath }) {
  return extractKnowledgeFromDocument({
    sourceType: 'resume',
    referenceId: resumeId,
    name,
    content,
    storagePath
  });
}

async function extractKnowledgeFromDocument({
  sourceType = 'document',
  referenceId = null,
  name,
  content,
  storagePath
}) {
  const sourceId = sqliteStore.addKnowledgeSource({
    sourceType,
    label: name,
    referenceId,
    storagePath,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    metadata: { extractionStatus: 'imported' }
  });
  try {
    getAiAuth();
    const existingContext = trustedKnowledgeContext();
    const response = await aiJson([
      'Convert this professional document into a structured career knowledge base.',
      'Return JSON with one key, records, containing an array.',
      `Allowed categories: ${knowledgeCategories.join(', ')}.`,
      'Each record must contain: category, name, metadata (object), facts (array), confidence (0 to 1).',
      'Each item in facts must contain: factType, title, summary, sourceExcerpt.',
      'Use one record per employer, school, project, writing sample, or portfolio item.',
      'Employment metadata: role, location, workMode, dates. Education metadata: degree, field, location, dates.',
      'Copy resume bullet points into facts with only light rewording. Preserve every number, metric, technology, scope detail, and concrete outcome.',
      'Do not convert role, location, or dates into fact prose; keep them only in metadata.',
      'For skills, create one record named "Skills" and one fact per explicitly named skill. Keep every listed skill.',
      'Never include the candidate name or pronouns in a fact. Facts must be concise fragments, not biographical sentences.',
      'GPA must be title "GPA" and summary like "GPA: 3.63".',
      'Do not create duplicate records or duplicate facts.',
      'Compare against the existing knowledge below. Merge into the same canonical employer, school, or project names. Return only genuinely new facts or metadata.',
      'For transcripts, courses and coursework belong under the education record for the institution where they were taken. Never classify courses as skills.',
      'Course facts should use factType "course", title as the course code/name, and a concise summary preserving grade, credits, and term when available.',
      'Do not infer role preferences, career goals, or application answers unless explicitly stated.',
      'Preserve metrics and dates exactly. Do not invent facts.',
      '',
      'Existing knowledge:',
      existingContext.slice(0, 18000),
      '',
      'Document:',
      content.slice(0, 24000)
    ].join('\n'));
    const facts = flattenKnowledgeRecords(response.records, candidateName(), {
      sourceName: name,
      existingRecords: loadKnowledgeCenter().records
    });
    const added = sqliteStore.addKnowledgeFacts(facts, sourceId, 'trusted');
    return { method: 'ai', added, records: Array.isArray(response.records) ? response.records.length : 0, status: 'ai-imported' };
  } catch (error) {
    const facts = extractKnowledgeHeuristically(content);
    const added = sqliteStore.addKnowledgeFacts(facts, sourceId, 'trusted');
    return {
      method: 'heuristic',
      added,
      records: 0,
      status: 'locally-imported',
      warning: error.message
    };
  }
}

function flattenKnowledgeRecords(records, name = '', options = {}) {
  const output = [];
  const educationNames = [
    ...(options.existingRecords || []).filter((record) => record.category === 'education').map((record) => record.name),
    ...(Array.isArray(records) ? records : []).filter((record) => String(record.category).toLowerCase() === 'education').map((record) => record.name)
  ].filter(Boolean);
  const transcript = /transcript|academic record|student record/i.test(String(options.sourceName || ''));
  for (const record of Array.isArray(records) ? records : []) {
    let category = String(record.category || '').toLowerCase();
    if (!knowledgeCategories.includes(category)) continue;
    let entity = String(record.name || '').trim();
    if (transcript && category === 'skills') {
      category = 'education';
      entity = educationNames[0] || entity || 'Education';
    }
    const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
    for (const fact of Array.isArray(record.facts) ? record.facts : []) {
      const courseLike = /course|coursework|class/i.test(String(fact.factType || ''))
        || /\b[A-Z]{2,5}\s?\d{3,4}\b/.test(`${fact.title || ''} ${fact.summary || ''}`);
      const factCategory = courseLike ? 'education' : category;
      const factEntity = courseLike ? (educationNames[0] || entity || 'Education') : entity;
      output.push(normalizeExtractedKnowledgeFact({
        category: factCategory,
        factType: courseLike ? 'course' : (fact.factType || 'detail'),
        title: fact.title || fact.factType || 'Detail',
        summary: fact.summary || '',
        details: { entity: factEntity, ...metadata },
        confidence: Math.max(0.1, Math.min(1, Number(record.confidence) || 0.85)),
        sourceExcerpt: fact.sourceExcerpt || fact.summary || ''
      }, name));
    }
    if ((!record.facts || record.facts.length === 0) && entity) {
      output.push({
        category,
        factType: 'record',
        title: 'Record',
        summary: entity,
        details: { entity, ...metadata },
        confidence: Math.max(0.1, Math.min(1, Number(record.confidence) || 0.85)),
        sourceExcerpt: entity
      });
    }
  }
  return output.filter((fact) => fact.title && fact.summary).slice(0, 300);
}

async function uploadKnowledgeDocumentFromPath(sourcePath, originalName = '') {
  if (!sqliteStore.available()) throw new Error('Document ingestion requires initialized application data.');
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Uploaded document was not found.');
  const content = await resumeMarkdownFromFile(sourcePath);
  if (!content.trim()) throw new Error('Could not extract text from the uploaded document.');
  const displayName = cleanResumeName(originalName || path.basename(sourcePath));
  const ext = path.extname(sourcePath).toLowerCase();
  const uploadDir = path.join(sqliteStore.dataRoot, 'files', 'uploads', 'knowledge');
  fs.mkdirSync(uploadDir, { recursive: true });
  const storedPath = path.join(uploadDir, `${Date.now()}-${slug(path.basename(displayName, path.extname(displayName)))}${ext}`);
  fs.copyFileSync(sourcePath, storedPath);
  const relativePath = path.relative(sqliteStore.dataRoot, storedPath).split(path.sep).join('/');
  const extraction = await extractKnowledgeFromDocument({
    sourceType: 'document',
    name: displayName,
    content,
    storagePath: relativePath
  });
  return {
    ok: true,
    extraction,
    knowledgeCenter: loadKnowledgeCenter(),
    message: `${displayName} parsed by AI. ${extraction.added} facts added.`
  };
}

async function rebuildKnowledgeCenter() {
  if (!sqliteStore.available()) throw new Error('Knowledge rebuild requires initialized application data.');
  getAiAuth();
  sqliteStore.clearKnowledge();
  const results = [];
  for (const resume of listResumes()) {
    const stored = getResume(resume.id);
    results.push(await extractKnowledgeFromResume({
      resumeId: resume.id,
      name: resume.name,
      content: stored.content,
      storagePath: path.relative(sqliteStore.dataRoot, resume.path).split(path.sep).join('/')
    }));
  }
  syncSetupKnowledge(loadSetupSettings());
  return {
    ok: true,
    results,
    knowledgeCenter: loadKnowledgeCenter(),
    message: `Knowledge Center rebuilt from ${results.length} resume${results.length === 1 ? '' : 's'}.`
  };
}

async function chatKnowledge(payload = {}) {
  if (!sqliteStore.available()) throw new Error('Knowledge chat requires initialized application data.');
  const message = cleanRequiredText(payload.message, 'message');
  getAiAuth();
  const response = await aiJson([
    'You are a career knowledge assistant. Interpret the user message and update their structured professional knowledge.',
    'Return JSON with keys: assistantMessage (short confirmation or clarification) and records (array).',
    `Allowed categories: ${knowledgeCategories.join(', ')}.`,
    'Each record: category, name, metadata object, facts array, confidence.',
    'Each fact: factType, title, summary, sourceExcerpt.',
    'Use existing canonical record names where applicable. Return only new or changed information, never duplicates.',
    'If the message lacks enough factual information, return an empty records array and ask one concise clarification in assistantMessage.',
    'Never invent details.',
    '',
    'Existing knowledge:',
    trustedKnowledgeContext().slice(0, 18000),
    '',
    'User message:',
    message
  ].join('\n'));
  const facts = flattenKnowledgeRecords(response.records, candidateName(), {
    sourceName: 'AI knowledge chat',
    existingRecords: loadKnowledgeCenter().records
  });
  let added = 0;
  if (facts.length) {
    const sourceId = sqliteStore.addKnowledgeSource({
      sourceType: 'ai-chat',
      label: 'AI knowledge chat',
      metadata: { enteredBy: 'user', message }
    });
    added = sqliteStore.addKnowledgeFacts(facts, sourceId, 'trusted');
  }
  return {
    ok: true,
    added,
    assistantMessage: String(response.assistantMessage || (added ? `Added ${added} facts.` : 'No new facts were added.')),
    knowledgeCenter: loadKnowledgeCenter()
  };
}

function normalizeExtractedKnowledgeFact(fact, name = '') {
  const combined = `${fact.title || ''} ${fact.summary || ''} ${fact.sourceExcerpt || ''}`;
  const details = { ...(fact.details || {}) };
  if (!details.entity && String(fact.category || '').toLowerCase() === 'education') {
    const institution = combined.match(/\b([A-Z][A-Za-z&'.-]*(?:\s+[A-Z][A-Za-z&'.-]*)*\s+(?:University|College|Institute|School))\b/);
    if (institution) details.entity = institution[1];
  }
  const gpa = combined.match(/\bGPA(?:\s+(?:of|is|was))?\s*[:\-]?\s*(\d(?:\.\d{1,3})?)\b/i)
    || combined.match(/\b(\d(?:\.\d{1,3})?)\s*GPA\b/i);
  const normalized = normalizeBareExtractedFact(fact, name);
  if (!gpa) return { ...fact, ...normalized, details };
  return {
    ...fact,
    factType: 'gpa',
    title: 'GPA',
    summary: `GPA: ${gpa[1]}`,
    details
  };
}

function normalizeBareExtractedFact(fact, name = '') {
  const escapedName = String(name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactNamePrefix = escapedName ? new RegExp(`^${escapedName}\\s+`, 'i') : null;
  const strip = (value) => String(value || '')
    .replace(/^[-*•]\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(exactNamePrefix || /$a/, '')
    .replace(/^(?:[A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){1,3})\s+(?=(?:has|is|was|worked|built|created|developed|led|managed|earned|received|studied|graduated|improved|increased|reduced|launched|designed|implemented|analyzed|conducted|supported|delivered)\b)/i, '')
    .replace(/^(?:he|she|they)\s+(?:has|have|is|was)\s+/i, '')
    .replace(/^has\s+(?:an?\s+)?/i, '')
    .replace(/^is\s+(?:an?\s+)?/i, '')
    .replace(/^was\s+(?:an?\s+)?/i, '')
    .replace(/^worked\s+as\s+(?:an?\s+)?/i, '')
    .replace(/^earned\s+(?:an?\s+)?/i, '')
    .replace(/^received\s+(?:an?\s+)?/i, '')
    .replace(/[.;]+$/, '')
    .trim();
  return {
    title: strip(fact.title),
    summary: strip(fact.summary)
  };
}

function extractKnowledgeHeuristically(content) {
  const lines = String(content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const facts = [];
  let category = 'attributes';
  const sectionMap = [
    [/experience|employment|work history/i, 'employment'],
    [/education|academic/i, 'education'],
    [/projects?/i, 'projects'],
    [/skills?|technologies|tools/i, 'skills'],
    [/awards?|accomplishments?|achievements?/i, 'accomplishments'],
    [/portfolio|writing|publications?/i, 'portfolio']
  ];
  for (const line of lines) {
    const heading = line.replace(/^#+\s*/, '').replace(/:$/, '');
    const matchedSection = sectionMap.find(([pattern]) => pattern.test(heading) && heading.length < 60);
    if (matchedSection) {
      category = matchedSection[1];
      continue;
    }
    if (line.length < 3 || /^[|:-]+$/.test(line)) continue;
    const summary = line.replace(/^[-*•]\s*/, '').trim();
    if (!summary || /^(email|phone|linkedin|github|portfolio)\s*:/i.test(summary)) continue;
    const hasMetric = /(?:\d+(?:\.\d+)?%|\$[\d,.]+|\b\d+[xX]\b|\b\d{2,}\b)/.test(summary);
    facts.push({
      category: hasMetric ? 'accomplishments' : category,
      factType: hasMetric ? 'metric' : 'resume-statement',
      title: summary.split(/[.;|]/)[0].slice(0, 100),
      summary,
      details: {},
      confidence: hasMetric ? 0.68 : 0.55,
      sourceExcerpt: summary
    });
  }
  return facts;
}

function cleanResumeName(value) {
  return path.basename(String(value || 'Resume')).replace(/[\r\n\t]/g, ' ').trim().slice(0, 160) || 'Resume';
}

async function resumeMarkdownFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let text = '';
  if (ext === '.pdf') text = await readPdfText(filePath);
  else if (ext === '.docx') text = await readDocxText(filePath);
  else if (ext === '.md' || ext === '.txt') text = readText(filePath);
  else throw new Error('Unsupported resume file type.');
  text = cleanExtractedText(text);
  if (!text) return '';
  if (ext === '.md') return text.endsWith('\n') ? text : `${text}\n`;
  return `# Resume\n\n${text.replace(/\n{3,}/g, '\n\n')}\n`;
}

async function updateStatus(payload) {
  const targetNumber = Number(payload.number);
  const nextStatus = crmStatusToCareerOps(payload.status || payload.crmStatus || '').trim();
  if (sqliteStore.available()) {
    sqliteStore.updateStatus(targetNumber, nextStatus);
    return loadDashboard();
  }
  const filePath = trackerPath();
  const text = readText(filePath);
  const lines = text.split(/\r?\n/);
  const next = lines.map((line) => {
    if (!line.trim().startsWith('|')) return line;
    const fields = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((part) => part.trim());
    if (Number.parseInt(fields[0], 10) !== targetNumber || fields.length < 8) return line;
    fields[5] = nextStatus;
    return `| ${fields.join(' | ')} |`;
  });
  fs.writeFileSync(filePath, next.join('\n'), 'utf8');
  return loadDashboard();
}

async function updateApplicationNotes(payload = {}) {
  const targetNumber = Number(payload.number);
  const notes = String(payload.notes || '').replace(/\r/g, '').trim().slice(0, 4000);
  if (sqliteStore.available()) {
    sqliteStore.updateApplicationNotes(targetNumber, notes);
    return loadDashboard();
  }
  const filePath = trackerPath();
  const next = readText(filePath).split(/\r?\n/).map((line) => {
    if (!line.trim().startsWith('|')) return line;
    const fields = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((part) => part.trim());
    if (Number.parseInt(fields[0], 10) !== targetNumber || fields.length < 8) return line;
    while (fields.length < 9) fields.push('');
    fields[8] = notes.replace(/\|/g, '/').replace(/\n/g, ' ');
    return `| ${fields.join(' | ')} |`;
  });
  fs.writeFileSync(filePath, next.join('\n'), 'utf8');
  return loadDashboard();
}

async function generateApplicationReport(payload = {}) {
  const row = findApplicationByNumber(payload.number);
  if (!row) throw new Error('Application not found.');
  if (!row.jobUrl) throw new Error('This application does not have a job posting URL.');
  if (!sqliteStore.available()) throw new Error('Report generation for tracked jobs requires application storage.');
  const reportNum = row.number;
  const today = new Date().toISOString().slice(0, 10);
  const job = { url: row.jobUrl, company: row.company, role: row.role };
  const jd = await getJobDescription(job);
  const response = await aiJson(buildEvaluationPrompt({
    reportNum,
    today,
    job,
    profile: yaml.dump(loadProfile()),
    resume: currentResume(),
    approvedKnowledge: relevantKnowledgeContext(jd, job.role),
    jd
  }));
  const score = clampScore(response.score);
  const legitimacy = String(response.legitimacy || 'unconfirmed').replace(/\|/g, '/');
  const reportName = `${String(reportNum).padStart(3, '0')}-${slug(job.company)}-${today}.md`;
  const reportMarkdown = normalizeGeneratedReport(response.reportMarkdown, {
    reportNum, today, job, score, legitimacy
  });
  const saved = sqliteStore.saveApplicationReport({
    number: reportNum, today, score, legitimacy, reportMarkdown, reportName
  });
  return {
    ok: true,
    number: reportNum,
    reportPath: saved.reportPath,
    message: `Report ${String(reportNum).padStart(3, '0')} generated.`,
    dashboard: await loadDashboard()
  };
}

async function exportCoverLetterPdf(payload) {
  const row = findApplicationByNumber(payload?.number);
  if (!row) throw new Error('Application not found.');
  const materials = deriveMaterials(row);
  if (!materials.coverLetterPath) throw new Error('Cover letter not generated yet.');
  const text = await readDocxText(materials.coverLetterPath);
  const outDir = loadCoverLetterSettings().outputDir;
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${String(row.number).padStart(3, '0')}-${slug(row.company)}-cover-letter.pdf`);
  const html = coverLetterPdfHtml(row, text);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outPath,
      format: 'Letter',
      margin: { top: '0.7in', bottom: '0.7in', left: '0.75in', right: '0.75in' },
      printBackground: true
    });
  } finally {
    await browser.close();
  }
  return { ok: true, path: outPath, relativePath: displayPath(outPath), dashboard: await loadDashboard() };
}

function generateAutofillPrompt(payload) {
  const row = findApplicationByNumber(payload?.number);
  if (!row) throw new Error('Application not found.');
  const prompt = buildAutofillPrompt(row);
  const promptPath = writeAutofillPrompt(row, prompt);
  clipboard.writeText(prompt);
  return { ok: true, copied: true, content: prompt, path: promptPath, relativePath: displayPath(promptPath) };
}

function buildAutofillPrompt(row) {
  const materials = deriveMaterials(row);
  const report = row.reportPath
    ? readText(path.isAbsolute(row.reportPath) ? row.reportPath : path.join(careerRoot, row.reportPath))
    : '';
  const candidate = candidateProfile();
  const profile = loadProfile();
  const candidateLines = [
    ['Name', candidate.full_name],
    ['Email', candidate.email],
    ['Phone', candidate.phone],
    ['Location', candidate.location],
    ['LinkedIn', candidate.linkedin],
    ['Portfolio', candidate.portfolio_url],
    ['GitHub', candidate.github],
    ['Visa / work authorization', profile.location?.visa_status]
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);
  return [
    `You are helping ${candidate.full_name || 'the candidate'} apply to this role.`,
    '',
    `Company: ${row.company}`,
    `Role: ${row.role}`,
    `Job URL: ${row.jobUrl || ''}`,
    '',
    'Candidate info:',
    ...candidateLines,
    '',
    'Files:',
    `Resume source: ${materials.resumeSourcePath || ''}`,
    `Resume PDF: ${materials.pdfPath || ''}`,
    `Cover Letter: ${materials.coverLetterPath || ''}`,
    `Cover Letter PDF: ${materials.coverLetterPdfPath || ''}`,
    '',
    'Instructions:',
    '1. Open the job URL.',
    '2. Fill in all application fields using the candidate info.',
    '3. Upload the resume PDF if available.',
    '4. Upload the cover letter PDF if the form asks for one.',
    '5. Draft short-answer responses using the report notes below.',
    '6. Stop before clicking Submit.',
    `7. Ask ${candidate.full_name || 'the candidate'} to review the full application manually.`,
    '',
    'Do not submit the application.',
    '',
    'Report notes:',
    report.slice(0, 5000),
    '',
    'Approved professional knowledge (use only these additional claims):',
    trustedKnowledgeContext().slice(0, 10000)
  ].join('\n');
}

function writeAutofillPrompt(row, prompt) {
  const outDir = sqliteStore.available()
    ? path.join(sqliteStore.dataRoot, 'files', 'generated', 'apply-prompts')
    : path.join(careerRoot, 'output', 'apply-prompts');
  fs.mkdirSync(outDir, { recursive: true });
  const number = row.number ? String(row.number).padStart(3, '0') : 'job';
  const outPath = path.join(outDir, `${number}-${slug(row.company)}-${slug(row.role)}-autofill-prompt.md`);
  fs.writeFileSync(outPath, String(prompt || ''), 'utf8');
  return outPath;
}

async function withConcurrency(limit, tasks) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        results[index] = { ok: false, error: error.message };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function evaluatePending(payload) {
  const requested = new Set((payload?.urls || []).filter(Boolean));
  const jobs = parsePendingJobs().filter((job) => requested.size === 0 || requested.has(job.url));
  if (jobs.length === 0) return { ok: false, message: 'No pending jobs selected.', dashboard: await loadDashboard() };

  const results = await withConcurrency(3, jobs.map((job) => async () => {
    try {
      const evaluation = await evaluateOnePending(job);
      return { ok: true, ...evaluation };
    } catch (error) {
      return { ok: false, job, error: error.message };
    }
  }));

  if (!sqliteStore.available()) await runScript('merge-tracker.mjs');
  return {
    ok: results.some((item) => item.ok),
    results,
    message: `${results.filter((item) => item.ok).length}/${results.length} jobs evaluated.`,
    dashboard: await loadDashboard()
  };
}

async function evaluateOnePending(job) {
  const reportNum = sqliteStore.available() ? sqliteStore.nextApplicationNumber() : nextReportNumber();
  const today = new Date().toISOString().slice(0, 10);
  const resume = currentResume();
  const profile = yaml.dump(loadProfile());
  const jd = await getJobDescription(job);
  const response = await aiJson(buildEvaluationPrompt({
    reportNum,
    today,
    job,
    profile,
    resume,
    approvedKnowledge: relevantKnowledgeContext(jd, job.role),
    jd
  }));

  const score = clampScore(response.score);
  const legitimacy = String(response.legitimacy || 'unconfirmed').replace(/\|/g, '/');
  const notes = String(response.notes || response.recommendation || '').replace(/\r?\n/g, ' ').replace(/\|/g, '/').slice(0, 220);
  const slugBase = slug(job.company);
  const reportName = `${String(reportNum).padStart(3, '0')}-${slugBase}-${today}.md`;
  const reportMarkdown = normalizeGeneratedReport(response.reportMarkdown, {
    reportNum,
    today,
    job,
    score,
    legitimacy
  });
  if (sqliteStore.available()) {
    const saved = sqliteStore.saveEvaluation({
      job, reportNum, today, score, legitimacy, notes, reportMarkdown, reportName,
      jobDescription: jd
    });
    return {
      job,
      reportNum: saved.reportNum,
      score,
      reportPath: saved.reportPath,
      jobDescriptionPath: saved.jobDescriptionPath || '',
      duplicate: saved.duplicate
    };
  }
  const reportPath = path.join(careerRoot, 'reports', reportName);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, reportMarkdown, 'utf8');
  const jobDescriptionPath = score >= 3
    ? writeStoredJobDescription({ reportNum, job, content: jd })
    : '';
  writeTrackerAddition({ reportNum, today, job, score, reportName, notes });
  markPendingProcessed(job.url, `#${String(reportNum).padStart(3, '0')} | ${score.toFixed(1)}/5 | ${legitimacy}`);
  return {
    job,
    reportNum,
    score,
    reportPath: path.relative(careerRoot, reportPath).replaceAll(path.sep, '/'),
    jobDescriptionPath: jobDescriptionPath
      ? path.relative(careerRoot, jobDescriptionPath).replaceAll(path.sep, '/')
      : ''
  };
}

async function discardPending(payload) {
  const urls = (payload?.urls || []).filter(Boolean);
  if (urls.length === 0) return { ok: false, message: 'No pending jobs selected.', dashboard: await loadDashboard() };
  if (sqliteStore.available()) {
    sqliteStore.discardPending(urls);
    return { ok: true, message: `${urls.length} pending jobs discarded.`, dashboard: await loadDashboard() };
  }
  for (const url of urls) {
    markPendingProcessed(url, 'Discarded from dashboard');
  }
  return { ok: true, message: `${urls.length} pending jobs discarded.`, dashboard: await loadDashboard() };
}

async function checkPendingAvailability(payload) {
  const urls = (payload?.urls || []).filter(Boolean);
  const pending = parsePendingJobs().filter((job) => urls.includes(job.url));
  const results = [];
  const verifier = await createLivenessVerifier();
  for (const job of pending) {
    results.push({ url: job.url, ...(await verifyAvailability(job.url, verifier)) });
  }
  await verifier.close();
  return { ok: true, results };
}

async function runBulkQueue(event, payload) {
  const requested = new Set((payload?.urls || []).filter(Boolean));
  const includeCoverLetter = Boolean(payload?.includeCoverLetter);
  const jobs = parsePendingJobs().filter((job) => requested.size === 0 || requested.has(job.url));
  if (jobs.length === 0) return { ok: false, message: 'No pending jobs selected.', dashboard: await loadDashboard(), results: [] };

  const results = [];
  const verifier = await createLivenessVerifier();
  const emit = (update) => event.sender.send('dashboard:bulkQueueProgress', {
    total: jobs.length,
    timestamp: new Date().toISOString(),
    ...update
  });

  emit({ type: 'queue-started', status: 'running', message: `Starting ${jobs.length} queued job(s).` });
  const evaluationQueue = [];
  try {
    // Phase 1: verify all jobs serially (single shared verifier page)
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const base = { index, url: job.url, company: job.company, role: job.role };
      emit({ ...base, type: 'job-update', stage: 'verify', status: 'running', message: 'Verifying posting availability...' });

      let availability = null;
      try {
        availability = await verifyAvailability(job.url, verifier);
        emit({
          ...base,
          type: 'job-update',
          stage: 'verify',
          status: availability.available ? 'done' : 'skipped',
          message: availability.reason,
          availability
        });

        if (!availability.available) {
          if (sqliteStore.available()) {
            sqliteStore.processPending(job.url, `Skipped by bulk queue | ${availability.reason}`);
          } else {
            markPendingProcessed(job.url, `Skipped by bulk queue | ${availability.reason}`);
          }
          const dashboard = await loadDashboard();
          const skipped = { ok: true, skipped: true, job, availability, message: availability.reason };
          results.push(skipped);
          emit({ ...base, type: 'job-complete', stage: 'done', status: 'skipped', result: skipped, dashboard, message: 'Skipped unavailable posting.' });
        } else {
          evaluationQueue.push({ job, availability, base });
        }
      } catch (error) {
        const dashboard = await loadDashboard();
        const failed = { ok: false, job, availability, evaluation: null, application: null, error: error.message };
        results.push(failed);
        emit({
          ...base,
          type: 'job-complete',
          stage: 'failed',
          status: 'failed',
          result: failed,
          dashboard,
          message: error.message
        });
      }
    }

    // Phase 2: evaluate jobs that passed concurrently (up to 3 at once)
    const evalResults = await withConcurrency(3, evaluationQueue.map(({ job, availability, base }) => async () => {
      let evaluation = null;
      try {
        emit({ ...base, type: 'job-update', stage: 'evaluate', status: 'running', message: 'Evaluating and writing report...' });
        evaluation = await evaluateOnePending(job);
        if (!sqliteStore.available()) {
          const merge = await runScript('merge-tracker.mjs');
          if (!merge.ok) throw new Error(`merge-tracker failed: ${merge.output || `exit ${merge.code}`}`);
        }
        emit({
          ...base,
          type: 'job-update',
          stage: 'evaluate',
          status: 'done',
          message: `Report ${String(evaluation.reportNum).padStart(3, '0')} written.`,
          evaluation
        });

        const appRow = findApplicationByNumber(evaluation.reportNum);
        if (!appRow) throw new Error(`Evaluation #${evaluation.reportNum} was written but could not be found in the tracker.`);

        let coverLetter = null;
        let coverLetterPdf = null;
        if (includeCoverLetter) {
          emit({ ...base, type: 'job-update', stage: 'cover-letter', status: 'running', message: 'Generating cover letter...' });
          coverLetter = await generateCoverLetter(appRow);
          coverLetterPdf = await exportCoverLetterPdf({ number: appRow.number });
          emit({
            ...base,
            type: 'job-update',
            stage: 'cover-letter',
            status: 'done',
            message: `Cover letter ready: ${coverLetter.relativePath}`,
            coverLetter,
            coverLetterPdf
          });
        }

        emit({ ...base, type: 'job-update', stage: 'autofill', status: 'running', message: 'Generating autofill prompt...' });
        const refreshedRow = findApplicationByNumber(appRow.number) || appRow;
        const prompt = buildAutofillPrompt(refreshedRow);
        const promptPath = writeAutofillPrompt(refreshedRow, prompt);
        clipboard.writeText(prompt);
        const promptResult = { path: promptPath, relativePath: displayPath(promptPath), copied: true };
        emit({
          ...base,
          type: 'job-update',
          stage: 'autofill',
          status: 'done',
          message: `Autofill prompt ready: ${promptResult.relativePath}`,
          prompt: promptResult
        });

        const dashboard = await loadDashboard();
        const application = dashboard.applications.find((row) => row.number === appRow.number) || null;
        const result = { ok: true, job, availability, evaluation, application, coverLetter, coverLetterPdf, prompt: promptResult };
        emit({
          ...base,
          type: 'job-complete',
          stage: 'done',
          status: 'done',
          result,
          dashboard,
          message: application ? `Added to dashboard as #${String(application.number).padStart(3, '0')}.` : 'Queue item complete.'
        });
        return result;
      } catch (error) {
        const dashboard = await loadDashboard();
        const application = evaluation?.reportNum
          ? dashboard.applications.find((row) => row.number === evaluation.reportNum) || null
          : null;
        const failed = { ok: false, job, availability, evaluation, application, error: error.message };
        emit({
          ...base,
          type: 'job-complete',
          stage: 'failed',
          status: 'failed',
          result: failed,
          dashboard,
          message: application
            ? `Evaluation #${String(application.number).padStart(3, '0')} saved, but a later step failed: ${error.message}`
            : error.message
        });
        return failed;
      }
    }));
    for (const r of evalResults) results.push(r);
  } finally {
    await verifier.close();
  }

  const okCount = results.filter((item) => item.ok && !item.skipped).length;
  const skippedCount = results.filter((item) => item.skipped).length;
  const failedCount = results.filter((item) => !item.ok).length;
  emit({
    type: 'queue-complete',
    status: failedCount ? 'failed' : 'done',
    results,
    message: `${okCount}/${results.length} completed, ${skippedCount} skipped, ${failedCount} failed.`
  });
  return {
    ok: results.some((item) => item.ok),
    results,
    message: `${okCount}/${results.length} completed, ${skippedCount} skipped, ${failedCount} failed.`,
    dashboard: await loadDashboard()
  };
}

async function generateCoverLetter(row) {
  const dir = loadCoverLetterSettings().outputDir;
  fs.mkdirSync(dir, { recursive: true });
  const number = row.number ? String(row.number).padStart(3, '0') : 'job';
  const file = `${number}-${slug(row.company)}-${slug(row.role)}.docx`;
  const outPath = path.join(dir, file);
  const resume = currentResume();
  const name = candidateName();
  const examples = await loadCoverLetterExamples();
  const jobDescription = await getJobDescription(row);
  const generated = await aiJson([
    'Write a one-page internship cover letter in the same format and voice as the examples.',
    'Return strict JSON with keys: greeting (string), paragraphs (array of 4 to 5 paragraph strings), closing (string).',
    'Use Times New Roman DOCX formatting will be applied by the app; you only write the cover letter content.',
    `Do not include the ${name} contact header, salutation, or signature inside the body paragraphs.`,
    'Style requirements from examples:',
    `- Header is ${name} contact info.`,
    '- Direct salutation to the company hiring team.',
    '- First paragraph states interest, school/program, and why this company/role.',
    '- Body paragraphs tie job requirements to Launch Lift Media, TSA forecasting, campaign work, Hyperloop, ORIE, or other resume evidence only when supported.',
    '- Closing paragraph is concise and specific.',
    '- Keep it to one page: about 430 to 560 words total.',
    '- Do not invent dates, certifications, employers, or metrics.',
    '- Avoid markdown, bullets, tables, or section headings.',
    '',
    `Company: ${row.company}`,
    `Role: ${row.role}`,
    `Job URL: ${row.jobUrl || row.url || ''}`,
    '',
    'Resume:',
    resume.slice(0, 16000),
    '',
    'Approved professional knowledge:',
    trustedKnowledgeContext().slice(0, 14000),
    '',
    'Job description / report context:',
    jobDescription.slice(0, 18000),
    '',
    'Examples:',
    examples.slice(0, 12000)
  ].join('\n'), { modelPurpose: 'cover-letter' });
  const body = coverLetterTextFromGenerated(row, generated);
  await writeCoverLetterDocx(outPath, body);
  if (sqliteStore.available() && row.number) {
    sqliteStore.linkApplicationDocument(row.number, 'cover-letter', outPath, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }
  return {
    applicationNumber: row.number || null,
    company: row.company,
    role: row.role,
    path: outPath,
    relativePath: displayPath(outPath),
    content: body
  };
}

async function saveCoverLetter(payload) {
  const targetPath = path.resolve(String(payload.path || ''));
  const allowedDir = path.resolve(loadCoverLetterSettings().outputDir);
  if (!isInsidePath(targetPath, allowedDir)) throw new Error('Cover letter path is outside the configured cover letter output folder.');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  await writeCoverLetterDocx(targetPath, String(payload.content || ''));
  return { ok: true, path: targetPath, relativePath: displayPath(targetPath) };
}

async function loadCoverLetters() {
  const dir = loadCoverLetterSettings().outputDir;
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.docx'))
    .map((name) => {
      const full = path.join(dir, name);
      return {
        name,
        path: full,
        relativePath: displayPath(full),
        updatedAt: fs.statSync(full).mtime.toISOString()
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return Promise.all(files.map(async (file) => ({
    ...file,
    content: await readDocxText(file.path)
  })));
}

function runScript(scriptName, args = [], { timeoutMs = 0 } = {}) {
  return runNodeProcess(path.join(careerRoot, scriptName), args, {
    cwd: careerRoot,
    timeoutMs,
    timeoutLabel: 'Scan'
  });
}

function runNodeProcess(scriptPath, args = [], {
  cwd,
  timeoutMs = 0,
  env = {},
  timeoutLabel = 'Process'
} = {}) {
  return new Promise((resolve) => {
    const nodeExe = findNodeExecutable();
    if (!nodeExe) {
      loadDashboard().then((dashboard) => resolve({
        ok: false,
        code: -1,
        output: 'Node.js was not found on PATH. Install Node.js or launch the app from a terminal where node is available.',
        dashboard
      }));
      return;
    }

    const childEnv = { ...process.env, ...env, FORCE_COLOR: '0' };
    if (process.versions?.electron && nodeExe === process.execPath) {
      childEnv.ELECTRON_RUN_AS_NODE = '1';
    }
    const child = spawn(nodeExe, [scriptPath, ...args], {
      cwd: cwd || careerRoot,
      shell: false,
      windowsHide: true,
      env: childEnv
    });
    let output = '';
    let settled = false;
    let timer = null;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, dashboard: await loadDashboard() });
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        output += `\n${timeoutLabel} stopped after exceeding ${Math.round(timeoutMs / 1000)} seconds.`;
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore'
          });
        } else {
          child.kill('SIGTERM');
        }
        finish({ ok: false, code: -2, output: output.trim() });
      }, timeoutMs);
    }
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => {
      finish({ ok: false, code: -1, output: error.message });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, output: output.trim() });
    });
  });
}

async function runScan() {
  if (!sqliteStore.available()) {
    return runScript('scan.mjs', ['--verify', '--verify-limit=8'], { timeoutMs: 240_000 });
  }

  const runtime = scannerRuntime();
  if (!runtime.available) {
    return {
      ok: false,
      code: -1,
      output: runtime.reason,
      dashboard: await loadDashboard()
    };
  }

  const workspaceParent = path.join(sqliteStore.dataRoot, 'temp');
  fs.mkdirSync(workspaceParent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(workspaceParent, 'scan-'));
  try {
    const snapshot = sqliteStore.loadSnapshot();
    const dataDir = path.join(workspace, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const portalsPath = path.join(workspace, 'portals.yml');
    // Build portals config: merge careerRoot portals.yml (for tracked_companies/search_queries)
    // with SQLite targeting (for title_filter.positive set via Settings UI).
    let portalsConfig = snapshot.targeting || {};
    const careerRootPortals = path.join(careerRoot, 'portals.yml');
    if (fs.existsSync(careerRootPortals)) {
      try {
        const baseConfig = yaml.load(fs.readFileSync(careerRootPortals, 'utf8')) || {};
        portalsConfig = { ...baseConfig };
        const sqliteKeywords = snapshot.targeting?.title_filter?.positive;
        if (Array.isArray(sqliteKeywords) && sqliteKeywords.length > 0) {
          portalsConfig.title_filter = { ...(baseConfig.title_filter || {}), positive: sqliteKeywords };
        }
      } catch (err) {
        // portals.yml parse error — fall back to SQLite targeting only
      }
    }
    fs.writeFileSync(portalsPath, yaml.dump(portalsConfig), 'utf8');
    fs.writeFileSync(
      path.join(dataDir, 'pipeline.md'),
      '# Pipeline\n\n## Pendientes\n\n## Procesadas\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(dataDir, 'applications.md'),
      [
        '# Applications',
        '',
        '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
        '|---|------|---------|------|-------|--------|-----|--------|-------|',
        ...snapshot.applications.map((row) => (
          `| ${row.number || ''} | ${row.date || ''} | ${safeTableCell(row.company)} | ${safeTableCell(row.role)} | ${row.scoreRaw || 'N/A'} | ${row.status || ''} | | | ${row.jobUrl || ''} |`
        ))
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dataDir, 'scan-history.tsv'),
      [
        'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation',
        ...snapshot.scanHistory.map((row) => [
          row.url, row.firstSeen, row.portal, row.title, row.company, row.status, ''
        ].map(safeTsvCell).join('\t'))
      ].join('\n') + '\n',
      'utf8'
    );
    const knownUrls = new Set(snapshot.scanHistory.map((row) => row.url));
    const result = await runNodeProcess(runtime.scriptPath, ['--verify', '--verify-limit=8'], {
      cwd: workspace,
      timeoutMs: 240_000,
      timeoutLabel: 'Scan',
      env: { CAREER_OPS_PORTALS: portalsPath }
    });
    if (!result.ok) return result;

    const discoveries = readScanHistoryFile(path.join(dataDir, 'scan-history.tsv'))
      .filter((row) => !knownUrls.has(row.url));
    const imported = sqliteStore.importScanDiscoveries(discoveries);
    return {
      ...result,
      output: [
        result.output,
        `SQLite import: ${imported.added} new pending, ${imported.recorded} total scan records.`
      ].filter(Boolean).join('\n'),
      imported,
      dashboard: await loadDashboard()
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function safeTableCell(value) {
  return String(value || '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
}

function safeTsvCell(value) {
  return String(value || '').replace(/[\t\r\n]/g, ' ');
}

function readScanHistoryFile(filePath) {
  const lines = readText(filePath).split(/\r?\n/).filter(Boolean);
  const headers = (lines.shift() || '').split('\t');
  return lines.map((line) => {
    const values = line.split('\t');
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
    return {
      url: row.url || '',
      firstSeen: row.first_seen || '',
      portal: row.portal || '',
      title: row.title || '',
      company: row.company || '',
      status: row.status || '',
      location: row.location || '',
      datePosted: row.date_posted || ''
    };
  }).filter((row) => row.url);
}

async function getJobDescription(row) {
  const storedPath = row.jobDescriptionPath || deriveMaterials(row).jobDescriptionPath;
  const resolvedStoredPath = storedPath && !path.isAbsolute(storedPath)
    ? path.join(careerRoot, storedPath)
    : storedPath;
  if (resolvedStoredPath && fs.existsSync(resolvedStoredPath)) {
    return readText(resolvedStoredPath).replace(/^#[^\n]*\n+(?:\*\*URL:\*\*[^\n]*\n+)?## Job Description\s*/i, '').trim();
  }
  if (row.reportSummary?.content) return row.reportSummary.content;
  const url = row.jobUrl || row.url;
  if (!url) return '';
  if (sqliteStore.available()) {
    const cached = sqliteStore.getCachedJobDescription(url);
    if (cached) return cached;
  }
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'career-ops-dashboard/0.1' },
      signal: AbortSignal.timeout(8000)
    });
    const html = await response.text();
    const stripped = stripHtml(html).slice(0, 30000);
    if (sqliteStore.available()) {
      sqliteStore.setCachedJobDescription(url, stripped);
    }
    return stripped;
  } catch (error) {
    return `Could not fetch job description from ${url}: ${error.message}`;
  }
}

function writeStoredJobDescription({ reportNum, job, content }) {
  const body = String(content || '').trim();
  if (!body) return '';
  const dir = path.join(careerRoot, 'jds');
  const fileName = `${String(reportNum).padStart(3, '0')}-${slug(job.company)}-${slug(job.role)}.md`;
  const filePath = path.join(dir, fileName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, [
    `# ${job.company || 'Unknown'} - ${job.role || 'Unknown'}`,
    '',
    `**URL:** ${job.url || ''}`,
    '',
    '## Job Description',
    '',
    body,
    ''
  ].join('\n'), 'utf8');
  return filePath;
}

async function quickAvailability(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'career-ops-dashboard/0.1' },
      signal: AbortSignal.timeout(12000)
    });
    const text = stripHtml(await response.text()).toLowerCase();
    const closedSignals = ['job is no longer available', 'position has been filled', 'no longer accepting applications', 'this job is closed', 'job not found'];
    const closed = response.status === 404 || closedSignals.some((signal) => text.includes(signal));
    return { available: !closed && response.ok, status: response.status, reason: closed ? 'Closed signal found' : response.ok ? 'Looks available' : `HTTP ${response.status}` };
  } catch (error) {
    return { available: false, status: 0, reason: error.message };
  }
}

async function createLivenessVerifier() {
  try {
    const rootRequire = createRequire(path.join(careerRoot, 'package.json'));
    const { chromium } = rootRequire('playwright');
    const liveness = await import(pathToFileURL(path.join(careerRoot, 'liveness-browser.mjs')).href);
    const browser = await chromium.launch({ headless: true });
    const page = await liveness.newLivenessPage(browser);
    const headed = liveness.createHeadedPageProvider(chromium);
    return {
      mode: 'playwright',
      async check(url) {
        const result = await liveness.checkUrlLivenessWithFallback(page, url, { getHeadedPage: () => headed.get() });
        return {
          available: result.result !== 'expired',
          status: result.result,
          reason: result.reason || result.code || result.result,
          code: result.code || ''
        };
      },
      async close() {
        await headed.close();
        await browser.close();
      }
    };
  } catch (error) {
    return {
      mode: 'fetch',
      async check(url) {
        const result = await quickAvailability(url);
        return { ...result, code: result.available ? 'quick_available' : 'quick_unavailable' };
      },
      async close() {}
    };
  }
}

async function verifyAvailability(url, verifier) {
  const activeVerifier = verifier || await createLivenessVerifier();
  try {
    const result = await activeVerifier.check(url);
    return {
      ...result,
      verifier: activeVerifier.mode,
      reason: result.reason || (result.available ? 'Looks available' : 'Posting unavailable')
    };
  } finally {
    if (!verifier) await activeVerifier.close();
  }
}

async function aiText(input, options = {}) {
  const { data } = await openAiResponse(input, options);
  return extractResponseText(data).trim();
}

async function testAi() {
  const settings = getAiAuth('cover-letter');
  const { data } = await openAiResponse('Reply with exactly: career-ops-api-ok', { modelPurpose: 'cover-letter' });
  return {
    ok: true,
    requestedModel: settings.model,
    internalModel: internalOpenAiModel,
    responseModel: data.model || '',
    id: data.id || '',
    output: extractResponseText(data).trim()
  };
}

async function openAiResponse(input, options = {}) {
  const settings = getAiAuth(options.modelPurpose);
  const body = {
    model: options.modelOverride || settings.model,
    input
  };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `OpenAI request failed with HTTP ${response.status}`);
  return { data, request: body };
}

async function aiJson(input, options = {}) {
  const text = await aiText(`${input}\n\nReturn only valid JSON. No markdown fences.`, options);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('The AI response was not valid JSON.');
  }
}

function getAiAuth(modelPurpose = 'internal') {
  const stored = readJson(aiSettingsPath()) || {};
  const apiKey = process.env.OPENAI_API_KEY || stored.apiKey;
  const model = modelPurpose === 'cover-letter'
    ? normalizeOpenAiModel(
      stored.coverLetterModel || stored.model || process.env.OPENAI_MODEL || defaultCoverLetterModel
    )
    : internalOpenAiModel;
  if (!apiKey) throw new Error('Add an OpenAI API key in Settings before generating AI evaluations or cover letters.');
  return { apiKey, model };
}

function normalizeOpenAiModel(value) {
  const model = String(value || '').trim();
  return model || defaultCoverLetterModel;
}

function extractResponseText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}

async function loadCoverLetterExamples() {
  const parts = [];
  for (const filePath of coverLetterExamplePaths) {
    if (!fs.existsSync(filePath)) continue;
    const text = await readPdfText(filePath);
    if (text) parts.push(`## ${path.basename(filePath)}\n${text.slice(0, 5000)}`);
  }

  const folders = [path.join(careerRoot, 'writing-samples', 'cover-letters'), path.join(careerRoot, 'writing-samples')];
  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    for (const name of fs.readdirSync(folder).filter((item) => /\.(md|txt)$/i.test(item)).slice(0, 4)) {
      const text = readText(path.join(folder, name));
      if (text) parts.push(`## ${name}\n${text.slice(0, 5000)}`);
    }
  }
  return parts.join('\n\n');
}

async function readPdfText(filePath) {
  try {
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    const result = await parser.getText();
    await parser.destroy?.();
    return cleanExtractedText(result.text || '');
  } catch (error) {
    return `Could not read ${path.basename(filePath)}: ${error.message}`;
  }
}

async function readDocxText(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return cleanExtractedText(result.value || '');
  } catch {
    return '';
  }
}

function coverLetterTextFromGenerated(row, generated) {
  const name = candidateName();
  const contact = candidateContactLine();
  const greeting = cleanGeneratedGreeting(generated.greeting, row.company);
  const paragraphs = (Array.isArray(generated.paragraphs) ? generated.paragraphs : [])
    .map(cleanGeneratedParagraph)
    .filter(Boolean)
    .slice(0, 5);
  const closing = cleanGeneratedClosing(generated.closing);
  return [
    name,
    contact,
    '',
    greeting,
    '',
    ...paragraphs.map((paragraph) => String(paragraph || '').trim()).filter(Boolean).flatMap((paragraph) => [paragraph, '']),
    closing
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function cleanGeneratedGreeting(value, company) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const dear = [...lines].reverse().find((line) => /^Dear\b/i.test(line));
  return dear || `Dear ${company} Hiring Team,`;
}

function cleanGeneratedParagraph(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isCoverLetterBoilerplate(line));
  return lines.join(' ').replace(/\s{2,}/g, ' ').trim();
}

function cleanGeneratedClosing(value) {
  const text = String(value || '').trim();
  if (/sincerely/i.test(text)) return `Sincerely,\n${candidateName()}`;
  return `Sincerely,\n${candidateName()}`;
}

function isCoverLetterBoilerplate(line) {
  const candidate = candidateProfile();
  return (candidate.full_name && line.toLowerCase() === String(candidate.full_name).toLowerCase())
    || (candidate.email && line.toLowerCase().includes(String(candidate.email).toLowerCase()))
    || (candidate.phone && line.includes(String(candidate.phone).replace(/^\+1-?/, '')))
    || (candidate.location && line.toLowerCase().includes(String(candidate.location).toLowerCase()))
    || /^Dear\b/i.test(line)
    || /^Sincerely,?$/i.test(line);
}

async function writeCoverLetterDocx(filePath, content) {
  const paragraphs = coverLetterParagraphs(content);
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 21 },
          paragraph: { spacing: { after: 105, line: 235 } }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 720, right: 900, bottom: 720, left: 900 }
        }
      },
      children: paragraphs
    }]
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
}

function coverLetterParagraphs(content) {
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  return lines.map((line, index) => {
    const trimmed = line.trim();
    const isHeader = index < 2;
    const isBlank = !trimmed;
    return new Paragraph({
      alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: isBlank ? { after: 60, line: 200 } : { after: isHeader ? 45 : 105, line: 235 },
      children: [
        new TextRun({
          text: trimmed,
          font: 'Times New Roman',
          size: isHeader ? (index === 0 ? 23 : 20) : 21,
          bold: index === 0
        })
      ]
    });
  });
}

function cleanExtractedText(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function displayPath(filePath) {
  const relative = path.relative(careerRoot, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.replaceAll(path.sep, '/');
  return filePath;
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function nextReportNumber() {
  let max = 0;
  const reportsDir = path.join(careerRoot, 'reports');
  if (fs.existsSync(reportsDir)) {
    for (const name of fs.readdirSync(reportsDir)) {
      const match = name.match(/^(\d{3})-/);
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  for (const row of parseApplications()) max = Math.max(max, row.number || 0);
  return max + 1;
}

function writeTrackerAddition({ reportNum, today, job, score, reportName, notes }) {
  const dir = path.join(careerRoot, 'batch', 'tracker-additions');
  fs.mkdirSync(dir, { recursive: true });
  const line = [
    reportNum,
    today,
    job.company,
    job.role,
    score >= 4 ? 'Evaluated' : score < 3 ? 'SKIP' : 'Evaluated',
    `${score.toFixed(1)}/5`,
    '\u274c',
    `[${reportNum}](reports/${reportName})`,
    notes || 'Generated from dashboard pending scan inbox.'
  ].join('\t');
  fs.writeFileSync(path.join(dir, `${String(reportNum).padStart(3, '0')}-${slug(job.company)}.tsv`), `${line}\n`, 'utf8');
}

function markPendingProcessed(url, note) {
  const pipelinePath = path.join(careerRoot, 'data', 'pipeline.md');
  const lines = readText(pipelinePath).split(/\r?\n/);
  const next = lines.map((line) => {
    if (!line.includes(url) || !/^\s*-\s\[\s\]/.test(line)) return line;
    return line.replace('- [ ]', '- [x]') + ` | ${note}`;
  });
  fs.writeFileSync(pipelinePath, next.join('\n'), 'utf8');
}

function normalizeGeneratedReport(markdown, context) {
  const body = String(markdown || '').trim();
  const required = [
    `# ${String(context.reportNum).padStart(3, '0')} - ${context.job.company} - ${context.job.role}`,
    `**Date:** ${context.today}`,
    `**Company:** ${context.job.company}`,
    `**Role:** ${context.job.role}`,
    `**Score:** ${context.score.toFixed(1)}/5`,
    `**URL:** ${context.job.url}`,
    '**PDF:** not generated',
    `**Legitimacy:** ${context.legitimacy || 'unconfirmed'}`
  ];
  const missingHeader = !body.includes('**URL:**') || !body.includes('**Legitimacy:**');
  return missingHeader ? `${required.join('\n')}\n\n${body}\n` : `${body}\n`;
}

function buildEvaluationPrompt({ reportNum, today, job, profile, resume, approvedKnowledge, jd }) {
  return [
    `You are the hiring manager for ${job.company}.`,
    'Evaluate this job for the candidate and produce a career-ops report.',
    'Return strict JSON with keys: score (number 0-5), recommendation (string), legitimacy (string), notes (one line), reportMarkdown (markdown string).',
    'The reportMarkdown must include these header lines exactly:',
    `# ${String(reportNum).padStart(3, '0')} - ${job.company} - ${job.role}`,
    `**Date:** ${today}`,
    `**Company:** ${job.company}`,
    `**Role:** ${job.role}`,
    `**Score:** X.X/5`,
    `**URL:** ${job.url}`,
    '**PDF:** not generated',
    '**Legitimacy:** active/unconfirmed/closed',
    '',
    'Then include sections in this order: TL;DR, Fit, Risks, Resume angles, First-round interview assessment, Offer likelihood, Missing / future positioning, Interview preparation, Application recommendation.',
    'In First-round interview assessment, answer whether you would give this applicant a first-round interview based on this resume and job description.',
    'In Offer likelihood, estimate the likelihood of giving them an offer and explain the main drivers.',
    'In Missing / future positioning, explain what else the applicant could do in the future to better position themselves and what they are currently missing.',
    'In Interview preparation, explain how the applicant should prepare for an interview for this role.',
    'Do not invent candidate experience. Use only the resume/profile and job description.',
    '',
    'Candidate profile YAML:',
    String(profile || '').slice(0, 10000),
    '',
    'Resume:',
    String(resume || '').slice(0, 16000),
    '',
    'Approved professional knowledge:',
    String(approvedKnowledge || '').slice(0, 6000),
    '',
    'Job description:',
    String(jd || '').slice(0, 22000)
  ].join('\n');
}

function clampScore(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(5, parsed));
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function pickRoot(rootPath) {
  if (!rootPath) return careerRoot;
  const resolved = path.resolve(String(rootPath));
  careerRoot = resolved;
  saveRememberedRoot(careerRoot);
  return careerRoot;
}

async function pickCoverLetterFolder(outputDir) {
  if (!outputDir) return loadCoverLetterSettings();
  return saveCoverLetterSettings({ outputDir: path.resolve(String(outputDir)) });
}

function setCareerRoot(rootPath) {
  if (!rootPath) return careerRoot;
  careerRoot = path.resolve(String(rootPath));
  saveRememberedRoot(careerRoot);
  return careerRoot;
}

function getCareerRoot() {
  return careerRoot;
}

function findCareerRoot() {
  if (process.env.CAREER_OPS_ROOT) {
    const explicitRoot = path.resolve(process.env.CAREER_OPS_ROOT);
    if (fs.existsSync(path.join(explicitRoot, 'scan.mjs')) && fs.existsSync(path.join(explicitRoot, 'portals.yml'))) {
      return explicitRoot;
    }
  }
  const candidates = [
    loadRememberedRoot(),
    path.resolve(__dirname, '..', '..', '..', 'classic'),
    process.cwd(),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..')
  ].filter(Boolean);

  const uniqueCandidates = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  const completeRoot = uniqueCandidates.find((candidate) => {
    const required = [
      'scan.mjs',
      'cv.md',
      'portals.yml',
      path.join('config', 'profile.yml'),
      path.join('data', 'applications.md')
    ];
    return required.every((item) => fs.existsSync(path.join(candidate, item)));
  });
  if (completeRoot) return completeRoot;

  for (const candidate of uniqueCandidates) {
    if (fs.existsSync(path.join(candidate, 'scan.mjs')) && fs.existsSync(path.join(candidate, 'portals.yml'))) {
      return path.resolve(candidate);
    }
  }
  return process.cwd();
}

function rememberedRootPath() {
  try {
    return path.join(app.getPath('userData'), 'career-root.txt');
  } catch {
    return '';
  }
}

function loadRememberedRoot() {
  const filePath = rememberedRootPath();
  if (!filePath || !fs.existsSync(filePath)) return '';
  return readText(filePath).trim();
}

function saveRememberedRoot(root) {
  const filePath = rememberedRootPath();
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, root, 'utf8');
}

function rootDiagnostics() {
  if (sqliteStore.available()) {
    const runtime = scannerRuntime();
    return {
      ...sqliteStore.diagnostics(),
      node: findNodeExecutable(),
      scannerAvailable: runtime.available,
      scannerRuntime: runtime.root,
      scannerReason: runtime.reason
    };
  }
  const checks = ['scan.mjs', 'portals.yml', 'cv.md', path.join('data', 'applications.md')];
  return {
    valid: checks.every((item) => fs.existsSync(path.join(careerRoot, item))),
    checks: Object.fromEntries(checks.map((item) => [item, fs.existsSync(path.join(careerRoot, item))])),
    node: findNodeExecutable()
  };
}

function scannerRuntime() {
  const scriptPath = path.join(careerRoot, 'scan.mjs');
  if (!fs.existsSync(scriptPath)) {
    return {
      available: false,
      root: careerRoot,
      scriptPath,
      reason: `Scanner runtime not found. Set CAREER_OPS_ROOT to the classic Career Ops folder containing scan.mjs. Current runtime: ${careerRoot}`
    };
  }
  return { available: true, root: careerRoot, scriptPath, reason: '' };
}

function findNodeExecutable() {
  if (process.versions?.electron && process.execPath) return process.execPath;
  const candidates = [
    process.env.CAREER_OPS_NODE,
    'node.exe',
    'node',
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'node' || candidate === 'node.exe') {
      const resolved = resolveOnPath(candidate);
      if (resolved) return resolved;
      continue;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function resolveOnPath(command) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, command);
    if (fs.existsSync(full)) return full;
  }
  return '';
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase().replaceAll('*', '').trim();
  if (s.includes('skip') || s.includes('no aplicar')) return 'skip';
  if (s.includes('interview')) return 'interview';
  if (s.includes('offer')) return 'offer';
  if (s.includes('responded')) return 'responded';
  if (s.includes('applied')) return 'applied';
  if (s.includes('rejected')) return 'rejected';
  if (s.includes('discarded')) return 'discarded';
  if (s.includes('evaluated')) return 'evaluated';
  return s || 'unknown';
}

function mapCareerOpsStatusToCRM(status) {
  const normalized = String(status || '').toLowerCase().trim();
  if (normalized.includes('online assessment') || normalized === 'oa') return 'online_assessment';
  if (normalized.includes('applied') || normalized.includes('responded')) return 'applied';
  if (normalized.includes('interview')) return 'interview';
  if (normalized.includes('offer')) return 'offer';
  if (normalized.includes('rejected') || normalized.includes('discarded') || normalized.includes('skip') || normalized.includes('archived')) return 'rejected_archived';
  return 'need_to_apply';
}

function crmStatusToCareerOps(status) {
  const value = String(status || '').trim();
  const map = {
    need_to_apply: 'Evaluated',
    applied: 'Applied',
    online_assessment: 'Online Assessment',
    interview: 'Interview',
    offer: 'Offer',
    rejected_archived: 'Discarded'
  };
  return map[value] || (states.includes(value) ? value : 'Evaluated');
}

function crmStatusLabel(status) {
  return {
    need_to_apply: 'Need to Apply',
    applied: 'Applied',
    online_assessment: 'Online Assessment',
    interview: 'Interview',
    offer: 'Offer'
  }[status] || status;
}

function nextActionForApplication(row) {
  const crm = mapCareerOpsStatusToCRM(row.status);
  if (crm === 'need_to_apply' && row.score >= 4) return 'Apply soon';
  if (crm === 'need_to_apply') return 'Review fit';
  if (crm === 'applied') return 'Track response';
  if (crm === 'online_assessment') return 'Complete assessment';
  if (crm === 'interview') return 'Prepare interview';
  if (crm === 'offer') return 'Evaluate offer';
  return 'Archived';
}

function coverLetterPdfHtml(row, text) {
  const paragraphs = cleanExtractedText(text).split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const name = candidateName();
  const contact = candidateContactLine();
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: "Times New Roman", serif; font-size: 11pt; line-height: 1.18; color: #111; margin: 0; }
    .header { text-align: center; margin-bottom: 14px; }
    .name { font-weight: 700; font-size: 12pt; }
    p { margin: 0 0 9px; }
  </style></head><body>
    <div class="header"><div class="name">${escapeHtmlServer(name)}</div><div>${escapeHtmlServer(contact)}</div></div>
    ${paragraphs.filter((p, i) => i > 1).map((p) => `<p>${escapeHtmlServer(p)}</p>`).join('')}
  </body></html>`;
}

function escapeHtmlServer(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function normalizeCompany(company) {
  return String(company || '').toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|technologies|technology|group|co)\.?$/i, '').trim();
}

function pick(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/\|$/, '').trim();
  }
  return '';
}

function pct(part, whole) {
  return whole ? (part / whole) * 100 : 0;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function currentResume() {
  if (sqliteStore.available()) return sqliteStore.loadSnapshot().resume;
  const primary = listResumes().find((resume) => resume.isPrimary);
  if (primary) return getResume(primary.id).content;
  return readText(path.join(careerRoot, 'cv.md'));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function aiSettingsPath() {
  return path.join(app.getPath('userData'), 'openai-settings.json');
}

function coverLetterSettingsPath() {
  return path.join(app.getPath('userData'), 'cover-letter-settings.json');
}

function resumeSettingsPath() {
  return path.join(app.getPath('userData'), 'resume-settings.json');
}

function resumeLibraryPath() {
  return path.join(app.getPath('userData'), 'resume-library.json');
}

function extensionSettingsPath() {
  return path.join(app.getPath('userData'), 'extension-settings.json');
}

function setupSettingsPath() {
  return path.join(app.getPath('userData'), 'guided-setup-settings.json');
}

function daysSince(dateText) {
  const first = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(first.getTime())) return null;
  return Math.floor((Date.now() - first.getTime()) / 86400000);
}

function portalFromUrl(url) {
  if (/greenhouse/i.test(url)) return 'greenhouse';
  if (/ashby/i.test(url)) return 'ashby';
  if (/lever\.co/i.test(url)) return 'lever';
  if (/workable\.com/i.test(url)) return 'workable';
  if (/recruitee\.com/i.test(url)) return 'recruitee';
  if (/smartrecruiters\.com/i.test(url)) return 'smartrecruiters';
  if (/myworkdayjobs\.com|workday\.com/i.test(url)) return 'workday';
  if (/icims\.com/i.test(url)) return 'icims';
  if (/jobvite\.com/i.test(url)) return 'jobvite';
  if (/breezy\.hr/i.test(url)) return 'breezy';
  if (/bamboohr\.com/i.test(url)) return 'bamboohr';
  return 'web';
}

function slug(value) {
  return String(value || 'draft')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'draft';
}


module.exports = {
  loadDashboard,
  addPendingJobLink,
  importDiscoverySource,
  refreshDiscovery,
  deleteDiscoverySource,
  updateDiscoverySource,
  addDashboardJobLink,
  updateStatus,
  updateApplicationNotes,
  generateApplicationReport,
  runScript,
  runScan,
  saveSettings,
  saveResume,
  uploadResumeFromPath,
  uploadKnowledgeDocumentFromPath,
  listResumes,
  getResume,
  loadResumeBuilder,
  getResumeBuilderVariant,
  getResumeBuilderPreview,
  createMasterResume,
  createTailoredResume,
  analyzeResumeForJob,
  generateAiTailoredResume,
  saveResumeBuilderVariant,
  decideResumeBuilderSuggestion,
  deleteResumeBuilderVariant,
  exportResumeBuilderVariant,
  analyzeResumeFit,
  parseResumeEditableBlocks,
  setPrimaryResume,
  renameResume,
  deleteResume,
  saveAiSettings,
  saveSetupSettings,
  buildCloudMatchingProfile,
  testSetup,
  extensionContext,
  extensionAutofillContext,
  extensionDocument,
  loadExtensionSettings,
  saveExtensionSettings,
  logExternalApplication,
  testAi,
  pickCoverLetterFolder,
  generateCoverLetter,
  saveCoverLetter,
  exportCoverLetterPdf,
  generateAutofillPrompt,
  evaluatePending,
  runBulkQueue,
  discardPending,
  checkPendingAvailability,
  pickRoot,
  setCareerRoot,
  getCareerRoot,
  rootDiagnostics,
  isInsidePath,
  parseScoreField,
  parseDiscoverySource,
  parsePostedDate,
  rankDiscoveryJobs,
  daysAgoFromDate,
  normalizeExtensionSettings,
  validateExternalApplication,
  deriveJobIdentity,
  extractPageTitle,
  loadKnowledgeCenter,
  saveKnowledgeFact,
  updateKnowledgeFact,
  updateKnowledgeRecord,
  setKnowledgeFactStatus,
  removeKnowledgeFact,
  clearKnowledgeCenter,
  rebuildKnowledgeCenter,
  chatKnowledge,
  trustedKnowledgeContext,
  buildKnowledgeRecords,
  extractKnowledgeHeuristically,
  patchResumeDocumentXml
};
