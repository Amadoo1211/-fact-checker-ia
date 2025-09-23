const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Configuration CORS élargie pour le développement
app.use(cors({ 
    origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app', 'http://localhost:*', 'https://localhost:*'],
    credentials: true
}));
app.use(express.json({ limit: '5mb' }));

// Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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
        console.log('✅ Database ready');
    } catch (err) {
        console.error('❌ Database error:', err.message);
    }
};

// Secure cleanup
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

// INTELLIGENT CONTENT ANALYSIS
function analyzeContentType(text) {
    const sanitizedText = sanitizeInput(text);
    const lower = sanitizedText.toLowerCase();
    
    console.log(`🔍 Analysis: "${sanitizedText.substring(0, 60)}..."`);
    
    // 1. SUBJECTIVE OPINION DETECTION
    const opinionPatterns = [
        /\b(je pense|je crois|je sens|à mon avis|personnellement|subjectivement)\b/i,
        /\b(i think|i believe|i feel|in my opinion|personally|subjectively)\b/i,
        /\b(better than|worse than|prefer|favorite|best|worst)\b/i,
        /\b(beautiful|ugly|delicious|terrible|amazing|awful)\b/i,
        /\b(love|hate|like|dislike).*more\b/i,
        /\b(matter of taste|subjective|personal preference)\b/i
    ];
    
    for (const pattern of opinionPatterns) {
        if (pattern.test(sanitizedText)) {
            console.log(`💭 Subjective opinion detected`);
            return { type: 'OPINION', confidence: 0.9 };
        }
    }
    
    // 2. QUESTION DETECTION
    if (sanitizedText.length < 300 && (/^(what|how|why|when|where|which|who|can you|could you)\b/i.test(sanitizedText.trim()) || 
        /^(qu'est|comment|pourquoi|quand|où|qui|quel|quelle)\b/i.test(sanitizedText.trim()) ||
        sanitizedText.includes('?'))) {
        return { type: 'QUESTION', confidence: 0.95 };
    }
    
    // 3. VERIFIABLE FACTS DETECTION
    
    // Historical facts with dates
    if (/\b(19|20)\d{2}\b/.test(sanitizedText)) {
        const historicalWords = ['fondé', 'établi', 'né', 'mort', 'guerre', 'traité', 'indépendance', 'victoire', 'défaite', 'empire', 'président', 'révolution', 'founded', 'established', 'born', 'died', 'war', 'treaty', 'independence', 'victory', 'defeat', 'empire', 'president', 'revolution'];
        if (historicalWords.some(word => lower.includes(word))) {
            console.log(`📚 Historical fact detected`);
            return { type: 'HISTORICAL_FACT', confidence: 0.85 };
        }
    }
    
    // Geographic facts
    if (/\b(capitale|population|superficie|kilomètres carrés|km²|situé.*dans|frontières|capital|area|square.*kilometers|located.*in|borders)\b/i.test(sanitizedText)) {
        console.log(`🌍 Geographic fact detected`);
        return { type: 'GEOGRAPHIC_FACT', confidence: 0.85 };
    }
    
    // Scientific facts
    if (/\b(vitesse.*lumière|point.*ébullition|numéro.*atomique|formule.*chimique|speed.*light|boiling.*point|atomic.*number|chemical.*formula|299.*792.*458)\b/i.test(sanitizedText)) {
        console.log(`🔬 Scientific fact detected`);
        return { type: 'SCIENTIFIC_FACT', confidence: 0.9 };
    }
    
    // Statistical facts
    if (/\b\d+(\.\d+)?\s*(pour.*cent|%|million|milliard|billions?|percent|trillion)\b/i.test(sanitizedText)) {
        console.log(`📊 Statistical fact detected`);
        return { type: 'STATISTICAL_FACT', confidence: 0.8 };
    }
    
    // 4. TOO SHORT CONTENT
    if (sanitizedText.length < 20) {
        return { type: 'TOO_SHORT', confidence: 0.95 };
    }
    
    // 5. GENERAL INFORMATION
    console.log(`📄 General information`);
    return { type: 'GENERAL_INFO', confidence: 0.6 };
}

// INTELLIGENT KEYWORD EXTRACTION
function extractMainKeywords(text) {
    const cleaned = sanitizeInput(text).substring(0, 1000);
    const keywords = [];
    
    try {
        // Named entities (proper nouns)
        const namedEntities = cleaned.match(/\b[A-Z][a-zA-ZÀ-ÿ]+(?:\s+[A-Z][a-zA-ZÀ-ÿ]+){0,2}\b/g) || [];
        const filteredEntities = namedEntities.filter(entity => 
            entity.length > 2 && entity.length < 40 &&
            !/^(The|This|That|When|Where|What|How|Why|Who|Yes|World|War|Day|May|Will|Can|Le|La|Les|Cette|Celui|Quand|Où|Quoi|Comment|Pourquoi|Qui|Oui|Monde|Guerre|Jour|Mai|Volonté|Peut)$/i.test(entity)
        );
        keywords.push(...filteredEntities.slice(0, 5));
        
        // Important dates
        const dates = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
        keywords.push(...dates.slice(0, 2));
        
        // Numbers with units
        const numbersWithUnits = cleaned.match(/\b\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?\s*(?:million|milliard|billions?|pour.*cent|%|km²|kilomètres|mètres|miles|habitants|population|percent|kilometers|meters|miles)\b/gi) || [];
        keywords.push(...numbersWithUnits.slice(0, 3));
        
        // Important words (bilingual)
        const importantWords = cleaned.match(/\b(?:capitale|président|fondé|établi|indépendance|victoire|défaite|traité|constitution|république|démocratie|population|superficie|température|vitesse|lumière|atomique|chimique|capital|president|founded|established|independence|victory|defeat|treaty|constitution|republic|democracy|area|temperature|speed|light|atomic|chemical)\b/gi) || [];
        keywords.push(...importantWords.slice(0, 4));
        
        // Significant long words
        const significantWords = cleaned.match(/\b[a-zA-ZÀ-ÿ]{6,20}\b/g) || [];
        const cleanedWords = significantWords.filter(word => 
            !/^(however|therefore|because|through|without|although|sometimes|something|anything|everything|nothing|javascript|function|document|cependant|donc|parce|travers|sans|bien|parfois|quelque|chose|tout|rien)$/i.test(word)
        );
        keywords.push(...cleanedWords.slice(0, 3));
        
        const finalKeywords = [...new Set(keywords)].filter(k => k && k.length > 2).slice(0, 8);
        console.log(`🏷️ Extracted keywords: ${finalKeywords.join(', ')}`);
        return finalKeywords;
        
    } catch (e) {
        console.log('❌ Keywords extraction error:', e.message);
        return [];
    }
}

// INTELLIGENT SOURCE SEARCH - VERSION CORRIGÉE
async function findWebSources(keywords, smartQueries, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    console.log(`🔑 API_KEY exists: ${!!API_KEY}`);
    console.log(`🔑 SEARCH_ENGINE_ID exists: ${!!SEARCH_ENGINE_ID}`);

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        console.log('❌ Missing API credentials - returning mock sources for testing');
        // SOURCES MOCK POUR LE DÉVELOPPEMENT
        return [
            {
                title: "Wikipedia - Information de référence",
                url: "https://fr.wikipedia.org/wiki/Main_Page",
                snippet: "Source d'information encyclopédique vérifiée",
                query_used: "mock_query",
                relevance: 0.8
            },
            {
                title: "Site officiel gouvernemental",
                url: "https://www.insee.fr",
                snippet: "Données officielles et statistiques",
                query_used: "mock_query",
                relevance: 0.9
            }
        ];
    }
    
    let allSources = [];
    console.log(`🔍 Starting search with ${smartQueries?.length || 0} smart queries and ${keywords.length} keywords`);
    
    // 1. RECHERCHE AVEC LES QUERIES INTELLIGENTES
    if (smartQueries && smartQueries.length > 0) {
        for (const [index, query] of smartQueries.slice(0, 2).entries()) {
            try {
                console.log(`🔍 Smart Query ${index + 1}: "${query}"`);
                const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=5&lr=lang_fr`;
                
                console.log(`📡 Calling API: ${url.substring(0, 100)}...`);
                const response = await fetch(url);
                const data = await response.json();
                
                console.log(`📊 API Response status: ${response.status}`);
                
                if (response.ok && data.items) {
                    const sources = data.items.map(item => ({
                        title: item.title || 'No title',
                        url: item.link || '',
                        snippet: item.snippet || 'No description',
                        query_used: query,
                        relevance: calculateRelevance(item, originalText)
                    }));
                    allSources.push(...sources);
                    console.log(`✅ Found ${sources.length} sources for query "${query}"`);
                } else {
                    console.log(`❌ API Error:`, data.error || 'Unknown error');
                }
                
                // Délai entre les requêtes
                await new Promise(resolve => setTimeout(resolve, 300));
                
            } catch (error) {
                console.error(`❌ Search error for query "${query}":`, error.message);
            }
        }
    }
    
    // 2. RECHERCHE FALLBACK AVEC LES MOTS-CLÉS
    if (allSources.length < 2 && keywords.length > 0) {
        try {
            const fallbackQuery = keywords.slice(0, 3).join(' ');
            console.log(`🔄 Fallback search: "${fallbackQuery}"`);
            const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(fallbackQuery)}&num=4&lr=lang_fr`;
            
            const response = await fetch(url);
            const data = await response.json();
            
            if (response.ok && data.items) {
                const sources = data.items.map(item => ({
                    title: item.title || 'No title',
                    url: item.link || '',
                    snippet: item.snippet || 'No description',
                    query_used: fallbackQuery,
                    relevance: calculateRelevance(item, originalText)
                }));
                allSources.push(...sources);
                console.log(`✅ Fallback found ${sources.length} sources`);
            }
        } catch (error) {
            console.error('❌ Fallback search error:', error.message);
        }
    }
    
    // 3. FILTRAGE ET DÉDUPLICATION
    const filteredSources = allSources.filter(source => source.relevance > 0.2);
    const uniqueSources = [];
    const seenUrls = new Set();
    
    filteredSources.sort((a, b) => b.relevance - a.relevance);
    
    for (const source of filteredSources) {
        if (!seenUrls.has(source.url) && uniqueSources.length < 6) {
            seenUrls.add(source.url);
            uniqueSources.push(source);
        }
    }
    
    console.log(`📋 Final: ${uniqueSources.length} unique sources selected`);
    return uniqueSources;
}

// SOURCE RELEVANCE CALCULATION
function calculateRelevance(item, originalText) {
    const title = (item.title || '').toLowerCase();
    const snippet = (item.snippet || '').toLowerCase();
    const url = (item.link || '').toLowerCase();
    const original = originalText.toLowerCase();
    
    let score = 0.3; // Score de base
    
    // Mots-clés communs
    const originalWords = original.split(/\s+/).filter(w => w.length > 3).slice(0, 10);
    const titleWords = title.split(/\s+/);
    const snippetWords = snippet.split(/\s+/);
    
    let commonWords = 0;
    for (const word of originalWords) {
        if (titleWords.includes(word) || snippetWords.includes(word)) {
            commonWords++;
        }
    }
    
    score += (commonWords / Math.max(originalWords.length, 1)) * 0.4;
    
    // Bonus pour les sources fiables
    if (url.includes('wikipedia.org')) score += 0.3;
    else if (url.includes('.edu') || url.includes('.gov') || url.includes('insee.fr') || url.includes('gouv.fr')) score += 0.25;
    else if (url.includes('britannica') || url.includes('nationalgeographic') || url.includes('larousse')) score += 0.2;
    else if (url.includes('history.com') || url.includes('smithsonian') || url.includes('lemonde.fr')) score += 0.15;
    
    // Pénalité pour les sources moins fiables
    if (url.includes('reddit.com') || url.includes('quora.com') || url.includes('yahoo.com/answers')) score -= 0.2;
    if (url.includes('blog') || url.includes('forum') || url.includes('commentaires')) score -= 0.1;
    
    return Math.max(0.1, Math.min(1, score));
}

// FINAL SCORING LOGIC - VERSION CORRIGÉE
function calculateFinalScore(contentAnalysis, sources, keywords) {
    const { type, confidence } = contentAnalysis;
    
    console.log(`🎯 Calculating score for type: ${type}, sources found: ${sources.length}`);
    
    // 1. OPINIONS - Score modéré
    if (type === 'OPINION') {
        return {
            score: 0.35,
            explanation: "**Opinion Subjective** (35%). Point de vue personnel qui nécessite d'autres perspectives pour être équilibré."
        };
    }
    
    // 2. QUESTIONS - Score bas
    if (type === 'QUESTION') {
        return {
            score: 0.25,
            explanation: "**Question Utilisateur** (25%). Ceci semble être une question plutôt qu'une affirmation factuelle."
        };
    }
    
    // 3. CONTENU TROP COURT
    if (type === 'TOO_SHORT') {
        return {
            score: 0.20,
            explanation: "**Contenu Insuffisant** (20%). Texte trop court pour une analyse fiable."
        };
    }
    
    // 4. FAITS VÉRIFIABLES - Score basé sur le type + sources
    let baseScore = 0.45;
    let explanation = "";
    
    switch (type) {
        case 'HISTORICAL_FACT':
            baseScore = 0.65;
            explanation = "**Fait Historique** - ";
            break;
        case 'GEOGRAPHIC_FACT':
            baseScore = 0.70;
            explanation = "**Information Géographique** - ";
            break;
        case 'SCIENTIFIC_FACT':
            baseScore = 0.75;
            explanation = "**Fait Scientifique** - ";
            break;
        case 'STATISTICAL_FACT':
            baseScore = 0.60;
            explanation = "**Données Statistiques** - ";
            break;
        case 'GENERAL_INFO':
        default:
            baseScore = 0.45;
            explanation = "**Information Générale** - ";
            break;
    }
    
    // 5. BONUS SOURCES - VERSION AMÉLIORÉE
    let sourceBonus = 0;
    let sourceText = "";
    
    if (sources && sources.length > 0) {
        console.log(`📚 Analyzing ${sources.length} sources for quality`);
        
        const wikipediaSources = sources.filter(s => s.url && s.url.includes('wikipedia')).length;
        const officialSources = sources.filter(s => s.url && (s.url.includes('.edu') || s.url.includes('.gov') || s.url.includes('insee.fr') || s.url.includes('gouv.fr'))).length;
        const highQualitySources = sources.filter(s => s.relevance && s.relevance > 0.6).length;
        
        // Bonus qualité
        if (wikipediaSources >= 1) {
            sourceBonus += 0.15;
            sourceText += "Sources Wikipédia trouvées. ";
        }
        
        if (officialSources >= 1) {
            sourceBonus += 0.12;
            sourceText += "Sources officielles/académiques. ";
        }
        
        if (highQualitySources >= 2) {
            sourceBonus += 0.08;
            sourceText += "Plusieurs sources très pertinentes. ";
        } else if (sources.length >= 3) {
            sourceBonus += 0.05;
            sourceText += "Plusieurs sources de vérification. ";
        } else {
            sourceBonus += 0.02;
            sourceText += "Sources de vérification limitées. ";
        }
        
        console.log(`💎 Source bonus calculated: +${Math.round(sourceBonus * 100)}%`);
    } else {
        sourceText = "Aucune source de vérification trouvée. ";
        console.log(`❌ No sources found - no bonus applied`);
    }
    
    // 6. CALCUL FINAL
    const finalScore = Math.min(baseScore + sourceBonus, 0.95);
    const finalPercent = Math.round(finalScore * 100);
    
    // 7. LIBELLÉS LOGIQUES
    let reliabilityLabel;
    if (finalPercent >= 85) reliabilityLabel = "Très Fiable";
    else if (finalPercent >= 70) reliabilityLabel = "Bonne Fiabilité";
    else if (finalPercent >= 55) reliabilityLabel = "Fiabilité Modérée";
    else if (finalPercent >= 40) reliabilityLabel = "Fiabilité Limitée";
    else reliabilityLabel = "Faible Fiabilité";
    
    const finalExplanation = `${explanation}**${reliabilityLabel}** (${finalPercent}%). ${sourceText}`;
    
    console.log(`✅ Final calculation: Base(${Math.round(baseScore*100)}%) + Sources(+${Math.round(sourceBonus*100)}%) = ${finalPercent}%`);
    
    return {
        score: finalScore,
        explanation: finalExplanation
    };
}

// MAIN ENDPOINT - VERSION CORRIGÉE
app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType } = req.body;
        
        console.log(`\n🔍 === NEW ANALYSIS REQUEST ===`);
        console.log(`📝 Text: "${text.substring(0, 100)}..."`);
        console.log(`🧠 Smart queries: ${smartQueries?.length || 0}`);
        console.log(`📊 Analysis type: ${analysisType || 'standard'}`);
        
        if (!text || text.length < 5) {
            console.log(`❌ Text too short: ${text?.length || 0} characters`);
            return res.json({ 
                overallConfidence: 0.20, 
                scoringExplanation: "**Entrée Insuffisante** (20%). Texte trop court pour une analyse significative.", 
                keywords: [],
                sources: []
            });
        }
        
        // 1. ANALYSE DU TYPE DE CONTENU
        const contentAnalysis = analyzeContentType(text);
        console.log(`📊 Content type: ${contentAnalysis.type} (confidence: ${Math.round(contentAnalysis.confidence*100)}%)`);
        
        // 2. EXTRACTION DES MOTS-CLÉS
        const keywords = extractMainKeywords(text);
        console.log(`🏷️ Extracted ${keywords.length} keywords: ${keywords.join(', ')}`);
        
        // 3. RECHERCHE DE SOURCES (pour les faits vérifiables uniquement)
        let sources = [];
        const searchableTypes = ['HISTORICAL_FACT', 'GEOGRAPHIC_FACT', 'SCIENTIFIC_FACT', 'STATISTICAL_FACT', 'GENERAL_INFO'];
        
        if (searchableTypes.includes(contentAnalysis.type)) {
            console.log(`🔍 Searching sources for ${contentAnalysis.type}...`);
            sources = await findWebSources(keywords, smartQueries, text);
            console.log(`📚 Search completed: ${sources.length} sources found`);
        } else {
            console.log(`⏭️ Skipping source search for content type: ${contentAnalysis.type}`);
        }
        
        // 4. CALCUL DU SCORE FINAL
        console.log(`🎯 Calculating final score...`);
        const result = calculateFinalScore(contentAnalysis, sources, keywords);
        
        // 5. CONSTRUCTION DE LA RÉPONSE
        const response = {
            overallConfidence: result.score,
            sources: sources || [],
            scoringExplanation: result.explanation,
            keywords: keywords || [],
            contentType: contentAnalysis.type
        };
        
        console.log(`✅ === ANALYSIS COMPLETED ===`);
        console.log(`🎯 Final score: ${Math.round(result.score * 100)}%`);
        console.log(`📚 Sources returned: ${sources.length}`);
        console.log(`🏷️ Keywords returned: ${keywords.length}`);
        console.log(`===============================\n`);
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ CRITICAL ERROR in /verify:', error);
        console.error('Stack:', error.stack);
        res.status(500).json({ 
            overallConfidence: 0.15,
            scoringExplanation: "**Erreur Serveur** (15%). Impossible de terminer l'analyse.",
            keywords: [],
            sources: [],
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// FEEDBACK ENDPOINT
app.post('/feedback', async (req, res) => {
    try {
        const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
        
        if (!originalText || scoreGiven === undefined || isUseful === undefined) {
            return res.status(400).json({ error: 'Données de feedback incomplètes' });
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
        console.log(`📝 Feedback reçu: ${isUseful ? 'Utile' : 'Pas utile'} - Score: ${scoreGiven}`);
        res.json({ success: true });
        
    } catch (err) {
        console.error('❌ Erreur feedback:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// STATS ENDPOINT
app.get('/stats', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN is_useful = true THEN 1 END) as positive,
                AVG(score_given) as average_score
            FROM feedback 
            WHERE created_at > NOW() - INTERVAL '7 days'
        `);
        client.release();
        
        const stats = result.rows[0];
        res.json({
            total_feedback: parseInt(stats.total),
            positive_feedback: parseInt(stats.positive),
            satisfaction_rate: stats.total > 0 ? Math.round((stats.positive / stats.total) * 100) : 0,
            average_score: parseFloat(stats.average_score) || 0
        });
        
    } catch (err) {
        console.error('❌ Erreur stats:', err);
        res.status(500).json({ error: 'Erreur stats' });
    }
});

// HEALTH ENDPOINT
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'FRENCH-CORRECTED-1.1',
        features: ['universal_capture', 'logical_scoring', 'relevant_sources', 'debug_logging'],
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        api_configured: !!(process.env.GOOGLE_API_KEY && process.env.SEARCH_ENGINE_ID)
    });
});

// Route de test pour débugger
app.get('/test', (req, res) => {
    res.json({
        message: 'Server is running',
        environment: process.env.NODE_ENV,
        api_key_configured: !!process.env.GOOGLE_API_KEY,
        search_engine_configured: !!process.env.SEARCH_ENGINE_ID,
        database_configured: !!process.env.DATABASE_URL
    });
});

// STARTUP
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 === VERIFYAI SERVER STARTED ===`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔑 Google API configured: ${!!process.env.GOOGLE_API_KEY}`);
    console.log(`🔍 Search Engine configured: ${!!process.env.SEARCH_ENGINE_ID}`);
    console.log(`💾 Database configured: ${!!process.env.DATABASE_URL}`);
    console.log(`🎯 Features: Universal capture, Logical scoring, Relevant sources`);
    console.log(`🐛 Debug logging: ENABLED`);
    console.log(`==================================\n`);
    initDb();
});
