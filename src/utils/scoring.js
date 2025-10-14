function selectTopAutoSources(analyzedSources = []) {
  const sorted = [...analyzedSources].sort((a, b) => {
    const supportWeightA = (a.actuallySupports ? 1 : 0) - (a.contradicts ? 1 : 0);
    const supportWeightB = (b.actuallySupports ? 1 : 0) - (b.contradicts ? 1 : 0);

    if (supportWeightB !== supportWeightA) {
      return supportWeightB - supportWeightA;
    }

    return (b.semanticRelevance || 0) - (a.semanticRelevance || 0);
  });

  return sorted.slice(0, 5);
}

function summarizeAutoAssessment(balancedScore, claims = [], analyzedSources = []) {
  const claimCount = claims.length;
  const supporting = analyzedSources.filter((source) => source.actuallySupports).length;
  const contradicting = analyzedSources.filter((source) => source.contradicts).length;

  const parts = [];

  if (claimCount > 0) {
    parts.push(`${claimCount} affirmation${claimCount > 1 ? 's' : ''} vérifiables identifiée${claimCount > 1 ? 's' : ''}.`);
  } else {
    parts.push('Aucune affirmation chiffrée claire détectée.');
  }

  if (supporting > 0) {
    parts.push(`${supporting} source${supporting > 1 ? 's' : ''} concordante${supporting > 1 ? 's' : ''} trouvée${supporting > 1 ? 's' : ''}.`);
  }

  if (contradicting > 0) {
    parts.push(`${contradicting} source${contradicting > 1 ? 's' : ''} présente${contradicting > 1 ? 's' : ''} des contradictions.`);
  }

  if (balancedScore?.reasoning) {
    parts.push(balancedScore.reasoning.trim());
  }

  return parts.join(' ');
}

function buildOttoSummary(agentsResult = {}) {
  const segments = [];

  if (agentsResult.fact_checker?.summary) {
    segments.push(`Fact-checker: ${agentsResult.fact_checker.summary}`);
  }

  if (agentsResult.source_analyst?.summary) {
    segments.push(`Sources: ${agentsResult.source_analyst.summary}`);
  }

  if (agentsResult.context_guardian?.summary) {
    segments.push(`Contexte: ${agentsResult.context_guardian.summary}`);
  }

  if (agentsResult.freshness_detector?.summary) {
    segments.push(`Actualité: ${agentsResult.freshness_detector.summary}`);
  }

  return segments.join(' ');
}

function computeOttoGlobalReliability(agentsResult = {}) {
  const weights = {
    fact_checker: 0.45,
    source_analyst: 0.3,
    context_guardian: 0.15,
    freshness_detector: 0.1,
  };

  let totalWeight = 0;
  let weightedScore = 0;

  const addScore = (value, weight) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      weightedScore += value * weight;
      totalWeight += weight;
    }
  };

  addScore(agentsResult.fact_checker?.score, weights.fact_checker);
  addScore(
    agentsResult.source_analyst?.score ?? agentsResult.source_analyst?.source_score,
    weights.source_analyst,
  );
  addScore(agentsResult.context_guardian?.context_score, weights.context_guardian);
  addScore(agentsResult.freshness_detector?.freshness_score, weights.freshness_detector);

  if (totalWeight === 0) {
    return 50;
  }

  return Math.round(weightedScore / totalWeight);
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const getOttoBarColor = (trustIndex) => {
  if (trustIndex >= 75) {
    return '#22c55e';
  }
  if (trustIndex >= 50) {
    return '#f97316';
  }
  return '#ef4444';
};

const getRiskLevel = (trustIndex) => {
  if (trustIndex >= 75) return 'Faible';
  if (trustIndex >= 50) return 'Moyen';
  return 'Élevé';
};

module.exports = {
  selectTopAutoSources,
  summarizeAutoAssessment,
  buildOttoSummary,
  computeOttoGlobalReliability,
  clamp,
  getOttoBarColor,
  getRiskLevel,
};
