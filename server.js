// server.js - PYRAMIDE DE CONFIANCE - VERSION CORRIGÉE
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Configuration
// Laisser cette configuration CORS, elle est importante pour la sécurité.
app.use(cors({ origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

// Connexion à la base de données (aucune modification nécessaire)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Initialisation de la base de données (aucune modification nécessaire)
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
//                 LA FONCTION CORRIGÉE (LE COEUR DU PROBLÈME)
// ===================================================================

function extractMainKeywords(text) {
    // Nettoyer le texte
    const cleaned = text.replace(/['']/g, "'").substring(0, 500);
    
    const keywords = [];
    
    // Noms propres (Ex: "Emmanuel Macron", "Tour Eiffel")
    const properNouns = cleaned.match(/\b[A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ]+){0,2}\b/g) || [];
    keywords.push(...properNouns);
    
    // Années (Ex: "1889", "2017")
    const years = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
    keywords.push(...years);
    
    // Mots techniques longs (Ex: "République", "Exposition")
    // On prend les 3 plus longs pour éviter le bruit
    const technical = cleaned.match(/\b[A-Za-zÀ-ÿ]{7,}\b/g) || [];
    keywords.push(...technical.slice(0, 3));
    
    // Filtrer et dédupliquer pour n'garder que les 5 meilleurs
    const unique = [...new Set(keywords)]
        .filter(k => k && k.length > 3)
        .filter(k => !['Oui', 'Non', 'Cette', 'Voici', 'Selon', 'C’est', 'exact'].includes(k))
        .slice(0, 5); 
    
    console.log('Mots-clés extraits:', unique);
    return unique;
}

// ===================================================================
//         LE RESTE DE LA LOGIQUE SERVEUR (PEU DE CHANGEMENTS)
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
// NOTE : Cette fonction est très limitée, elle ne connaît que 3 sujets.
// C'est une piste d'amélioration pour le futur, mais ce n'est pas un bug.
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
        // On utilise la NOUVELLE fonction ici !
        const keywords = extractMainKeywords(text);
        
        // Le serveur donne un score de base de 20% si aucune source experte n'est trouvée.
        // Le client (popup.js) recalculera le vrai score après la recherche Wikipedia.
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

// Route feedback (aucune modification nécessaire)
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
