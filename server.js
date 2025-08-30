// server.js - VERSION 4.1 - FINALE ET COMPLÈTE
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*'] }));
app.use(express.json());

const API_HEADERS = { 'User-Agent': 'FactCheckerIA/4.1 (boud3285@gmail.com)' };

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ===================================================================================
// DÉTECTION DE CONTENU NON FACTUEL
// ===================================================================================
function isFactCheckable(text) {
    const textLower = text.toLowerCase();
    
    // Phrases indiquant une opinion, une subjectivité ou une conversation
    const nonFactualIndicators = [
        'je pense que', 'à mon avis', 'selon moi', 'il me semble', 'je crois que',
        'magnifique', 'superbe', 'un plaisir', 'c\'est bon', 'c\'est mauvais', 'préfère', 'j\'aime', 'je déteste',
        'testing me', 'you\'re testing', 'how can i help', 'how may i assist', 'hello!', 'bonjour!',
        'je suis là pour vous aider', 'comment puis-je vous aider', 'posez-moi une question'
    ];

    if (text.split(' ').length < 8 || nonFactualIndicators.some(indicator => textLower.includes(indicator))) {
        console.log('[Analyse Contenu] Non factuel détecté (opinion, conversation ou trop court).');
        return false;
    }
    
    // Vérifie la présence d'éléments potentiellement factuels (chiffres, dates, noms propres)
    const factualClues = /\d+|[A-Z][a-z]+/.test(text);
    if (!factualClues) {
        console.log('[Analyse Contenu] Non factuel détecté (manque d\'éléments vérifiables).');
        return false;
    }

    return true; // Le texte semble factuel et vérifiable
}

// ===================================================================================
// EXTRACTION DE MOTS-CLÉS (Intégrée depuis votre code)
// ===================================================================================
function extractPreciseKeywords(text) {
    const cleaned = text.replace(/^(Oui|Non|Bien sûr|Voici|En effet|Selon)[,.\s:]*/gi, '').substring(0, 600);
    const keywords = [];
    const entities = cleaned.match(/\b[A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ]+){0,3}\b/g) || [];
    entities.forEach(entity => {
        if (entity.length > 2 && !['Oui', 'Non', 'Voici'].includes(entity)) keywords.push(entity.trim());
    });
    const dates = cleaned.match(/\b(19|20)\d{2}\b/gi) || [];
    keywords.push(...dates);
    const technical = cleaned.match(/\b(GIEC|INSEE|climat|population|France|économie)\b/gi) || [];
    if (technical) keywords.push(...technical);
    const numbers = cleaned.match(/\b\d+(?:\.\d+)?\s*(?:%|millions?|milliards?)\b/gi) || [];
    if (numbers) keywords.push(...numbers);
    const unique = [...new Set(keywords.map(k => k.toLowerCase()))].slice(0, 6);
    console.log('Mots-clés extraits:', unique);
    return unique;
}

// ===================================================================================
// RECHERCHE WIKIPEDIA (Intégrée depuis votre code)
// ===================================================================================
async function searchWikipediaFixed(keywords) {
    if (!keywords || keywords.length === 0) return [];
    const sources = [];
    const query = keywords.join(' ');
    for (const lang of ['fr', 'en']) {
        try {
            const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch="${encodeURIComponent(query)}"&format=json&origin=*&srlimit=2`;
            const res = await fetch(url, { headers: API_HEADERS, timeout: 4000 });
            const data = await res.json();
            if (data.query?.search?.length > 0) {
                for (const article of data.query.search) {
                    sources.push({
                        title: `Wikipedia (${lang.toUpperCase()}): ${article.title}`,
                        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(article.title.replace(/ /g, '_'))}`,
                        snippet: article.snippet.replace(/<[^>]*>/g, ''),
                        reliability: lang === 'fr' ? 0.85 : 0.82,
                        sourceCategory: 'encyclopedia'
                    });
                }
            }
        } catch (e) { console.warn(`Wiki ${lang} erreur:`, e.message); }
    }
    return sources;
}

// ===================================================================================
// SOURCES OFFICIELLES (Intégrées depuis votre code)
// ===================================================================================
function getContextualOfficialSources(text, keywords) {
    const sources = [];
    const allText = (keywords.join(' ') + ' ' + text).toLowerCase();
    if ((allText.includes('population') || allText.includes('habitants')) && allText.includes('france')) {
        sources.push({ title: "INSEE - Population française officielle", url: "https://www.insee.fr/fr/statistiques/1893198", snippet: "L'INSEE fournit les données démographiques officielles pour la France, actualisées annuellement.", reliability: 0.99, sourceCategory: 'primary', isOfficialData: true });
    }
    if (allText.includes('giec') || allText.includes('climat') || allText.includes('réchauffement')) {
        sources.push({ title: "GIEC - Rapports d'évaluation sur le climat", url: "https://www.ipcc.ch/reports/", snippet: "Le GIEC est l'organe des Nations Unies chargé d'évaluer les données scientifiques relatives au changement climatique.", reliability: 0.98, sourceCategory: 'scientific', isOfficialData: true });
    }
    return sources;
}

// ===================================================================================
// CALCUL DU SCORE (Intégré et ajusté depuis votre code)
// ===================================================================================
function calculateRealScore(sources) {
    if (sources.length === 0) return { score: 0.20, explanation: "**Fiabilité faible** en raison de l'absence totale de sources externes." };
    
    let finalScore = 0.25;
    const officialSources = sources.filter(s => s.isOfficialData);
    const wikiSources = sources.filter(s => s.sourceCategory === 'encyclopedia');

    if (officialSources.length > 0) finalScore = 0.80;
    else if (wikiSources.length >= 2) finalScore = 0.65;
    else if (wikiSources.length === 1) finalScore = 0.50;

    if (officialSources.length > 0 && wikiSources.length > 0) finalScore += 0.10;
    if (sources.length >= 4) finalScore += 0.05;

    finalScore = Math.min(0.95, finalScore); // Plafonner le score
    
    let explanation = `Score: ${Math.round(finalScore * 100)}%. `;
    if (finalScore >= 0.75) explanation += "**Très bonne fiabilité** basée sur des sources officielles ou encyclopédiques de haute qualité.";
    else if (finalScore >= 0.60) explanation += "**Fiabilité correcte** soutenue par plusieurs sources pertinentes.";
    else explanation += "**Fiabilité limitée** due au manque de sources concordantes ou de haute qualité.";
    
    return { score: finalScore, explanation };
}

// ===================================================================================
// FONCTION PRINCIPALE
// ===================================================================================
async function performFactCheck(text) {
    console.log('[FACT-CHECK] Début analyse:', text.substring(0, 100));

    if (!isFactCheckable(text)) {
        return {
            overallConfidence: 0.10,
            sources: [],
            extractedKeywords: [],
            scoringExplanation: "**Contenu non factuel**. Ce texte semble être une opinion, une salutation ou une affirmation non vérifiable."
        };
    }
    
    const keywords = extractPreciseKeywords(text);
    if (keywords.length === 0) {
        return {
            overallConfidence: 0.18,
            sources: [],
            extractedKeywords: keywords,
            scoringExplanation: "Aucun mot-clé pertinent trouvé pour lancer une recherche."
        };
    }
    
    const [wikiSources, officialSources] = await Promise.all([
        searchWikipediaFixed(keywords),
        Promise.resolve(getContextualOfficialSources(text, keywords))
    ]);
    
    const allSources = [...officialSources, ...wikiSources];
    const uniqueSources = Array.from(new Map(allSources.map(s => [s.url, s])).values());
    
    const { score, explanation } = calculateRealScore(uniqueSources);
    
    return {
        overallConfidence: score,
        sources: uniqueSources,
        extractedKeywords: keywords,
        scoringExplanation: explanation
    };
}

// ===================================================================================
// ROUTES EXPRESS
// ===================================================================================
app.get("/", (req, res) => res.send("✅ Fact-Checker API v4.1 - Final"));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fact-Checker v4.1 sur port ${PORT}`);
});
