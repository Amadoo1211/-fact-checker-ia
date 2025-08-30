// server.js - VERSION 6.0 - PYRAMIDE DE CONFIANCE (FINALE)
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*'] }));
app.use(express.json());

const API_HEADERS = { 'User-Agent': 'FactCheckerIA/6.0 (boud3285@gmail.com)' };

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ÉTAGE 1 : FILTRE FONDAMENTAL
function isFactCheckable(text) {
    const textLower = text.toLowerCase();
    const nonFactualIndicators = [
        'je pense que', 'à mon avis', 'il me semble', 'je crois que', 'un plaisir', 'j\'aime', 'personnellement',
        'how can i help', 'hello!', 'bonjour!', 'je suis là pour vous aider', 'looks like you\'re testing'
    ];
    if (text.split(' ').length < 10 || nonFactualIndicators.some(i => textLower.includes(i))) {
        console.log('[Analyse Contenu] Non factuel détecté.');
        return false;
    }
    if (!/\d+|[A-Z][a-z]{3,}/.test(text)) { // Cherche des nombres ou des noms propres de plus de 3 lettres
        console.log('[Analyse Contenu] Manque d\'éléments vérifiables.');
        return false;
    }
    return true;
}

// Extraction de mots-clés
function extractPreciseKeywords(text) {
    const cleaned = text.substring(0, 400);
    let keywords = (cleaned.match(/\b[A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ]+){0,2}\b/g) || []);
    keywords = keywords.filter(k => k.length > 4);
    if (keywords.length === 0) { // Fallback si aucun nom propre n'est trouvé
        keywords = (cleaned.match(/\b\w{6,}\b/g) || []).slice(0, 3);
    }
    const unique = [...new Set(keywords.map(k => k.toLowerCase()))];
    console.log('Mots-clés extraits:', unique.slice(0, 3));
    return unique.slice(0, 3);
}

// ÉTAGE 2 : RECHERCHE DE PREUVES
async function findSources(keywords) {
    const textQuery = keywords.join(' ');
    const sources = [];

    // Recherche "Experte" (codée en dur pour fiabilité maximale)
    if (textQuery.includes('insee') || textQuery.includes('population france')) {
        sources.push({ title: "INSEE - Population française officielle", url: "https://www.insee.fr/fr/statistiques/1893198", snippet: "L'INSEE fournit les données démographiques officielles pour la France.", reliability: 0.99, sourceCategory: 'expert' });
    }
    if (textQuery.includes('giec') || textQuery.includes('climat')) {
        sources.push({ title: "GIEC - Rapports d'évaluation sur le climat", url: "https://www.ipcc.ch/reports/", snippet: "Le GIEC est l'organe de l'ONU chargé d'évaluer la science relative au changement climatique.", reliability: 0.98, sourceCategory: 'expert' });
    }

    // Recherche "Généraliste" sur Wikipédia
    try {
        const url = `https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch="${encodeURIComponent(textQuery)}"&format=json&origin=*&srlimit=2`;
        const res = await fetch(url, { headers: API_HEADERS, timeout: 4000 });
        const data = await res.json();
        if (data.query?.search?.length > 0) {
            for (const article of data.query.search) {
                sources.push({
                    title: `Wikipedia (FR): ${article.title}`,
                    url: `https://fr.wikipedia.org/wiki/${encodeURIComponent(article.title.replace(/ /g, '_'))}`,
                    snippet: article.snippet.replace(/<[^>]*>/g, ''),
                    sourceCategory: 'wikipedia',
                    isHighlyRelevant: article.title.toLowerCase().includes(keywords[0])
                });
            }
        }
    } catch (e) { console.warn(`Wiki erreur:`, e.message); }
    
    return Array.from(new Map(sources.map(s => [s.url, s])).values()); // Déduplication
}

// ÉTAGES 3, 4 & SOMMET : CALCUL DU SCORE (PYRAMIDE DE CONFIANCE)
function calculatePyramidScore(sources) {
    if (sources.length === 0) {
        return { score: 0.20, explanation: "**Fiabilité faible**. Aucune source externe pertinente n'a pu être trouvée pour vérifier ces informations." };
    }

    const expertSources = sources.filter(s => s.sourceCategory === 'expert');
    const wikiSources = sources.filter(s => s.sourceCategory === 'wikipedia');
    const highlyRelevantWiki = wikiSources.filter(s => s.isHighlyRelevant);

    let score = 0.20; // Score de base
    let explanation = "";

    if (expertSources.length > 0) {
        score = 0.85;
        explanation = "La présence d'une source officielle ou experte confère une très haute fiabilité.";
        if (wikiSources.length > 0) {
            score = 0.95; // Sommet de la pyramide
            explanation = "**Excellente fiabilité**, confirmée par une source officielle et des sources encyclopédiques."
        }
    } else if (wikiSources.length >= 2) {
        score = 0.75;
        explanation = "**Très fiable**, l'information est corroborée par plusieurs sources encyclopédiques.";
    } else if (highlyRelevantWiki.length === 1) {
        score = 0.65;
        explanation = "**Fiable**, basé sur une source encyclopédique directement pertinente.";
    } else if (wikiSources.length === 1) {
        score = 0.50;
        explanation = "**Fiabilité moyenne**, une source encyclopédique a été trouvée.";
    }

    return { score, explanation: `Score: ${Math.round(score*100)}%. ${explanation}` };
}

// FONCTION PRINCIPALE
async function performFactCheck(text) {
    if (!isFactCheckable(text)) {
        return {
            overallConfidence: 0.10,
            sources: [],
            scoringExplanation: "**Contenu non factuel**. Ce texte semble être une opinion, une salutation ou une affirmation non vérifiable."
        };
    }
    
    const keywords = extractPreciseKeywords(text);
    if (keywords.length === 0) {
        return { overallConfidence: 0.18, sources: [], scoringExplanation: "Aucun mot-clé pertinent trouvé." };
    }
    
    const sources = await findSources(keywords);
    const { score, explanation } = calculatePyramidScore(sources);
    
    return { overallConfidence: score, sources, scoringExplanation: explanation };
}

// ROUTES EXPRESS
app.get("/", (req, res) => res.send("✅ Fact-Checker API v6.0 - Pyramide"));

app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.length < 10) return res.status(400).json({ error: 'Texte trop court' });
        const result = await performFactCheck(text);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: "Erreur interne du serveur" });
    }
});

app.post('/feedback', async (req, res) => {
    const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
    try {
        const client = await pool.connect();
        await client.query(
            `INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)`,
            [originalText, scoreGiven, isUseful, comment, JSON.stringify(sourcesFound)]
        );
        client.release();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Erreur sauvegarde feedback' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fact-Checker v6.0 (Pyramide) sur port ${PORT}`);
});
