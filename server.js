const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Final configuration
app.use(cors({ 
    origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'],
    credentials: true
}));
app.use(express.json({ limit: '5mb' }));

// Database
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
    if (sanitizedText.length < 300 && /^(what|how|why|when|where|which|who|can you|could you)\b/i.test(sanitizedText.trim())) {
        return { type: 'QUESTION', confidence: 0.95 };
    }
    
    // 3. VERIFIABLE FACTS DETECTION
    
    // Historical facts with dates
    if (/\b(19|20)\d{2}\b/.test(sanitizedText)) {
        const historicalWords = ['founded', 'established', 'born', 'died', 'war', 'treaty', 'independence', 'victory', 'defeat', 'empire', 'president', 'revolution'];
        if (historicalWords.some(word => lower.includes(word))) {
            console.log(`📚 Historical fact detected`);
            return { type: 'HISTORICAL_FACT', confidence: 0.85 };
        }
    }
    
    // Geographic facts
    if (/\b(capital|population|area|square.*kilometers|km²|located.*in|borders)\b/i.test(sanitizedText)) {
        console.log(`🌍 Geographic fact detected`);
        return { type: 'GEOGRAPHIC_FACT', confidence: 0.85 };
    }
    
    // Scientific facts
    if (/\b(speed.*light|boiling.*point|atomic.*number|chemical.*formula|299.*792.*458)\b/i.test(sanitizedText)) {
        console.log(`🔬 Scientific fact detected`);
        return { type: 'SCIENTIFIC_FACT', confidence: 0.9 };
    }
    
    // Statistical facts
    if (/\b\d+(\.\d+)?\s*(percent|%|million|billion|trillion)\b/i.test(sanitizedText)) {
        console.log(`📊 Statistical fact detected`);
        return { type: 'STATISTICAL_FACT', confidence: 0.8 };
    }
    
    // 4. TOO SHORT CONTENT
    if (sanitizedText.length < 30) {
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
        const namedEntities = cleaned.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2}\b/g) || [];
        const filteredEntities = namedEntities.filter(entity => 
            entity.length > 3 && entity.length < 40 &&
            !/^(The|This|That|When|Where|What|How|Why|Who|Yes|World|War|Day|May|Will|Can)$/i.test(entity)
        );
        keywords.push(...filteredEntities.slice(0, 5));
        
        // Important dates
        const dates = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
        keywords.push(...dates.slice(0, 2));
        
        // Numbers with units
        const numbersWithUnits = cleaned.match(/\b\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?\s*(?:million|billion|percent|%|km²|kilometers|meters|miles|population)\b/gi) || [];
        keywords.push(...numbersWithUnits.slice(0, 3));
        
        // Important words
        const importantWords = cleaned.match(/\b(?:capital|president|founded|established|independence|victory|defeat|treaty|constitution|republic|democracy|population|area|temperature|speed|light|atomic|chemical)\b/gi) || [];
        keywords.push(...importantWords.slice(0, 4));
        
        // Significant long words
        const significantWords = cleaned.match(/\b[a-zA-Z]{6,20}\b/g) || [];
        const cleanedWords = significantWords.filter(word => 
            !/^(however|therefore|because|through|without|although|sometimes|something|anything|everything|nothing|javascript|function|document)$/i.test(word)
        );
        keywords.push(...cleanedWords.slice(0, 3));
        
        return [...new Set(keywords)].filter(k => k && k.length > 2).slice(0, 8);
    } catch (e) {
        console.log('Keywords extraction error:', e.message);
        return [];
    }
}

// INTELLIGENT SOURCE SEARCH
async function findWebSources(keywords, smartQueries, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        console.log('❌ Missing API credentials');
        return [];
    }
    
    let allSources = [];
    console.log(`🔍 Search with ${smartQueries?.length || 0} smart queries`);
    
    // 1. Use smart queries from frontend
    if (smartQueries && smartQueries.length > 0) {
        for (const [index, query] of smartQueries.slice(0, 3).entries()) {
            try {
                console.log(`🔍 Query ${index + 1}: "${query}"`);
                const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=4`;
                const response = await fetch(url);
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.items) {
                        const sources = data.items.map(item => ({
                            title: item.title || 'No title',
                            url: item.link || '',
                            snippet: item.snippet || 'No description',
                            query_used: query,
                            relevance: calculateRelevance(item, originalText)
                        }));
                        allSources.push(...sources);
                        console.log(`✅ ${sources.length} sources for "${query}"`);
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 200));
                
            } catch (error) {
                console.error(`❌ Query error "${query}":`, error.message);
            }
        }
    }
    
    // 2. Fallback with keywords if few sources
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
                        title: item.title || 'No title',
                        url: item.link || '',
                        snippet: item.snippet || 'No description',
                        query_used: fallbackQuery,
                        relevance: calculateRelevance(item, originalText)
                    }));
                    allSources.push(...sources);
                    console.log(`✅ Fallback: ${sources.length} sources`);
                }
            }
        } catch (error) {
            console.error('❌ Fallback error:', error.message);
        }
    }
    
    // 3. Filtering and sorting by relevance
    const filteredSources = allSources.filter(source => source.relevance > 0.3);
    
    // 4. Deduplication
    const uniqueSources = [];
    const seenUrls = new Set();
    
    filteredSources.sort((a, b) => b.relevance - a.relevance);
    
    for (const source of filteredSources) {
        if (!seenUrls.has(source.url) && uniqueSources.length < 6) {
            seenUrls.add(source.url);
            uniqueSources.push(source);
        }
    }
    
    console.log(`📋 ${uniqueSources.length} final sources selected`);
    return uniqueSources;
}

// SOURCE RELEVANCE CALCULATION
function calculateRelevance(item, originalText) {
    const title = (item.title || '').toLowerCase();
    const snippet = (item.snippet || '').toLowerCase();
    const url = (item.link || '').toLowerCase();
    const original = originalText.toLowerCase();
    
    let score = 0;
    
    // Common keywords
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
    
    // Reliable sources bonus
    if (url.includes('wikipedia.org')) score += 0.4;
    else if (url.includes('.edu') || url.includes('.gov')) score += 0.35;
    else if (url.includes('britannica') || url.includes('nationalgeographic')) score += 0.3;
    else if (url.includes('history.com') || url.includes('smithsonianmag')) score += 0.25;
    
    // Unreliable sources penalty
    if (url.includes('reddit.com') || url.includes('quora.com')) score -= 0.2;
    if (url.includes('blog') || url.includes('forum')) score -= 0.15;
    
    return Math.max(0, Math.min(1, score));
}

// FINAL SCORING LOGIC
function calculateFinalScore(contentAnalysis, sources, keywords) {
    const { type, confidence } = contentAnalysis;
    
    console.log(`🎯 Score calculation for ${type}`);
    
    // 1. OPINIONS - Moderate score
    if (type === 'OPINION') {
        return {
            score: 0.35,
            explanation: "**Subjective Opinion** (35%). Personal viewpoint that requires other perspectives to be balanced."
        };
    }
    
    // 2. QUESTIONS - Low score
    if (type === 'QUESTION') {
        return {
            score: 0.25,
            explanation: "**User Question** (25%). This appears to be a question rather than a factual statement."
        };
    }
    
    // 3. TOO SHORT CONTENT
    if (type === 'TOO_SHORT') {
        return {
            score: 0.20,
            explanation: "**Insufficient Content** (20%). Text too short for reliable analysis."
        };
    }
    
    // 4. VERIFIABLE FACTS - Scoring based on type + sources
    let baseScore = 0.45;
    let explanation = "";
    
    switch (type) {
        case 'HISTORICAL_FACT':
            baseScore = 0.70;
            explanation = "**Historical Fact** - ";
            break;
        case 'GEOGRAPHIC_FACT':
            baseScore = 0.75;
            explanation = "**Geographic Information** - ";
            break;
        case 'SCIENTIFIC_FACT':
            baseScore = 0.80;
            explanation = "**Scientific Fact** - ";
            break;
        case 'STATISTICAL_FACT':
            baseScore = 0.65;
            explanation = "**Statistical Data** - ";
            break;
        case 'GENERAL_INFO':
            baseScore = 0.50;
            explanation = "**General Information** - ";
            break;
    }
    
    // 5. SOURCES BONUS
    let sourceBonus = 0;
    let sourceText = "";
    
    if (sources && sources.length > 0) {
        const wikipediaSources = sources.filter(s => s.url && s.url.includes('wikipedia')).length;
        const academicSources = sources.filter(s => s.url && (s.url.includes('.edu') || s.url.includes('.gov'))).length;
        const highQualitySources = sources.filter(s => s.relevance > 0.6).length;
        
        // Quality bonus
        if (wikipediaSources >= 1) {
            sourceBonus += 0.12;
            sourceText += "Wikipedia sources found. ";
        }
        
        if (academicSources >= 1) {
            sourceBonus += 0.08;
            sourceText += "Academic/official sources. ";
        }
        
        if (highQualitySources >= 2) {
            sourceBonus += 0.10;
            sourceText += "Multiple highly relevant sources.";
        } else if (sources.length >= 3) {
            sourceBonus += 0.06;
            sourceText += "Multiple verification sources.";
        } else if (sources.length >= 1) {
            sourceBonus += 0.03;
            sourceText += "Limited verification available.";
        }
    } else {
        sourceText += "No verification sources found.";
    }
    
    // 6. FINAL CALCULATION
    const finalScore = Math.min(baseScore + sourceBonus, 0.92);
    const finalPercent = Math.round(finalScore * 100);
    
    // 7. LOGICAL LABELS
    let reliabilityLabel;
    if (finalPercent >= 85) reliabilityLabel = "Highly Reliable";
    else if (finalPercent >= 70) reliabilityLabel = "Good Reliability";
    else if (finalPercent >= 55) reliabilityLabel = "Moderate Reliability";
    else if (finalPercent >= 40) reliabilityLabel = "Limited Reliability";
    else reliabilityLabel = "Low Reliability";
    
    return {
        score: finalScore,
        explanation: `${explanation}**${reliabilityLabel}** (${finalPercent}%). ${sourceText}`
    };
}

// MAIN ENDPOINT
app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType } = req.body;
        
        console.log(`🔍 New analysis: ${analysisType || 'standard'}`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                overallConfidence: 0.20, 
                scoringExplanation: "**Insufficient Input** (20%). Text too short for meaningful analysis.", 
                keywords: [],
                sources: []
            });
        }
        
        // 1. CONTENT TYPE ANALYSIS
        const contentAnalysis = analyzeContentType(text);
        console.log(`📊 Type detected: ${contentAnalysis.type}`);
        
        // 2. KEYWORD EXTRACTION
        const keywords = extractMainKeywords(text);
        console.log(`🏷️ Keywords: ${keywords.slice(0, 3).join(', ')}`);
        
        // 3. SOURCE SEARCH (only for verifiable facts)
        let sources = [];
        if (['HISTORICAL_FACT', 'GEOGRAPHIC_FACT', 'SCIENTIFIC_FACT', 'STATISTICAL_FACT', 'GENERAL_INFO'].includes(contentAnalysis.type)) {
            console.log('🔍 Searching sources...');
            sources = await findWebSources(keywords, smartQueries, text);
        } else {
            console.log('⏭️ No source search for this content type');
        }
        
        // 4. FINAL SCORE CALCULATION
        const result = calculateFinalScore(contentAnalysis, sources, keywords);
        
        // 5. RESPONSE
        const response = {
            overallConfidence: result.score,
            sources: sources,
            scoringExplanation: result.explanation,
            keywords: keywords,
            contentType: contentAnalysis.type
        };
        
        console.log(`✅ Final score: ${Math.round(result.score * 100)}%`);
        res.json(response);
        
    } catch (error) {
        console.error('❌ Analysis error:', error);
        res.status(500).json({ 
            overallConfidence: 0.15,
            scoringExplanation: "**Server Error** (15%). Unable to complete analysis.",
            keywords: [],
            sources: []
        });
    }
});

// FEEDBACK ENDPOINT
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
                sanitizeInput(originalText).substring(0, 2000), 
                scoreGiven, 
                isUseful, 
                sanitizeInput(comment || '').substring(0, 500), 
                JSON.stringify(sourcesFound || [])
            ]
        );
        
        client.release();
        console.log(`📝 Feedback received: ${isUseful ? 'Useful' : 'Not useful'}`);
        res.json({ success: true });
        
    } catch (err) {
        console.error('❌ Feedback error:', err);
        res.status(500).json({ error: 'Server error' });
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
        console.error('❌ Stats error:', err);
        res.status(500).json({ error: 'Stats error' });
    }
});

// HEALTH ENDPOINT
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'ENGLISH-FINAL-1.0',
        features: ['universal_capture', 'logical_scoring', 'relevant_sources'],
        timestamp: new Date().toISOString()
    });
});

// STARTUP
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 VerifyAI Backend ENGLISH FINAL v1.0`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🎯 UNIVERSAL CAPTURE ChatGPT/Claude/Gemini`);
    console.log(`⚖️ LOGICAL SCORING balanced`);
    console.log(`🔍 RELEVANT SOURCES intelligent`);
    console.log(`✅ NO MODIFICATIONS NEEDED AFTER DEPLOYMENT`);
    initDb();
});
