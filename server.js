// server.js - VERSION 1.8 - FINALE ET 100% COMPLÈTE
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 heures

app.use(cors({ origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

// --- Fonctions Utilitaires & Détection ---
function cleanText(text) { return text.trim().replace(/\s+/g, ' ').substring(0, 8000); }

function extractBestKeywords(text) {
    // 1. Nettoyer les phrases de politesse et intros des IA
    const cleaned = text.split(/[.!?]/)[0] // Travailler sur la première phrase
        .replace(/^(Bien sûr|Certainement|Voici|Selon|D'après|L'invention de|La vitesse de|La chute de)/i, '')
        .replace(/"/g, '')
        .trim();

    // 2. Priorité aux noms propres de plusieurs mots (ex: "Thomas Edison", "Mur de Berlin")
    let keywords = cleaned.match(/\b[A-ZÀ-ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-ÿa-zà-ÿ]+){1,3}\b/g) || [];
    
    // 3. Si aucun, chercher des sujets ou concepts clés (ex: "vitesse de la lumière")
    if (keywords.length === 0) {
        keywords = cleaned.match(/\b[a-zà-ÿ]+ de la [a-zà-ÿ]+\b/gi) || [];
    }
    // 4. En dernier recours, prendre les mots les plus longs et significatifs
    if (keywords.length === 0) {
        keywords = cleaned.split(/\s+/).filter(w => w.length > 6);
    }

    const finalKeywords = [...new Set(keywords.map(k => k.trim().replace(/,$/, '')))];
    console.log("Mots-clés extraits:", finalKeywords.slice(0, 4));
    return finalKeywords.slice(0, 4);
}

function calculateRelevance(claim, sourceContent) {
    const claimKeywords = extractBestKeywords(claim);
    const sourceText = (sourceContent || '').toLowerCase();
    if (claimKeywords.length === 0) return 0;
    let relevanceScore = 0;
    claimKeywords.forEach(keyword => {
        if (sourceText.includes(keyword.toLowerCase())) {
            relevanceScore += (keyword.length > 5) ? 0.6 : 0.4;
        }
    });
    return Math.min(relevanceScore, 1.0);
}

function isStrongOpinionContent(text) {
    const lowerText = text.toLowerCase();
    const opinionWords = ['meilleur', 'pire', 'préféré', 'déteste', 'adore', 'subjectif', 'avis', 'pense que'];
    if (opinionWords.some(word => lowerText.includes(word))) return true;
    const questionWords = ['quel est', 'qui est', 'penses-tu', 'selon toi'];
    if (questionWords.some(word => lowerText.includes(word)) && (lowerText.includes('musique') || lowerText.includes('film') || lowerText.includes('art'))) return true;
    return false;
}

function generateScoringExplanation(details, sources) {
    const { finalPercentage } = details;
    const relevantCount = sources.filter(s => (s.relevanceScore || 0) > 0.4).length;
    if (finalPercentage >= 80) return `Score très élevé, confirmé par ${relevantCount} sources fiables et très pertinentes.`;
    if (finalPercentage >= 50) return `Score correct, ${relevantCount} sources corroborent les points principaux.`;
    return `Score faible. Peu de sources (${relevantCount}) ont pu vérifier directement les affirmations.`;
}

// --- Fonctions de recherche complètes ---
async function searchWikipediaAdvanced(claimText) {
    const sources = [];
    const keywords = extractBestKeywords(claimText);
    if (keywords.length === 0) return [];
    const query = keywords.join(' ');

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
            title: `Wikipedia (${lang.toUpperCase()}): ${data.title}`,
            url: data.content_urls.desktop.page,
            snippet: data.extract?.substring(0, 250) + "..." || "Pas d'extrait disponible.",
            reliability: 0.85,
            sourceCategory: 'encyclopedia',
            relevanceScore: calculateRelevance(originalClaim, content),
        };
    } catch (e) { return null; }
}

function deduplicateAndRankSources(sources) {
    const seen = new Set();
    const deduplicated = [];
    sources.forEach(source => {
        try {
            const domain = new URL(source.url).hostname;
            if (!seen.has(domain)) {
                seen.add(domain);
                deduplicated.push(source);
            }
        } catch (e) {}
    });
    return deduplicated.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 5);
}

// --- Moteur de Scoring ---
function calculateEnhancedConfidenceScore(text, sources) {
    let baseScore = 20;
    let sourceScore = 0;
    const relevantSources = sources.filter(s => s.relevanceScore > 0.4); // Seuil de pertinence
    
    relevantSources.forEach(source => {
        sourceScore += 35 * source.relevanceScore; // Bonus important par source pertinente
    });

    if (relevantSources.length === 0) {
        baseScore = 15; // Pénalité si aucune source pertinente
    }

    const rawScore = baseScore + sourceScore;
    const finalScore = Math.min(95, rawScore); // Plafonné à 95%

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
            alternativeContent: {
                title: "Ceci est une opinion 🧐",
                explanation: "L'analyse factuelle n'est pas applicable. Pour approfondir, explorez ces questions :",
                prompts: [ `Quels sont les faits vérifiables sur "${keywords[0] || 'ce sujet'}" ?`, `Quelles sont les différentes perspectives ?` ]
            }
        };
    }

    const sources = await searchWikipediaAdvanced(cleanedText);
    const rankedSources = deduplicateAndRankSources(sources);
    const scoringAnalysis = calculateEnhancedConfidenceScore(cleanedText, rankedSources);

    return {
        overallConfidence: scoringAnalysis.finalScore,
        sources: rankedSources,
        extractedKeywords: keywords,
        contradictions: [],
        scoringExplanation: generateScoringExplanation(scoringAnalysis.details, rankedSources),
        scoringDetails: scoringAnalysis.details
    };
}

// --- Routes API ---
app.get("/", (req, res) => res.send("✅ API Fact-Checker IA Pro V1.8 - Final"));
app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Texte requis.' });
        const result = await performComprehensiveFactCheck(text);
        res.json(result);
    } catch (error) {
        console.error("Erreur dans /verify:", error);
        res.status(500).json({ error: 'Échec de la vérification.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Fact-Checker IA Pro V1.8 démarré sur port ${PORT}`));
