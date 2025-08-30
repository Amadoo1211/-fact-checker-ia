// server.js - VERSION FINALE AVEC GOOGLE SEARCH ET FILTRE AMÉLIORÉ
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Configuration
app.use(cors({ origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

// Connexion à la base de données
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Initialisation de la base de données
const initDb = async () => {
    try {
        const client = await pool.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS feedback (
                id SERIAL PRIMARY KEY,
                original_text TEXT,
                score_given REAL,
                is_useful BOOLEAN,
                comment TEXT,
                sources_found JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        client.release();
        console.log('✅ DB prête');
    } catch (err) {
        console.error('Erreur DB:', err);
    }
};

// ===================================================================
//                 LA LOGIQUE DE L'APPLICATION
// ===================================================================

function extractMainKeywords(text) {
    const cleaned = text.normalize('NFC').replace(/['’]/g, "'").substring(0, 500);
    const keywords = [];
    const properNouns = cleaned.match(/\b\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){0,2}\b/gu) || [];
    keywords.push(...properNouns);
    const years = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
    keywords.push(...years);
    const importantWords = cleaned.match(/\b\p{L}{6,}\b/gu) || [];
    keywords.push(...importantWords.slice(0, 3));
    const unique = [...new Set(keywords)].filter(k => k && k.length > 3).filter(k => !/^(Oui|Non|Cette|Voici|Selon|C’est|exact|depuis|pour)$/i.test(k)).slice(0, 5);
    console.log('Mots-clés extraits :', unique);
    return unique;
}

function isOpinionOrNonFactual(text) {
    const lower = text.toLowerCase().normalize('NFC');
    const opinionMarkers = [ 'je pense', 'je crois', 'à mon avis', 'selon moi', 'j\'ai l\'impression', 'je trouve que', 'il me semble que' ];
    if (opinionMarkers.some(marker => lower.includes(marker))) return true;
    const subjectiveWords = [ 'opinion', 'subjectif', 'avis', 'goût', 'perçu comme', 'semble', 'pourrait être', 'répandue' ];
    if (subjectiveWords.some(word => lower.includes(word))) return true;
    const metaMarkers = [ 'pas de sens', 'suite de lettres', 'tapée au hasard', 'une question', 'n\'hésitez pas' ];
    if (metaMarkers.some(marker => lower.includes(marker))) return true;
    if (lower.trim().endsWith('?')) return true;
    return false;
}

async function findWebSources(keywords) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID || keywords.length === 0) {
        return [];
    }
    
    const query = keywords.join(' ');
    const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=3`;

    try {
        const response = await fetch(url);
        if (!response.ok) { // Gérer les erreurs de l'API Google
            console.error("Erreur API Google:", response.status, await response.text());
            return [];
        }
        const data = await response.json();
        if (!data.items) return [];

        return data.items.map(item => ({
            title: item.title,
            url: item.link,
            snippet: item.snippet,
            type: 'web'
        }));
    } catch (error) {
        console.error("Erreur lors de la recherche Google:", error);
        return [];
    }
}

// ===================================================================
//                          LES ROUTES DE L'API
// ===================================================================

app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.length < 20) {
            return res.json({ overallConfidence: 0.15, scoringExplanation: "Texte trop court.", keywords: [] });
        }
        if (isOpinionOrNonFactual(text)) {
            return res.json({ overallConfidence: 0.10, scoringExplanation: "**Non factuel** (10%). Opinion, question ou contenu non vérifiable.", keywords: [] });
        }
        
        const keywords = extractMainKeywords(text);
        const webSources = await findWebSources(keywords);
        
        res.json({
            overallConfidence: 0.20,
            sources: webSources,
            scoringExplanation: "Analyse initiale...",
            keywords: keywords
        });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ scoringExplanation: "Erreur d'analyse serveur." });
    }
});

app.post('/feedback', async (req, res) => {
    try {
        const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
        const client = await pool.connect();
        await client.query( 'INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)', [originalText?.substring(0, 5000), scoreGiven, isUseful, comment, JSON.stringify(sourcesFound)] );
        client.release();
        res.json({ success: true });
    } catch (err) {
        console.error('Erreur feedback:', err);
        res.status(500).json({ error: 'Erreur' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Pyramide de Confiance sur port ${PORT}`);
    initDb();
});
