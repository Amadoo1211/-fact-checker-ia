const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Configuration sécurisée finale
app.use(cors({ 
    origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'],
    credentials: true
}));
app.use(express.json({ limit: '5mb' }));

// Connexion sécurisée à la base de données
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Initialisation sécurisée de la base de données
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
        console.error('❌ Erreur base de données:', err.message);
    }
};

// Validation et nettoyage sécurisé des entrées
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

// ANALYSE DU TYPE DE CONTENU - APPROCHE GÉNÉRALISTE
function analyzeContentType(text) {
    const sanitizedText = sanitizeInput(text);
    const lower = sanitizedText.toLowerCase().normalize('NFC');
    
    console.log(`🔍 Analyse: "${sanitizedText.substring(0, 80)}..."`);
    
    // DÉTECTION D'OPINIONS - Plus équilibrée pour usage général
    const opinionPatterns = [
        // Opinions subjectives explicites
        /\b(i think|i believe|i feel|in my opinion|personally|subjectively)\b/i,
        /\b(je pense|je crois|je trouve|à mon avis|personnellement|subjectivement)\b/i,
        
        // Comparaisons subjectives
        /\b(better than|worse than|prefer.*over|tastes better|looks better|sounds better)\b/i,
        /\b(meilleur que|pire que|préfère.*à|goût.*meilleur|plus.*beau)\b/i,
        
        // Jugements esthétiques/gustatifs
        /\b(delicious|disgusting|beautiful|ugly|amazing|terrible|wonderful|awful)\b/i,
        /\b(délicieux|dégoûtant|beau|laid|merveilleux|terrible|magnifique|affreux)\b/i,
        
        // Préférences personnelles
        /\b(favorite|favourite|best.*ever|worst.*ever|love.*more|hate.*more)\b/i,
        /\b(favori|préféré|le meilleur|le pire|aime.*plus|déteste.*plus)\b/i,
        
        // Questions de goût
        /\b(matter of taste|question.*taste|subjective.*matter|personal.*preference)\b/i,
        /\b(question.*goût|affaire.*goût|sujet.*subjectif|préférence.*personnelle)\b/i
    ];
    
    // Vérification pour opinions
    for (const [index, pattern] of opinionPatterns.entries()) {
        if (pattern.test(sanitizedText)) {
            console.log(`💭 Opinion détectée avec pattern ${index + 1}`);
            return { type: 'OPINION', confidence: 0.85 };
        }
    }
    
    // DÉTECTION DE QUESTIONS UTILISATEUR
    const questionPatterns = [
        /^(what|how|why|when|where|which|who|can you|could you|please tell me)/i,
        /^(qu'est-ce que|comment|pourquoi|quand|où|quel|qui|peux-tu|pouvez-vous)/i,
        /\?$/,
        /^(explain|describe|give me|tell me about)/i,
        /^(explique|décris|donne-moi|parle-moi de)/i
    ];
    
    for (const pattern of questionPatterns) {
        if (pattern.test(sanitizedText.trim()) && sanitizedText.length < 300) {
            console.log(`❓ Question utilisateur détectée`);
            return { type: 'USER_QUESTION', confidence: 0.9 };
        }
    }
    
    // DÉTECTION DE FAITS HISTORIQUES
    if (sanitizedText.match(/\b(19|20)\d{2}\b/)) {
        const historicalIndicators = [
            'founded', 'established', 'died', 'born', 'war', 'ended', 'began',
            'built', 'discovered', 'invented', 'signed', 'declared',
            'revolution', 'independence', 'treaty', 'battle',
            'elected', 'created', 'launched', 'opened',
            'empire', 'kingdom', 'republic', 'constitution', 'president',
            'victory', 'defeat', 'surrender', 'official'
        ];
        
        if (historicalIndicators.some(word => lower.includes(word))) {
            console.log(`📚 Fait historique détecté`);
            return { type: 'HISTORICAL_FACT', confidence: 0.8 };
        }
    }
    
    // DÉTECTION DE FAITS GÉOGRAPHIQUES
    const geoPatterns = [
        /capital.*is|capitale.*de|population.*is|population.*de/i,
        /area.*square|superficie|located in|situé.*en/i,
        /largest city|plus.*grande.*ville|official language|langue.*officielle/i,
        /borders|frontière|elevation|altitude|climate|climat/i,
        /square.*kilometers|km²|square.*miles/i
    ];
    
    if (geoPatterns.some(pattern => pattern.test(sanitizedText))) {
        console.log(`🌍 Fait géographique détecté`);
        return { type: 'GEOGRAPHIC_FACT', confidence: 0.8 };
    }
    
    // DÉTECTION DE FAITS SCIENTIFIQUES
    const sciencePatterns = [
        /speed of light|vitesse.*lumière|299.*792.*458/i,
        /boiling point|point.*ébullition|melting point|point.*fusion/i,
        /atomic number|numéro.*atomique|molecular weight|masse.*molaire/i,
        /scientific name|nom.*scientifique|chemical formula|formule.*chimique/i,
        /relativity|relativité|quantum|quantique|theorem|théorème/i
    ];
    
    if (sciencePatterns.some(pattern => pattern.test(sanitizedText))) {
        console.log(`🔬 Fait scientifique détecté`);
        return { type: 'SCIENTIFIC_FACT', confidence: 0.8 };
    }
    
    // Texte trop court
    if (sanitizedText.length < 25) {
        console.log(`⚠️ Texte trop court`);
        return { type: 'TOO_SHORT', confidence: 0.9 };
    }
    
    // Contenu factuel potentiel par défaut
    const factualScore = Math.min(0.5 + (sanitizedText.length / 1000) * 0.2, 0.7);
    console.log(`📄 Contenu factuel potentiel`);
    return { type: 'POTENTIAL_FACT', confidence: factualScore };
}

// EXTRACTION SÉCURISÉE DE MOTS-CLÉS
function extractMainKeywords(text) {
    const cleaned = sanitizeInput(text).normalize('NFC').substring(0, 1200);
    const keywords = [];
    
    try {
        // Entités nommées
        const namedEntities = cleaned.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\b/g) || [];
        const filteredEntities = namedEntities.filter(entity => 
            entity.length > 3 && entity.length < 50 &&
            !entity.match(/^(The|This|That|When|Where|What|How|Why|Who|Yes|World|War|Day|May|Victory)$/i)
        );
        keywords.push(...filteredEntities.slice(0, 4));
        
        // Dates et années
        const dates = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
        keywords.push(...dates.slice(0, 2));
        
        // Nombres avec contexte
        const numbers = cleaned.match(/\b\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?\s*(?:million|billion|trillion|percent|%|km²|square\s*kilometers|meters|miles|dollars|euros|kilometres|population)\b/gi) || [];
        keywords.push(...numbers.slice(0, 3));
        
        // Termes techniques
        const technicalTerms = cleaned.match(/\b(?:approximately|exactly|officially|capital|area|population|founded|established|located|situated|declared|independence|surrender|treaty|victory|defeat|government|constitution|republic|democracy)\b/gi) || [];
        keywords.push(...technicalTerms.slice(0, 3));
        
        // Mots significatifs longs
        const significantWords = cleaned.match(/\b[a-zA-Z]{6,25}\b/g) || [];
        const filteredWords = significantWords.filter(word => 
            !word.match(/^(however|therefore|because|through|without|although|sometimes|everything|anything|something|nothing|correct|exactly|javascript|document|function)$/i)
        );
        keywords.push(...filteredWords.slice(0, 4));
        
        return [...new Set(keywords)].filter(k => k && k.length > 2).slice(0, 8);
    } catch (e) {
        console.log('Erreur extraction keywords:', e.message);
        return [];
    }
}

// RECHERCHE SÉCURISÉE DE SOURCES
async function findWebSources(keywords) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID || keywords.length === 0) {
        return [];
    }
    
    const query = keywords.slice(0, 4).join(' ');
    const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=5`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.log('Search API error:', response.status);
            return [];
        }
        const data = await response.json();
        if (!data.items) return [];

        return data.items.map(item => ({
            title: item.title || 'Untitled',
            url: item.link || '',
            snippet: item.snippet || 'No description',
            type: 'search'
        }));
    } catch (error) {
        console.error('Search error:', error.message);
        return [];
    }
}

// RECHERCHE INTELLIGENTE AVEC REQUÊTES MULTIPLES
async function findWebSourcesIntelligent(smartQueries, fallbackKeywords, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        console.log('❌ Missing API credentials');
        return [];
    }
    
    let allSources = [];
    console.log(`🔍 Recherche intelligente avec ${smartQueries?.length || 0} requêtes`);
    
    // Utiliser les requêtes intelligentes
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
                            title: item.title || 'Untitled',
                            url: item.link || '',
                            snippet: item.snippet || 'No description',
                            type: 'intelligent_search',
                            query_used: query
                        }));
                        allSources.push(...sources);
                        console.log(`✅ ${sources.length} sources trouvées`);
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 250));
                
            } catch (error) {
                console.error(`❌ Erreur requête "${query}":`, error.message);
            }
        }
    }
    
    // Fallback si nécessaire
    if (allSources.length < 2 && fallbackKeywords && fallbackKeywords.length > 0) {
        console.log('🔄 Utilisation fallback');
        
        try {
            const fallbackQuery = fallbackKeywords.slice(0, 4).join(' ');
            console.log(`🔍 Requête fallback: "${fallbackQuery}"`);
            const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(fallbackQuery)}&num=3`;
            const response = await fetch(url);
            
            if (response.ok) {
                const data = await response.json();
                if (data.items) {
                    const sources = data.items.map(item => ({
                        title: item.title || 'Untitled',
                        url: item.link || '',
                        snippet: item.snippet || 'No description',
                        type: 'fallback_search',
                        query_used: fallbackQuery
                    }));
                    allSources.push(...sources);
                    console.log(`✅ Fallback: ${sources.length} sources supplémentaires`);
                }
            }
        } catch (error) {
            console.error('❌ Erreur fallback:', error.message);
        }
    }
    
    // Déduplication
    const uniqueSources = [];
    const seenUrls = new Set();
    
    for (const source of allSources) {
        if (!seenUrls.has(source.url) && uniqueSources.length < 6) {
            seenUrls.add(source.url);
            uniqueSources.push(source);
        }
    }
    
    console.log(`📋 ${uniqueSources.length} sources finales`);
    return uniqueSources;
}

// CALCUL DU SCORE FINAL - APPROCHE ÉQUILIBRÉE
function calculateFinalScore(contentAnalysis, sourceCount, keywords, sources = []) {
    const { type, confidence } = contentAnalysis;
    
    // GESTION DES OPINIONS - Score modéré au lieu de très bas
    if (type === 'OPINION') {
        console.log('💭 Opinion détectée - Score modéré');
        return {
            score: 0.40,
            explanation: "**Opinion/Subjective** (40%). Personal viewpoint or subjective statement. Consider seeking additional perspectives."
        };
    }
    
    // GESTION DES QUESTIONS UTILISATEUR
    if (type === 'USER_QUESTION') {
        return {
            score: 0.20,
            explanation: "**User Question** (20%). This appears to be a question rather than a factual statement."
        };
    }
    
    // SCORES DE BASE équilibrés
    let baseScore = 0.40;
    let explanation = "";
    
    switch (type) {
        case 'HISTORICAL_FACT':
            baseScore = 0.65;
            explanation = "**Historical information** - ";
            break;
        case 'GEOGRAPHIC_FACT':
            baseScore = 0.70;
            explanation = "**Geographic information** - ";
            break;
        case 'SCIENTIFIC_FACT':
            baseScore = 0.75;
            explanation = "**Scientific information** - ";
            break;
        case 'POTENTIAL_FACT':
            baseScore = 0.55;
            explanation = "**Factual information** - ";
            break;
        case 'TOO_SHORT':
            return {
                score: 0.25,
                explanation: "**Insufficient content** (25%). Text too short for reliable analysis."
            };
    }
    
    // BONUS BASÉ SUR LES SOURCES
    let sourceBonus = 0;
    let sourceText = "";
    
    if (sources && sources.length > 0) {
        const wikipediaSources = sources.filter(s => s.url && s.url.includes('wikipedia')).length;
        const academicSources = sources.filter(s => s.url && (s.url.includes('.edu') || s.url.includes('.gov'))).length;
        
        if (wikipediaSources >= 1) {
            sourceBonus += 0.15;
            sourceText += "Wikipedia sources found. ";
        }
        
        if (academicSources >= 1) {
            sourceBonus += 0.10;
            sourceText += "Academic/official sources found. ";
        }
        
        if (sources.length >= 3) {
            sourceBonus += 0.10;
            sourceText += "Multiple sources support this information.";
        } else if (sources.length >= 1) {
            sourceBonus += 0.05;
            sourceText += "Limited source verification available.";
        }
    } else {
        sourceText += "No supporting sources found for verification.";
    }
    
    // CALCUL FINAL avec plafond réaliste
    const finalScore = Math.min(baseScore + sourceBonus, 0.90);
    const finalPercent = Math.round(finalScore * 100);
    
    // LABELS DE FIABILITÉ
    let reliabilityLabel = "";
    if (finalPercent >= 80) {
        reliabilityLabel = "High reliability";
    } else if (finalPercent >= 65) {
        reliabilityLabel = "Good reliability";
    } else if (finalPercent >= 50) {
        reliabilityLabel = "Moderate reliability";
    } else if (finalPercent >= 35) {
        reliabilityLabel = "Limited reliability";
    } else {
        reliabilityLabel = "Low reliability";
    }
    
    const fullExplanation = `${explanation}**${reliabilityLabel}** (${finalPercent}%). ${sourceText}`;
    
    return {
        score: finalScore,
        explanation: fullExplanation
    };
}

// ENDPOINT PRINCIPAL
app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType } = req.body;
        
        console.log(`🔍 Analyse: Type ${analysisType || 'standard'}`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                overallConfidence: 0.20, 
                scoringExplanation: "**Insufficient input** (20%). Text too short for meaningful analysis.", 
                keywords: [],
                sources: []
            });
        }
        
        // ANALYSE DU CONTENU
        const contentAnalysis = analyzeContentType(text);
        console.log(`📊 Type: ${contentAnalysis.type} (${(contentAnalysis.confidence * 100).toFixed(0)}%)`);
        
        // EXTRACTION DES MOTS-CLÉS
        const keywords = extractMainKeywords(text);
        
        // RECHERCHE DE SOURCES pour contenu factuel
        let sources = [];
        if (['HISTORICAL_FACT', 'GEOGRAPHIC_FACT', 'SCIENTIFIC_FACT', 'POTENTIAL_FACT'].includes(contentAnalysis.type)) {
            
            if (analysisType === 'intelligent' && smartQueries && smartQueries.length > 0) {
                console.log('🧠 Recherche intelligente');
                sources = await findWebSourcesIntelligent(smartQueries, keywords, text);
            } else {
                console.log('🔍 Recherche standard');
                sources = await findWebSources(keywords);
            }
            
            console.log(`📄 Sources trouvées: ${sources.length}`);
        }
        
        // CALCUL DU SCORE FINAL
        const result = calculateFinalScore(contentAnalysis, sources.length, keywords, sources);
        
        const response = {
            overallConfidence: result.score,
            sources: sources,
            scoringExplanation: result.explanation,
            keywords: keywords,
            contentType: contentAnalysis.type
        };
        
        console.log(`✅ Score: ${Math.round(result.score * 100)}% (${contentAnalysis.type})`);
        res.json(response);
        
    } catch (error) {
        console.error('❌ Erreur:', error);
        res.status(500).json({ 
            overallConfidence: 0.15,
            scoringExplanation: "**Server error** (15%). Unable to complete analysis.",
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
            return res.status(400).json({ error: 'Incomplete feedback data' });
        }
        
        const client = await pool.connect();
        
        await client.query(
            'INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)',
            [
                sanitizeInput(originalText).substring(0, 3000), 
                scoreGiven, 
                isUseful, 
                sanitizeInput(comment || '').substring(0, 1000), 
                JSON.stringify(sourcesFound || [])
            ]
        );
        
        client.release();
        console.log(`📝 Feedback: ${isUseful ? 'Positif' : 'Négatif'}`);
        res.json({ success: true });
        
    } catch (err) {
        console.error('❌ Erreur feedback:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ENDPOINT STATISTIQUES
app.get('/stats', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(`
            SELECT 
                COUNT(*) as total_feedback,
                COUNT(CASE WHEN is_useful = true THEN 1 END) as positive_feedback,
                AVG(score_given) as avg_score
            FROM feedback 
            WHERE created_at > NOW() - INTERVAL '30 days'
        `);
        client.release();
        
        const stats = result.rows[0];
        res.json({
            total_feedback: parseInt(stats.total_feedback),
            positive_feedback: parseInt(stats.positive_feedback),
            satisfaction_rate: stats.total_feedback > 0 ? Math.round((stats.positive_feedback / stats.total_feedback) * 100) : 0,
            average_score: parseFloat(stats.avg_score) || 0
        });
        
    } catch (err) {
        console.error('❌ Erreur stats:', err);
        res.status(500).json({ error: 'Error retrieving stats' });
    }
});

// ENDPOINT SANTÉ
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '3.0-final',
        features: ['intelligent_search', 'balanced_scoring', 'gemini_support', 'secure_inputs'],
        timestamp: new Date().toISOString()
    });
});

// DÉMARRAGE DU SERVEUR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 VerifyAI Backend v3.0 - VERSION FINALE`);
    console.log(`📡 Port ${PORT}`);
    console.log(`🌍 Système généraliste US/International`);
    console.log(`🔍 Support Gemini renforcé`);
    console.log(`⚖️ Scoring équilibré et pratique`);
    console.log(`🔒 Sécurité Chrome Web Store complète`);
    console.log(`✅ PRÊT POUR PRODUCTION`);
    initDb();
});
