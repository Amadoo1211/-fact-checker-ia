const pdfParse = require('pdf-parse');
const cheerio = require('cheerio');

const TRUSTED_DOMAINS = [
  'oecd.org',
  'imf.org',
  'worldbank.org',
  'who.int',
  'un.org',
  'ilo.org',
  'weforum.org',
  'banquemondiale.org',
  'data.gov',
  'europa.eu',
  'gouvernement.fr',
];

const MAX_SOURCE_CHARACTERS = 15000;

const parseUrlSafely = (value) => {
  try {
    return new URL(value);
  } catch (error) {
    return null;
  }
};

const isTrustedDomain = (value) => {
  const parsed = parseUrlSafely(value);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();
  return TRUSTED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
};

const cleanExtractedText = (text = '') => text.replace(/\s+/g, ' ').trim();

async function fetchTrustedContent(targetUrl) {
  const parsedUrl = parseUrlSafely(targetUrl);
  if (!parsedUrl) {
    const error = new Error('invalid url');
    error.code = 'INVALID_URL';
    throw error;
  }

  if (!isTrustedDomain(targetUrl)) {
    const error = new Error('untrusted domain');
    error.code = 'UNTRUSTED_DOMAIN';
    throw error;
  }

  const response = await fetch(targetUrl);
  if (!response.ok) {
    const error = new Error(`failed to fetch: ${response.status}`);
    error.code = 'FETCH_FAILED';
    throw error;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();
  let textContent = '';

  if (pathname.endsWith('.pdf')) {
    const buffer = Buffer.from(await response.arrayBuffer());
    const parsedPdf = await pdfParse(buffer);
    textContent = parsedPdf.text || '';
  } else {
    const html = await response.text();
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe').remove();
    textContent = $('body').text();
  }

  const cleanedContent = cleanExtractedText(textContent).substring(0, MAX_SOURCE_CHARACTERS);

  return {
    domain: hostname,
    content: cleanedContent,
  };
}

const ensureHttpUrl = (value) => {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalize = (url) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      return parsed.toString();
    } catch (error) {
      return null;
    }
  };

  const direct = normalize(trimmed);
  if (direct) return direct;

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
  return normalize(`https://${withoutProtocol}`);
};

const sanitizeSourceTitle = (value) => {
  if (!value || typeof value !== 'string') return 'Source';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'Source';
};

const sanitizeSourceSnippet = (value) => {
  if (!value || typeof value !== 'string') return '';
  return value.trim();
};

const resolveDomainFromUrl = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.startsWith('http') ? value : `https://${value}`);
    return parsed.hostname.toLowerCase();
  } catch (error) {
    return null;
  }
};

const normalizeScoreValue = (raw) => {
  if (raw === undefined || raw === null) return null;
  let numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  if (Math.abs(numeric) <= 1) {
    numeric *= 100;
  }
  numeric = Math.max(0, Math.min(100, Math.round(numeric)));
  return numeric;
};

const normalizeSourceScore = (source) => {
  const candidates = [
    source?.score,
    source?.relevance,
    source?.semanticRelevance,
    source?.confidence,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeScoreValue(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }

  return null;
};

const normalizeSourceForOutput = (source) => {
  if (!source) return null;
  const url = ensureHttpUrl(source.url);
  if (!url) return null;

  const title = sanitizeSourceTitle(source.title);
  const snippet = sanitizeSourceSnippet(source.snippet);
  const domain = resolveDomainFromUrl(url);
  const score = normalizeSourceScore(source);

  return {
    title,
    url,
    snippet,
    domain,
    score,
  };
};

const mapSourcesForOutput = (sources = []) => sources.map(normalizeSourceForOutput).filter(Boolean);

async function findWebSources(keywords, smartQueries, originalText) {
  const API_KEY = process.env.GOOGLE_API_KEY;
  const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

  if (!API_KEY || !SEARCH_ENGINE_ID) {
    return [];
  }

  const uniqueQueries = [...new Set([...smartQueries, ...keywords])].filter(Boolean).slice(0, 5);
  const results = [];

  for (const query of uniqueQueries) {
    const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=5`;
    const response = await fetch(url);
    if (!response.ok) {
      continue;
    }

    const data = await response.json();
    const items = data.items || [];

    for (const item of items) {
      if (!item.link) continue;
      results.push({
        title: item.title,
        url: item.link,
        snippet: item.snippet || '',
        displayLink: item.displayLink,
      });
    }

    if (results.length >= 8) {
      break;
    }
  }

  return results.slice(0, 8);
}

async function extractTrustedSourceContentFromList(sources = []) {
  const enriched = [];

  for (const source of sources) {
    const normalizedUrl = ensureHttpUrl(source.url);
    if (!normalizedUrl) {
      continue;
    }

    try {
      const trustedContent = await fetchTrustedContent(normalizedUrl);
      enriched.push({
        ...source,
        url: normalizedUrl,
        domain: trustedContent.domain,
        content: trustedContent.content,
      });
    } catch (error) {
      if (error.code === 'UNTRUSTED_DOMAIN' || error.code === 'INVALID_URL') {
        continue;
      }
      enriched.push({
        ...source,
        url: normalizedUrl,
        domain: parseUrlSafely(normalizedUrl)?.hostname || source.domain,
        content: '',
        error: error.message,
      });
    }
  }

  return enriched;
}

module.exports = {
  findWebSources,
  extractTrustedSourceContent: extractTrustedSourceContentFromList,
  mapSourcesForOutput,
};
