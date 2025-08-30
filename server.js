// server.js - VERSION 4.0 - AVEC DÉTECTION D'OPINION
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
// ... (le reste de vos 'require' et configurations initiales)
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*', 'https-fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

const API_HEADERS = {
    'User-Agent': 'FactCheckerIA/4.0 (boud3285@gmail.com)'
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});


// ===================================================================================
// NOUVELLE FONCTION : DÉTECTION DE CONTENU NON FACTUEL
// ===================================================================================
function isFactCheckable(text) {
    const textLower = text.toLowerCase();
    
    // Mots-clés et phrases indiquant une opinion ou une subjectivité
    const opinionIndicators = [
        'je pense que', 'à mon avis', 'selon moi', 'il me semble', 'je crois que',
        'magnifique', 'superbe', 'un plaisir', 'c\'est bon', 'c\'est mauvais', 'préfère', 'j\'aime', 'je déteste'
    ];
    
    // Phrases de conversation ou de test
    const metaIndicators = [
        'testing me', 'you\'re testing', 'how can i help', 'how may i assist', 'hello!', 'bonjour!',
        'je suis là pour vous aider', 'posez-moi une question'
    ];
    
    // Texte trop court pour être factuel
    if (text.split(' ').length < 7) {
        console.log('[Analyse Contenu] Texte trop court.');
        return false;
    }
    
    if (opinionIndicators.some(indicator => textLower.includes(indicator))) {
        console.log('[Analyse Contenu] Opinion détectée.');
        return false;
    }
    
    if (metaIndicators.some(indicator => textLower.includes(indicator))) {
        console.log('[Analyse Contenu] Méta-conversation détectée.');
        return false;
    }
    
    // Si le texte est une question ouverte
    if (text.trim().endsWith('?') && !textLower.includes('quel est') && !textLower.includes('combien')) {
        console.log('[Analyse Contenu] Question ouverte détectée.');
        return false;
    }
    
    return true; // Le texte semble factuel
}


// ... (vos fonctions extractPreciseKeywords, searchWikipediaFixed, getContextualOfficialSources, calculateRealScore restent les mêmes) ...
function extractPreciseKeywords(text) {
    // ...
    return []; // Placeholder for brevity, your code is here
}
async function searchWikipediaFixed(keywords) {
    // ...
    return []; // Placeholder for brevity, your code is here
}
function getContextualOfficialSources(text, keywords) {
    // ...
    return []; // Placeholder for brevity, your code is here
}
function calculateRealScore(originalText, sources) {
    // ...
    return { score: 0.15, explanation: "Default" }; // Placeholder for brevity, your code is here
}


// ===================================================================================
// FONCTION PRINCIPALE MISE À JOUR AVEC LA NOUVELLE LOGIQUE
// ===================================================================================
async function performFactCheck(text) {
    console.log('[FACT-CHECK] Début analyse:', text.substring(0, 100));

    // Étape 1: Vérifier si le texte est factuel
    if (!isFactCheckable(text)) {
        return {
            overallConfidence: 0.10, // Score très bas
            sources: [],
            extractedKeywords: [],
            scoringExplanation: "**Contenu non factuel**. Ce texte semble être une opinion, une salutation ou une affirmation non vérifiable. Aucune recherche de source n'a été effectuée."
        };
    }
    
    // Le reste de la fonction ne s'exécute que si le texte est factuel
    const keywords = extractPreciseKeywords(text);
    
    if (keywords.length === 0) {
        return {
            overallConfidence: 0.18,
            sources: [],
            extractedKeywords: [],
            scoringExplanation: "Aucun mot-clé pertinent trouvé pour lancer une recherche."
        };
    }
    
    const [wikiSources, officialSources] = await Promise.all([
        searchWikipediaFixed(keywords),
        Promise.resolve(getContextualOfficialSources(text, keywords))
    ]);
    
    const allSources = [...officialSources, ...wikiSources];
    const uniqueSources = Array.from(new Map(allSources.map(s => [s.url, s])).values()).slice(0, 10);
    
    const { score, explanation } = calculateRealScore(text, uniqueSources);
    
    return {
        overallConfidence: score,
        sources: uniqueSources,
        extractedKeywords: keywords,
        scoringExplanation: explanation
    };
}

// ... (vos routes Express restent les mêmes) ...
app.get("/", (req, res) => res.send("✅ Fact-Checker API v4.0 - Opinion Detection OK"));

app.post('/verify', async (req, res) => {
    // ...
    try {
        const { text } = req.body;
        if (!text || text.length < 5) { // Seuil abaissé
            return res.status(400).json({ error: 'Texte trop court' });
        }
        const result = await performFactCheck(text);
        res.json(result);
    } catch (error) {
        console.error("Erreur /verify:", error);
        res.status(500).json({ error: "Erreur interne du serveur" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fact-Checker v4.0 sur port ${PORT}`);
});
