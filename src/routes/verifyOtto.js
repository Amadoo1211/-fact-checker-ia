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
  generateHumanSummary,
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
  const requestedLangRaw =
    req.body?.userLang || req.body?.lang || req.body?.language || 'fr';
  const normalizedRequestedLang =
    typeof requestedLangRaw === 'string' && requestedLangRaw.toLowerCase() === 'en'
      ? 'en'
      : 'fr';
  let responseLang = normalizedRequestedLang;
  const defaultDebugMessage = 'Otto verification request failed.';

  const sendError = (statusCode, payload = {}) =>
    res.status(statusCode).json({
      status: 'error',
      success: false,
      lang: responseLang,
      debugMessage: defaultDebugMessage,
      ...payload,
      ottoResult: null,
    });

  try {
    const { userEmail, userId } = req.body || {};
    let inputText = typeof req.body?.text === 'string' ? req.body.text : '';

    if (!userEmail && !userId) {
      return sendError(400, {
        error: 'missing_parameters',
        debugMessage: 'Missing Otto user parameters.',
      });
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
      return sendError(400, {
        error: 'invalid_pdf',
        debugMessage: 'Unable to extract PDF text for Otto analysis.',
      });
    }

    console.log('[VerifyOtto] Input text length:', inputText?.length || 0);

    if (!inputText || inputText.trim() === '') {
      return sendError(400, {
        error: 'missing_text',
        debugMessage: 'No text provided for Otto verification.',
      });
    }

    let user = userId ? await getUserById(userId) : await getUserByEmail(userEmail);
    if (!user) {
      return sendError(404, {
        error: 'user_not_found',
        debugMessage: 'User record not found for Otto verification.',
      });
    }

    user = await ensureDailyReset(user);
    const plan = getPlanFromUser(user);
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN];
    const usedOtto = normalizeUsageValue(user.daily_otto_analysis);
    const ottoLimit = limits.dailyOtto;

    if (Number.isFinite(ottoLimit) && usedOtto >= ottoLimit) {
      const quota = buildQuotaPayload(user);
      return sendError(429, {
        error: 'limit_reached',
        message: 'Daily Otto analysis limit reached',
        quota,
        debugMessage: 'Daily Otto analysis limit reached.',
      });
    }

    const requestedLang = (
      req.body?.userLang ||
      user?.preferred_language ||
      user?.language ||
      user?.lang ||
      'fr'
    )
      .toString()
      .toLowerCase();
    const lang = requestedLang === 'en' ? 'en' : 'fr';
    responseLang = lang;

    const sanitizedText = sanitizeInput(inputText);
    if (!sanitizedText || sanitizedText.trim() === '') {
      return sendError(400, {
        error: 'invalid_text',
        debugMessage: 'Provided text is invalid after sanitization.',
      });
    }
    const keywords = extractMainKeywords(sanitizedText);
    const queries = buildOttoSearchQueries(sanitizedText, keywords);

    const contextualSourcesRaw = await findWebSources(keywords, queries, sanitizedText);
    const enrichedSources = await extractTrustedSourceContent(contextualSourcesRaw);

    const requiresLongAnalysis = pdfAttempted || sanitizedText.length > 8000;
    let agentResults;

    if (requiresLongAnalysis) {
      const longAnalysis = await runOttoLongAnalysis(sanitizedText, enrichedSources, lang);
      agentResults = longAnalysis?.agentResults || {};
    } else {
      agentResults = await runAllAgents(sanitizedText, enrichedSources);
    }

    const normalizedAgents = agentResults || {};
    const metaResult = computeOttoMetaResult(normalizedAgents, lang);
    const { reliability } = metaResult;
    let keyPoints = Array.isArray(metaResult.keyPoints) ? metaResult.keyPoints : [];
    if ((!keyPoints || keyPoints.length === 0) && keywords.length > 0) {
      keyPoints = keywords.slice(0, 8);
    }
    const summaryLocalized = generateHumanSummary(lang, reliability, keyPoints);

    const ottoPayload = {
      reliability,
      summaryLocalized,
      keyPoints,
      rawAgents: metaResult.agentResults,
    };

    if (normalizedAgents?.meta_summary) {
      ottoPayload.metaSummary = normalizedAgents.meta_summary;
    }
    if (Array.isArray(normalizedAgents?.segments)) {
      ottoPayload.segments = normalizedAgents.segments;
    }

    const updatedUser = await incrementUsageCounters(user.id, { otto: 1 });
    const quotaUser = updatedUser || { ...user, daily_otto_analysis: usedOtto + 1 };
    const quota = buildQuotaPayload(quotaUser);

    return res.json({
      status: 'ok',
      lang,
      ottoResult: ottoPayload,
      updatedQuota: quota,
      success: true,
    });
  } catch (error) {
    console.error('❌ Otto error:', error);
    if (!res.headersSent) {
      return sendError(500, {
        error: 'server_error',
        message: 'Internal server error',
        debugMessage: 'Otto verification failed. Please try again later.',
      });
    }
    return;
  }
});

module.exports = router;
