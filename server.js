// server.js - VERSION FINALE CORRIGÉE - Logique de pertinence et scoring avancée
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

const API_HEADERS = {
    'User-Agent': 'FactCheckerIA/2.3 (boud3285@gmail.com; https://github.com/Amadoo1211/-fact-checker-ia)'
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
    const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'dans', 'sur', 'avec', 'par', 'pour', 'qui', 'que', 'est', 'sont', 'il', 'elle', 'a', 'été', 'dit', 'événement', 'chute']);
    
    // Priorité 1: Noms propres et lieux (ex: Mur de Berlin, Marie Curie, Guido van Rossum)
    let keywords = text.match(/\b[A-ZÀ-ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-ÿ][a-zà-ÿ]+){1,3}\b/g) || [];
    
    // Priorité 2: Dates (1989), acronymes (INSEE), et termes techniques (Python)
    keywords.push(...(text.match(/\b(19|20)\d{2}\b/g) || []));
    keywords.push(...(text.match(/\b[A-Z]{2,}\b/g) || [])); // Acronymes comme INSEE, PIB...
    if (text.toLowerCase().includes('python')) keywords.push('Python');
    
    // Nettoyage final
    let uniqueKeywords = [...new Set(keywords)];
    let finalKeywords = uniqueKeywords.filter(kw => !stopWords.has(kw.toLowerCase()));

    // Si après tout ça il n'y a rien, on prend les mots longs en dernier recours
    if (finalKeywords.length === 0) {
        finalKeywords = text.toLowerCase().replace(/[^\w\sà-ÿ]/g, ' ').split(/\s+/)
            .filter(word => word.length > 5 && !stopWords.has(word));
    }
    
    console.log(`Mots-clés extraits: [${finalKeywords.slice(0, 5).join(', ')}]`);
    return finalKeywords.slice(0, 5);
}

async function searchWikipedia(query) {
    const sources = [];
    for (const lang of ['fr', 'en']) {
        try {
            if (!query) continue;
            const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=2`;
            const res = await fetch(url, { headers: API_HEADERS });
            const data = await res.json();
            if (data.query?.search) {
                for (const article of data.query.search.slice(0, 1)) { // On ne prend que le 1er résultat, le plus pertinent
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

function calculateConfidenceScore(keywords, sources) {
    if (sources.length === 0) { return { score: 0.23, explanation: "Score de 23% basé sur 0 source(s) trouvée(s). La faible pertinence ou le manque de sources fiables expliquent ce score bas." }; }
    let score = 0.25;
    const qualitySources = sources.filter(s => s.isOfficialData || s.reliability > 0.9);
    if (qualitySources.length > 0) { score += 0.30; score += (qualitySources.length - 1) * 0.05; }
    score += Math.min(sources.length, 5) * 0.05;
    const categories = new Set(sources.map(s => s.sourceCategory));
    if (categories.size > 1) { score += categories.size * 0.07; }
    const finalScore = Math.max(0.20, Math.min(0.98, score));
    const explanation = generateScoringExplanation(finalScore, sources, qualitySources, categories);
    return { score: finalScore, explanation };
}

function generateScoringExplanation(finalScore, sources, qualitySources, categories) {
    const scorePercent = Math.round(finalScore * 100);
    let reason = `Score de ${scorePercent}% basé sur ${sources.length} source(s) trouvée(s).`;
    if (qualitySources.length > 0) { reason += ` Inclus **${qualitySources.length} source(s) de haute qualité**.`; }
    if (categories.size > 1) { reason += ` La vérification couvre **${categories.size} domaines différents**, renforçant la fiabilité.`; }
    return reason;
}

async function performComprehensiveFactCheck(text) {
    const cleanedText = cleanTextForAnalysis(text);
    const keywords = extractBestKeywords(cleanedText);
    if (keywords.length === 0) { return { overallConfidence: 0.25, sources: [], extractedKeywords: [], contradictions: [], scoringExplanation: "Le texte ne contient pas d'éléments suffisamment distinctifs pour lancer une recherche."}; }
    const sourcePromises = [searchWikipedia(keywords.join(' ')), ...keywords.map(kw => getDomainSpecificSources(kw)), ...keywords.map(kw => getOfficialSources(kw))];
    const allSourcesNested = await Promise.all(sourcePromises);
    const sources = deduplicateAndRankSources(allSourcesNested.flat().filter(Boolean));
    const { score, explanation } = calculateConfidenceScore(keywords, sources);
    return { overallConfidence: score, sources: sources, extractedKeywords: keywords, contradictions: [], scoringExplanation: explanation };
}

app.get("/", (req, res) => res.send("✅ API Fact-Checker IA Pro - Version Finale Corrigée"));
app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Texte manquant.' });
        const result = await performComprehensiveFactCheck(text);
        res.json(result);
    } catch (error) { console.error("Erreur dans /verify:", error); res.status(500).json({ error: 'Échec de la vérification interne.' }); }
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
    } catch (err) { console.error('❌ Erreur lors de l-enregistrement du feedback:', err); res.status(500).json({ error: 'Impossible d-enregistrer le feedback.' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fact-Checker IA Pro (V-Finale) démarré sur port ${PORT}`);
    initializeDb();
});
