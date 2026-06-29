export interface DiscoverySourceContent {
  type: 'csv' | 'markdown' | 'html';
  label: string;
  sourceUrl: string;
  content: string;
}

export interface ImportedDiscoveryJob {
  url: string;
  company: string;
  role: string;
  datePosted: string;
  location: string;
  portal?: string;
  sourceLabel?: string;
  importedAt?: string;
}

export interface StoredDiscoverySource {
  url: string;
  label: string;
  sourceType: 'csv' | 'markdown' | 'html';
  lastRefreshedAt?: string;
  lastError?: string;
}

type FetchLike = typeof fetch;

export async function fetchDiscoverySource(
  sourceUrl: string,
  fetchImpl: FetchLike = fetch
): Promise<DiscoverySourceContent> {
  const normalizedUrl = normalizeHttpUrl(sourceUrl, true);
  const parsed = new URL(normalizedUrl);
  const headers: Record<string, string> = {
    'User-Agent': 'Career-Ops/0.1 (+https://github.com/santif/career-ops)',
    Accept: 'text/html,text/plain,application/json'
  };
  let fetchUrl = normalizedUrl;
  let type: DiscoverySourceContent['type'] = 'html';
  let label = parsed.hostname;

  if (parsed.hostname === 'github.com') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      fetchUrl = `https://api.github.com/repos/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}/readme`;
      headers.Accept = 'application/vnd.github.raw+json';
      type = 'markdown';
      label = `${parts[0]}/${parts[1]}`;
    }
  } else if (parsed.hostname === 'docs.google.com' && parsed.pathname.includes('/spreadsheets/d/')) {
    const sheetId = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/)?.[1];
    const gid = parsed.searchParams.get('gid') || normalizedUrl.match(/[?#&]gid=(\d+)/)?.[1] || '0';
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

  const response = await fetchImpl(fetchUrl, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(`Could not read the source (${response.status} ${response.statusText}). Make sure it is public.`);
  }
  const content = await response.text();
  if (!content.trim()) throw new Error('The source was empty.');
  return { type, label, sourceUrl: normalizedUrl, content };
}

export function parseDiscoverySource(source: DiscoverySourceContent): ImportedDiscoveryJob[] {
  if (source.type === 'csv') return parseDelimitedJobList(source.content, source.sourceUrl);
  if (source.type === 'markdown') return parseMarkdownJobList(source.content, source.sourceUrl);
  return parseHtmlJobList(source.content, source.sourceUrl);
}

export function deduplicateSourceJobs(jobs: ImportedDiscoveryJob[]): ImportedDiscoveryJob[] {
  const unique = new Map<string, ImportedDiscoveryJob>();
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

export function sanitizeDiscoveryJobs(input: unknown): ImportedDiscoveryJob[] {
  if (!Array.isArray(input)) return [];
  const jobs: ImportedDiscoveryJob[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    try {
      const url = normalizeHttpUrl(record.url, true);
      jobs.push({
        url,
        company: cleanText(record.company, 'Unknown company'),
        role: cleanText(record.role, 'Job posting'),
        datePosted: cleanDate(record.datePosted),
        location: cleanText(record.location, ''),
        portal: cleanText(record.portal, portalFromUrl(url)),
        sourceLabel: cleanText(record.sourceLabel, ''),
        importedAt: cleanIso(record.importedAt)
      });
    } catch {
      continue;
    }
  }
  return deduplicateSourceJobs(jobs).slice(0, 1000);
}

export function sanitizeDiscoverySources(input: unknown): StoredDiscoverySource[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const sources: StoredDiscoverySource[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    try {
      const url = normalizeHttpUrl(record.url, true);
      const key = comparableUrl(url);
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        url,
        label: cleanText(record.label, url),
        sourceType: normalizeSourceType(record.sourceType),
        lastRefreshedAt: cleanIso(record.lastRefreshedAt),
        lastError: cleanText(record.lastError, '')
      });
    } catch {
      continue;
    }
  }
  return sources.slice(0, 100);
}

export function mergeImportedJobs(
  existingJobs: ImportedDiscoveryJob[],
  importedJobs: ImportedDiscoveryJob[],
  knownUrls: Iterable<string>
): { jobs: ImportedDiscoveryJob[]; added: number } {
  const known = new Set<string>([...knownUrls].map((value) => comparableUrl(value)));
  const jobs = sanitizeDiscoveryJobs(existingJobs);
  for (const job of jobs) known.add(comparableUrl(job.url));

  let added = 0;
  for (const job of importedJobs) {
    const key = comparableUrl(job.url);
    if (known.has(key)) continue;
    known.add(key);
    jobs.push(job);
    added += 1;
  }

  return { jobs: deduplicateSourceJobs(jobs).slice(0, 1000), added };
}

export function upsertDiscoverySource(
  existingSources: StoredDiscoverySource[],
  source: StoredDiscoverySource
): StoredDiscoverySource[] {
  const normalized = sanitizeDiscoverySources(existingSources);
  const key = comparableUrl(source.url);
  const next = normalized.filter((item) => comparableUrl(item.url) !== key);
  next.unshift(source);
  return sanitizeDiscoverySources(next);
}

export function comparableUrl(value: string): string {
  return normalizeHttpUrl(value, true).replace(/\/$/, '').toLowerCase();
}

export function normalizeHttpUrl(value: unknown, keepQuery = true): string {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL must use HTTP or HTTPS');
  }
  parsed.hash = '';
  if (!keepQuery) parsed.search = '';
  return parsed.toString();
}

export function portalFromUrl(value: string): string {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('ashbyhq')) return 'ashby';
    if (host.includes('greenhouse')) return 'greenhouse';
    if (host.includes('lever')) return 'lever';
    if (host.includes('workable')) return 'workable';
    if (host.includes('smartrecruiters')) return 'smartrecruiters';
    if (host.includes('recruitee')) return 'recruitee';
    if (host.includes('workday')) return 'workday';
    return 'web';
  } catch {
    return 'web';
  }
}

function parseDelimitedJobList(content: string, sourceUrl: string): ImportedDiscoveryJob[] {
  const rows = parseCsvRows(content);
  if (rows.length < 2) return [];
  const headers = rows.shift()!.map(normalizeHeader);
  return rows.map((cells) => jobFromCells(headers, cells, sourceUrl)).filter(isJob);
}

function parseMarkdownJobList(content: string, sourceUrl: string): ImportedDiscoveryJob[] {
  const jobs: ImportedDiscoveryJob[] = [];
  let headers: string[] = [];
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

function parseHtmlJobList(content: string, sourceUrl: string): ImportedDiscoveryJob[] {
  const jobs: ImportedDiscoveryJob[] = [];
  const tableMatches = content.match(/<table\b[\s\S]*?<\/table>/gi) || [];
  for (const table of tableMatches) {
    const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < 2) continue;
    let headers: string[] = [];
    let previousCompany = '';
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) => match[1] || '');
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
    const text = cleanCellText(match[2] || '');
    const url = resolveSourceUrl(match[1] || '', sourceUrl);
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

function jobFromCells(
  headers: string[],
  cells: string[],
  sourceUrl: string,
  previousCompany = ''
): ImportedDiscoveryJob | null {
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

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
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

function splitMarkdownRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function looksLikeJobHeader(cells: string[]): boolean {
  const headers = cells.map((cell) => normalizeHeader(cleanCellText(cell)));
  return findHeaderIndex(headers, ['company', 'employer']) >= 0
    && (findHeaderIndex(headers, ['role', 'job title', 'position', 'title']) >= 0
      || findHeaderIndex(headers, ['apply', 'posting', 'link']) >= 0);
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  return headers.findIndex((header) => candidates.some((candidate) => (
    header === candidate || header.includes(candidate)
  )));
}

function findHeaderIndexes(headers: string[], candidates: string[]): number[] {
  const indexes: number[] = [];
  for (const candidate of candidates) {
    headers.forEach((header, index) => {
      if ((header === candidate || header.includes(candidate)) && !indexes.includes(index)) indexes.push(index);
    });
  }
  return indexes;
}

function normalizeHeader(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanCellText(value: string): string {
  return decodeHtmlEntities(String(value || '')
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim());
}

function extractCellLinks(value: string, sourceUrl: string): string[] {
  const links: string[] = [];
  for (const match of String(value || '').matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/gi)) {
    links.push(resolveSourceUrl(match[1] || '', sourceUrl));
  }
  for (const match of String(value || '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    links.push(resolveSourceUrl(match[1] || '', sourceUrl));
  }
  const plain = decodeHtmlEntities(String(value || '').trim());
  if (/^https?:\/\//i.test(plain)) links.push(resolveSourceUrl(plain, sourceUrl));
  return [...new Set(links.filter(Boolean))];
}

function resolveSourceUrl(value: string, sourceUrl: string): string {
  try {
    return normalizeHttpUrl(new URL(decodeHtmlEntities(value), sourceUrl).toString(), true);
  } catch {
    return '';
  }
}

function isLikelyJobUrl(value: string, label = ''): boolean {
  if (!value) return false;
  let parsed: URL;
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

function companyFromJobUrl(value: string): string {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '').split('.')[0] || '';
    return titleCase(host.replace(/[-_]+/g, ' ')) || 'Unknown company';
  } catch {
    return 'Unknown company';
  }
}

function parsePostedDate(value: string, now = new Date()): string {
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
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]!.padStart(2, '0')}-${isoMatch[3]!.padStart(2, '0')}`;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /\d{4}/.test(text)) return parsed.toISOString().slice(0, 10);
  const monthDay = new Date(`${text}, ${now.getUTCFullYear()} 00:00:00 UTC`);
  if (Number.isNaN(monthDay.getTime())) return '';
  if (monthDay.getTime() > now.getTime() + 7 * 86400000) monthDay.setUTCFullYear(monthDay.getUTCFullYear() - 1);
  return monthDay.toISOString().slice(0, 10);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: '\'', lt: '<', gt: '>', nbsp: ' ' };
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
      const code = Number.parseInt(entity.replace(/^#x?/i, ''), radix);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function titleCase(value: string): string {
  return String(value || '').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cleanText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function cleanDate(value: unknown): string {
  return typeof value === 'string' ? parsePostedDate(value) : '';
}

function cleanIso(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return undefined;
  return Number.isNaN(new Date(text).getTime()) ? undefined : text;
}

function normalizeSourceType(value: unknown): StoredDiscoverySource['sourceType'] {
  return value === 'csv' || value === 'markdown' || value === 'html' ? value : 'html';
}

function isJob(value: ImportedDiscoveryJob | null): value is ImportedDiscoveryJob {
  return Boolean(value);
}
