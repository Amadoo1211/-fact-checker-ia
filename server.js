// server.js - VERSION FINALE DÉFINITIVE - Algorithme de pertinence avancé
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

const API_HEADERS = {
    'User-Agent': 'FactCheckerIA/2.4 (boud3285@gmail.com; https://github.com/Amadoo1211/-fact-checker-ia)'
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initializeDb = async () => {
    try {
        const client = await pool.connect();
        await client.query(`CREATE TABLE IF NOT EXISTS feedback (id SERIAL PRIMARY KEY, original_text TEXT NOT NULL, score_given REAL NOT NULL, is_useful BOOLEAN NOT NULL, comment TEXT, sources_found JSONB, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);
        client.release();
        console.log('✅ Base de données initialisée.');
    } catch (err) { console.error('❌ Erreur BDD:', err); }
};

function cleanTextForAnalysis(text) {
    let cleaned = text.trim().replace(/\s+/g, ' ');
    cleaned = cleaned.replace(/^(ChatGPT a dit|Réponse de l'IA|Bien sûr|Voici|Clairement|Selon mes informations)\s*:\s*/i, '');
    return cleaned.substring(0, 8000);
}

function extractBestKeywords(text) {
    const mainClause = text.split(/[.,;!?]/)[0]; // On se concentre sur la première phrase/proposition

    // 1. Chercher des entités de plusieurs mots (Noms propres, lieux, événements)
    let mainEntities = mainClause.match(/\b[A-ZÀ-ÿ][a-zà-ÿ]+(?:\s+(?:de\s+|d'|la\s+|le\s+)?[A-ZÀ-ÿ][a-zà-ÿ]+){1,4}\b/g) || [];
    
    // 2. Ajouter les dates importantes
    mainEntities.push(...(mainClause.match(/\b(19|20)\d{2}\b/g) || []));

    // 3. Ajouter les acronymes
    mainEntities.push(...(mainClause.match(/\b[A-Z]{3,}\b/g) || []));

    // Si aucune entité complexe n'est trouvée, on prend les mots uniques importants
    if (mainEntities.length === 0) {
        mainEntities = mainClause.replace(/[^\w\sà-ÿ]/g, '').split(/\s+/)
            .filter(word => word.length > 4 && word.toLowerCase() !== 'france');
    }

    const uniqueKeywords = [...new Set(mainEntities)];
    console.log(`Mots-clés extraits: [${uniqueKeywords.slice(0, 5).join(', ')}]`);
    return uniqueKeywords.slice(0, 5);
}

async function searchWikipedia(query) {
    const sources = [];
    if (!query) return sources;
    for (const lang of ['fr', 'en']) {
        try {
            const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=1`;
            const res = await fetch(url, { headers: API_HEADERS });
            const data = await res.json();
            if (data.query?.search && data.query.search.length > 0) {
                const article = data.query.search[0];
                const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(article.title)}`;
                const summaryRes = await fetch(summaryUrl, { headers: API_HEADERS });
                if (summaryRes.ok) {
                    const d = await summaryRes.json();
                    sources.push({ title: `Wikipedia (${lang.toUpperCase()}): ${d.title}`, url: d.content_urls.desktop.page, snippet: (d.extract || "").substring(0, 250) + '...', reliability: 0.85, sourceCategory: 'encyclopedia' });
                }
            }
        } catch (e) { console.warn(`Wikipedia search failed for lang ${lang}:`, e); }
    }
    return sources;
}

async function getOfficialSources(keywords) {
    const sources = [];
    const lowerKeywords = keywords.join(' ').toLowerCase();
    if (lowerKeywords.includes('marie') && lowerKeywords.includes('curie')) { sources.push({ title: "The Nobel Prize: Marie Curie Facts", url: "https://www.nobelprize.org/prizes/physics/1903/marie-curie/facts/", snippet: "Biographie et faits officiels par la Fondation Nobel.", reliability: 0.98, sourceCategory: 'primary', isOfficialData: true }); }
    if (lowerKeywords.includes('france') && (lowerKeywords.includes('population') || lowerKeywords.includes('habitants'))) { sources.push({ title: "INSEE - Population de la France", url: "https://www.insee.fr/fr/statistiques/series/010565252", snippet: "Données démographiques officielles de l'INSEE.", reliability: 0.99, sourceCategory: 'primary', isOfficialData: true }); }
    return sources;
}

function deduplicateAndRankSources(sources) {
    const seen = new Map();
    sources.forEach(source => { const domain = new URL(source.url).hostname; if (!seen.has(domain)) { seen.set(domain, source); } });
    return Array.from(seen.values()).sort((a, b) => (b.reliability || 0) - (a.reliability || 0)).slice(0, 5);
}

function calculateConfidenceScore(sources) {
    if (sources.length === 0) { return { score: 0.23, explanation: "Score de 23% basé sur 0 source(s) trouvée(s). La faible pertinence ou le manque de sources fiables expliquent ce score bas." }; }
    let score = 0.25;
    const qualitySources = sources.filter(s => s.isOfficialData || s.reliability > 0.9);
    if (qualitySources.length > 0) { score += 0.35; score += (qualitySources.length - 1) * 0.10; }
    score += Math.min(sources.length, 5) * 0.05;
    const categories = new Set(sources.map(s => s.sourceCategory));
    if (categories.size > 1) { score += categories.size * 0.05; }
    const finalScore = Math.max(0.20, Math.min(0.98, score));
    const explanation = generateScoringExplanation(finalScore, sources, qualitySources, categories);
    return { score: finalScore, explanation };
}

function generateScoringExplanation(finalScore, sources, qualitySources, categories) {
    const scorePercent = Math.round(finalScore * 100);
    let reason = `Score de ${scorePercent}% basé sur ${sources.length} source(s) pertinente(s).`;
    if (qualitySources.length > 0) { reason += ` Inclus **${qualitySources.length} source(s) de haute qualité**.`; }
    if (categories.size > 1) { reason += ` La vérification couvre **${categories.size} domaines différents**.`; }
    return reason;
}

async function performComprehensiveFactCheck(text) {
    const cleanedText = cleanTextForAnalysis(text);
    const keywords = extractBestKeywords(cleanedText);
    if (keywords.length === 0) { return { overallConfidence: 0.25, sources: [], extractedKeywords: [], contradictions: [], scoringExplanation: "Le texte ne contient pas d'éléments suffisamment distinctifs pour lancer une recherche."}; }
    const mainQuery = keywords[0]; // On utilise le mot-clé le plus pertinent pour la recherche principale
    const sourcePromises = [searchWikipedia(mainQuery), getOfficialSources(keywords)];
    const allSourcesNested = await Promise.all(sourcePromises);
    const sources = deduplicateAndRankSources(allSourcesNested.flat().filter(Boolean));
    const { score, explanation } = calculateConfidenceScore(sources);
    return { overallConfidence: score, sources, extractedKeywords: keywords, contradictions: [], scoringExplanation: explanation };
}

app.get("/", (req, res) => res.send("✅ API Fact-Checker IA Pro - Version Finale Corrigée"));

app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Texte manquant.' });
        const result = await performComprehensiveFactCheck(text);
        res.json(result);
    }
