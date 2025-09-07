const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Configuration
app.use(cors({ 
    origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));

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
        console.error('❌ Erreur DB:', err);
    }
};

function extractMainKeywords(text) {
    const cleaned = text.normalize('NFC').replace(/['']/g, "'").substring(0, 500);
    const keywords = [];
    const properNouns = cleaned.match(/\b\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){0,2}\b/gu) || [];
    keywords.push(...properNouns);
    const years = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
    keywords.push(...years);
    const importantWords = cleaned.match(/\b\p{L}{6,}\b/gu) || [];
    keywords.push(...importantWords.slice(0, 3));
    const unique = [...new Set(keywords)].filter(k => k && k.length > 3).filter(k => !/^(Oui|Non|Cette|Voici|Selon|C'est|exact|depuis|pour|Yes|No|This|Here|According|It's|exactly|since|for)$/i.test(k)).slice(0, 5);
    return unique;
}

function isOpinionOrNonFactual(text) {
    const lower = text.toLowerCase().normalize('NFC');
    
    // NOUVEAU : Détecter les faits historiques avec dates
    if (text.match(/\b(19|20)\d{2}\b/)) {
        const historicalWords = [
            'fell', 'founded', 'established', 'died', 'born', 'war', 'ended', 'began',
            'started', 'built', 'discovered', 'invented', 'signed', 'declared',
            'wall', 'berlin', 'revolution', 'independence', 'treaty', 'battle',
            'elected', 'assassinated', 'created', 'launched', 'opened', 'closed'
        ];
        
        if (historicalWords.some(word => lower.includes(word))) {
            return false; // C'est un fait historique avec date
        }
    }
    
    // NOUVEAU : Détecter les faits géographiques courts
    const geoPatterns = [
        /capital.*is/i,
        /\b\w+ is the capital/i,
        /located in/i,
        /currency.*is/i,
        /population.*is/i,
        /situated in/i,
        /borders/i,
        /largest city/i
    ];
    
    if (geoPatterns.some(pattern => pattern.test(text))) {
        return false; // C'est un fait géographique
    }
    
    // NOUVEAU : Détecter les faits scientifiques simples
    const sciencePatterns = [
        /speed of light/i,
        /boiling point/i,
        /melting point/i,
        /atomic number/i,
        /discovered by/i,
        /invented by/i,
        /formula.*is/i,
        /temperature.*is/i
    ];
    
    if (sciencePatterns.some(pattern => pattern.test(text))) {
        return false; // C'est un fait scientifique
    }
    
    // DÉTECTION RÉPONSES D'IA (souvent factuelles mais génériques)
    if (lower.includes('excellent choix') || lower.includes('c\'est délicieux') || 
        lower.includes('tu as une préférence') || lower.includes('tu préfères') ||
        lower.includes('bonne question') || lower.includes('intéressant') ||
        lower.includes('effectivement') || lower.includes('en effet') ||
        lower.includes('excellent choice') || lower.includes('it\'s delicious') ||
        lower.includes('good question') || lower.includes('interesting') ||
        lower.includes('indeed') || lower.includes('in fact')) {
        return true; // Traiter comme opinion car c'est du contenu générique d'IA
    }
    
    // DÉTECTION CHARABIA : ratio consonnes/voyelles anormal
    const cleanText = lower.replace(/[^a-z]/g, '');
    const vowels = (cleanText.match(/[aeiouy]/g) || []).length;
    const vowelRatio = cleanText.length > 5 ? vowels / cleanText.length : 0.3;
    
    if (vowelRatio < 0.15 && cleanText.length > 5) {
        return true;
    }
    
    // Texte très court = non factuel (SAUF si c'est un fait simple détecté ci-dessus)
    if (text.length < 30) {
        return true;
    }
    
    // Ignorer les questions finales de l'IA
    const textWithoutAIQuestion = lower
        .replace(/tu veux que je.*?\?/g, '')
        .replace(/veux-tu.*?\?/g, '')
        .replace(/voulez-vous.*?\?/g, '')
        .replace(/n'hésit.*?\./g, '')
        .replace(/would you like me.*?\?/g, '')
        .replace(/do you want.*?\?/g, '')
        .replace(/would you.*?\?/g, '')
        .replace(/don't hesitate.*?\./g, '')
        .trim();
    
    // Marqueurs d'opinion directs
    const opinionMarkers = [ 
        'je pense', 'je crois', 'à mon avis', 'selon moi', 
        'j\'ai l\'impression', 'je trouve que', 'il me semble que',
        'les gens aiment', 'tout le monde aime', 'la plupart des gens',
        'i think', 'i believe', 'in my opinion', 'i feel',
        'it seems to me', 'people like', 'everyone likes', 'most people'
    ];
    if (opinionMarkers.some(marker => textWithoutAIQuestion.includes(marker))) {
        return true;
    }
    
    // Détection RENFORCÉE des goûts et préférences
    const preferencePatterns = [
        /j'aime/i, /j'adore/i, /je préfère/i, /je déteste/i,
        /j'apprécie/i, /je n'aime pas/i, /j aime/i,
        /i love/i, /i like/i, /i hate/i, /i prefer/i,
        /c'est mieux/i, /c'est meilleur/i, /plus agréable/i,
        /it's better/i, /more pleasant/i, /tastes better/i
    ];
    
    if (preferencePatterns.some(pattern => pattern.test(textWithoutAIQuestion))) {
        return true;
    }
    
    // Patterns opinion généraux
    if (textWithoutAIQuestion.match(/\b(quelque chose de.*apaisant|très apaisant|assez.*pour|pour l'ambiance|something.*soothing|very soothing|enough.*for|for the ambiance)\b/i)) {
        return true;
    }
    
    const subjectiveWords = [ 
        'opinion', 'subjectif', 'avis', 'goût', 'perçu comme', 'semble', 'pourrait être', 'répandue',
        'subjective', 'taste', 'perceived as', 'seems', 'could be', 'widespread'
    ];
    if (subjectiveWords.some(word => textWithoutAIQuestion.includes(word))) {
        return true;
    }
    
    const metaMarkers = [ 
        'pas de sens', 'suite de lettres', 'tapée au hasard', 'une question',
        'no sense', 'string of letters', 'typed randomly', 'a question'
    ];
    if (metaMarkers.some(marker => textWithoutAIQuestion.includes(marker))) {
        return true;
    }
    
    // Texte trop court = non factuel
    if (textWithoutAIQuestion.length < 50) {
        return true;
    }
    
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
        if (!response.ok) {
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
        return [];
    }
}

app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!text || text.length < 20) {
            return res.json({ 
                overallConfidence: 0.15, 
                scoringExplanation: "**Text too short** (15%). Cannot analyze.", 
                keywords: [] 
            });
        }
        
        if (isOpinionOrNonFactual(text)) {
            return res.json({ 
                overallConfidence: 0.25, 
                scoringExplanation: "**Opinion/Subjective** (25%). Non-verifiable content.", 
                keywords: [] 
            });
        }
        
        // Pour les faits potentiels, calculer le score selon les sources
        const keywords = extractMainKeywords(text);
        const webSources = await findWebSources(keywords);
        
        let finalScore = 0.30;
        let explanation = "**Low reliability** (30%). No sources found to verify.";
        
        const sourceCount = webSources.length;
        
        if (sourceCount >= 3) {
            finalScore = 0.85;
            explanation = "**Highly reliable** (85%). Multiple concordant web sources found.";
        } else if (sourceCount === 2) {
            finalScore = 0.70;
            explanation = "**Good reliability** (70%). Two web sources found.";
        } else if (sourceCount === 1) {
            finalScore = 0.55;
            explanation = "**Average reliability** (55%). One web source found.";
        } else if (keywords.length >= 3) {
            finalScore = 0.45;
            explanation = "**Uncertain reliability** (45%). Probable factual content but unconfirmed.";
        }
        
        res.json({
            overallConfidence: finalScore,
            sources: webSources,
            scoringExplanation: explanation,
            keywords: keywords
        });
    } catch (error) {
        res.status(500).json({ scoringExplanation: "Server analysis error." });
    }
});

app.post('/feedback', async (req, res) => {
    try {
        const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
        
        if (!originalText || scoreGiven === undefined || isUseful === undefined) {
            return res.status(400).json({ error: 'Incomplete data' });
        }
        
        const client = await pool.connect();
        
        await client.query(
            'INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)',
            [
                originalText?.substring(0, 5000), 
                scoreGiven, 
                isUseful, 
                comment || '', 
                JSON.stringify(sourcesFound || [])
            ]
        );
        
        client.release();
        res.json({ success: true });
        
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/feedback-debug', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(`
            SELECT 
                id, 
                LEFT(original_text, 100) as text_preview,
                score_given,
                is_useful,
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
        res.status(500).json({ error: 'Error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🚀 Fact-Checker v1.1 - Historical Facts Fixed');
    initDb();
});
