const express = require('express');
const { runAutoVerification } = require('../services/verificationService');
const { extractTrustedSourceContent } = require('../services/googleSearch');
const {
  PLAN_LIMITS,
  DEFAULT_PLAN,
  buildQuotaPayload,
  ensureDailyReset,
  incrementUsageCounters,
  getPlanFromUser,
  normalizeUsageValue,
} = require('../services/quotaService');
const { sanitizeInput } = require('../utils/textSanitizer');
const { getRiskLevel } = require('../utils/scoring');
const { getUserByEmail, getUserById } = require('../services/userService');
const pool = require('../services/db');

const router = express.Router();

router.post('/verify', async (req, res) => {
  try {
    const { text, userEmail, userId } = req.body || {};

    if (!text || text.trim().length === 0 || (!userEmail && !userId)) {
      return res.status(400).json({ success: false, error: 'missing_parameters' });
    }

    let user = userId ? await getUserById(userId) : await getUserByEmail(userEmail);
    if (!user) {
      return res.status(404).json({ success: false, error: 'user_not_found' });
    }

    user = await ensureDailyReset(user);
    const plan = getPlanFromUser(user);
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN];
    const usedVerifications = normalizeUsageValue(user.daily_checks_used);
    const dailyLimit = limits.dailyVerifications;

    if (Number.isFinite(dailyLimit) && usedVerifications >= dailyLimit) {
      const quota = buildQuotaPayload(user);
      return res.status(429).json({
        success: false,
        error: 'limit_reached',
        message: 'Daily verification limit reached',
        quota,
      });
    }

    const autoResult = await runAutoVerification(text);

    const updatedUser = await incrementUsageCounters(user.id, { verifications: 1 });
    const quotaUser = updatedUser || { ...user, daily_checks_used: usedVerifications + 1 };
    const quota = buildQuotaPayload(quotaUser);

    const risk = getRiskLevel(autoResult.score);
    const usageSnapshot = {
      daily_checks_used: quota.usage.verificationsUsed,
      daily_otto_analysis: quota.usage.ottoUsed,
    };

    return res.json({
      status: 'ok',
      mode: 'AUTO',
      plan: quota.plan,
      quota,
      confidence: autoResult.score,
      overallConfidence: autoResult.score / 100,
      risk,
      summary: autoResult.summary,
      keywords: autoResult.keywords,
      queries: autoResult.queries,
      claims: autoResult.claims,
      sources: autoResult.sources,
      usage: usageSnapshot,
      dailyChecksUsed: usageSnapshot.daily_checks_used,
      dailyOttoAnalysis: usageSnapshot.daily_otto_analysis,
    });
  } catch (error) {
    console.error('Erreur analyse documentaire :', error);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

router.post('/fetch-source', async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'invalid url' });
  }

  try {
    const enriched = await extractTrustedSourceContent([{ url }]);
    if (enriched.length === 0) {
      return res.status(400).json({ error: 'untrusted domain' });
    }
    return res.json({ content: enriched[0].content || '' });
  } catch (error) {
    if (error.code === 'UNTRUSTED_DOMAIN') {
      return res.status(400).json({ error: 'untrusted domain' });
    }
    if (error.code === 'INVALID_URL') {
      return res.status(400).json({ error: 'invalid url' });
    }
    console.error('Erreur récupération source:', error.message || error);
    return res.status(500).json({ error: 'failed to fetch source' });
  }
});

router.post('/feedback', async (req, res) => {
  try {
    const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
    const sanitizedComment = sanitizeInput(comment || '').substring(0, 500);
    const sanitizedOriginal = sanitizeInput(originalText || '').substring(0, 2000);

    const client = await pool.connect();
    await client.query(
      'INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)',
      [sanitizedOriginal, scoreGiven, isUseful, sanitizedComment, JSON.stringify(sourcesFound || [])],
    );
    client.release();

    return res.json({ success: true });
  } catch (error) {
    console.error('Erreur feedback:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
