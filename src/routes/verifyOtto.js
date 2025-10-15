const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { extractPdfText } = require('../utils/pdfExtractor');
const {
  buildOttoSearchQueries,
  runOttoLongAnalysis,
  computeOttoMetaResult,
  runAllAgents,
} = require('../services/verificationService');
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
const { findWebSources, extractTrustedSourceContent } = require('../services/googleSearch');
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

    const fileUrl = typeof req.body?.fileUrl === 'string' ? req.body.fileUrl.trim() : '';
    const pdfTextSegments = [];
    let pdfAttempted = false;

    if (fileUrl) {
      pdfAttempted = true;
      try {
        const extractedText = await extractPdfText(fileUrl);
        if (extractedText && extractedText.trim()) {
          pdfTextSegments.push(extractedText.trim());
        }
      } catch (pdfError) {
        console.error('Erreur extraction PDF Otto (url) :', pdfError);
      }
    }

    if (req.file && req.file.buffer) {
      pdfAttempted = true;
      const tempPath = path.join(
        os.tmpdir(),
        `otto-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`,
      );
      try {
        await fs.writeFile(tempPath, req.file.buffer);
        const extractedText = await extractPdfText(tempPath);
        if (extractedText && extractedText.trim()) {
          pdfTextSegments.push(extractedText.trim());
        }
      } catch (pdfError) {
        console.error('Erreur extraction PDF Otto (upload) :', pdfError);
      } finally {
        await fs.unlink(tempPath).catch(() => {});
      }
    }

    if (pdfTextSegments.length > 0) {
      const pdfCombined = pdfTextSegments.join('\n\n');
      inputText = inputText ? `${inputText}\n\n${pdfCombined}` : pdfCombined;
    } else if (pdfAttempted && (!inputText || inputText.trim() === '')) {
      return res.status(400).json({ success: false, error: 'invalid_pdf' });
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

    const requiresLongAnalysis = pdfAttempted || sanitizedText.length > 8000;
    let agentResults;

    if (requiresLongAnalysis) {
      const longAnalysis = await runOttoLongAnalysis(sanitizedText, enrichedSources, userLang);
      agentResults = longAnalysis?.agentResults || {};
    } else {
      agentResults = await runAllAgents(sanitizedText, enrichedSources);
    }

    const normalizedAgents = agentResults || {};
    const metaResult = computeOttoMetaResult(normalizedAgents, userLang);

    const ottoPayload = {
      summaryLocalized: metaResult.summary,
      keyPoints: metaResult.keyPoints,
      reliability: metaResult.reliability,
      rawAgents: metaResult.agentResults,
    };

    if (normalizedAgents?.meta_summary) {
      ottoPayload.metaSummary = normalizedAgents.meta_summary;
    }
    if (Array.isArray(normalizedAgents?.segments)) {
      ottoPayload.segments = normalizedAgents.segments;
    }

    if ((!ottoPayload.keyPoints || ottoPayload.keyPoints.length === 0) && keywords.length > 0) {
      ottoPayload.keyPoints = keywords.slice(0, 8);
    }

    const updatedUser = await incrementUsageCounters(user.id, { otto: 1 });
    const quotaUser = updatedUser || { ...user, daily_otto_analysis: usedOtto + 1 };
    const quota = buildQuotaPayload(quotaUser);

    return res.json({
      status: 'ok',
      lang: userLang,
      ottoResult: ottoPayload,
      updatedQuota: quota,
    });
  } catch (error) {
    console.error('Erreur Otto :', error);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

module.exports = router;
