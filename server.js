// server.js - VERSION 1.7 - FINALE ET 100% COMPLÈTE
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000;

app.use(cors({ origin: ['chrome-extension://*', 'https://*.netlify.app', 'http://localhost:3000', 'https://fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

// --- Fonctions Utilitaires & Détection ---
function cleanText(text) { return text.trim().replace(/\s+/g, ' ').substring(0, 12000); }
function extractIntelligentClaims(text) { return text.split(/[.!?]+/).filter(s => s.trim().length > 15).map(s => s.trim()).slice(0, 3); }

function extractBestKeywords(text) {
    const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'dans', 'sur', 'avec', 'par', 'pour', 'qui', 'que', 'est', 'sont', 'il', 'elle', 'je', 'tu', 'nous', 'vous', 'the', 'a', 'is', 'in', 'on', 'of']);
    let keywords = text.match(/\b[A-ZÀ-ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-ÿa-zà-ÿ]+){1,3}\b/g) || [];
    const concepts = text.match(/\b(?:\w+\s+){1,2}\w+(?:quantique|relativité|musique|cinéma|histoire)\b/gi) || [];
    keywords.push(...concepts);
    if (keywords.length < 3) {
        const simpleWords = text.toLowerCase().replace(/[^\w\sÀ-ÿ]/g, '').split(/\s+/).filter(word => word.length > 5 && !stopWords.has(word));
        keywords.push(...simpleWords);
    }
    return [...new Set(keywords.map(k => k.trim().replace(/[.,]$/, '')))].slice(0, 5);
}

function calculateRelevance(claim, sourceContent) {
    const claimKeywords = extractBestKeywords(claim);
    const sourceText = (sourceContent || '').toLowerCase();
    if (claimKeywords.length === 0) return 0;
    let relevanceScore = 0;
    claimKeywords.forEach(keyword => {
        if (sourceText.includes(keyword.toLowerCase())) {
            relevanceScore += (keyword.length > 5) ? 0.5 : 0.3;
        }
    });
    if (relevanceScore === 0) return 0.01;
    return Math.min(relevanceScore, 1.0);
}

function extractDomain(url) { try { return new URL(url).hostname.replace('www.', ''); } catch (e) { return 'unknown'; }}

function isStrongOpinionContent(text) {
    const lowerText = text.toLowerCase();
    const opinionWords = ['meilleur', 'pire', 'préféré', 'déteste', 'adore', 'subjectif', 'avis', 'pense'];
    const questionWords = ['quel est', 'qui est', 'penses-tu', 'selon toi'];

    if (opinionWords.some(word => lowerText.includes(word))) return true;
    if (questionWords.some(word => lowerText.includes(word)) && lowerText.includes('?')) {
        if (lowerText.includes('musique') || lowerText.includes('film') || lowerText.includes('art')) return true;
    }
    return false;
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
    const keywords = extractBestKeywords(claimText);
    const query = keywords.length > 0 ? keywords.slice(0, 3).join(' ') : claimText;
    for (const lang of ['fr', 'en']) {
        try {
            const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=2`;
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
    let baseScore = 30, sourceScore = 0, qualityBonus = 0, penalties = 0;
    const relevantSources = sources.filter(s => s.relevanceScore && s.relevanceScore > 0.3);
    relevantSources.forEach(source => { sourceScore += 20 * source.relevanceScore; });
    const relevantCount = relevantSources.length;
    if (relevantCount >= 3) qualityBonus = 25;
    else if (relevantCount >= 1) qualityBonus = 10;
    if (relevantCount === 0) penalties = 60;
    const rawScore = baseScore + sourceScore + qualityBonus - penalties;
    const finalScore = Math.max(15, Math.min(95, rawScore));
    return {
        finalScore: finalScore / 100,
        details: { finalPercentage: Math.round(finalScore) },
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
    const sourceArrays = await Promise.all(claims.map(claim => searchWikipediaAdvanced(claim)));
    const allSources = sourceArrays.flat().filter(Boolean);
    const rankedSources = deduplicateAndRankSources(allSources);
    const scoringAnalysis = calculateEnhancedConfidenceScore(claims, rankedSources, cleanedText);

    return {
        overallConfidence: scoringAnalysis.finalScore,
        sources: rankedSources,
        extractedKeywords: keywords,
        contradictions: [], // La détection de contradiction est complexe, gardée simple pour la V1
        scoringExplanation: generateScoringExplanation(scoringAnalysis.details, rankedSources),
        scoringDetails: scoringAnalysis.details
    };
}

// --- Routes API ---
app.get("/", (req, res) => res.send("✅ API Fact-Checker IA Pro V1.7 - Production Ready!"));
app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.length < 10) return res.status(400).json({ error: 'Texte requis.' });
        // Le cache est désactivé pour les derniers tests, vous pouvez le réactiver plus tard
        // const cacheKey = `v1.7_${text.substring(0, 50)}`;
        // if (cache.has(cacheKey)) { return res.json(cache.get(cacheKey)); }
        const result = await performComprehensiveFactCheck(text);
        // cache.set(cacheKey, result);
        res.json(result);
    } catch (error) {
        console.error("Erreur dans /verify:", error);
        res.status(500).json({ error: 'Échec de la vérification.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Fact-Checker IA Pro V1.7 démarré sur port ${PORT}`));
