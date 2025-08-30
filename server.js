// server.js - VERSION 9.0 - FINALE STABLE
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*'] }));
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const API_HEADERS = { 'User-Agent': 'FactCheckerIA/9.0 (boud3285@gmail.com)' };

// FILTRE À OPINIONS (LOGIQUE INVERSÉE)
function isFactCheckable(text) {
    const textLower = text.toLowerCase();
    const nonFactualIndicators = [
        'je pense que', 'à mon avis', 'selon moi', 'il me semble', 'je crois que', 'un plaisir', 'j\'aime', 'personnellement',
        'how can i help', 'hello!', 'bonjour!', 'je suis là pour vous aider', 'looks like you\'re testing'
    ];
    if (nonFactualIndicators.some(i => textLower.includes(i))) return false;
    const hasFactualClues = /\d/.test(text) || /\b[A-Z][a-z]{4,}/.test(text);
    if (text.split(' ').length < 15 && !hasFactualClues) return false;
    return true;
}

// EXTRACTION DE MOTS-CLÉS (POUR LE CLIENT)
function extractKeywordsForClient(text) {
    let keywords = (text.match(/\b[A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ]+){0,2}\b/g) || []);
    keywords = keywords.filter(k => k.length > 4 && k.toLowerCase() !== 'france');
    if (keywords.length < 2) {
        const generalWords = (text.match(/\b\w{7,}\b/g) || []);
        keywords.push(...generalWords);
    }
    const unique = [...new Set(keywords.map(k => k.toLowerCase().trim()))];
    console.log('Mots-clés extraits pour client:', unique.slice(0, 3));
    return unique.slice(0, 3);
}

// FONCTION PRINCIPALE DU SERVEUR
async function performExpertCheck(text) {
    if (!isFactCheckable(text)) {
        return {
            status: 'NON_FACTUAL',
            overallConfidence: 0.10,
            sources: [],
            scoringExplanation: "**Contenu non factuel**. Ce texte semble être une opinion ou une conversation."
        };
    }

    const textLower = text.toLowerCase();
    const expertSources = [];

    if (textLower.includes('insee') || (textLower.includes('population') && textLower.includes('france'))) {
        expertSources.push({ title: "INSEE - Population française officielle", url: "https://www.insee.fr/fr/statistiques/1893198", snippet: "L'INSEE fournit les données démographiques officielles pour la France.", sourceCategory: 'expert' });
    }
    if (textLower.includes('giec') || textLower.includes('climat') || textLower.includes('réchauffement')) {
        expertSources.push({ title: "GIEC - Rapports d'évaluation sur le climat", url: "https://www.ipcc.ch/reports/", snippet: "Le GIEC est l'organe de l'ONU chargé d'évaluer la science relative au changement climatique.", sourceCategory: 'expert' });
    }

    if (expertSources.length > 0) {
        return {
            status: 'EXPERT_SUCCESS',
            overallConfidence: 0.85,
            sources: expertSources,
            scoringExplanation: "Score: 85%. La présence d'une source officielle confère une très haute fiabilité."
        };
    } else {
        return {
            status: 'CLIENT_SEARCH_REQUIRED',
            keywords: extractKeywordsForClient(text)
        };
    }
}

// ROUTES EXPRESS
app.get("/", (req, res) => res.send("✅ Fact-Checker API v9.0 - Finale"));

app.post('/verify', async (req, res) => {
    try {
        let { text } = req.body;
        if (!text || text.length < 20) return res.status(400).json({ error: 'Texte trop court' });
        // Nettoyage du texte potentiellement "sale"
        text = text.replace(/Regenerate response/gi, '').trim();
        const result = await performExpertCheck(text);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: "Erreur interne du serveur" });
    }
});

app.post('/feedback', async (req, res) => {
    const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
    try {
        const client = await pool.connect();
        await client.query( `INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)`,
            [originalText, scoreGiven, isUseful, comment, JSON.stringify(sourcesFound)]
        );
        client.release();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Erreur sauvegarde feedback' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Fact-Checker v9.0 (Finale) sur port ${PORT}`); });
