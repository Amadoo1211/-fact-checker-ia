// server.js - VERSION 5.0 - MOTEUR GÉNÉRALISTE
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*'] }));
app.use(express.json());

// ===================================================================================
// DÉTECTION DE CONTENU NON FACTUEL (INCHANGÉ)
// ===================================================================================
function isFactCheckable(text) {
    const textLower = text.toLowerCase();
    const nonFactualIndicators = [
        'je pense que', 'à mon avis', 'il me semble', 'je crois que', 'un plaisir', 'j\'aime',
        'how can i help', 'hello!', 'bonjour!', 'je suis là pour vous aider'
    ];
    if (text.split(' ').length < 8 || nonFactualIndicators.some(i => textLower.includes(i))) return false;
    if (!/\d+|[A-Z][a-z]+/.test(text)) return false;
    return true;
}

// ===================================================================================
// EXTRACTION DE MOTS-CLÉS (INCHANGÉ)
// ===================================================================================
function extractPreciseKeywords(text) {
    const cleaned = text.replace(/^(Oui|Non|Bien sûr|Voici|En effet|Selon)[,.\s:]*/gi, '').substring(0, 400);
    let keywords = (cleaned.match(/\b[A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ]+){0,2}\b/g) || []);
    keywords = keywords.filter(k => k.length > 3 && !['Oui', 'Non', 'Voici'].includes(k));
    const dates = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
    if (dates) keywords.push(...dates);
    const unique = [...new Set(keywords.map(k => k.toLowerCase()))];
    console.log('Mots-clés extraits:', unique.slice(0, 4));
    return unique.slice(0, 4);
}

// ===================================================================================
// NOUVEAU : ÉVALUATION DE LA FIABILITÉ D'UNE SOURCE
// ===================================================================================
function getSourceReliability(url) {
    const u = url.toLowerCase();
    // Très haute fiabilité (sites gouvernementaux, éducatifs, institutions majeures)
    if (/\.(gov|gouv|edu)\b|europa\.eu|who\.int|unesco\.org|ipcc\.ch|insee\.fr|nobelprize\.org/.test(u)) return 0.95;
    // Haute fiabilité (grandes encyclopédies, revues scientifiques reconnues)
    if (/britannica\.com|universalis\.fr|nature\.com|sciencemag\.org/.test(u)) return 0.90;
    // Bonne fiabilité (agences de presse internationales, grands journaux de référence)
    if (/reuters\.com|apnews\.com|afp\.com|lemonde\.fr|nytimes\.com|bbc\.com/.test(u)) return 0.80;
    // Fiabilité correcte (Wikipedia)
    if (/wikipedia\.org/.test(u)) return 0.70;
    // Fiabilité moyenne (autres médias connus, sites spécialisés)
    if (/\.(org|com|fr)/.test(u)) return 0.50;
    return 0.30; // Faible fiabilité par défaut
}

// ===================================================================================
// NOUVEAU : RECHERCHE DE SOURCES GÉNÉRALISTE
// ===================================================================================
async function searchGeneralistSources(keywords) {
    if (!keywords || keywords.length === 0) return [];
    
    // On crée une requête de recherche plus intelligente
    const query = `"${keywords.join('" "')}" source fiable OR "faits sur ${keywords[0]}"`;
    console.log(`Recherche Google: ${query}`);
    
    // Simuler un appel à une API de recherche (remplacez par un vrai appel si vous en avez une)
    // Ici, nous utilisons une recherche web simulée pour l'exemple.
    // Dans un vrai projet, il faudrait une clé API pour Google Search ou une alternative.
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    
    // NOTE: Le scraping direct de Google est instable. Une API est recommandée.
    // Pour cet exemple, nous allons construire des sources fictives basées sur les mots-clés.
    // C'est ici que la magie opère en production avec une vraie API.
    
    // Simulation de résultats pour Marie Curie
    if (keywords.includes('marie curie')) {
        return [
            { title: "Marie Curie - Nobel Prize in Physics 1903", url: "https://www.nobelprize.org/prizes/physics/1903/marie-curie/facts/", snippet: "Marie Curie a reçu le prix Nobel pour ses recherches sur les radiations..." },
            { title: "Marie Curie - Wikipedia", url: "https://fr.wikipedia.org/wiki/Marie_Curie", snippet: "Marie Skłodowska-Curie, née le 7 novembre 1867 à Varsovie..." },
            { title: "Biographie : Marie Curie - L'internaute", url: "https://www.linternaute.fr/science/marie-curie/", snippet: "Découvrez la biographie de Marie Curie, ses photos, vidéos." }
        ].map(s => ({ ...s, reliability: getSourceReliability(s.url) }));
    }
    
    // Si pas de mot-clé spécifique, retourner un tableau vide
    return [];
}


// ===================================================================================
// NOUVEAU : CALCUL DU SCORE GÉNÉRALISTE
// ===================================================================================
function calculateGeneralistScore(sources) {
    if (sources.length === 0) {
        return { score: 0.20, explanation: "**Fiabilité faible** : Aucune source externe pertinente n'a pu être trouvée pour vérifier ces informations." };
    }

    // Calcule la moyenne pondérée de la fiabilité des 3 meilleures sources
    const topSources = sources.slice(0, 3);
    const totalReliability = topSources.reduce((acc, src) => acc + src.reliability, 0);
    let score = totalReliability / topSources.length;

    // Bonus pour la quantité et la qualité
    if (sources.length >= 3) score += 0.10;
    if (sources.some(s => s.reliability >= 0.90)) score += 0.15; // Bonus pour une source excellente

    score = Math.min(0.95, score); // Plafonner à 95%

    let explanation = `Score: ${Math.round(score * 100)}%. `;
    if (score >= 0.80) explanation += "**Très bonne fiabilité**, soutenue par plusieurs sources de haute qualité.";
    else if (score >= 0.65) explanation += "**Fiabilité correcte**, les informations sont corroborées par des sources crédibles.";
    else if (score >= 0.50) explanation += "**Fiabilité moyenne**, les sources sont présentes mais de qualité variable.";
    else explanation += "**Fiabilité faible**, les sources trouvées sont peu nombreuses ou peu fiables.";

    return { score, explanation };
}


// ===================================================================================
// FONCTION PRINCIPALE MISE À JOUR
// ===================================================================================
async function performFactCheck(text) {
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
    
    const foundSources = await searchGeneralistSources(keywords);
    
    // Trier les sources par fiabilité décroissante
    foundSources.sort((a, b) => b.reliability - a.reliability);
    
    const { score, explanation } = calculateGeneralistScore(foundSources);
    
    return {
        overallConfidence: score,
        sources: foundSources.slice(0, 4), // On retourne les 4 meilleures sources
        extractedKeywords: keywords,
        scoringExplanation: explanation
    };
}


// ===================================================================================
// ROUTES EXPRESS
// ===================================================================================
app.get("/", (req, res) => res.send("✅ Fact-Checker API v5.0 - Généraliste"));

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
    console.log(`🚀 Fact-Checker v5.0 (Généraliste) sur port ${PORT}`);
});
