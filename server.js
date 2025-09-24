const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Configuration CORS
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

// ========== SYSTÈME DE FACT-CHECKING INTELLIGENT ==========

class IntelligentFactChecker {
    constructor() {
        this.sourceCredibilityRanks = {
            tier1: { // Sources académiques et officielles
                domains: ['edu', 'gov', 'who.int', 'nature.com', 'science.org', 'pubmed.ncbi.nlm.nih.gov'],
                multiplier: 1.0,
                description: 'Sources académiques vérifiées'
            },
            tier2: { // Médias réputés
                domains: ['reuters.com', 'bbc.com', 'lemonde.fr', 'nytimes.com', 'theguardian.com', 'lefigaro.fr'],
                multiplier: 0.85,
                description: 'Médias avec processus éditorial rigoureux'
            },
            tier3: { // Encyclopédies
                domains: ['wikipedia.org', 'britannica.com', 'larousse.fr'],
                multiplier: 0.75,
                description: 'Encyclopédies avec vérification communautaire'
            },
            tier4: { // Sources spécialisées
                domains: ['scholar.google.com', 'jstor.org', 'researchgate.net'],
                multiplier: 0.9,
                description: 'Bases de données scientifiques'
            },
            unreliable: {
                domains: ['reddit.com', 'quora.com', 'yahoo.answers', 'answers.com'],
                multiplier: 0.3,
                description: 'Sources non éditorialisées'
            }
        };
    }

    // 1. EXTRACTION DE CLAIMS VÉRIFIABLES
    extractVerifiableClaims(text) {
        const claims = [];
        const cleanText = sanitizeInput(text);
        
        // Claims quantitatifs
        const numberClaims = cleanText.match(/\b\d+([,\.]\d+)?\s*(millions?|milliards?|billions?|%|pour\s*cent|kilomètres?|km|habitants?|années?|ans|dollars?|\$|euros?|€)\b/gi);
        if (numberClaims) {
            claims.push(...numberClaims.slice(0, 3).map(claim => ({
                type: 'QUANTITATIVE',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.9
            })));
        }

        // Claims historiques (événements avec dates)
        const historicalClaims = cleanText.match(/\b(en|in|depuis|from|until)\s+(19|20)\d{2}.*?(fondé|créé|né|mort|established|founded|born|died|independence|indépendance|guerre|war)\b/gi);
        if (historicalClaims) {
            claims.push(...historicalClaims.slice(0, 2).map(claim => ({
                type: 'HISTORICAL',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.85
            })));
        }

        // Claims géographiques
        const geoClaims = cleanText.match(/\b(capitale|capital|population|superficie|area|situé|located)\s+(de|of|dans|in)\s+[A-Z][a-zA-ZÀ-ÿ\s]+\b/gi);
        if (geoClaims) {
            claims.push(...geoClaims.slice(0, 2).map(claim => ({
                type: 'GEOGRAPHIC',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.95
            })));
        }

        // Claims scientifiques
        const sciClaims = cleanText.match(/\b(vitesse.*lumière|point.*ébullition|formule.*chimique|speed.*light|boiling.*point|chemical.*formula|299.*792.*458|température|temperature)\b/gi);
        if (sciClaims) {
            claims.push(...sciClaims.slice(0, 2).map(claim => ({
                type: 'SCIENTIFIC',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.92
            })));
        }

        console.log(`🔍 Claims extraits: ${claims.length}`);
        return claims;
    }

    // 2. ANALYSE SÉMANTIQUE DES SOURCES
    async analyzeSourceRelevance(originalText, sources) {
        const analyzedSources = [];
        
        console.log(`📚 Analyse de ${sources.length} sources...`);
        
        for (const source of sources.slice(0, 5)) {
            try {
                // Calcul de la crédibilité
                const credibility = this.getSourceCredibilityTier(source.url);
                
                // Analyse sémantique simplifiée (mots-clés communs)
                const semanticMatch = this.calculateSemanticSimilarity(originalText, source.snippet || '');
                
                // Détection de contradiction numérique
                const contradiction = this.detectNumericContradiction(originalText, source.snippet || '');
                
                // Calcul de support réel
                const actuallySupports = semanticMatch.confirms && !contradiction.detected && semanticMatch.score > 0.2;
                
                analyzedSources.push({
                    ...source,
                    semanticRelevance: semanticMatch.score,
                    confirmsContent: semanticMatch.confirms,
                    contradicts: contradiction.detected,
                    contradictionDetails: contradiction.details,
                    credibilityTier: credibility.tier,
                    credibilityMultiplier: credibility.multiplier,
                    actuallySupports: actuallySupports
                });
                
            } catch (error) {
                console.error(`Erreur analyse source ${source.url}:`, error.message);
                
                // Fallback: gardons la source avec des valeurs par défaut
                const credibility = this.getSourceCredibilityTier(source.url);
                analyzedSources.push({
                    ...source,
                    semanticRelevance: 0.3,
                    confirmsContent: false,
                    contradicts: false,
                    credibilityTier: credibility.tier,
                    credibilityMultiplier: credibility.multiplier,
                    actuallySupports: false
                });
            }
        }
        
        console.log(`✅ Sources analysées: ${analyzedSources.length}`);
        return analyzedSources;
    }

    // 3. CALCUL DU SCORE INTELLIGENT
    calculateIntelligentScore(originalText, analyzedSources, claims) {
        let totalScore = 0;
        let confidence = 0;
        const reasoning = [];

        console.log(`🎯 Calcul du score intelligent...`);

        // 1. Score de base selon le type de contenu
        const contentType = this.analyzeContentType(originalText, claims);
        totalScore += contentType.baseScore;
        reasoning.push(contentType.reasoning);
        confidence += 0.2;

        // 2. Évaluation de la qualité des sources
        const sourceEval = this.evaluateSourceQuality(analyzedSources);
        totalScore += sourceEval.impact;
        reasoning.push(sourceEval.reasoning);
        confidence += sourceEval.confidence;

        // 3. Évaluation du consensus
        const consensus = this.evaluateConsensus(analyzedSources);
        totalScore += consensus.bonus;
        reasoning.push(consensus.reasoning);
        confidence += consensus.confidence;

        // 4. Pénalité pour contradictions
        const contradictions = this.evaluateContradictions(analyzedSources);
        totalScore -= contradictions.penalty;
        if (contradictions.penalty > 0) {
            reasoning.push(contradictions.reasoning);
        }

        // Score final normalisé
        const finalScore = Math.max(0.05, Math.min(0.95, totalScore));
        
        console.log(`📊 Score final: ${Math.round(finalScore * 100)}%`);
        
        return {
            score: finalScore,
            confidence: Math.min(1.0, confidence),
            reasoning: reasoning.join(' '),
            details: {
                claimsFound: claims.length,
                sourcesAnalyzed: analyzedSources.length,
                supportingSources: analyzedSources.filter(s => s.actuallySupports).length,
                contradictingSources: analyzedSources.filter(s => s.contradicts).length,
                contentType: contentType.type
            }
        };
    }

    // 4. ANALYSE DU TYPE DE CONTENU
    analyzeContentType(text, claims) {
        const lower = text.toLowerCase();
        
        // Opinion subjective
        const opinionPatterns = [
            /\b(je pense|je crois|à mon avis|personnellement)\b/i,
            /\b(i think|i believe|in my opinion|personally)\b/i,
            /\b(meilleur|pire|préfère|favorite|best|worst|better|worse)\b/i
        ];
        
        if (opinionPatterns.some(pattern => pattern.test(text))) {
            return {
                type: 'OPINION',
                baseScore: 0.35,
                reasoning: '**Opinion subjective** (35%) - Point de vue personnel.'
            };
        }

        // Question
        if (text.length < 300 && (/^(what|how|why|when|where|qui|quoi|comment|pourquoi|quand|où)/i.test(text.trim()) || text.includes('?'))) {
            return {
                type: 'QUESTION',
                baseScore: 0.25,
                reasoning: '**Question utilisateur** (25%) - Demande d\'information.'
            };
        }

        // Contenu avec claims vérifiables
        if (claims.length > 0) {
            const hasScientific = claims.some(c => c.type === 'SCIENTIFIC');
            const hasQuantitative = claims.some(c => c.type === 'QUANTITATIVE');
            const hasHistorical = claims.some(c => c.type === 'HISTORICAL');
            
            if (hasScientific) {
                return {
                    type: 'SCIENTIFIC_FACT',
                    baseScore: 0.65,
                    reasoning: '**Fait scientifique** (65%) - Contient des informations scientifiques vérifiables.'
                };
            } else if (hasQuantitative) {
                return {
                    type: 'STATISTICAL_FACT',
                    baseScore: 0.60,
                    reasoning: '**Données quantitatives** (60%) - Contient des statistiques vérifiables.'
                };
            } else if (hasHistorical) {
                return {
                    type: 'HISTORICAL_FACT',
                    baseScore: 0.58,
                    reasoning: '**Fait historique** (58%) - Contient des informations historiques vérifiables.'
                };
            }
        }

        // Information générale
        return {
            type: 'GENERAL_INFO',
            baseScore: 0.45,
            reasoning: '**Information générale** (45%) - Contenu informatif standard.'
        };
    }

    // 5. ÉVALUATION DE LA QUALITÉ DES SOURCES
    evaluateSourceQuality(sources) {
        if (sources.length === 0) {
            return {
                impact: -0.15,
                confidence: 0,
                reasoning: 'Aucune source de vérification trouvée (-15%).'
            };
        }

        let qualityScore = 0;
        let supportingHigh = sources.filter(s => s.actuallySupports && s.credibilityMultiplier > 0.8).length;
        let supportingAny = sources.filter(s => s.actuallySupports).length;
        let contradictingHigh = sources.filter(s => s.contradicts && s.credibilityMultiplier > 0.8).length;

        // Bonus pour sources de support
        if (supportingHigh > 0) {
            qualityScore += supportingHigh * 0.12; // 12% par source fiable qui confirme
        } else if (supportingAny > 0) {
            qualityScore += supportingAny * 0.06; // 6% par source quelconque qui confirme
        }

        // Pénalité pour sources contradictoires fiables
        if (contradictingHigh > 0) {
            qualityScore -= contradictingHigh * 0.1;
        }

        // Bonus progressif pour multiple sources
        if (sources.length >= 3) {
            qualityScore += 0.03;
        }

        let reasoning = `Sources analysées: ${supportingAny} confirment, ${contradictingHigh} contredisent.`;
        if (supportingHigh > 0) {
            reasoning += ` ${supportingHigh} sources très fiables confirment (+${supportingHigh * 12}%).`;
        }

        return {
            impact: Math.max(-0.2, Math.min(0.25, qualityScore)),
            confidence: Math.min(0.3, sources.length * 0.08),
            reasoning
        };
    }

    // 6. ÉVALUATION DU CONSENSUS
    evaluateConsensus(sources) {
        if (sources.length < 2) {
            return {
                bonus: 0,
                confidence: 0,
                reasoning: ''
            };
        }

        const supporting = sources.filter(s => s.actuallySupports).length;
        const contradicting = sources.filter(s => s.contradicts).length;
        const total = sources.length;

        const consensusRatio = supporting / total;
        
        let bonus = 0;
        let reasoning = '';

        if (consensusRatio >= 0.75 && supporting >= 2) {
            bonus = 0.1;
            reasoning = `Fort consensus: ${supporting}/${total} sources confirment (+10%).`;
        } else if (consensusRatio >= 0.5 && supporting >= 2) {
            bonus = 0.05;
            reasoning = `Consensus modéré: ${supporting}/${total} sources confirment (+5%).`;
        } else if (contradicting > supporting) {
            bonus = -0.08;
            reasoning = `Consensus négatif: plus de contradictions que de confirmations (-8%).`;
        }

        return {
            bonus: Math.max(-0.15, Math.min(0.15, bonus)),
            confidence: Math.min(0.2, total * 0.05),
            reasoning
        };
    }

    // 7. ÉVALUATION DES CONTRADICTIONS
    evaluateContradictions(sources) {
        const contradicting = sources.filter(s => s.contradicts);
        
        if (contradicting.length === 0) {
            return { penalty: 0, reasoning: '' };
        }

        const highCredibilityContradictions = contradicting.filter(s => s.credibilityMultiplier > 0.8).length;
        const penalty = highCredibilityContradictions * 0.12 + (contradicting.length - highCredibilityContradictions) * 0.05;

        return {
            penalty: Math.min(0.3, penalty),
            reasoning: `${contradicting.length} sources contradictoires détectées (-${Math.round(penalty * 100)}%).`
        };
    }

    // MÉTHODES UTILITAIRES

    calculateSemanticSimilarity(text1, text2) {
        if (!text1 || !text2) return { score: 0, confirms: false };
        
        // Extraction des mots-clés importants (> 4 lettres, pas de stop words)
        const stopWords = new Set(['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'mais', 'dans', 'sur', 'pour', 'avec', 'par']);
        
        const extractKeywords = (text) => {
            return text.toLowerCase()
                .replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, ' ')
                .split(/\s+/)
                .filter(word => word.length > 3 && !stopWords.has(word) && !/^\d+$/.test(word));
        };

        const keywords1 = new Set(extractKeywords(text1));
        const keywords2 = new Set(extractKeywords(text2));
        
        const intersection = new Set([...keywords1].filter(x => keywords2.has(x)));
        const union = new Set([...keywords1, ...keywords2]);
        
        const similarity = union.size > 0 ? intersection.size / union.size : 0;
        
        return {
            score: similarity,
            confirms: similarity > 0.15 // Seuil ajusté
        };
    }

    detectNumericContradiction(text1, text2) {
        const extractNumbers = (text) => {
            return (text.match(/\b\d+([,\.]\d+)?\b/g) || [])
                .map(num => parseFloat(num.replace(',', '.')))
                .filter(num => !isNaN(num));
        };

        const nums1 = extractNumbers(text1);
        const nums2 = extractNumbers(text2);

        if (nums1.length === 0 || nums2.length === 0) {
            return { detected: false, details: null };
        }

        // Vérifie les contradictions significatives (différence > 25%)
        for (const num1 of nums1) {
            for (const num2 of nums2) {
                if (num1 > 0 && Math.abs(num1 - num2) / num1 > 0.25) {
                    return {
                        detected: true,
                        details: { original: num1, source: num2, difference: Math.abs(num1 - num2) / num1 }
                    };
                }
            }
        }

        return { detected: false, details: null };
    }

    getSourceCredibilityTier(url) {
        if (!url) return { tier: 'unknown', multiplier: 0.4 };
        
        const urlLower = url.toLowerCase();
        
        for (const [tierName, tierData] of Object.entries(this.sourceCredibilityRanks)) {
            if (tierData.domains.some(domain => urlLower.includes(domain))) {
                return { tier: tierName, multiplier: tierData.multiplier };
            }
        }
        return { tier: 'unknown', multiplier: 0.5 };
    }
}

// ========== FONCTIONS UTILITAIRES ==========

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

function extractMainKeywords(text) {
    const cleaned = sanitizeInput(text).substring(0, 1000);
    const keywords = [];
    
    try {
        // Entités nommées
        const namedEntities = cleaned.match(/\b[A-Z][a-zA-ZÀ-ÿ]+(?:\s+[A-Z][a-zA-ZÀ-ÿ]+){0,2}\b/g) || [];
        keywords.push(...namedEntities.slice(0, 4));
        
        // Dates importantes
        const dates = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
        keywords.push(...dates.slice(0, 2));
        
        // Nombres avec unités
        const numbersWithUnits = cleaned.match(/\b\d+([,\.]\d+)?\s*(?:million|milliard|%|km|habitants|meters)\b/gi) || [];
        keywords.push(...numbersWithUnits.slice(0, 2));
        
        // Mots significatifs longs
        const significantWords = cleaned.match(/\b[a-zA-ZÀ-ÿ]{5,15}\b/g) || [];
        keywords.push(...significantWords.slice(0, 3));
        
        return [...new Set(keywords)].filter(k => k && k.length > 2).slice(0, 6);
        
    } catch (e) {
        console.error('Erreur extraction keywords:', e.message);
        return [];
    }
}

async function findWebSources(keywords, smartQueries, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        console.log('API credentials manquantes - sources mock');
        return [
            {
                title: "Wikipedia - Source de référence",
                url: "https://fr.wikipedia.org/wiki/Main_Page",
                snippet: "Information encyclopédique vérifiée",
                query_used: "mock",
                relevance: 0.8
            },
            {
                title: "Source officielle",
                url: "https://www.insee.fr",
                snippet: "Données officielles et statistiques",
                query_used: "mock",
                relevance: 0.9
            }
        ];
    }
    
    let allSources = [];
    
    // Recherche avec queries intelligentes
    if (smartQueries && smartQueries.length > 0) {
        for (const query of smartQueries.slice(0, 2)) {
            try {
                const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=4`;
                const response = await fetch(url);
                const data = await response.json();
                
                if (response.ok && data.items) {
                    const sources = data.items.map(item => ({
                        title: item.title || 'Sans titre',
                        url: item.link || '',
                        snippet: item.snippet || 'Pas de description',
                        query_used: query,
                        relevance: calculateRelevance(item, originalText)
                    }));
                    allSources.push(...sources);
                }
                
                await new Promise(resolve => setTimeout(resolve, 300));
            } catch (error) {
                console.error(`Erreur recherche pour "${query}":`, error.message);
            }
        }
    }
    
    // Recherche fallback avec keywords
    if (allSources.length < 2 && keywords.length > 0) {
        try {
            const fallbackQuery = keywords.slice(0, 3).join(' ');
            const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(fallbackQuery)}&num=3`;
            
            const response = await fetch(url);
            const data = await response.json();
            
            if (response.ok && data.items) {
                const sources = data.items.map(item => ({
                    title: item.title || 'Sans titre',
                    url: item.link || '',
                    snippet: item.snippet || 'Pas de description',
                    query_used: fallbackQuery,
                    relevance: calculateRelevance(item, originalText)
                }));
                allSources.push(...sources);
            }
        } catch (error) {
            console.error('Erreur recherche fallback:', error.message);
        }
    }
    
    // Déduplication et tri
    const uniqueSources = [];
    const seenUrls = new Set();
    
    allSources.sort((a, b) => b.relevance - a.relevance);
    
    for (const source of allSources) {
        if (!seenUrls.has(source.url) && uniqueSources.length < 5) {
            seenUrls.add(source.url);
            uniqueSources.push(source);
        }
    }
    
    console.log(`📋 ${uniqueSources.length} sources uniques trouvées`);
    return uniqueSources;
}

function calculateRelevance(item, originalText) {
    const title = (item.title || '').toLowerCase();
    const snippet = (item.snippet || '').toLowerCase();
    const url = (item.link || '').toLowerCase();
    const original = originalText.toLowerCase();
    
    let score = 0.3;
    
    // Mots communs
    const originalWords = original.split(/\s+/).filter(w => w.length > 3).slice(0, 8);
    let commonWords = 0;
    
    for (const word of originalWords) {
        if (title.includes(word) || snippet.includes(word)) {
            commonWords++;
        }
    }
    
    score += (commonWords / Math.max(originalWords.length, 1)) * 0.4;
    
    // Bonus sources fiables
    if (url.includes('wikipedia')) score += 0.25;
    else if (url.includes('.edu') || url.includes('.gov')) score += 0.2;
    else if (url.includes('britannica') || url.includes('nature.com')) score += 0.15;
    
    // Pénalité sources douteuses
    if (url.includes('reddit') || url.includes('forum')) score -= 0.15;
    
    return Math.max(0.1, Math.min(1, score));
}

// ========== ENDPOINTS API ==========

// Endpoint principal avec système intelligent
app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType } = req.body;
        
        console.log(`\n🔍 === ANALYSE INTELLIGENTE ===`);
        console.log(`📝 Texte: "${text.substring(0, 80)}..."`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                overallConfidence: 0.20, 
                scoringExplanation: "**Texte insuffisant** (20%) - Contenu trop court pour analyse.", 
                keywords: [],
                sources: [],
                methodology: "Analyse intelligente avec vérification croisée"
            });
        }
        
        const factChecker = new IntelligentFactChecker();
        
        // 1. Extraction des claims vérifiables
        const claims = factChecker.extractVerifiableClaims(text);
        
        // 2. Extraction des mots-clés
        const keywords = extractMainKeywords(text);
        
        // 3. Recherche de sources
        const sources = await findWebSources(keywords, smartQueries, text);
        
        // 4. Analyse sémantique des sources
        const analyzedSources = await factChecker.analyzeSourceRelevance(text, sources);
        
        // 5. Calcul du score intelligent
        const result = factChecker.calculateIntelligentScore(text, analyzedSources, claims);
        
        const response = {
            overallConfidence: result.score,
            confidence: result.confidence,
            scoringExplanation: result.reasoning,
            sources: analyzedSources,
            keywords: keywords,
            claimsAnalyzed: claims,
            details: result.details,
            methodology: "Analyse intelligente avec vérification croisée des sources"
        };
        
        console.log(`✅ Score final: ${Math.round(result.score * 100)}% (confiance: ${Math.round(result.confidence * 100)}%)`);
        console.log(`📊 ${analyzedSources.length} sources | ${claims.length} claims | ${analyzedSources.filter(s => s.actuallySupports).length} confirment`);
        console.log(`===============================\n`);
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Erreur analyse intelligente:', error);
        res.status(500).json({ 
            overallConfidence: 0.15,
            scoringExplanation: "**Erreur système** (15%) - Impossible de terminer l'analyse.",
            keywords: [],
            sources: [],
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Autres endpoints (feedback, stats, health)
app.post('/feedback', async (req, res) => {
    try {
        const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
        
        const client = await pool.connect();
        await client.query(
            'INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)',
            [sanitizeInput(originalText).substring(0, 2000), scoreGiven, isUseful, sanitizeInput(comment || '').substring(0, 500), JSON.stringify(sourcesFound || [])]
        );
        client.release();
        
        console.log(`📝 Feedback: ${isUseful ? 'Utile' : 'Pas utile'} - Score: ${scoreGiven}`);
        res.json({ success: true });
        
    } catch (err) {
        console.error('❌ Erreur feedback:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'INTELLIGENT-FACTCHECKER-2.0',
        features: ['intelligent_scoring', 'semantic_analysis', 'source_verification', 'claim_extraction'],
        timestamp: new Date().toISOString(),
        api_configured: !!(process.env.GOOGLE_API_KEY && process.env.SEARCH_ENGINE_ID)
    });
});

// Database initialization
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

// Startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 === VERIFYAI INTELLIGENT SERVER ===`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔑 Google API configured: ${!!process.env.GOOGLE_API_KEY}`);
    console.log(`💾 Database configured: ${!!process.env.DATABASE_URL}`);
    console.log(`🧠 Features: Intelligent scoring, Semantic analysis, Source verification`);
    console.log(`=====================================\n`);
    initDb();
});
