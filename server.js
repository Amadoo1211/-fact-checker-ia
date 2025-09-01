const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Configuration avec logs
app.use(cors({ 
    origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Log middleware pour debug
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`, req.body ? 'avec body' : 'sans body');
    next();
});

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
        
        // Test de connexion
        const result = await client.query('SELECT COUNT(*) FROM feedback');
        console.log(`✅ DB prête - ${result.rows[0].count} feedbacks en base`);
        client.release();
    } catch (err) {
        console.error('❌ Erreur DB:', err);
    }
};

// ===================================================================
//                 LA LOGIQUE DE L'APPLICATION
// ===================================================================

function extractMainKeywords(text) {
    const cleaned = text.normalize('NFC').replace(/['']/g, "'").substring(0, 500);
    const keywords = [];
    const properNouns = cleaned.match(/\b\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){0,2}\b/gu) || [];
    keywords.push(...properNouns);
    const years = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
    keywords.push(...years);
    const importantWords = cleaned.match(/\b\p{L}{6,}\b/gu) || [];
    keywords.push(...importantWords.slice(0, 3));
    const unique = [...new Set(keywords)].filter(k => k && k.length > 3).filter(k => !/^(Oui|Non|Cette|Voici|Selon|C'est|exact|depuis|pour)$/i.test(k)).slice(0, 5);
    console.log('Mots-clés extraits :', unique);
    return unique;
}

function isOpinionOrNonFactual(text) {
    const lower = text.toLowerCase().normalize('NFC');
    
    // DÉTECTION CHARABIA : ratio consonnes/voyelles anormal
    const cleanText = lower.replace(/[^a-z]/g, '');
    const vowels = (cleanText.match(/[aeiouy]/g) || []).length;
    const vowelRatio = cleanText.length > 10 ? vowels / cleanText.length : 0.3;
    
    // Si moins de 15% de voyelles = charabia probable
    if (vowelRatio < 0.15 && cleanText.length > 10) {
        return true;
    }
    
    // Ignorer les questions finales de l'IA
    const textWithoutAIQuestion = lower
        .replace(/tu veux que je.*?\?/g, '')
        .replace(/veux-tu.*?\?/g, '')
        .replace(/voulez-vous.*?\?/g, '')
        .replace(/n'hésit.*?\./g, '')
        .trim();
    
    // Vérifier les marqueurs d'opinion
    const opinionMarkers = [ 
        'je pense', 'je crois', 'à mon avis', 'selon moi', 
        'j\'ai l\'impression', 'je trouve que', 'il me semble que',
        'les gens aiment', 'tout le monde aime', 'la plupart des gens'
    ];
    if (opinionMarkers.some(marker => textWithoutAIQuestion.includes(marker))) return true;
    
    // Détection des goûts et préférences GLOBALE
    if (textWithoutAIQuestion.match(/\b(j'aime|j'adore|je préfère|je déteste|j'apprécie|je n'aime pas|j aime|tu l'aimes|l'aimes|i love|i like|i hate|i prefer)\b/i)) {
        return true;
    }
    
    // Détection patterns opinion généraux
    if (textWithoutAIQuestion.match(/\b(quelque chose de.*apaisant|très apaisant|assez.*pour|pour l'ambiance)\b/i)) {
        return true;
    }
    
    const subjectiveWords = [ 'opinion', 'subjectif', 'avis', 'goût', 'perçu comme', 'semble', 'pourrait être', 'répandue' ];
    if (subjectiveWords.some(word => textWithoutAIQuestion.includes(word))) return true;
    
    const metaMarkers = [ 'pas de sens', 'suite de lettres', 'tapée au hasard', 'une question' ];
    if (metaMarkers.some(marker => textWithoutAIQuestion.includes(marker))) return true;
    
    // Texte trop court = non factuel
    if (textWithoutAIQuestion.length < 50) return true;
    
    return false;
}

async function findWebSources(keywords) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID || keywords.length === 0) {
        console.log('⚠️ API Google non configurée ou pas de mots-clés');
        return [];
    }
    
    const query = keywords.join(' ');
    const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=3`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.error("Erreur API Google:", response.status, await response.text());
            return [];
        }
        const data = await response.json();
        if (!data.items) return [];

        console.log(`✅ ${data.items.length} sources web trouvées`);
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
        console.log('📝 Analyse demandée pour:', text?.substring(0, 100) + '...');
        
        if (!text || text.length < 20) {
            return res.json({ overallConfidence: 0.15, scoringExplanation: "Texte trop court.", keywords: [] });
        }
        
        // VÉRIFIER D'ABORD LE TEXTE ORIGINAL (avant analyse IA)
        const userInput = text.split(/Hello|Je peux|Pouvez-vous|reformuler/i)[0] || text;
        
        if (isOpinionOrNonFactual(userInput)) {
            console.log('👤 Détecté comme opinion/non-factuel');
            return res.json({ 
                overallConfidence: 0.25, 
                scoringExplanation: "**Opinion/Non factuel** (25%). Contenu subjectif non vérifiable.", 
                keywords: [] 
            });
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
        console.error('❌ Erreur verify:', error);
        res.status(500).json({ scoringExplanation: "Erreur d'analyse serveur." });
    }
});

// ROUTE FEEDBACK CORRIGÉE AVEC LOGS
app.post('/feedback', async (req, res) => {
    console.log('🔔 Feedback reçu:', {
        hasOriginalText: !!req.body.originalText,
        scoreGiven: req.body.scoreGiven,
        isUseful: req.body.isUseful,
        hasComment: !!req.body.comment,
        sourcesCount: req.body.sourcesFound?.length || 0
    });
    
    try {
        const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
        
        if (!originalText || scoreGiven === undefined || isUseful === undefined) {
            console.log('❌ Données feedback incomplètes');
            return res.status(400).json({ error: 'Données incomplètes' });
        }
        
        const client = await pool.connect();
        
        const result = await client.query(
            'INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5) RETURNING id',
            [
                originalText?.substring(0, 5000), 
                scoreGiven, 
                isUseful, 
                comment || '', 
                JSON.stringify(sourcesFound || [])
            ]
        );
        
        client.release();
        console.log('✅ Feedback sauvé avec ID:', result.rows[0].id);
        res.json({ success: true, feedbackId: result.rows[0].id });
        
    } catch (err) {
        console.error('❌ Erreur feedback:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// ROUTE DE DEBUG POUR VOIR LES FEEDBACKS
app.get('/feedback-debug', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(`
            SELECT 
                id, 
                LEFT(original_text, 100) as text_preview,
                score_given,
                is_useful,
                comment,
                created_at
            FROM feedback 
            ORDER BY created_at DESC 
            LIMIT 20
        `);
        client.release();
        
        res.json({
            count: result.rows.length,
            feedbacks: result.rows
        });
    } catch (err) {
        console.error('❌ Erreur debug:', err);
        res.status(500).json({ error: 'Erreur' });
    }
});

// Route de santé
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        version: '1.0'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🚀 Fact-Checker v1.0 Stable - Port:', PORT);
    initDb();
});
