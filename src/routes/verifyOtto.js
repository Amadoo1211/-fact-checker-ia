const express = require('express');
const aiAgentsService = require('../services/aiAgents');
const { buildOttoSearchQueries, computeOttoGlobalResult } = require('../services/verificationService');
const {
  PLAN_LIMITS,
  DEFAULT_PLAN,
  buildQuotaPayload,
  ensureDailyReset,
  incrementUsageCounters,
  getPlanFromUser,
  normalizeUsageValue,
} = require('../services/quotaService');
const { extractMainKeywords, sanitizeInput } = require('../utils/textSanitizer');
const { getOttoBarColor, getRiskLevel } = require('../utils/scoring');
const { findWebSources, extractTrustedSourceContent, mapSourcesForOutput } = require('../services/googleSearch');
const { getUserByEmail, getUserById } = require('../services/userService');

const router = express.Router();

router.post('/verify-otto', async (req, res) => {
  try {
    const { text, userEmail, userId } = req.body || {};

    if (!text || text.trim() === '' || (!userEmail && !userId)) {
      return res.status(400).json({ success: false, error: 'missing_parameters' });
    }

    let user = userId ? await getUserById(userId) : await getUserByEmail(userEmail);
    if (!user) {
      return res.status(404).json({ success: false, error: 'user_not_found' });
    }

    user = await ensureDailyReset(user);
    const plan = getPlanFromUser(user);
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN];
    const usedOtto = normalizeUsageValue(user.daily_otto_analysis);
    const ottoLimit = limits.dailyOtto;

    if (Number.isFinite(ottoLimit) && usedOtto >= ottoLimit) {
      const quota = buildQuotaPayload(user);
      return res.status(429).json({
        success: false,
        error: 'limit_reached',
        message: 'Daily Otto analysis limit reached',
        quota,
      });
    }

    const sanitizedText = sanitizeInput(text);
    const keywords = extractMainKeywords(sanitizedText);
    const queries = buildOttoSearchQueries(sanitizedText, keywords);

    const contextualSourcesRaw = await findWebSources(keywords, queries, sanitizedText);
    const enrichedSources = await extractTrustedSourceContent(contextualSourcesRaw);
    const agents = await aiAgentsService.runAllAgents(sanitizedText, enrichedSources);
    const ottoResult = computeOttoGlobalResult(agents, text);

    const globalReliability = ottoResult.global_reliability;
    const risk = getRiskLevel(globalReliability);
    const barColor = getOttoBarColor(globalReliability);
    const summary = ottoResult.summary || 'Analyse Otto indisponible pour le moment. Réessayez plus tard.';

    const contextualSources = mapSourcesForOutput(enrichedSources.length > 0 ? enrichedSources : contextualSourcesRaw).slice(0, 5);

    const updatedUser = await incrementUsageCounters(user.id, { otto: 1 });
    const quotaUser = updatedUser || { ...user, daily_otto_analysis: usedOtto + 1 };
    const quota = buildQuotaPayload(quotaUser);

    const usageSnapshot = {
      daily_checks_used: quota.usage.verificationsUsed,
      daily_otto_analysis: quota.usage.ottoUsed,
    };

    return res.json({
      ...ottoResult,
      globalReliability,
      summary,
      risk,
      barColor,
      plan: quota.plan,
      quota,
      userEmail: user.email,
      keywords,
      queries,
      contextualSources,
      agents,
      keyPoints: ottoResult.key_points,
      usage: usageSnapshot,
      dailyChecksUsed: usageSnapshot.daily_checks_used,
      dailyOttoAnalysis: usageSnapshot.daily_otto_analysis,
    });
  } catch (error) {
    console.error('Erreur Otto :', error);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

module.exports = router;
