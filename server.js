// server.js - VERSION 7.0 - FINALE STABLE
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*'] }));
app.use(express.json());

const API_HEADERS = { 'User-Agent': 'FactCheckerIA/7.0 (boud3285@gmail.com)' };

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ÉTAGE 1 : FILTRE FONDAMENTAL (RENFORCÉ)
function isFactCheckable(text) {
    const textLower = text.toLowerCase();
    const nonFactualIndicators = [
        'je pense que', 'à mon avis', 'selon moi', 'il me semble', 'je crois que', 'un plaisir', 'j\'aime', 'personnellement',
        'how can i help', 'hello!', 'bonjour!', 'je suis là pour vous aider', 'looks like you\'re testing', 'it seems you are testing'
    ];
    if (text.split(' ').length < 12 || nonFactualIndicators.some(i => textLower.includes(i))) {
        console.log('[Analyse Contenu] Non factuel détecté.');
        return false;
    }
    if (!/\d+|[A-Z][a-z]{4,}/.test(text)) {
        console.log('[Analyse Contenu] Manque d\'éléments vérifiables.');
        return false;
    }
    return true;
}

// Extraction de mots-clés pour la recherche généraliste
function extractGeneralKeywords(text) {
    let keywords = (text.match(/\b[A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ]+){0,2}\b/g) || []);
    keywords = keywords.filter(k => k.length > 4 && k.toLowerCase() !== 'france');
    if (keywords.length === 0) {
        keywords = (text.match(/\b\w{7,}\b/g) || []).slice(0, 3);
    }
    const unique = [...new Set(keywords.map(k => k.toLowerCase()))];
    console.log('Mots-clés extraits pour Wikipédia:', unique.slice(0, 3));
    return unique.slice(0, 3);
}

// ÉTAGE 2 : RECHERCHE DE PREUVES (MODÈLE HYBRIDE)
async function findSources(text) {
    const textLower = text.toLowerCase();
    const sources = [];

    // Règle N°1 - L'Expert lit tout le texte
    if (textLower.includes('insee') || (textLower.includes('population') && textLower.includes('france'))) {
        sources.push({ title: "INSEE - Population française officielle", url: "https://www.insee.fr/fr/statistiques/1893198", snippet: "L'INSEE fournit les données démographiques officielles pour la France.", sourceCategory: 'expert' });
    }
    if (textLower.includes('giec') || textLower.includes('climat') || textLower.includes('réchauffement')) {
        sources.push({ title: "GIEC - Rapports d'évaluation sur le climat", url: "https://www.ipcc.ch/reports/", snippet: "Le GIEC est l'organe de l'ONU chargé d'évaluer la science relative au changement climatique.", sourceCategory: 'expert' });
    }

    // Règle N°2 - Le Généraliste cherche sur Wikipédia
    const keywords = extractGeneralKeywords(text);
    if (keywords.length > 0) {
        try {
            const query = keywords.join(' ');
            const url = `https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch="${encodeURIComponent(query)}"&format=json&origin=*&srlimit=2`;
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
    }
    
    return Array.from(new Map(sources.map(s => [s.url, s])).values());
}

// ÉTAGES 3, 4 & SOMMET : CALCUL DU SCORE (PYRAMIDE DE CONFIANCE)
function calculatePyramidScore(sources) {
    if (sources.length === 0) {
        return { score: 0.20, explanation: "**Fiabilité faible**. Aucune source externe pertinente n'a pu être trouvée." };
    }

    const expertSources = sources.filter(s => s.sourceCategory === 'expert');
    const wikiSources = sources.filter(s => s.sourceCategory === 'wikipedia');
    const highlyRelevantWiki = wikiSources.filter(s => s.isHighlyRelevant);

    let score = 0.20;
    let explanation = "";

    if (expertSources.length > 0) {
        score = 0.85;
        explanation = "La présence d'une source officielle confère une très haute fiabilité.";
        if (wikiSources.length > 0) {
            score = 0.95;
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
            scoringExplanation: "**Contenu non factuel**. Ce texte semble être une opinion ou une conversation."
        };
    }
    
    const sources = await findSources(text);
    const { score, explanation } = calculatePyramidScore(sources);
    
    return { overallConfidence: score, sources, scoringExplanation: explanation };
}

// ROUTES EXPRESS
app.get("/", (req, res) => res.send("✅ Fact-Checker API v7.0 - Stable"));

app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.length < 10) return res.status(400).json({ error: 'Texte trop court' });
        const result = await performFactCheck(text);
        res.json(result);
    } catch (error) {
        console.error("Erreur /verify:", error);
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
        console.error('Erreur feedback:', err);
        res.status(500).json({ error: 'Erreur sauvegarde feedback' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fact-Checker v7.0 (Stable) sur port ${PORT}`);
});
