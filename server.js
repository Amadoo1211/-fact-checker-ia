// server.js - PYRAMIDE DE CONFIANCE - VERSION AVEC DÉBOGAGE
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
//                 LA FONCTION MODIFIÉE POUR LE DÉBOGAGE
// ===================================================================

function extractMainKeywords(text) {
    // --- NOS ESPIONS ---
    console.log("--- DÉBUT DU DÉBUG ---");
    console.log("1. Texte brut reçu :", JSON.stringify(text)); // Affiche le texte brut avec les caractères invisibles

    const cleaned = text.replace(/['']/g, "'").substring(0, 500);
    console.log("2. Texte après nettoyage :", JSON.stringify(cleaned)); // Affiche le texte nettoyé

    // Le reste de la fonction est inchangé
    const keywords = [];
    
    const properNouns = cleaned.match(/\b[A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ]+){0,2}\b/g) || [];
    keywords.push(...properNouns);
    
    const years = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
    keywords.push(...years);
    
    const technical = cleaned.match(/\b[A-Za-zÀ-ÿ]{7,}\b/g) || [];
    keywords.push(...technical.slice(0, 3));
    
    const unique = [...new Set(keywords)]
        .filter(k => k && k.length > 3)
        .filter(k => !['Oui', 'Non', 'Cette', 'Voici', 'Selon', 'C’est', 'exact'].includes(k))
        .slice(0, 5); 
    
    console.log("3. Mots-clés finaux :", unique);
    console.log("--- FIN DU DÉBUG ---");
    
    return unique;
}


// ===================================================================
//         LE RESTE DE LA LOGIQUE SERVEUR (INCHANGÉ)
// ===================================================================

// ÉTAGE 1 : Détection Non-Factuel (Opinion, conversation...)
function isOpinion(text) {
    const lower = text.toLowerCase();
    const opinionMarkers = [
        'je pense', 'je crois', 'à mon avis', 'selon moi', 
        'j\'aime', 'je déteste', 'c\'est super', 'hello', 'bonjour'
    ];
    if (opinionMarkers.some(marker => lower.includes(marker))) return true;
    if (text.length < 50 && !(/\d{4}/.test(text)) && !(/[A-Z][a-z]+\s+[A-Z]/.test(text))) return true;
    return false;
}

// ÉTAGE 2-4 : Recherche de sources expertes (Limité mais fonctionnel)
function findExpertSources(text) {
    const lower = text.toLowerCase();
    const sources = [];
    if (lower.includes('marie curie')) {
        sources.push({ title: "Nobel Prize - Marie Curie", url: "https://www.nobelprize.org/prizes/physics/1903/marie-curie/", snippet: "Marie Curie fut la première femme Prix Nobel en 1903.", type: 'expert' });
    }
    if (lower.includes('population') && lower.includes('france') || lower.includes('insee')) {
        sources.push({ title: "INSEE - Population France", url: "https://www.insee.fr/fr/statistiques/", snippet: "Population française : 68 millions d'habitants (2024)", type: 'expert' });
    }
    if (lower.includes('giec') || lower.includes('ipcc') || (lower.includes('climat') && lower.includes('réchauffement'))) {
        sources.push({ title: "GIEC - Rapport Climat", url: "https://www.ipcc.ch/", snippet: "Réchauffement global de +1.1°C confirmé", type: 'expert' });
    }
    return sources;
}

// Route principale /verify
app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.length < 20) {
            return res.json({ overallConfidence: 0.15, sources: [], scoringExplanation: "Texte trop court pour analyse.", keywords: [] });
        }

        if (isOpinion(text)) {
            return res.json({ overallConfidence: 0.10, sources: [], scoringExplanation: "**Non factuel** (10%). Opinion ou conversation détectée.", keywords: [] });
        }
        
        const expertSources = findExpertSources(text);
        const keywords = extractMainKeywords(text);
        
        const initialScore = expertSources.length > 0 ? 0.85 : 0.20;
        const initialExplanation = expertSources.length > 0 ? "**Très fiable** (85%). Confirmé par source officielle." : "**Faible fiabilité** (20%). Aucune source externe trouvée.";

        res.json({
            overallConfidence: initialScore,
            sources: expertSources,
            scoringExplanation: initialExplanation,
            keywords: keywords
        });
        
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ scoringExplanation: "Erreur d'analyse serveur." });
    }
});

// Route feedback
app.post('/feedback', async (req, res) => {
    try {
        const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
        const client = await pool.connect();
        await client.query(
            'INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)',
            [originalText?.substring(0, 5000), scoreGiven, isUseful, comment, JSON.stringify(sourcesFound)]
        );
        client.release();
        res.json({ success: true });
    } catch (err) {
        console.error('Erreur feedback:', err);
        res.status(500).json({ error: 'Erreur' });
    }
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Pyramide de Confiance sur port ${PORT}`);
    initDb();
});
