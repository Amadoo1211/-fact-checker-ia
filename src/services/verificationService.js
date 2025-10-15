const { sanitizeInput, extractMainKeywords } = require('../utils/textSanitizer');
const { getRiskLevel } = require('../utils/scoring');
const { findWebSources, mapSourcesForOutput } = require('./googleSearch');

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

function computeOttoGlobalResult(agentsResult, text) {
  const { fact_checker, source_analyst, context_guardian, freshness_detector } = agentsResult || {};

  const fact = fact_checker?.score || 50;
  const source = source_analyst?.score || 50;
  const context = 100 - (context_guardian?.context_score || 50);
  const fresh = freshness_detector?.freshness_score || 50;

  const globalReliability = Math.round(
    fact * 0.4 + source * 0.3 + context * 0.2 + fresh * 0.1,
  );

  const summary = [
    fact_checker?.summary,
    source_analyst?.summary,
    context_guardian?.summary,
    freshness_detector?.summary,
  ]
    .filter(Boolean)
    .join(' | ');

  const keyPoints = Array.from(
    new Set(
      (text?.match(/\b[A-Z][a-z]{3,}\b/g) || []).slice(0, 8),
    ),
  );

  return {
    status: 'ok',
    mode: 'OTTO',
    global_reliability: globalReliability,
    summary: summary || 'Synthèse indisponible',
    key_points: keyPoints,
    agents: agentsResult,
  };
}

module.exports = {
  runAutoVerification,
  buildOttoSearchQueries,
  computeOttoGlobalResult,
};
