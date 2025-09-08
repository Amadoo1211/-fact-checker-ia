const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Configuration finale
app.use(cors({ 
    origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'],
    credentials: true
}));
app.use(express.json({ limit: '5mb' }));

// Base de données
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

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
        console.log('✅ Database prête');
    } catch (err) {
        console.error('❌ Database error:', err.message);
    }
};

// Nettoyage sécurisé
function sanitizeInput(text) {
    if (!text || typeof text !== 'string') return '';
    
    return text
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/<script[^>]*>.*?<\/script>/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '')
        .substring(0, 5000)
        .trim();
}

// ANALYSE INTELLIGENTE DU CONTENU
function analyzeContentType(text) {
    const sanitizedText = sanitizeInput(text);
    const lower = sanitizedText.toLowerCase();
    
    console.log(`🔍 Analyse: "${sanitizedText.substring(0, 60)}..."`);
    
    // 1. DÉTECTION OPINIONS SUBJECTIVES
    const opinionPatterns = [
        /\b(i think|i believe|i feel|in my opinion|personally|subjectively)\b/i,
        /\b(better than|worse than|prefer|favorite|best|worst)\b/i,
        /\b(beautiful|ugly|delicious|terrible|amazing|awful)\b/i,
        /\b(love|hate|like|dislike).*more\b/i,
        /\b(matter of taste|subjective|personal preference)\b/i
    ];
    
    for (const pattern of opinionPatterns) {
        if (pattern.test(sanitizedText)) {
            console.log(`💭 Opinion subjective détectée`);
            return { type: 'OPINION', confidence: 0.9 };
        }
    }
    
    // 2. DÉTECTION QUESTIONS
    if (sanitizedText.length < 300 && /^(what|how|why|when|where|which|who|can you|could you)\b/i.test(sanitizedText.trim())) {
        return { type: 'QUESTION', confidence: 0.95 };
    }
    
    // 3. DÉTECTION FAITS VÉRIFIABLES
    
    // Faits historiques avec dates
    if (/\b(19|20)\d{2}\b/.test(sanitizedText)) {
        const historicalWords = ['founded', 'established', 'born', 'died', 'war', 'treaty', 'independence', 'victory', 'defeat', 'empire', 'president', 'revolution'];
        if (historicalWords.some(word => lower.includes(word))) {
            console.log(`📚 Fait historique détecté`);
            return { type: 'HISTORICAL_FACT', confidence: 0.85 };
        }
    }
    
    // Faits géographiques
    if (/\b(capital|population|area|square.*kilometers|km²|located.*in|borders)\b/i.test(sanitizedText)) {
        console.log(`🌍 Fait géographique détecté`);
        return { type: 'GEOGRAPHIC_FACT', confidence: 0.85 };
    }
    
    // Faits scientifiques
    if (/\b(speed.*light|boiling.*point|atomic.*number|chemical.*formula|299.*792.*458)\b/i.test(sanitizedText)) {
        console.log(`🔬 Fait scientifique détecté`);
        return { type: 'SCIENTIFIC_FACT', confidence: 0.9 };
    }
    
    // Faits statistiques
    if (/\b\d+(\.\d+)?\s*(percent|%|million|billion|trillion)\b/i.test(sanitizedText)) {
        console.log(`📊 Fait statistique détecté`);
        return { type: 'STATISTICAL_FACT', confidence: 0.8 };
    }
    
    // 4. CONTENU TROP COURT
    if (sanitizedText.length < 30) {
        return { type: 'TOO_SHORT', confidence: 0.95 };
    }
    
    // 5. INFORMATION GÉNÉRALE
    console.log(`📄 Information générale`);
    return { type: 'GENERAL_INFO', confidence: 0.6 };
}

// EXTRACTION MOTS-CLÉS INTELLIGENTE
function extractMainKeywords(text) {
    const cleaned = sanitizeInput(text).substring(0, 1000);
    const keywords = [];
    
    try {
        // Entités nommées (noms propres)
        const namedEntities = cleaned.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2}\b/g) || [];
        const filteredEntities = namedEntities.filter(entity => 
            entity.length > 3 && entity.length < 40 &&
            !/^(The|This|That|When|Where|What|How|Why|Who|Yes|World|War|Day|May|Will|Can)$/i.test(entity)
        );
        keywords.push(...filteredEntities.slice(0, 5));
        
        // Dates importantes
        const dates = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
        keywords.push(...dates.slice(0, 2));
        
        // Nombres avec unités
        const numbersWithUnits = cleaned.match(/\b\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?\s*(?:million|billion|percent|%|km²|kilometers|meters|miles|population)\b/gi) || [];
        keywords.push(...numbersWithUnits.slice(0, 3));
        
        // Mots-clés importants
        const importantWords = cleaned.match(/\b(?:capital|president|founded|established|independence|victory|defeat|treaty|constitution|republic|democracy|population|area|temperature|speed|light|atomic|chemical)\b/gi) || [];
        keywords.push(...importantWords.slice(0, 4));
        
        // Mots significatifs longs
        const significantWords = cleaned.match(/\b[a-zA-Z]{6,20}\b/g) || [];
        const cleanedWords = significantWords.filter(word => 
            !/^(however|therefore|because|through|without|although|sometimes|something|anything|everything|nothing|javascript|function|document)$/i.test(word)
        );
        keywords.push(...cleanedWords.slice(0, 3));
        
        return [...new Set(keywords)].filter(k => k && k.length > 2).slice(0, 8);
    } catch (e) {
        console.log('Erreur extraction keywords:', e.message);
        return [];
    }
}

// RECHERCHE SOURCES INTELLIGENTE
async function findWebSources(keywords, smartQueries, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        console.log('❌ API credentials manquantes');
        return [];
    }
    
    let allSources = [];
    console.log(`🔍 Recherche avec ${smartQueries?.length || 0} requêtes intelligentes`);
    
    // 1. Utiliser requêtes intelligentes du frontend
    if (smartQueries && smartQueries.length > 0) {
        for (const [index, query] of smartQueries.slice(0, 3).entries()) {
            try {
                console.log(`🔍 Requête ${index + 1}: "${query}"`);
                const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=4`;
                const response = await fetch(url);
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.items) {
                        const sources = data.items.map(item => ({
                            title: item.title || 'Sans titre',
                            url: item.link || '',
                            snippet: item.snippet || 'Pas de description',
                            query_used: query,
                            relevance: calculateRelevance(item, originalText)
                        }));
                        allSources.push(...sources);
                        console.log(`✅ ${sources.length} sources pour "${query}"`);
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 200));
                
            } catch (error) {
                console.error(`❌ Erreur requête "${query}":`, error.message);
            }
        }
    }
    
    // 2. Fallback avec mots-clés si peu de sources
    if (allSources.length < 2 && keywords.length > 0) {
        try {
            const fallbackQuery = keywords.slice(0, 4).join(' ');
            console.log(`🔄 Fallback: "${fallbackQuery}"`);
            const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(fallbackQuery)}&num=3`;
            const response = await fetch(url);
            
            if (response.ok) {
                const data = await response.json();
                if (data.items) {
                    const sources = data.items.map(item => ({
                        title: item.title || 'Sans titre',
                        url: item.link || '',
                        snippet: item.snippet || 'Pas de description',
                        query_used: fallbackQuery,
                        relevance: calculateRelevance(item, originalText)
                    }));
                    allSources.push(...sources);
                    console.log(`✅ Fallback: ${sources.length} sources`);
                }
            }
        } catch (error) {
            console.error('❌ Erreur fallback:', error.message);
        }
    }
    
    // 3. Filtrage et tri par pertinence
    const filteredSources = allSources.filter(source => source.relevance > 0.3);
    
    // 4. Déduplication
    const uniqueSources = [];
    const seenUrls = new Set();
    
    filteredSources.sort((a, b) => b.relevance - a.relevance);
    
    for (const source of filteredSources) {
        if (!seenUrls.has(source.url) && uniqueSources.length < 6) {
            seenUrls.add(source.url);
            uniqueSources.push(source);
        }
    }
    
    console.log(`📋 ${uniqueSources.length} sources finales sélectionnées`);
    return uniqueSources;
}

// CALCUL PERTINENCE SOURCE
function calculateRelevance(item, originalText) {
    const title = (item.title || '').toLowerCase();
    const snippet = (item.snippet || '').toLowerCase();
    const url = (item.link || '').toLowerCase();
    const original = originalText.toLowerCase();
    
    let score = 0;
    
    // Mots-clés communs
    const originalWords = original.split(/\s+/).filter(w => w.length > 3);
    const titleWords = title.split(/\s+/);
    const snippetWords = snippet.split(/\s+/);
    
    let commonWords = 0;
    for (const word of originalWords.slice(0, 10)) {
        if (titleWords.includes(word) || snippetWords.includes(word)) {
            commonWords++;
        }
    }
    
    score += (commonWords / Math.min(originalWords.length, 10)) * 0.5;
    
    // Bonus sources fiables
    if (url.includes('wikipedia.org')) score += 0.4;
    else if (url.includes('.edu') || url.includes('.gov')) score += 0.35;
    else if (url.includes('britannica') || url.includes('nationalgeographic')) score += 0.3;
    else if (url.includes('history.com') || url.includes('smithsonianmag')) score += 0.25;
    
    // Malus sources peu fiables
    if (url.includes('reddit.com') || url.includes('quora.com')) score -= 0.2;
    if (url.includes('blog') || url.includes('forum')) score -= 0.15;
    
    return Math.max(0, Math.min(1, score));
}

// SCORING LOGIQUE FINAL
function calculateFinalScore(contentAnalysis, sources, keywords) {
    const { type, confidence } = contentAnalysis;
    
    console.log(`🎯 Calcul score pour ${type}`);
    
    // 1. OPINIONS - Score modéré
    if (type === 'OPINION') {
        return {
            score: 0.35,
            explanation: "**Opinion subjective** (35%). Point de vue personnel qui nécessite d'autres perspectives pour être équilibré."
        };
    }
    
    // 2. QUESTIONS - Score bas
    if (type === 'QUESTION') {
        return {
            score: 0.25,
            explanation: "**Question utilisateur** (25%). Ceci semble être une question plutôt qu'une affirmation factuelle."
        };
    }
    
    // 3. CONTENU TROP COURT
    if (type === 'TOO_SHORT') {
        return {
            score: 0.20,
            explanation: "**Contenu insuffisant** (20%). Texte trop court pour une analyse fiable."
        };
    }
    
    // 4. FAITS VÉRIFIABLES - Scoring basé sur type + sources
    let baseScore = 0.45;
    let explanation = "";
    
    switch (type) {
        case 'HISTORICAL_FACT':
            baseScore = 0.70;
            explanation = "**Fait historique** - ";
            break;
        case 'GEOGRAPHIC_FACT':
            baseScore = 0.75;
            explanation = "**Information géographique** - ";
            break;
        case 'SCIENTIFIC_FACT':
            baseScore = 0.80;
            explanation = "**Fait scientifique** - ";
            break;
        case 'STATISTICAL_FACT':
            baseScore = 0.65;
            explanation = "**Donnée statistique** - ";
            break;
        case 'GENERAL_INFO':
            baseScore = 0.50;
            explanation = "**Information générale** - ";
            break;
    }
    
    // 5. BONUS SOURCES
    let sourceBonus = 0;
    let sourceText = "";
    
    if (sources && sources.length > 0) {
        const wikipediaSources = sources.filter(s => s.url && s.url.includes('wikipedia')).length;
        const academicSources = sources.filter(s => s.url && (s.url.includes('.edu') || s.url.includes('.gov'))).length;
        const highQualitySources = sources.filter(s => s.relevance > 0.6).length;
        
        // Bonus par qualité
        if (wikipediaSources >= 1) {
            sourceBonus += 0.12;
            sourceText += "Sources Wikipedia trouvées. ";
        }
        
        if (academicSources >= 1) {
            sourceBonus += 0.08;
            sourceText += "Sources académiques/officielles. ";
        }
        
        if (highQualitySources >= 2) {
            sourceBonus += 0.10;
            sourceText += "Plusieurs sources très pertinentes.";
        } else if (sources.length >= 3) {
            sourceBonus += 0.06;
            sourceText += "Multiples sources de vérification.";
        } else if (sources.length >= 1) {
            sourceBonus += 0.03;
            sourceText += "Vérification limitée disponible.";
        }
    } else {
        sourceText += "Aucune source de vérification trouvée.";
    }
    
    // 6. CALCUL FINAL
    const finalScore = Math.min(baseScore + sourceBonus, 0.92);
    const finalPercent = Math.round(finalScore * 100);
    
    // 7. LABELS LOGIQUES
    let reliabilityLabel;
    if (finalPercent >= 85) reliabilityLabel = "Très fiable";
    else if (finalPercent >= 70) reliabilityLabel = "Bonne fiabilité";
    else if (finalPercent >= 55) reliabilityLabel = "Fiabilité modérée";
    else if (finalPercent >= 40) reliabilityLabel = "Fiabilité limitée";
    else reliabilityLabel = "Faible fiabilité";
    
    return {
        score: finalScore,
        explanation: `${explanation}**${reliabilityLabel}** (${finalPercent}%). ${sourceText}`
    };
}

// ENDPOINT PRINCIPAL
app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType } = req.body;
        
        console.log(`🔍 Nouvelle analyse: ${analysisType || 'standard'}`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                overallConfidence: 0.20, 
                scoringExplanation: "**Entrée insuffisante** (20%). Texte trop court pour une analyse significative.", 
                keywords: [],
                sources: []
            });
        }
        
        // 1. ANALYSE TYPE DE CONTENU
        const contentAnalysis = analyzeContentType(text);
        console.log(`📊 Type détecté: ${contentAnalysis.type}`);
        
        // 2. EXTRACTION MOTS-CLÉS
        const keywords = extractMainKeywords(text);
        console.log(`🏷️ Mots-clés: ${keywords.slice(0, 3).join(', ')}`);
        
        // 3. RECHERCHE SOURCES (seulement pour faits vérifiables)
        let sources = [];
        if (['HISTORICAL_FACT', 'GEOGRAPHIC_FACT', 'SCIENTIFIC_FACT', 'STATISTICAL_FACT', 'GENERAL_INFO'].includes(contentAnalysis.type)) {
            console.log('🔍 Recherche de sources...');
            sources = await findWebSources(keywords, smartQueries, text);
        } else {
            console.log('⏭️ Pas de recherche de sources pour ce type de contenu');
        }
        
        // 4. CALCUL SCORE FINAL
        const result = calculateFinalScore(contentAnalysis, sources, keywords);
        
        // 5. RÉPONSE
        const response = {
            overallConfidence: result.score,
            sources: sources,
            scoringExplanation: result.explanation,
            keywords: keywords,
            contentType: contentAnalysis.type
        };
        
        console.log(`✅ Score final: ${Math.round(result.score * 100)}%`);
        res.json(response);
        
    } catch (error) {
        console.error('❌ Erreur analyse:', error);
        res.status(500).json({ 
            overallConfidence: 0.15,
            scoringExplanation: "**Erreur serveur** (15%). Impossible de compléter l'analyse.",
            keywords: [],
            sources: []
        });
    }
});

// ENDPOINT FEEDBACK
app.post('/feedback', async (req, res) => {
    try {
        const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
        
        if (!originalText || scoreGiven === undefined || isUseful === undefined) {
            return res.status(400).json({ error: 'Données feedback incomplètes' });
        }
        
        const client = await pool.connect();
        
        await client.query(
            'INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)',
            [
                sanitizeInput(originalText).substring(0, 2000), 
                scoreGiven, 
                isUseful, 
                sanitizeInput(comment || '').substring(0, 500), 
                JSON.stringify(sourcesFound || [])
            ]
        );
        
        client.release();
        console.log(`📝 Feedback reçu: ${isUseful ? 'Utile' : 'Pas utile'}`);
        res.json({ success: true });
        
    } catch (err) {
        console.error('❌ Erreur feedback:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// ENDPOINT STATS
app.get('/stats', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN is_useful = true THEN 1 END) as positif,
                AVG(score_given) as score_moyen
            FROM feedback 
            WHERE created_at > NOW() - INTERVAL '7 days'
        `);
        client.release();
        
        const stats = result.rows[0];
        res.json({
            total_feedback: parseInt(stats.total),
            feedback_positif: parseInt(stats.positif),
            taux_satisfaction: stats.total > 0 ? Math.round((stats.positif / stats.total) * 100) : 0,
            score_moyen: parseFloat(stats.score_moyen) || 0
        });
        
    } catch (err) {
        console.error('❌ Erreur stats:', err);
        res.status(500).json({ error: 'Erreur stats' });
    }
});

// ENDPOINT SANTÉ
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'FINAL-1.0',
        features: ['capture_universelle', 'scoring_logique', 'sources_pertinentes'],
        timestamp: new Date().toISOString()
    });
});

// DÉMARRAGE
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 VerifyAI Backend FINAL v1.0`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🎯 CAPTURE UNIVERSELLE ChatGPT/Claude/Gemini`);
    console.log(`⚖️ SCORING LOGIQUE équilibré`);
    console.log(`🔍 SOURCES PERTINENTES intelligentes`);
    console.log(`✅ AUCUNE MODIFICATION NÉCESSAIRE APRÈS DÉPLOIEMENT`);
    initDb();
});
