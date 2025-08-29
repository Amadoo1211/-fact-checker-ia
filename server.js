// server.js - VERSION FINALE AVEC FEEDBACK & CORRECTION DE PERTINENCE
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

const API_HEADERS = {
    'User-Agent': 'FactCheckerIA/2.2 (boud3285@gmail.com; https://github.com/Amadoo1211/-fact-checker-ia)'
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initializeDb = async () => {
    try {
        const client = await pool.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS feedback (
                id SERIAL PRIMARY KEY,
                original_text TEXT NOT NULL,
                score_given REAL NOT NULL,
                is_useful BOOLEAN NOT NULL,
                comment TEXT,
                sources_found JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        client.release();
        console.log('✅ Base de données initialisée.');
    } catch (err) {
        console.error('❌ Erreur BDD:', err);
    }
};

function cleanText(text) {
    let cleaned = text.trim().replace(/\s+/g, ' ');
    // **CORRECTION CLÉ** : On enlève les préfixes courants des IAs
    cleaned = cleaned.replace(/^(ChatGPT a dit|Réponse de l'IA|Bien sûr|Voici|Clairement)\s*:\s*/i, '');
    return cleaned.substring(0, 8000);
}

function extractKeywords(text) {
    const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'dans', 'sur', 'avec', 'par', 'pour', 'qui', 'que', 'the', 'and', 'or', 'of', 'est', 'sont', 'il']);
    return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(word => word.length > 3 && !stopWords.has(word)).slice(0, 6);
}

function extractDomain(url) { try { return new URL(url).hostname.replace('www.', ''); } catch { return url; } }
function extractIntelligentClaims(text) {
    const claims = [];
    claims.push(...(text.match(/[^.!?]*\b(?:19|20)\d{2}\b[^.!?]*/g) || []));
    claims.push(...(text.match(/[^.!?]*\b[A-Z][a-z]+\s+[A-Z][a-z]+\b[^.!?]*/g) || []));
    claims.push(...(text.match(/[^.!?]*\d+(?:[.,]\d+)?(?:\s*%|€|$|millions?|milliards?)[^.!?]*/g) || []));
    if (claims.length < 2) { claims.push(...text.split(/[.!?]+/).filter(s => s.trim().length > 40)); }
    return [...new Set(claims.map(c => c.trim()).filter(c => c.length > 25))].slice(0, 4);
}

async function searchWikipedia(claimText) {
    const sources = [];
    for (const lang of ['fr', 'en']) {
        try {
            const keywords = extractKeywords(claimText).join(' ');
            if (!keywords) continue;
            const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(keywords)}&format=json&origin=*&srlimit=2`;
            const searchRes = await fetch(searchUrl, { headers: API_HEADERS });
            const searchData = await searchRes.json();
            if (searchData.query?.search) {
                for (const article of searchData.query.search) {
                    const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(article.title)}`;
                    const summaryRes = await fetch(summaryUrl, { headers: API_HEADERS });
                    if (summaryRes.ok) {
                        const d = await summaryRes.json();
                        sources.push({ title: `Wikipedia (${lang.toUpperCase()}): ${d.title}`, url: d.content_urls.desktop.page, snippet: (d.extract || "").substring(0, 250) + '...', reliability: 0.85, sourceCategory: 'encyclopedia' });
                    }
                }
            }
        } catch (e) { console.warn(`Wikipedia search failed for lang ${lang}:`, e); }
    }
    return sources;
}
async function getDomainSpecificSources(claimText) {
    const sources = [];
    const lowerText = claimText.toLowerCase();
    if (lowerText.match(/\b(python|javascript|java|code|api)\b/)) { sources.push({ title: "MDN Web Docs", url: "https://developer.mozilla.org/", snippet: "Documentation de référence pour les développeurs web.", reliability: 0.96, sourceCategory: 'technical', isOfficialData: true }); }
    if (lowerText.match(/\b(santé|médical|virus|vaccin)\b/)) { sources.push({ title: "Organisation Mondiale de la Santé (OMS)", url: "https://www.who.int/fr", snippet: "Source officielle pour les informations sur la santé mondiale.", reliability: 0.98, sourceCategory: 'medical', isOfficialData: true }); }
    if (lowerText.match(/\b(économie|inflation|pib|finance)\b/)) { sources.push({ title: "Banque de France", url: "https://www.banque-france.fr/", snippet: "Statistiques et analyses économiques officielles.", reliability: 0.97, sourceCategory: 'primary', isOfficialData: true }); }
    if (lowerText.match(/\b(loi|droit|justice|législatif)\b/)) { sources.push({ title: "Légifrance", url: "https://www.legifrance.gouv.fr/", snippet: "Le service public de la diffusion du droit en France.", reliability: 0.99, sourceCategory: 'primary', isOfficialData: true }); }
    return sources;
}
async function getOfficialSources(claimText) {
    const sources = [];
    const lowerText = claimText.toLowerCase();
    if (lowerText.includes('marie') && lowerText.includes('curie')) { sources.push({ title: "The Nobel Prize: Marie Curie Facts", url: "https://www.nobelprize.org/prizes/physics/1903/marie-curie/facts/", snippet: "Biographie et faits officiels sur Marie Curie par la Fondation Nobel.", reliability: 0.98, sourceCategory: 'primary', isOfficialData: true }); }
    if (lowerText.includes('france') && (lowerText.includes('population') || lowerText.includes('habitants'))) { sources.push({ title: "INSEE - Population de la France", url: "https://www.insee.fr/fr/statistiques/series/010565252", snippet: "Données démographiques officielles de l'Institut National de la Statistique.", reliability: 0.99, sourceCategory: 'primary', isOfficialData: true }); }
    return sources;
}
function deduplicateAndRankSources(sources) {
    const seen = new Map();
    sources.forEach(source => { const domain = extractDomain(source.url); if (!seen.has(domain)) { seen.set(domain, source); } });
    return Array.from(seen.values()).sort((a, b) => (b.reliability || 0) - (a.reliability || 0)).slice(0, 8);
}
function calculateConfidenceScore(claims, sources) {
    if (sources.length === 0) { return { score: 0.20, explanation: "Score faible. Aucune source externe n'a pu être trouvée pour vérifier les affirmations." }; }
    let score = 0.25;
    const qualitySources = sources.filter(s => s.isOfficialData || s.reliability > 0.9);
    const wikipediaSources = sources.filter(s => s.sourceCategory === 'encyclopedia');
    if (qualitySources.length > 0) { score += 0.25; score += (qualitySources.length - 1) * 0.05; }
    score += Math.min(sources.length, 5) * 0.04;
    const categories = new Set(sources.map(s => s.sourceCategory));
    if (categories.size > 1) { score += categories.size * 0.06; }
    if (sources.length > 0 && wikipediaSources.length === sources.length) { score -= 0.10; }
    const finalScore = Math.max(0.20, Math.min(0.98, score));
    const explanation = generateScoringExplanation(finalScore, sources, qualitySources, categories);
    return { score: finalScore, explanation };
}
function generateScoringExplanation(finalScore, sources, qualitySources, categories) {
    const scorePercent = Math.round(finalScore * 100);
    let reason = `Score de ${scorePercent}% basé sur ${sources.length} source(s) trouvée(s).`;
    if (qualitySources.length > 0) { reason += ` Inclus **${qualitySources.length} source(s) de haute qualité** (officielles/académiques).`; }
    if (categories.size > 1) { reason += ` La vérification couvre **${categories.size} domaines différents**, renforçant la fiabilité.`; }
    if (scorePercent < 40) { reason += " La faible pertinence ou le manque de sources fiables expliquent ce score bas." }
    return reason;
}
async function performComprehensiveFactCheck(text) {
    const cleanedText = cleanText(text);
    const claims = extractIntelligentClaims(cleanedText);
    const keywords = [...new Set(claims.flatMap(extractKeywords))];
    if (claims.length === 0) { return { overallConfidence: 0.25, sources: [], extractedKeywords: keywords, contradictions: [], scoringExplanation: "Le texte ne contient pas d'affirmations factuelles claires à vérifier."}; }
    const sourcePromises = claims.flatMap(claim => [searchWikipedia(claim), getDomainSpecificSources(claim), getOfficialSources(claim)]);
    const allSourcesNested = await Promise.all(sourcePromises);
    const sources = deduplicateAndRankSources(allSourcesNested.flat().filter(Boolean));
    const { score, explanation } = calculateConfidenceScore(claims, sources);
    return { overallConfidence: score, sources: sources, extractedKeywords: keywords.slice(0, 5), contradictions: [], scoringExplanation: explanation };
}

// --- Routes API ---
app.get("/", (req, res) => res.send("✅ API Fact-Checker IA Pro - Version avec Feedback"));
app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Texte manquant.' });
        const result = await performComprehensiveFactCheck(text);
        res.json(result);
    } catch (error) {
        console.error("Erreur dans /verify:", error);
        res.status(500).json({ error: 'Échec de la vérification interne.' });
    }
});
app.post('/feedback', async (req, res) => {
    const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
    if (originalText == null || scoreGiven == null || isUseful == null) { return res.status(400).json({ error: 'Données de feedback manquantes.' }); }
    try {
        const client = await pool.connect();
        const query = `INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1, $2, $3, $4, $5) RETURNING id;`;
        const values = [originalText, scoreGiven, isUseful, comment || null, JSON.stringify(sourcesFound)];
        const result = await client.query(query, values);
        client.release();
        console.log(`📝 Feedback enregistré avec l'ID: ${result.rows[0].id}`);
        res.status(201).json({ success: true, feedbackId: result.rows[0].id });
    } catch (err) {
        console.error('❌ Erreur lors de l-enregistrement du feedback:', err);
        res.status(500).json({ error: 'Impossible d-enregistrer le feedback.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fact-Checker IA Pro (V-Feedback) démarré sur port ${PORT}`);
    initializeDb();
});
