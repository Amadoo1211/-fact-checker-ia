// server.js - VERSION 1.5 - FINALE ET COMPLÈTE
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 heures

app.use(cors({ origin: ['chrome-extension://*', 'https://*.netlify.app', 'http://localhost:3000', 'https://fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

// --- Fonctions Utilitaires & Détection ---
function cleanText(text) { return text.trim().replace(/\s+/g, ' ').substring(0, 12000); }
function extractIntelligentClaims(text) { return text.split(/[.!?]+/).filter(s => s.trim().length > 20).map(s => s.trim()).slice(0, 4); }
function extractBestKeywords(text) {
    const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'dans', 'sur', 'avec', 'par', 'pour', 'sans', 'qui', 'que', 'est', 'sont', 'été', 'avoir', 'être', 'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'is', 'are', 'was', 'were']);
    const properNouns = text.match(/\b[A-ZÀ-ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-ÿ][a-zà-ÿ]+){1,}\b/g) || [];
    let keywords = [...new Set(properNouns.filter(k => k.length > 5))];
    if (keywords.length < 5) {
        const otherWords = text.toLowerCase().replace(/[^\w\sÀ-ÿ]/g, ' ').split(/\s+/).filter(word => word.length > 6 && !stopWords.has(word));
        keywords.push(...otherWords);
    }
    return [...new Set(keywords)].slice(0, 7);
}
function calculateRelevance(claim, sourceContent) {
    const claimKeywords = extractBestKeywords(claim);
    const sourceText = (sourceContent || '').toLowerCase();
    if (claimKeywords.length === 0) return 0;
    let relevanceScore = 0;
    claimKeywords.forEach(keyword => {
        if (sourceText.includes(keyword.toLowerCase())) {
            relevanceScore += (keyword.length > 5) ? 0.4 : 0.3;
        }
    });
    if (relevanceScore === 0) return 0.02;
    return Math.min(relevanceScore, 1.0);
}
function extractDomain(url) { try { return new URL(url).hostname.replace('www.', ''); } catch (e) { return 'unknown'; }}
function isStrongOpinionContent(text) {
    const opinionPatterns = [/\b(meilleur|meilleure|pire|plus beau|plus belle)\b.*\b(monde|univers|tous temps)\b/i, /\b(préfère|déteste|adore|opinion|goût|je pense|à mon avis|selon moi)\b/i, /\b(magnifique|horrible|parfait|nul|génial|fantastique)\b/i];
    return opinionPatterns.some(pattern => pattern.test(text));
}
function detectContradictions(sources, originalText) {
    const contradictions = [];
    const datePattern = /\b(1\d{3}|20\d{2})\b/g;
    const textDates = [...new Set((originalText.match(datePattern) || []))];
    if (textDates.length > 0) {
        sources.forEach(source => {
            const sourceDates = [...new Set((source.snippet.match(datePattern) || []))];
            const hasConflict = sourceDates.some(sd => !textDates.includes(sd) && Math.abs(parseInt(sd) - parseInt(textDates[0])) > 2);
            if (hasConflict) {
                contradictions.push({ topic: "Date", description: `Une date contradictoire (${sourceDates.join(', ')}) a été trouvée.` });
            }
        });
    }
    return contradictions.slice(0, 1);
}
function generateScoringExplanation(details, sources) {
    const { finalPercentage } = details;
    const relevantCount = sources.filter(s => (s.relevanceScore || 0) > 0.25).length;
    if (finalPercentage >= 80) return `Score très élevé, confirmé par ${relevantCount} sources fiables et pertinentes.`;
    if (finalPercentage >= 50) return `Score modéré. ${relevantCount} sources corroborent les points principaux.`;
    return `Score faible. Peu de sources (${relevantCount}) ont pu vérifier directement les affirmations.`;
}

// --- Fonctions de recherche ---
async function searchWikipediaAdvanced(claimText) {
    const sources = [];
    for (const lang of ['fr', 'en']) {
        try {
            const keywords = extractBestKeywords(claimText);
            const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(keywords.join(' '))}&format=json&origin=*&srlimit=2`;
            const response = await fetch(searchUrl, { timeout: 4000 });
            const data = await response.json();
            if (data.query?.search) {
                for (const article of data.query.search) {
                    const content = await fetchWikipediaContent(lang, article.title, claimText);
                    if (content) sources.push(content);
                }
            }
        } catch (e) { console.warn(`Wikipedia (${lang}) search failed`); }
    }
    return sources;
}
async function fetchWikipediaContent(lang, title, originalClaim) {
    try {
        const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
        const response = await fetch(summaryUrl, { timeout: 4000 });
        if (!response.ok) return null;
        const data = await response.json();
        const content = data.title + ' ' + data.extract;
        return {
            title: `Wikipedia (${lang.toUpperCase()}): ${data.title}`, url: data.content_urls.desktop.page,
            snippet: data.extract?.substring(0, 250) + "..." || "Pas d'extrait disponible.",
            reliability: 0.85, sourceCategory: 'encyclopedia', relevanceScore: calculateRelevance(originalClaim, content),
        };
    } catch (e) { return null; }
}

function deduplicateAndRankSources(sources) {
    const seen = new Set();
    const deduplicated = [];
    sources.forEach(source => {
        if (!source || !source.url) return;
        const key = extractDomain(source.url);
        if (!seen.has(key)) {
            seen.add(key);
            deduplicated.push(source);
        }
    });
    return deduplicated.sort((a, b) => (b.reliability * b.relevanceScore) - (a.reliability * a.relevanceScore)).slice(0, 8);
}

// --- Moteur de Scoring ---
function calculateEnhancedConfidenceScore(claims, sources, originalText) {
    let baseScore = 25, sourceScore = 0, qualityBonus = 0, penalties = 0;
    const relevantSources = sources.filter(s => s.relevanceScore && s.relevanceScore > 0.25);
    relevantSources.forEach(source => {
        let sourceValue = 15 * source.relevanceScore;
        if (source.sourceCategory === 'academic' || source.sourceCategory === 'database') sourceValue *= 1.5;
        sourceScore += sourceValue;
    });
    const relevantCount = relevantSources.length;
    if (relevantCount >= 4) qualityBonus = 35;
    else if (relevantCount >= 2) qualityBonus = 20;
    if (relevantCount === 0) penalties += 50;
    
    const rawScore = baseScore + sourceScore + qualityBonus - penalties;
    const finalScore = Math.max(15, Math.min(95, rawScore));
    return {
        finalScore: finalScore / 100,
        details: { finalPercentage: Math.round(finalScore), sourceBreakdown: { totalRelevant: relevantCount } },
    };
}

// --- FONCTION PRINCIPALE ---
async function performComprehensiveFactCheck(text) {
    const cleanedText = cleanText(text);
    const keywords = extractBestKeywords(cleanedText);

    if (isStrongOpinionContent(cleanedText)) {
        return {
            overallConfidence: 0.22, sources: [], extractedKeywords: keywords, contradictions: [],
            scoringExplanation: "Un score bas est attribué car le texte exprime une opinion subjective.",
            alternativeContent: {
                title: "Ceci est une opinion 🧐",
                explanation: "L'analyse factuelle n'est pas applicable. Pour approfondir, explorez ces questions :",
                prompts: [ `Quels sont les faits vérifiables sur "${keywords.join(', ')}" ?`, `Quelles sont les différentes perspectives sur ce sujet ?`, `Quelle est l'histoire de "${keywords.join(', ')}" ?` ]
            }
        };
    }

    const claims = extractIntelligentClaims(cleanedText);
    const searchPromises = claims.flatMap(claim => [searchWikipediaAdvanced(claim)]);
    const sourceArrays = await Promise.all(searchPromises);
    const allSources = sourceArrays.flat().filter(Boolean);
    const rankedSources = deduplicateAndRankSources(allSources);
    const scoringAnalysis = calculateEnhancedConfidenceScore(claims, rankedSources, cleanedText);
    const contradictions = detectContradictions(rankedSources, cleanedText);

    return {
        overallConfidence: scoringAnalysis.finalScore,
        sources: rankedSources,
        extractedKeywords: keywords,
        contradictions: contradictions,
        scoringExplanation: generateScoringExplanation(scoringAnalysis.details, rankedSources),
        scoringDetails: scoringAnalysis.details
    };
}

// --- Routes API ---
app.get("/", (req, res) => res.send("✅ API Fact-Checker IA Pro V1.5 - Production Ready!"));
app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.length < 10) return res.status(400).json({ error: 'Texte requis.' });
        const cacheKey = `v1.5_${text.substring(0, 50)}`;
        if (cache.has(cacheKey)) { return res.json(cache.get(cacheKey)); }
        const result = await performComprehensiveFactCheck(text);
        cache.set(cacheKey, result);
        res.json(result);
    } catch (error) {
        console.error("Erreur dans /verify:", error);
        res.status(500).json({ error: 'Échec de la vérification.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Fact-Checker IA Pro V1.5 démarré sur port ${PORT}`));
