const { sanitizeInput, extractMainKeywords } = require('../utils/textSanitizer');
const { getRiskLevel } = require('../utils/scoring');
const { findWebSources, mapSourcesForOutput } = require('./googleSearch');
const aiAgentsService = require('./aiAgents');

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function segmentLongText(text, maxChunkSize = 7000) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const normalizedMax = Math.max(1000, maxChunkSize);
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return [];
  }

  const segments = [];
  let currentSegment = '';

  const pushCurrent = () => {
    if (currentSegment.trim().length > 0) {
      segments.push(currentSegment.trim());
    }
    currentSegment = '';
  };

  for (const paragraph of paragraphs) {
    if ((currentSegment + '\n\n' + paragraph).trim().length <= normalizedMax) {
      currentSegment = currentSegment ? `${currentSegment}\n\n${paragraph}` : paragraph;
      continue;
    }

    pushCurrent();

    if (paragraph.length > normalizedMax) {
      let start = 0;
      while (start < paragraph.length) {
        const chunk = paragraph.slice(start, start + normalizedMax);
        segments.push(chunk.trim());
        start += normalizedMax;
      }
      currentSegment = '';
    } else {
      currentSegment = paragraph;
    }
  }

  pushCurrent();

  return segments;
}

function extractKeyTerms(agentResults = {}) {
  const terms = new Set();

  const claims = agentResults?.fact_checker?.verified_claims || [];
  claims.forEach((claim) => {
    if (claim && typeof claim.claim === 'string') {
      const normalized = claim.claim.trim();
      if (normalized) {
        terms.add(normalized);
      }
    }
  });

  const realSources = agentResults?.source_analyst?.real_sources || [];
  realSources.forEach((source) => {
    const label = source?.title || source?.name || source?.citation;
    if (label && typeof label === 'string') {
      const normalized = label.trim();
      if (normalized) {
        terms.add(normalized);
      }
    }
  });

  if (terms.size === 0) {
    const summaries = [
      agentResults?.fact_checker?.summary,
      agentResults?.source_analyst?.summary,
      agentResults?.context_guardian?.summary,
      agentResults?.freshness_detector?.summary,
    ]
      .filter((entry) => typeof entry === 'string')
      .join(' ');

    summaries
      .split(/[,;\n\.]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 3)
      .slice(0, 5)
      .forEach((part) => terms.add(part));
  }

  return Array.from(terms).slice(0, 8);
}

function aggregateAgentRuns(segmentAnalyses = []) {
  if (!Array.isArray(segmentAnalyses) || segmentAnalyses.length === 0) {
    return {
      fact_checker: {},
      source_analyst: {},
      context_guardian: {},
      freshness_detector: {},
      segments: [],
    };
  }

  const aggregates = {
    fact_checker: {
      weightedScore: 0,
      weight: 0,
      summaries: [],
      verified_claims: [],
      unverified_claims: [],
    },
    source_analyst: {
      weightedScore: 0,
      weight: 0,
      summaries: [],
      real_sources: [],
      fake_sources: [],
    },
    context_guardian: {
      weightedScore: 0,
      weight: 0,
      summaries: [],
      omissions: [],
      manipulation_detected: [],
    },
    freshness_detector: {
      weightedScore: 0,
      weight: 0,
      summaries: [],
      recent_data: [],
      outdated_data: [],
    },
  };

  segmentAnalyses.forEach((segment, index) => {
    const { agents } = segment;
    if (!agents) return;

    const segmentLength = Math.max(1, segment.text?.length || 0);
    segment.segment_length = segmentLength;

    const annotate = (items) => items.map((item) => ({ ...item, segment_index: index }));

    if (agents.fact_checker) {
      const score = Number(agents.fact_checker.score);
      if (Number.isFinite(score)) {
        aggregates.fact_checker.weightedScore += score * segmentLength;
        aggregates.fact_checker.weight += segmentLength;
      }
      aggregates.fact_checker.summaries.push(agents.fact_checker.summary);
      aggregates.fact_checker.verified_claims.push(
        ...annotate(agents.fact_checker.verified_claims || []),
      );
      aggregates.fact_checker.unverified_claims.push(
        ...annotate(agents.fact_checker.unverified_claims || []),
      );
    }

    if (agents.source_analyst) {
      const score = Number(agents.source_analyst.score);
      if (Number.isFinite(score)) {
        aggregates.source_analyst.weightedScore += score * segmentLength;
        aggregates.source_analyst.weight += segmentLength;
      }
      aggregates.source_analyst.summaries.push(agents.source_analyst.summary);
      aggregates.source_analyst.real_sources.push(
        ...annotate(agents.source_analyst.real_sources || []),
      );
      aggregates.source_analyst.fake_sources.push(
        ...annotate(agents.source_analyst.fake_sources || []),
      );
    }

    if (agents.context_guardian) {
      const score = Number(agents.context_guardian.context_score);
      if (Number.isFinite(score)) {
        aggregates.context_guardian.weightedScore += score * segmentLength;
        aggregates.context_guardian.weight += segmentLength;
      }
      aggregates.context_guardian.summaries.push(agents.context_guardian.summary);
      aggregates.context_guardian.omissions.push(
        ...annotate(agents.context_guardian.omissions || []),
      );
      if (agents.context_guardian.manipulation_detected !== undefined) {
        aggregates.context_guardian.manipulation_detected.push({
          segment_index: index,
          value: Boolean(agents.context_guardian.manipulation_detected),
        });
      }
    }

    if (agents.freshness_detector) {
      const score = Number(agents.freshness_detector.freshness_score);
      if (Number.isFinite(score)) {
        aggregates.freshness_detector.weightedScore += score * segmentLength;
        aggregates.freshness_detector.weight += segmentLength;
      }
      aggregates.freshness_detector.summaries.push(agents.freshness_detector.summary);
      aggregates.freshness_detector.recent_data.push(
        ...annotate(agents.freshness_detector.recent_data || []),
      );
      aggregates.freshness_detector.outdated_data.push(
        ...annotate(agents.freshness_detector.outdated_data || []),
      );
    }
  });

  const segmentCount = segmentAnalyses.length;

  const buildSummary = (entries = []) => entries.filter(Boolean).join(' | ');

  const computeAverage = (bucket) => {
    if (!bucket) return 50;
    if (bucket.weight > 0) {
      return Math.round(bucket.weightedScore / bucket.weight);
    }
    return 50;
  };

  return {
    fact_checker: {
      score: computeAverage(aggregates.fact_checker),
      verified_claims: aggregates.fact_checker.verified_claims,
      unverified_claims: aggregates.fact_checker.unverified_claims,
      summary: buildSummary(aggregates.fact_checker.summaries),
    },
    source_analyst: {
      score: computeAverage(aggregates.source_analyst),
      real_sources: aggregates.source_analyst.real_sources,
      fake_sources: aggregates.source_analyst.fake_sources,
      summary: buildSummary(aggregates.source_analyst.summaries),
    },
    context_guardian: {
      context_score: computeAverage(aggregates.context_guardian),
      omissions: aggregates.context_guardian.omissions,
      manipulation_detected: aggregates.context_guardian.manipulation_detected,
      summary: buildSummary(aggregates.context_guardian.summaries),
    },
    freshness_detector: {
      freshness_score: computeAverage(aggregates.freshness_detector),
      recent_data: aggregates.freshness_detector.recent_data,
      outdated_data: aggregates.freshness_detector.outdated_data,
      summary: buildSummary(aggregates.freshness_detector.summaries),
    },
    segments: segmentAnalyses,
  };
}

async function buildMetaSummary(segmentAnalyses, aggregatedAgents, userLang = 'fr') {
  if (!Array.isArray(segmentAnalyses) || segmentAnalyses.length === 0) {
    return '';
  }

  if (!aiAgentsService || typeof aiAgentsService.callOpenAI !== 'function') {
    return '';
  }

  const languageLabel = userLang === 'en' ? 'English' : 'French';
  const prefix = userLang === 'en' ? 'Otto Summary:' : 'Synthèse Otto :';

  const segmentDescriptions = segmentAnalyses
    .map((segment) => {
      const excerpt = segment.text.replace(/\s+/g, ' ').slice(0, 350);
      const fc = segment.agents?.fact_checker;
      const sa = segment.agents?.source_analyst;
      const cg = segment.agents?.context_guardian;
      const fd = segment.agents?.freshness_detector;
      return [
        `Segment ${segment.index + 1}:`,
        `Excerpt: "${excerpt}"`,
        `Fact-checker score ${fc?.score ?? 'n/a'} – ${fc?.summary || 'No summary'}`,
        `Source analyst score ${sa?.score ?? 'n/a'} – ${sa?.summary || 'No summary'}`,
        `Context guardian score ${cg?.context_score ?? 'n/a'} – ${cg?.summary || 'No summary'}`,
        `Freshness detector score ${fd?.freshness_score ?? 'n/a'} – ${fd?.summary || 'No summary'}`,
      ].join('\n');
    })
    .join('\n\n');

  const globalOverview = `Global averages – Fact-checker: ${aggregatedAgents.fact_checker?.score ?? 'n/a'}, `
    + `Source analyst: ${aggregatedAgents.source_analyst?.score ?? 'n/a'}, `
    + `Context guardian: ${aggregatedAgents.context_guardian?.context_score ?? 'n/a'}, `
    + `Freshness detector: ${aggregatedAgents.freshness_detector?.freshness_score ?? 'n/a'}.`;

  const systemPrompt = userLang === 'en'
    ? `You are Otto, an advanced reliability analyst. Produce a concise synthesis in ${languageLabel}. `
      + `Always start with "${prefix}" and keep the answer under 250 words.`
    : `Tu es Otto, un analyste de fiabilité. Rédige une synthèse finale en ${languageLabel}. `
      + `Commence toujours par "${prefix}" et reste sous 250 mots.`;

  const userPrompt = [
    `We analysed a long document split into ${segmentAnalyses.length} segments.`,
    globalOverview,
    'Detailed segment insights:',
    segmentDescriptions,
    'Merge these findings into a coherent global synthesis highlighting convergence, contradictions, and level of reliability.',
  ].join('\n\n');

  try {
    const response = await aiAgentsService.callOpenAI(systemPrompt, userPrompt, 1200);
    return response ? response.trim() : '';
  } catch (error) {
    console.error('Meta-analysis error:', error);
    return '';
  }
}


function extractVerifiableClaims(text) {
  const cleaned = sanitizeInput(text);
  const claims = [];

  const numberClaims = cleaned.match(/\b\d+([,\.]\d+)?\s*(millions?|milliards?|billions?|%|pour\s*cent|km|habitants?|années?|ans)\b/gi) || [];
  claims.push(...numberClaims.slice(0, 5).map((claim) => ({ type: 'QUANTITATIVE', text: claim.trim(), verifiable: true })));

  const dateClaims = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
  claims.push(...dateClaims.slice(0, 3).map((claim) => ({ type: 'DATE', text: claim.trim(), verifiable: true })));

  return claims;
}

function buildAutoSearchQueries(originalText, claims, keywords) {
  const queries = [];

  for (const claim of (claims || []).slice(0, 4)) {
    if (claim?.text) {
      const normalized = claim.text.replace(/\s+/g, ' ').trim();
      if (normalized.length > 10) {
        queries.push(normalized.slice(0, 120));
      }
    }
  }

  if (keywords && keywords.length > 0) {
    const primaryKeywords = keywords.slice(0, 4).join(' ');
    if (primaryKeywords.length > 3) {
      queries.push(primaryKeywords);
    }
  }

  if (originalText && originalText.length > 0) {
    const excerpt = originalText.replace(/\s+/g, ' ').slice(0, 140);
    if (excerpt.length > 20) {
      queries.push(excerpt);
    }
  }

  return Array.from(new Set(queries)).filter(Boolean).slice(0, 5);
}

function buildOttoSearchQueries(originalText, keywords = []) {
  const queries = [];

  if (keywords.length > 0) {
    queries.push(keywords.slice(0, 5).join(' '));
  }

  if (originalText && originalText.length > 0) {
    const excerpt = originalText.replace(/\s+/g, ' ').slice(0, 160);
    if (excerpt.length > 20) {
      queries.push(excerpt);
    }
  }

  return Array.from(new Set(queries.filter(Boolean))).slice(0, 5);
}

function computeAutoScore(claims, sources) {
  const base = 35;
  const claimBonus = Math.min(30, claims.length * 8);
  const sourceBonus = Math.min(35, sources.length * 7);
  return Math.min(95, Math.round(base + claimBonus + sourceBonus));
}

function buildAutoSummary(score, claims, sources) {
  const risk = getRiskLevel(score);
  const claimPart = claims.length > 0
    ? `${claims.length} affirmation${claims.length > 1 ? 's' : ''} vérifiables détectée${claims.length > 1 ? 's' : ''}.`
    : 'Aucune affirmation chiffrée claire détectée.';
  const sourcePart = sources.length > 0
    ? `${sources.length} source${sources.length > 1 ? 's' : ''} pertinente${sources.length > 1 ? 's' : ''} retrouvée${sources.length > 1 ? 's' : ''}.`
    : 'Sources officielles introuvables ou limitées.';
  return `${claimPart} ${sourcePart} Niveau de risque estimé: ${risk}.`;
}

async function runAutoVerification(text) {
  const sanitizedText = sanitizeInput(text);
  const claims = extractVerifiableClaims(sanitizedText);
  const keywords = extractMainKeywords(sanitizedText);
  const queries = buildAutoSearchQueries(sanitizedText, claims, keywords);

  const webSources = await findWebSources(keywords, queries, sanitizedText);
  const formattedSources = mapSourcesForOutput(webSources);

  const score = computeAutoScore(claims, formattedSources);
  const summary = buildAutoSummary(score, claims, formattedSources);

  return {
    score,
    summary,
    reasoning: summary,
    claims,
    keywords,
    queries,
    sources: formattedSources,
    analyzedSources: webSources,
  };
}

async function runOttoLongAnalysis(text, sources = [], userLang = 'fr') {
  const segments = segmentLongText(text);

  if (segments.length === 0) {
    const agentResults = await aiAgentsService.runAllAgents(text, sources);
    return { agentResults };
  }

  const segmentAnalyses = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segmentText = segments[index];
    const agents = await aiAgentsService.runAllAgents(segmentText, sources);
    segmentAnalyses.push({ index, text: segmentText, agents });
  }

  const aggregatedAgents = aggregateAgentRuns(segmentAnalyses);
  const metaSummary = await buildMetaSummary(segmentAnalyses, aggregatedAgents, userLang);
  const fallbackSummary = segmentAnalyses
    .map((segment) => {
      const summaries = [
        segment.agents?.fact_checker?.summary,
        segment.agents?.source_analyst?.summary,
        segment.agents?.context_guardian?.summary,
        segment.agents?.freshness_detector?.summary,
      ].filter(Boolean);
      if (summaries.length === 0) {
        return '';
      }
      return `Segment ${segment.index + 1}: ${summaries.join(' ')}`;
    })
    .filter(Boolean)
    .join(' ');

  aggregatedAgents.meta_summary = (metaSummary && metaSummary.trim()) || fallbackSummary;

  return { agentResults: aggregatedAgents };
}

async function runAllAgents(text, sources = []) {
  return aiAgentsService.runAllAgents(text, sources);
}

function generateHumanSummary(lang, reliability, keyFindings) {
  const list = keyFindings?.length ? keyFindings.join(', ') : '';

  if (lang === 'fr') {
    return `L'étude obtient une fiabilité globale de ${reliability}/100. ${
      reliability > 85
        ? 'Les résultats sont solides et bien étayés par des sources crédibles.'
        : reliability > 65
        ? "L'étude semble globalement fiable, mais certaines affirmations manquent de précisions méthodologiques."
        : 'Les conclusions doivent être vérifiées, certaines données manquent de sources fiables.'
    } ${list ? 'Points clés : ' + list + '.' : ''}`;
  }

  return `The study achieves a global reliability score of ${reliability}/100. ${
    reliability > 85
      ? 'The findings are well-supported by credible sources and solid data.'
      : reliability > 65
      ? 'The research appears mostly reliable, though some claims lack methodological details.'
      : 'The conclusions need verification as some evidence appears weak or missing.'
  } ${list ? 'Key findings: ' + list + '.' : ''}`;
}

function computeOttoMetaResult(agentResults = {}, lang = 'fr') {
  const normalizedLang = lang === 'en' ? 'en' : 'fr';

  const factScore = clamp(agentResults?.fact_checker?.score ?? 50, 0, 100);
  const sourceScore = clamp(agentResults?.source_analyst?.score ?? 50, 0, 100);
  const contextScore = clamp(agentResults?.context_guardian?.context_score ?? 50, 0, 100);
  const freshnessScore = clamp(agentResults?.freshness_detector?.freshness_score ?? 50, 0, 100);

  const reliability = Math.round(
    factScore * 0.4
      + sourceScore * 0.3
      + (100 - contextScore) * 0.2
      + freshnessScore * 0.1,
  );

  const summary = normalizedLang === 'fr'
    ? `Le texte obtient une fiabilité globale de ${reliability}/100 selon les critères d'exactitude, de fiabilité des sources, de contexte et de fraîcheur des données.`
    : `The text achieves a global reliability score of ${reliability}/100 based on accuracy, source credibility, context, and data freshness.`;

  const keyPoints = extractKeyTerms(agentResults);

  const agentPayload = {
    fact_checker: agentResults?.fact_checker || {},
    source_analyst: agentResults?.source_analyst || {},
    context_guardian: agentResults?.context_guardian || {},
    freshness_detector: agentResults?.freshness_detector || {},
  };

  if (agentResults?.meta_summary) {
    agentPayload.meta_summary = agentResults.meta_summary;
  }
  if (Array.isArray(agentResults?.segments)) {
    agentPayload.segments = agentResults.segments;
  }

  return {
    reliability,
    summary,
    keyPoints,
    agentResults: agentPayload,
  };
}

function computeOttoGlobalResult(agentsResult, text, options = {}) {
  const { userLang = 'fr', metaSummary } = options || {};
  const prefix = userLang === 'en' ? 'Otto Summary:' : 'Synthèse Otto :';

  const fact = clamp((agentsResult?.fact_checker?.score ?? 50), 0, 100);
  const source = clamp((agentsResult?.source_analyst?.score ?? 50), 0, 100);
  const contextScore = clamp((agentsResult?.context_guardian?.context_score ?? 50), 0, 100);
  const fresh = clamp((agentsResult?.freshness_detector?.freshness_score ?? 50), 0, 100);

  const contextReliability = clamp(100 - contextScore, 0, 100);

  const globalReliability = Math.round(
    fact * 0.4 + source * 0.3 + contextReliability * 0.2 + fresh * 0.1,
  );

  let summary = (metaSummary || agentsResult?.meta_summary || '').trim();
  if (!summary) {
    const agentSummaries = [
      agentsResult?.fact_checker?.summary,
      agentsResult?.source_analyst?.summary,
      agentsResult?.context_guardian?.summary,
      agentsResult?.freshness_detector?.summary,
    ].filter(Boolean);

    if (agentSummaries.length > 0) {
      summary = `${prefix} ${agentSummaries.join(' | ')}`;
    } else {
      summary = `${prefix} ${userLang === 'en'
        ? 'Analysis unavailable. Please try again later.'
        : 'Analyse indisponible. Réessayez plus tard.'}`;
    }
  } else if (!summary.toLowerCase().startsWith(prefix.toLowerCase())) {
    summary = `${prefix} ${summary}`;
  }

  const claimKeyPoints = (agentsResult?.fact_checker?.verified_claims || [])
    .map((claim) => claim?.claim)
    .filter(Boolean);

  const fallbackKeyPoints = Array.from(
    new Set((text?.match(/\b[A-Z][a-z]{3,}\b/g) || []).slice(0, 8)),
  );

  const keyPoints = Array.from(new Set([...claimKeyPoints, ...fallbackKeyPoints])).slice(0, 8);

  return {
    status: 'ok',
    mode: 'OTTO',
    global_reliability: globalReliability,
    summary,
    key_points: keyPoints,
    agents: agentsResult,
    breakdown: {
      fact_checker: { weight: 0.4, score: fact },
      source_analyst: { weight: 0.3, score: source },
      context_guardian: { weight: 0.2, score: contextReliability, raw_score: contextScore },
      freshness_detector: { weight: 0.1, score: fresh },
    },
  };
}

module.exports = {
  runAutoVerification,
  buildOttoSearchQueries,
  computeOttoGlobalResult,
  segmentLongText,
  runOttoLongAnalysis,
  runAllAgents,
  computeOttoMetaResult,
  extractKeyTerms,
  generateHumanSummary,
};
