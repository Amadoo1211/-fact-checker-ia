const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const aiAgentsService = require('../services/aiAgents');
const { buildOttoSearchQueries, computeOttoGlobalResult, runOttoLongAnalysis } = require('../services/verificationService');
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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.post('/verify-otto', upload.single('file'), async (req, res) => {
  try {
    const { userEmail, userId } = req.body || {};
    let inputText = typeof req.body?.text === 'string' ? req.body.text : '';

    if (!userEmail && !userId) {
      return res.status(400).json({ success: false, error: 'missing_parameters' });
    }

    if (req.file) {
      try {
        const pdfData = await pdfParse(req.file.buffer);
        const pdfText = (pdfData?.text || '').trim();
        if (pdfText) {
          inputText = inputText ? `${inputText}\n\n${pdfText}` : pdfText;
        }
      } catch (pdfError) {
        console.error('Erreur extraction PDF Otto :', pdfError);
        if (!inputText || inputText.trim() === '') {
          return res.status(400).json({ success: false, error: 'invalid_pdf' });
        }
      }
    }

    if (!inputText || inputText.trim() === '') {
      return res.status(400).json({ success: false, error: 'missing_text' });
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

    const requestedLang = (req.body?.userLang || user?.preferred_language || user?.language || user?.lang || 'fr')
      .toString()
      .toLowerCase();
    const userLang = requestedLang === 'en' ? 'en' : 'fr';

    const sanitizedText = sanitizeInput(inputText);
    if (!sanitizedText || sanitizedText.trim() === '') {
      return res.status(400).json({ success: false, error: 'invalid_text' });
    }
    const keywords = extractMainKeywords(sanitizedText);
    const queries = buildOttoSearchQueries(sanitizedText, keywords);

    const contextualSourcesRaw = await findWebSources(keywords, queries, sanitizedText);
    const enrichedSources = await extractTrustedSourceContent(contextualSourcesRaw);

    const isLongText = sanitizedText.length > 8000;
    let agents;
    let ottoResult;

    if (isLongText) {
      const longAnalysis = await runOttoLongAnalysis(sanitizedText, enrichedSources, userLang);
      ottoResult = longAnalysis.ottoResult;
      agents = longAnalysis.agents || ottoResult.agents;
    } else {
      agents = await aiAgentsService.runAllAgents(sanitizedText, enrichedSources);
      ottoResult = computeOttoGlobalResult(agents, sanitizedText, { userLang });
    }

    const resolvedAgents = ottoResult.agents || agents;

    const globalReliability = ottoResult.global_reliability;
    const risk = getRiskLevel(globalReliability);
    const barColor = getOttoBarColor(globalReliability);
    const summary = ottoResult.summary
      || (userLang === 'en'
        ? 'Otto Summary: Analysis unavailable for now. Please try again later.'
        : 'Synthèse Otto : Analyse indisponible pour le moment. Réessayez plus tard.');

    const contextualSources = mapSourcesForOutput(enrichedSources.length > 0 ? enrichedSources : contextualSourcesRaw).slice(0, 5);

    const updatedUser = await incrementUsageCounters(user.id, { otto: 1 });
    const quotaUser = updatedUser || { ...user, daily_otto_analysis: usedOtto + 1 };
    const quota = buildQuotaPayload(quotaUser);

    const usageSnapshot = {
      daily_checks_used: quota.usage.verificationsUsed,
      daily_otto_analysis: quota.usage.ottoUsed,
    };

    return res.json({
      ottoResult,
      globalReliability,
      summary,
      risk,
      barColor,
      plan: quota.plan,
      quota,
      updatedQuota: quota,
      userEmail: user.email,
      userLang,
      keywords,
      queries,
      contextualSources,
      agents: resolvedAgents,
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
