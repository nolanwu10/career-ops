const highFitThreshold = 4.0;

function computeAdvancedAnalytics(apps, options = {}) {
  const scanHistory = options.scanHistory || [];
  const pendingJobs = options.pendingJobs || [];
  const now = options.now || new Date();
  const appSources = sourceIndex(scanHistory);
  const enrichedApps = apps.map((row) => ({
    ...row,
    sourcePortal: sourceForApp(row, appSources)?.portal || portalFromUrl(row.jobUrl),
    sourceCompany: sourceForApp(row, appSources)?.company || row.company
  }));

  return {
    sourceQuality: {
      byPortal: sourceQuality(enrichedApps, scanHistory, pendingJobs, 'portal'),
      byCompany: sourceQuality(enrichedApps, scanHistory, pendingJobs, 'company')
    },
    responseByScore: responseByScoreBucket(enrichedApps),
    staleHighFit: staleHighFitJobs(enrichedApps, now),
    rejectionReasons: rejectionReasons(enrichedApps),
    recommendations: recommendations(enrichedApps, scanHistory, pendingJobs, now)
  };
}

function sourceQuality(apps, scanHistory, pendingJobs, field) {
  const groups = new Map();
  const keyOf = (item) => normalizeKey(item[field] || (field === 'portal' ? portalFromUrl(item.url || item.jobUrl) : item.company));

  for (const item of scanHistory) {
    const key = keyOf(item);
    if (!key) continue;
    const group = ensureSourceGroup(groups, key, field, item);
    group.seen += 1;
    const status = String(item.status || '').toLowerCase();
    if (status.includes('added')) group.added += 1;
    else if (status.includes('expired')) group.expired += 1;
    else if (status.includes('duplicate')) group.duplicates += 1;
    else if (status.includes('skip') || status.includes('filter')) group.skipped += 1;
  }

  for (const item of pendingJobs) {
    const key = keyOf(item);
    if (!key) continue;
    ensureSourceGroup(groups, key, field, item).pending += 1;
  }

  for (const app of apps) {
    const source = {
      portal: app.sourcePortal || portalFromUrl(app.jobUrl),
      company: app.sourceCompany || app.company
    };
    const key = normalizeKey(source[field]);
    if (!key) continue;
    const group = ensureSourceGroup(groups, key, field, source);
    group.evaluated += 1;
    if (app.score > 0) {
      group.scoreTotal += app.score;
      group.scored += 1;
      if (app.score >= highFitThreshold) group.highFit += 1;
    }
    const stage = stageForStatus(app.status);
    if (stage.applied) group.applied += 1;
    if (stage.responded) group.responded += 1;
    if (stage.positive) group.positive += 1;
    if (isArchivedStatus(app.status)) group.archived += 1;
  }

  return [...groups.values()]
    .map((group) => {
      const avgScore = group.scored ? group.scoreTotal / group.scored : 0;
      const responseRate = pct(group.responded, group.applied);
      const highFitRate = pct(group.highFit, group.evaluated);
      return {
        ...group,
        avgScore,
        responseRate,
        highFitRate,
        qualityScore: (avgScore * 20) + (responseRate * 0.35) + (highFitRate * 0.2) + Math.min(group.evaluated, 8)
      };
    })
    .filter((group) => group.seen || group.evaluated || group.pending)
    .sort((a, b) => b.qualityScore - a.qualityScore || b.evaluated - a.evaluated || a.label.localeCompare(b.label))
    .slice(0, field === 'company' ? 8 : 6);
}

function responseByScoreBucket(apps) {
  const buckets = [
    { label: '4.5-5.0', min: 4.5, max: 5.01, evaluated: 0, applied: 0, responded: 0, positive: 0 },
    { label: '4.0-4.4', min: 4.0, max: 4.5, evaluated: 0, applied: 0, responded: 0, positive: 0 },
    { label: '3.5-3.9', min: 3.5, max: 4.0, evaluated: 0, applied: 0, responded: 0, positive: 0 },
    { label: '3.0-3.4', min: 3.0, max: 3.5, evaluated: 0, applied: 0, responded: 0, positive: 0 },
    { label: '<3.0', min: 0.00001, max: 3.0, evaluated: 0, applied: 0, responded: 0, positive: 0 }
  ];

  for (const app of apps) {
    const bucket = buckets.find((item) => app.score >= item.min && app.score < item.max);
    if (!bucket) continue;
    bucket.evaluated += 1;
    const stage = stageForStatus(app.status);
    if (stage.applied) bucket.applied += 1;
    if (stage.responded) bucket.responded += 1;
    if (stage.positive) bucket.positive += 1;
  }

  return buckets.map((bucket) => ({
    label: bucket.label,
    evaluated: bucket.evaluated,
    applied: bucket.applied,
    responded: bucket.responded,
    positive: bucket.positive,
    responseRate: pct(bucket.responded, bucket.applied),
    conversionRate: pct(bucket.positive, bucket.applied)
  }));
}

function staleHighFitJobs(apps, now) {
  return apps
    .map((row) => ({ ...row, ageDays: ageDays(row.lastContact || row.date, now) }))
    .filter((row) => row.score >= highFitThreshold && mapCareerOpsStatusToCRM(row.status) === 'need_to_apply' && row.ageDays != null && row.ageDays >= 14)
    .sort((a, b) => (b.score - a.score) || (b.ageDays - a.ageDays))
    .slice(0, 8);
}

function rejectionReasons(apps) {
  const groups = new Map();
  for (const app of apps) {
    if (!isArchivedStatus(app.status)) continue;
    const reason = classifyRejection(app);
    const group = groups.get(reason.key) || { key: reason.key, label: reason.label, count: 0, examples: [] };
    group.count += 1;
    if (group.examples.length < 3) {
      group.examples.push({
        company: app.company,
        role: app.role,
        score: app.score,
        note: firstSentence(app.notes)
      });
    }
    groups.set(reason.key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function recommendations(apps, scanHistory, pendingJobs, now) {
  const recs = [];
  const stale = staleHighFitJobs(apps, now);
  const needApply = apps
    .filter((row) => row.score >= highFitThreshold && mapCareerOpsStatusToCRM(row.status) === 'need_to_apply')
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  if (needApply.length) {
    recs.push({
      title: 'Apply to the strongest evaluated matches',
      reason: `${needApply.length} high-fit evaluated role${needApply.length === 1 ? '' : 's'} are still waiting.`,
      items: needApply.map((row) => jobItem(row, stale.some((item) => item.number === row.number) ? 'Stale high fit' : 'Ready to apply'))
    });
  }

  const portals = sourceQuality(apps, scanHistory, pendingJobs, 'portal').filter((row) => row.evaluated >= 1);
  const bestPortal = portals[0];
  if (bestPortal) {
    recs.push({
      title: `Scan ${bestPortal.label} next`,
      reason: `${bestPortal.evaluated} evaluated, ${bestPortal.avgScore.toFixed(1)} avg score, ${bestPortal.highFitRate.toFixed(0)}% high-fit yield.`,
      items: pendingJobs
        .filter((job) => normalizeKey(job.portal || portalFromUrl(job.url)) === bestPortal.key)
        .slice(0, 3)
        .map((job) => ({ company: job.company, role: job.role, meta: `${job.ageDays ?? '?'}d old` }))
    });
  }

  const companyMomentum = sourceQuality(apps, scanHistory, pendingJobs, 'company')
    .filter((row) => row.highFit > 0 || row.responseRate > 0)
    .slice(0, 3);
  if (companyMomentum.length) {
    recs.push({
      title: 'Prioritize companies with proven fit',
      reason: 'These companies already produced high scores or downstream movement.',
      items: companyMomentum.map((row) => ({
        company: row.label,
        role: `${row.highFit} high-fit / ${row.evaluated} evaluated`,
        meta: `${row.responseRate.toFixed(0)}% response`
      }))
    });
  }

  const freshPending = pendingJobs
    .filter((job) => !job.alreadyTracked)
    .sort((a, b) => (a.ageDays ?? 9999) - (b.ageDays ?? 9999))
    .slice(0, 4);
  if (freshPending.length) {
    recs.push({
      title: 'Evaluate fresh scan inbox jobs',
      reason: 'Recent unevaluated postings are less likely to be closed.',
      items: freshPending.map((job) => ({ company: job.company, role: job.role, meta: `${job.portal || portalFromUrl(job.url)} · ${job.ageDays ?? '?'}d` }))
    });
  }

  return recs.slice(0, 4);
}

function sourceIndex(scanHistory) {
  const byUrl = new Map();
  const byCompany = new Map();
  for (const item of scanHistory) {
    if (item.url) byUrl.set(item.url, item);
    const key = normalizeKey(item.company);
    if (!key) continue;
    byCompany.set(key, [...(byCompany.get(key) || []), item]);
  }
  return { byUrl, byCompany };
}

function sourceForApp(app, index) {
  if (app.jobUrl && index.byUrl.has(app.jobUrl)) return index.byUrl.get(app.jobUrl);
  const matches = index.byCompany.get(normalizeKey(app.company)) || [];
  if (!matches.length) return null;
  const role = normalizeText(app.role);
  return [...matches].sort((a, b) => wordOverlap(role, normalizeText(b.title)) - wordOverlap(role, normalizeText(a.title)))[0];
}

function ensureSourceGroup(groups, key, field, item) {
  if (!groups.has(key)) {
    groups.set(key, {
      key,
      label: labelForSource(field, item),
      seen: 0,
      added: 0,
      expired: 0,
      duplicates: 0,
      skipped: 0,
      pending: 0,
      evaluated: 0,
      scored: 0,
      scoreTotal: 0,
      highFit: 0,
      applied: 0,
      responded: 0,
      positive: 0,
      archived: 0
    });
  }
  return groups.get(key);
}

function labelForSource(field, item) {
  if (field === 'portal') return item.portal || portalFromUrl(item.url || item.jobUrl) || 'Unknown';
  return item.company || item.sourceCompany || 'Unknown';
}

function classifyRejection(app) {
  const text = normalizeText(`${app.status} ${app.notes} ${app.role}`);
  const checks = [
    ['closed', 'Closed or filled', /\b(closed|filled|expired|no longer|posting appears filled|deadline)\b/],
    ['eligibility', 'Eligibility mismatch', /\b(grad|graduation|undergrad|student|internship eligibility|visa|sponsorship|authorization|citizen)\b/],
    ['location', 'Location mismatch', /\b(on-?site|in-office|hybrid|relocat|location|commute|singapore|toronto|austin|nyc|sf|bay area)\b/],
    ['skills', 'Skills or experience gap', /\b(gap|required|research pubs|pytorch|java|sql depth|senior|full-time|too senior|experience)\b/],
    ['compensation', 'Compensation mismatch', /\b(comp|salary|pay|rate|below|low comp|hour)\b/],
    ['duplicate', 'Duplicate or already applied', /\b(already applied|duplicate|dup|repost)\b/],
    ['low-fit', 'Low fit score', /\b(low fit|weak fit|score|no apply|skip|stretch)\b/]
  ];
  for (const [key, label, pattern] of checks) {
    if (pattern.test(text)) return { key, label };
  }
  if (app.score > 0 && app.score < 3) return { key: 'low-fit', label: 'Low fit score' };
  return { key: 'other', label: 'Other / manual archive' };
}

function stageForStatus(status) {
  const normalized = normalizeStatus(status);
  return {
    applied: ['applied', 'responded', 'interview', 'offer', 'rejected'].includes(normalized),
    responded: ['responded', 'interview', 'offer'].includes(normalized),
    positive: ['responded', 'interview', 'offer'].includes(normalized)
  };
}

function isArchivedStatus(status) {
  return ['rejected', 'discarded', 'skip'].includes(normalizeStatus(status)) || mapCareerOpsStatusToCRM(status) === 'rejected_archived';
}

function mapCareerOpsStatusToCRM(status) {
  const normalized = normalizeStatus(status);
  if (normalized === 'online assessment' || normalized === 'oa') return 'online_assessment';
  if (normalized === 'applied' || normalized === 'responded') return 'applied';
  if (normalized === 'interview') return 'interview';
  if (normalized === 'offer') return 'offer';
  if (['rejected', 'discarded', 'skip'].includes(normalized) || normalized.includes('archived')) return 'rejected_archived';
  return 'need_to_apply';
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase().replaceAll('*', '').trim();
  if (s.includes('online assessment') || s === 'oa') return 'online assessment';
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

function portalFromUrl(url) {
  if (/greenhouse/i.test(url || '')) return 'greenhouse';
  if (/ashby/i.test(url || '')) return 'ashby';
  if (/lever/i.test(url || '')) return 'lever';
  if (/workable/i.test(url || '')) return 'workable';
  if (/smartrecruiters/i.test(url || '')) return 'smartrecruiters';
  return url ? 'web' : 'unknown';
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|technologies|technology|group|co)\.?$/i, '')
    .trim();
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function wordOverlap(left, right) {
  const words = new Set(left.split(/\s+/).filter((word) => word.length > 2));
  return right.split(/\s+/).filter((word) => words.has(word)).length;
}

function pct(part, whole) {
  return whole ? (part / whole) * 100 : 0;
}

function ageDays(dateText, now) {
  const first = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(first.getTime())) return null;
  const today = new Date(now);
  return Math.floor((today.getTime() - first.getTime()) / 86400000);
}

function firstSentence(text) {
  return String(text || '').split(/[.!?]\s/)[0].slice(0, 140);
}

function jobItem(row, meta) {
  return {
    number: row.number,
    company: row.company,
    role: row.role,
    score: row.score,
    meta
  };
}

module.exports = {
  computeAdvancedAnalytics,
  responseByScoreBucket,
  staleHighFitJobs,
  rejectionReasons,
  sourceQuality,
  classifyRejection,
  normalizeStatus,
  mapCareerOpsStatusToCRM,
  portalFromUrl
};
