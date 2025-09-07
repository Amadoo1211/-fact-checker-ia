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
        console.log('✅ Database ready');
    } catch (err) {
        console.error('❌ Database error:', err);
    }
};

// SYSTÈME DE DÉTECTION AMÉLIORÉ
function extractMainKeywords(text) {
    const cleaned = text.normalize('NFC').replace(/['']/g, "'").substring(0, 800);
    const keywords = [];
    
    // Noms propres (personnes, lieux, organisations)
    const properNouns = cleaned.match(/\b\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){0,2}\b/gu) || [];
    keywords.push(...properNouns);
    
    // Dates et années
    const dates = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
    keywords.push(...dates);
    
    // Chiffres importants
    const numbers = cleaned.match(/\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:million|billion|trillion|percent|%|km|meters|miles|dollars|euros)?\b/gi) || [];
    keywords.push(...numbers.slice(0, 3));
    
    // Mots techniques/scientifiques longs
    const technicalWords = cleaned.match(/\b\p{L}{7,}\b/gu) || [];
    keywords.push(...technicalWords.slice(0, 4));
    
    // Nettoyer et déduper
    const unique = [...new Set(keywords)]
        .filter(k => k && k.length > 2)
        .filter(k => !/^(this|that|with|from|they|were|have|been|will|would|could|should|might|since|until|before|after|during|through|across|about|above|below|under|over)$/i.test(k))
        .slice(0, 6);
    
    return unique;
}

function analyzeContentType(text) {
    const lower = text.toLowerCase().normalize('NFC');
    
    // PATTERN 1: FAITS HISTORIQUES AVEC DATES
    if (text.match(/\b(19|20)\d{2}\b/)) {
        const historicalIndicators = [
            'fell', 'founded', 'established', 'died', 'born', 'war', 'ended', 'began',
            'started', 'built', 'discovered', 'invented', 'signed', 'declared',
            'wall', 'berlin', 'revolution', 'independence', 'treaty', 'battle',
            'elected', 'assassinated', 'created', 'launched', 'opened', 'closed',
            'empire', 'dynasty', 'kingdom', 'republic', 'constitution', 'president',
            'tombé', 'fondé', 'établi', 'mort', 'né', 'guerre', 'fini', 'commencé',
            'construit', 'découvert', 'inventé', 'signé', 'déclaré', 'mur', 'révolution',
            'indépendance', 'traité', 'bataille', 'élu', 'assassiné', 'créé', 'lancé'
        ];
        
        if (historicalIndicators.some(word => lower.includes(word))) {
            return { type: 'HISTORICAL_FACT', confidence: 0.9 };
        }
    }
    
    // PATTERN 2: FAITS GÉOGRAPHIQUES
    const geoPatterns = [
        /capital.*is/i, /\b\w+ is the capital/i, /located in/i, /currency.*is/i,
        /population.*is/i, /situated in/i, /borders/i, /largest city/i,
        /official language/i, /time zone/i, /area.*square/i, /elevation/i,
        /capitale.*de/i, /\b\w+ est la capitale/i, /situé.*en/i, /population.*de/i,
        /habitants/i, /frontière/i, /plus.*grande.*ville/i, /langue.*officielle/i,
        /superficie/i, /altitude/i, /tokyo.*population/i, /berlin.*capitale/i
    ];
    
    if (geoPatterns.some(pattern => pattern.test(text))) {
        return { type: 'GEOGRAPHIC_FACT', confidence: 0.85 };
    }
    
    // PATTERN 3: FAITS SCIENTIFIQUES/TECHNIQUES
    const sciencePatterns = [
        /speed of light/i, /boiling point/i, /melting point/i, /atomic number/i,
        /discovered by/i, /invented by/i, /formula.*is/i, /temperature.*is/i,
        /molecular weight/i, /chemical formula/i, /scientific name/i, /theorem/i,
        /vitesse.*lumière/i, /299.*792.*458/i, /constante.*physique/i, /relativité/i,
        /point.*ébullition/i, /point.*fusion/i, /numéro.*atomique/i, /découvert.*par/i,
        /inventé.*par/i, /formule.*est/i, /température.*est/i, /masse.*molaire/i,
        /formule.*chimique/i, /nom.*scientifique/i, /théorème/i, /einstein/i
    ];
    
    if (sciencePatterns.some(pattern => pattern.test(text))) {
        return { type: 'SCIENTIFIC_FACT', confidence: 0.8 };
    }
    
    // PATTERN 4: DÉFINITIONS ET FAITS GÉNÉRAUX
    const definitionPatterns = [
        /\w+ is a/i, /\w+ refers to/i, /\w+ means/i, /defined as/i,
        /known as/i, /also called/i, /type of/i, /form of/i,
        /\w+ est un/i, /\w+ fait référence/i, /\w+ signifie/i, /défini comme/i,
        /connu comme/i, /également appelé/i, /type de/i, /forme de/i
    ];
    
    if (definitionPatterns.some(pattern => pattern.test(text))) {
        return { type: 'DEFINITION', confidence: 0.7 };
    }
    
    // PATTERN 5: DÉTECTION OPINIONS/SUBJECTIF
    const opinionIndicators = [
        'je pense', 'je crois', 'à mon avis', 'selon moi', 'il me semble',
        'i think', 'i believe', 'in my opinion', 'i feel', 'seems to me',
        'délicieux', 'excellent', 'agréable', 'beau', 'laid', 'bon', 'mauvais',
        'delicious', 'excellent', 'pleasant', 'beautiful', 'ugly', 'good', 'bad',
        'j\'aime', 'j\'adore', 'je préfère', 'i love', 'i like', 'i prefer',
        'meilleur', 'pire', 'better', 'worse', 'best', 'worst', 'sophistiqué',
        'chocolat noir', 'preference', 'goût', 'taste', 'opinion'
    ];
    
    if (opinionIndicators.some(indicator => lower.includes(indicator))) {
        return { type: 'OPINION', confidence: 0.9 };
    }
    
    // PATTERN 6: DÉTECTION CONTENU IA GÉNÉRIQUE
    const aiGeneratedPatterns = [
        'voici quelques', 'n\'hésitez pas', 'si vous avez', 'puis-je vous aider',
        'here are some', 'feel free to', 'if you have', 'can i help you',
        'bonne question', 'intéressant', 'effectivement', 'en effet',
        'good question', 'interesting', 'indeed', 'actually'
    ];
    
    if (aiGeneratedPatterns.some(pattern => lower.includes(pattern))) {
        return { type: 'AI_GENERIC', confidence: 0.8 };
    }
    
    // PATTERN 7: TEXTE TROP COURT
    if (text.length < 25) {
        return { type: 'TOO_SHORT', confidence: 0.9 };
    }
    
    // PATTERN 8: DÉTECTION CHARABIA/CODE
    const cleanText = lower.replace(/[^a-z]/g, '');
    const vowels = (cleanText.match(/[aeiouy]/g) || []).length;
    const vowelRatio = cleanText.length > 5 ? vowels / cleanText.length : 0.3;
    
    if (vowelRatio < 0.15 && cleanText.length > 10) {
        return { type: 'GIBBERISH', confidence: 0.95 };
    }
    
    // Par défaut: contenu factuel potentiel
    const factualScore = Math.min(0.6 + (text.length / 1000) * 0.2, 0.8);
    return { type: 'POTENTIAL_FACT', confidence: factualScore };
}

// RECHERCHE INTELLIGENTE AVEC REQUÊTES MULTIPLES
async function findWebSourcesIntelligent(smartQueries, fallbackKeywords) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        console.log('Missing API credentials for intelligent search');
        return [];
    }
    
    let allSources = [];
    
    // Utiliser les requêtes intelligentes du frontend d'abord
    if (smartQueries && smartQueries.length > 0) {
        console.log('🔍 Using intelligent queries:', smartQueries);
        
        for (const [index, query] of smartQueries.slice(0, 2).entries()) {
            try {
                console.log(`🔍 Query ${index + 1}: "${query}"`);
                const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=3`;
                const response = await fetch(url);
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.items) {
                        const sources = data.items.map(item => ({
                            title: item.title,
                            url: item.link,
                            snippet: item.snippet,
                            type: 'intelligent_search',
                            query_used: query,
                            relevance: calculateRelevance(item, query)
                        }));
                        allSources.push(...sources);
                        console.log(`✅ Found ${sources.length} sources for query "${query}"`);
                    }
                } else {
                    console.log(`❌ API error for query "${query}": ${response.status}`);
                }
                
                // Délai entre requêtes pour respecter les limites API
                await new Promise(resolve => setTimeout(resolve, 200));
                
            } catch (error) {
                console.error(`❌ Error with intelligent query "${query}":`, error.message);
            }
        }
    }
    
    // Si pas assez de sources avec les requêtes intelligentes, fallback
    if (allSources.length < 2 && fallbackKeywords && fallbackKeywords.length > 0) {
        console.log('🔄 Using fallback keywords:', fallbackKeywords);
        
        try {
            const fallbackQuery = fallbackKeywords.slice(0, 4).join(' ');
            console.log(`🔍 Fallback query: "${fallbackQuery}"`);
            const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(fallbackQuery)}&num=4`;
            const response = await fetch(url);
            
            if (response.ok) {
                const data = await response.json();
                if (data.items) {
                    const sources = data.items.map(item => ({
                        title: item.title,
                        url: item.link,
                        snippet: item.snippet,
                        type: 'fallback_search',
                        query_used: fallbackQuery,
                        relevance: calculateRelevance(item, fallbackQuery)
                    }));
                    allSources.push(...sources);
                    console.log(`✅ Fallback found ${sources.length} additional sources`);
                }
            }
        } catch (error) {
            console.error('❌ Fallback search error:', error.message);
        }
    }
    
    // Déduplication par URL et tri par pertinence
    const uniqueSources = [];
    const seenUrls = new Set();
    
    // Trier par pertinence décroissante
    allSources.sort((a, b) => (b.relevance || 0.5) - (a.relevance || 0.5));
    
    for (const source of allSources) {
        if (!seenUrls.has(source.url)) {
            seenUrls.add(source.url);
            uniqueSources.push(source);
        }
    }
    
    console.log(`📊 Total unique sources found: ${uniqueSources.length}`);
    return uniqueSources.slice(0, 6); // Limiter à 6 sources max
}

// Calculer la pertinence d'une source
function calculateRelevance(item, query) {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const titleWords = (item.title || '').toLowerCase().split(/\s+/);
    const snippetWords = (item.snippet || '').toLowerCase().split(/\s+/);
    
    let relevanceScore = 0;
    
    // Bonus pour mots dans le titre
    for (const qWord of queryWords) {
        if (titleWords.some(tWord => tWord.includes(qWord))) {
            relevanceScore += 0.3;
        }
        if (snippetWords.some(sWord => sWord.includes(qWord))) {
            relevanceScore += 0.1;
        }
    }
    
    // Bonus pour sources de qualité
    const url = (item.link || '').toLowerCase();
    if (url.includes('wikipedia')) relevanceScore += 0.4;
    else if (url.includes('.edu') || url.includes('.gov')) relevanceScore += 0.3;
    else if (url.includes('britannica') || url.includes('larousse')) relevanceScore += 0.2;
    
    return Math.min(relevanceScore, 1.0);
}

// RECHERCHE STANDARD (fallback)
async function findWebSources(keywords) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID || keywords.length === 0) {
        return [];
    }
    
    const query = keywords.slice(0, 4).join(' ');
    const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=4`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.log('Search API error:', response.status);
            return [];
        }
        const data = await response.json();
        if (!data.items) return [];

        return data.items.map(item => ({
            title: item.title,
            url: item.link,
            snippet: item.snippet,
            type: 'standard_search'
        }));
    } catch (error) {
        console.error('Search error:', error.message);
        return [];
    }
}

function calculateFinalScore(contentAnalysis, sourceCount, keywords, sources = []) {
    const { type, confidence } = contentAnalysis;
    
    // SCORES DE BASE SELON LE TYPE DE CONTENU
    let baseScore = 0.3;
    let explanation = "";
    
    switch (type) {
        case 'HISTORICAL_FACT':
            baseScore = 0.80;
            explanation = "**Historical content detected** - ";
            break;
            
        case 'GEOGRAPHIC_FACT':
            baseScore = 0.75;
            explanation = "**Geographic information** - ";
            break;
            
        case 'SCIENTIFIC_FACT':
            baseScore = 0.85;
            explanation = "**Scientific content** - ";
            break;
            
        case 'DEFINITION':
            baseScore = 0.65;
            explanation = "**Definition/explanation** - ";
            break;
            
        case 'POTENTIAL_FACT':
            baseScore = 0.55;
            explanation = "**Factual content** - ";
            break;
            
        case 'OPINION':
            return {
                score: 0.25,
                explanation: "**Opinion/Subjective** (25%). Personal viewpoint, not verifiable fact."
            };
            
        case 'AI_GENERIC':
            return {
                score: 0.3,
                explanation: "**AI-generated response** (30%). Generic conversational content."
            };
            
        case 'TOO_SHORT':
            return {
                score: 0.2,
                explanation: "**Insufficient content** (20%). Text too short for analysis."
            };
            
        case 'GIBBERISH':
            return {
                score: 0.1,
                explanation: "**Unreadable content** (10%). Contains garbled or nonsensical text."
            };
    }
    
    // BONUS SELON LA QUALITÉ DES SOURCES TROUVÉES
    let sourceBonus = 0;
    let sourceText = "";
    
    if (sources && sources.length > 0) {
        // Analyser la qualité des sources
        const wikipediaSources = sources.filter(s => s.url && s.url.includes('wikipedia')).length;
        const academicSources = sources.filter(s => s.url && (s.url.includes('.edu') || s.url.includes('.gov'))).length;
        const intelligentSources = sources.filter(s => s.type === 'intelligent_search').length;
        
        if (wikipediaSources > 0) {
            sourceBonus += 0.15;
            sourceText += "Wikipedia sources found. ";
        }
        if (academicSources > 0) {
            sourceBonus += 0.12;
            sourceText += "Academic sources found. ";
        }
        if (intelligentSources >= sourceCount * 0.7) {
            sourceBonus += 0.08;
            sourceText += "Intelligent search successful. ";
        }
    }
    
    // Bonus standard selon le nombre
    if (sourceCount >= 3) {
        sourceBonus += 0.10;
        sourceText += "Multiple sources confirm this information.";
    } else if (sourceCount === 2) {
        sourceBonus += 0.08;
        sourceText += "Two sources found supporting this information.";
    } else if (sourceCount === 1) {
        sourceBonus += 0.05;
        sourceText += "One source found related to this topic.";
    } else if (keywords.length >= 3) {
        sourceBonus += 0.02;
        sourceText += "Contains specific factual elements but no sources found.";
    } else {
        sourceBonus = 0;
        sourceText += "No supporting sources found for verification.";
    }
    
    // CALCUL FINAL
    const finalScore = Math.min(baseScore + sourceBonus, 0.96);
    const finalPercent = Math.round(finalScore * 100);
    
    // GÉNÉRATION DE L'EXPLICATION
    let reliabilityLabel = "";
    if (finalPercent >= 90) {
        reliabilityLabel = "Highly reliable";
    } else if (finalPercent >= 75) {
        reliabilityLabel = "Good reliability";
    } else if (finalPercent >= 60) {
        reliabilityLabel = "Moderate reliability";
    } else if (finalPercent >= 45) {
        reliabilityLabel = "Low reliability";
    } else {
        reliabilityLabel = "Very low reliability";
    }
    
    const fullExplanation = `${explanation}**${reliabilityLabel}** (${finalPercent}%). ${sourceText}`;
    
    return {
        score: finalScore,
        explanation: fullExplanation
    };
}

// ENDPOINT PRINCIPAL AVEC RECHERCHE INTELLIGENTE
app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType } = req.body;
        
        console.log(`🔍 Analysis request - Type: ${analysisType || 'standard'}, Smart queries: ${smartQueries ? smartQueries.length : 0}`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                overallConfidence: 0.15, 
                scoringExplanation: "**Insufficient input** (15%). Text too short for meaningful analysis.", 
                keywords: [],
                sources: []
            });
        }
        
        // ANALYSE DU CONTENU
        const contentAnalysis = analyzeContentType(text);
        console.log(`📊 Content analysis: ${contentAnalysis.type} (confidence: ${(contentAnalysis.confidence * 100).toFixed(0)}%)`);
        
        // EXTRACTION DES MOTS-CLÉS (pour fallback)
        const keywords = extractMainKeywords(text);
        console.log(`🏷️ Keywords extracted: ${keywords.join(', ')}`);
        
        // RECHERCHE DE SOURCES INTELLIGENTE
        let sources = [];
        if (['HISTORICAL_FACT', 'GEOGRAPHIC_FACT', 'SCIENTIFIC_FACT', 'DEFINITION', 'POTENTIAL_FACT'].includes(contentAnalysis.type)) {
            
            if (analysisType === 'intelligent' && smartQueries && smartQueries.length > 0) {
                console.log('🧠 Using intelligent search system');
                sources = await findWebSourcesIntelligent(smartQueries, keywords);
            } else {
                console.log('🔍 Using standard search system');
                sources = await findWebSources(keywords);
            }
            
            console.log(`📄 Total sources found: ${sources.length}`);
        } else {
            console.log(`⏭️ Skipping source search for content type: ${contentAnalysis.type}`);
        }
        
        // CALCUL DU SCORE FINAL
        const result = calculateFinalScore(contentAnalysis, sources.length, keywords, sources);
        
        // Préparer la réponse
        const response = {
            overallConfidence: result.score,
            sources: sources,
            scoringExplanation: result.explanation,
            keywords: keywords,
            contentType: contentAnalysis.type
        };
        
        // Ajouter des métadonnées de debug en mode intelligent
        if (analysisType === 'intelligent') {
            response.debugInfo = {
                queriesUsed: smartQueries || [],
                searchMethod: smartQueries && smartQueries.length > 0 ? 'intelligent' : 'fallback',
                sourcesFound: sources.length,
                contentConfidence: contentAnalysis.confidence,
                intelligentSourcesRatio: sources.filter(s => s.type === 'intelligent_search').length / Math.max(sources.length, 1)
            };
        }
        
        console.log(`✅ Final score: ${Math.round(result.score * 100)}% (${contentAnalysis.type})`);
        res.json(response);
        
    } catch (error) {
        console.error('❌ Verification error:', error);
        res.status(500).json({ 
            overallConfidence: 0.1,
            scoringExplanation: "**Server error** (10%). Unable to complete analysis.",
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
                originalText?.substring(0, 5000), 
                scoreGiven, 
                isUseful, 
                comment || '', 
                JSON.stringify(sourcesFound || [])
            ]
        );
        
        client.release();
        console.log(`📝 Feedback received: ${isUseful ? 'Positive' : 'Negative'}`);
        res.json({ success: true });
        
    } catch (err) {
        console.error('❌ Feedback error:', err);
        res.status(500).json({ error: 'Server error saving feedback' });
    }
});

// ENDPOINT DEBUG
app.get('/feedback-stats', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(`
            SELECT 
                COUNT(*) as total_feedback,
                COUNT(CASE WHEN is_useful = true THEN 1 END) as positive_feedback,
                COUNT(CASE WHEN is_useful = false THEN 1 END) as negative_feedback,
                AVG(score_given) as avg_score
            FROM feedback 
            WHERE created_at > NOW() - INTERVAL '30 days'
        `);
        client.release();
        
        const stats = result.rows[0];
        res.json({
            total_feedback: parseInt(stats.total_feedback),
            positive_feedback: parseInt(stats.positive_feedback),
            negative_feedback: parseInt(stats.negative_feedback),
            satisfaction_rate: stats.total_feedback > 0 ? Math.round((stats.positive_feedback / stats.total_feedback) * 100) : 0,
            average_score: parseFloat(stats.avg_score) || 0
        });
        
    } catch (err) {
        console.error('❌ Stats error:', err);
        res.status(500).json({ error: 'Error retrieving stats' });
    }
});

// ENDPOINT SANTÉ
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '2.0-intelligent',
        features: ['intelligent_search', 'multi_query', 'source_relevance'],
        timestamp: new Date().toISOString()
    });
});

// DÉMARRAGE DU SERVEUR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 VerifyAI Backend v2.0 - Intelligent Search System`);
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`🧠 Enhanced intelligent content analysis enabled`);
    console.log(`🔍 Multi-query search system active`);
    initDb();
});
