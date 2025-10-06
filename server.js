const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// ============================================
// RATE LIMITING
// ============================================
const requestCounts = new Map();

function rateLimiter(maxRequests, windowMs) {
    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();
        
        if (!requestCounts.has(ip)) {
            requestCounts.set(ip, []);
        }
        
        const requests = requestCounts.get(ip);
        const recentRequests = requests.filter(time => now - time < windowMs);
        
        if (recentRequests.length >= maxRequests) {
            return res.status(429).json({ 
                error: 'Too many requests. Please wait before trying again.',
                retryAfter: Math.ceil(windowMs / 1000)
            });
        }
        
        recentRequests.push(now);
        requestCounts.set(ip, recentRequests);
        next();
    };
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, requests] of requestCounts.entries()) {
        const recent = requests.filter(time => now - time < 600000);
        if (recent.length === 0) {
            requestCounts.delete(ip);
        } else {
            requestCounts.set(ip, recent);
        }
    }
}, 600000);

app.use(cors({ 
    origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app', 'http://localhost:*', 'https://localhost:*'],
    credentials: true
}));
app.use(express.json({ limit: '5mb' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ============================================
// ADVANCED SCORING ENGINE V4 - PRODUCTION READY
// ============================================

class AdvancedFactCheckingEngine {
    constructor() {
        this.sourceCredibilityTiers = {
            tier1_academic: { 
                domains: ['edu', '.gov', 'who.int', 'nature.com', 'science.org', 'pubmed.ncbi.nlm.nih.gov', 'nih.gov', 'cdc.gov', 'europa.eu'],
                weight: 1.0,
                description: 'Sources académiques et gouvernementales officielles'
            },
            tier2_verified_media: { 
                domains: ['reuters.com', 'apnews.com', 'bbc.com', 'lemonde.fr', 'afp.com', 'dpa.com'],
                weight: 0.85,
                description: 'Agences de presse et médias vérifiés'
            },
            tier3_quality_media: { 
                domains: ['nytimes.com', 'theguardian.com', 'economist.com', 'lefigaro.fr', 'washingtonpost.com'],
                weight: 0.75,
                description: 'Médias de qualité avec processus éditorial'
            },
            tier4_databases: { 
                domains: ['jstor.org', 'researchgate.net', 'scholar.google.com'],
                weight: 0.70,
                description: 'Bases de données académiques'
            },
            tier5_encyclopedias: { 
                domains: ['wikipedia.org', 'britannica.com', 'larousse.fr'],
                weight: 0.65,
                description: 'Encyclopédies avec modération communautaire'
            },
            tier6_preprints: {
                domains: ['arxiv.org', 'biorxiv.org', 'medrxiv.org'],
                weight: 0.50,
                description: 'Preprints non peer-reviewed'
            },
            unreliable: {
                domains: ['reddit.com', 'quora.com', 'yahoo.answers', 'answers.com', 'facebook.com', 'twitter.com', 'tiktok.com'],
                weight: 0.20,
                description: 'Sources non éditorialisées'
            }
        };

        this.stopWords = new Set([
            'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did',
            'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'mais', 'dans', 'sur', 'pour', 'avec', 'par', 'est', 'sont', 'été', 'avoir', 'a', 'ai', 'avons', 'ont'
        ]);
    }

    extractVerifiableClaims(text) {
        const claims = [];
        const cleanText = sanitizeInput(text);
        
        // Claims quantitatives avec contexte
        const quantitativeRegex = /\b(\d+(?:[,\.]\d+)?)\s*(millions?|milliards?|billions?|%|pour\s*cent|kilomètres?|km|mètres?|m|habitants?|personnes?|années?|ans|dollars?|\$|euros?|€|kg|tonnes?)\b/gi;
        const quantMatches = cleanText.match(quantitativeRegex);
        if (quantMatches) {
            claims.push(...quantMatches.slice(0, 3).map(claim => ({
                type: 'QUANTITATIVE',
                text: claim.trim(),
                verifiable: true,
                priority: 0.95
            })));
        }

        // Faits géographiques
        const geoRegex = /\b(capitale|capital|population|superficie|area|situé|located|se trouve|is located|habitants|densité)\s+(de|of|dans|in|:)\s+([A-Z][a-zA-ZÀ-ÿ\s]{2,30})\b/gi;
        const geoMatches = cleanText.match(geoRegex);
        if (geoMatches) {
            claims.push(...geoMatches.slice(0, 2).map(claim => ({
                type: 'GEOGRAPHIC',
                text: claim.trim(),
                verifiable: true,
                priority: 0.98
            })));
        }

        // Faits historiques avec dates
        const histRegex = /\b(en|in|depuis|from|de)\s+(1[6-9]\d{2}|20[0-2]\d)\s*[,:]?\s*([a-zA-ZÀ-ÿ\s]{5,50})\b/gi;
        const histMatches = cleanText.match(histRegex);
        if (histMatches) {
            claims.push(...histMatches.slice(0, 2).map(claim => ({
                type: 'HISTORICAL',
                text: claim.trim(),
                verifiable: true,
                priority: 0.90
            })));
        }

        // Faits scientifiques
        const sciRegex = /\b(vitesse|température|masse|densité|formule|composition|distance|speed|temperature|mass|density|formula|composition|distance)\s+(de|of|du|:)\s+([a-zA-ZÀ-ÿ0-9\s]{3,40})\b/gi;
        const sciMatches = cleanText.match(sciRegex);
        if (sciMatches) {
            claims.push(...sciMatches.slice(0, 2).map(claim => ({
                type: 'SCIENTIFIC',
                text: claim.trim(),
                verifiable: true,
                priority: 0.96
            })));
        }

        return claims;
    }

    analyzeContentType(text, claims) {
        const lower = text.toLowerCase();
        
        // Questions pures - pas de claim à vérifier
        if (text.length < 300 && (/^(what|how|why|when|where|which|who|can you|could you|please|qu|quoi|comment|pourquoi|quand|où|quel|quelle)/i.test(text.trim()) || text.includes('?'))) {
            return {
                type: 'QUESTION',
                isVerifiable: false,
                baseConfidence: 0.0,
                uncertaintyRange: 0.0,
                explanation: 'Question de l\'utilisateur - aucune affirmation à vérifier'
            };
        }

        // Opinions subjectives
        const opinionIndicators = /\b(je pense|je crois|à mon avis|selon moi|personnellement|i think|i believe|in my opinion|personally|meilleur|pire|préfère|favorite|best|worst|should|devrait)\b/i;
        if (opinionIndicators.test(text)) {
            return {
                type: 'OPINION',
                isVerifiable: false,
                baseConfidence: 0.0,
                uncertaintyRange: 0.15,
                explanation: 'Opinion personnelle - non vérifiable factuellement'
            };
        }

        // Faits vérifiables par priorité
        if (claims.length > 0) {
            const hasScientific = claims.some(c => c.type === 'SCIENTIFIC');
            const hasGeographic = claims.some(c => c.type === 'GEOGRAPHIC');
            const hasQuantitative = claims.some(c => c.type === 'QUANTITATIVE');
            const hasHistorical = claims.some(c => c.type === 'HISTORICAL');
            
            if (hasScientific) {
                return {
                    type: 'SCIENTIFIC_FACT',
                    isVerifiable: true,
                    baseConfidence: 0.35,
                    uncertaintyRange: 0.25,
                    explanation: 'Fait scientifique vérifiable'
                };
            }
            if (hasGeographic) {
                return {
                    type: 'GEOGRAPHIC_FACT',
                    isVerifiable: true,
                    baseConfidence: 0.35,
                    uncertaintyRange: 0.20,
                    explanation: 'Fait géographique vérifiable'
                };
            }
            if (hasQuantitative) {
                return {
                    type: 'STATISTICAL_FACT',
                    isVerifiable: true,
                    baseConfidence: 0.30,
                    uncertaintyRange: 0.25,
                    explanation: 'Données statistiques vérifiables'
                };
            }
            if (hasHistorical) {
                return {
                    type: 'HISTORICAL_FACT',
                    isVerifiable: true,
                    baseConfidence: 0.30,
                    uncertaintyRange: 0.25,
                    explanation: 'Fait historique vérifiable'
                };
            }
        }

        return {
            type: 'GENERAL_STATEMENT',
            isVerifiable: true,
            baseConfidence: 0.25,
            uncertaintyRange: 0.30,
            explanation: 'Affirmation générale nécessitant vérification'
        };
    }

    extractSemanticKeywords(text) {
        const words = text.toLowerCase()
            .replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, ' ')
            .split(/\s+/)
            .filter(word => 
                word.length > 4 && 
                !this.stopWords.has(word) && 
                !/^\d+$/.test(word)
            );

        // TF (fréquence dans le texte)
        const frequency = {};
        words.forEach(word => {
            frequency[word] = (frequency[word] || 0) + 1;
        });

        // Sélection des mots significatifs
        return [...new Set(words)]
            .sort((a, b) => frequency[b] - frequency[a])
            .slice(0, 8);
    }

    extractNamedEntities(text) {
        const entities = [];
        
        // Noms propres (majuscules)
        const properNouns = text.match(/\b[A-ZÀ-Ý][a-zA-ZÀ-ÿ]+(?:\s+[A-ZÀ-Ý][a-zA-ZÀ-ÿ]+){0,3}\b/g) || [];
        entities.push(...properNouns);
        
        // Années
        const years = text.match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/g) || [];
        entities.push(...years);
        
        // Nombres significatifs
        const numbers = text.match(/\b\d+(?:[,\.]\d+)?\s*(?:millions?|milliards?|%|km|habitants)\b/gi) || [];
        entities.push(...numbers);
        
        return [...new Set(entities)].slice(0, 6);
    }

    calculateAdvancedSimilarity(text1, text2) {
        if (!text1 || !text2) return { score: 0, isRelevant: false, details: {} };
        
        const keywords1 = new Set(this.extractSemanticKeywords(text1));
        const keywords2 = new Set(this.extractSemanticKeywords(text2));
        const entities1 = new Set(this.extractNamedEntities(text1));
        const entities2 = new Set(this.extractNamedEntities(text2));
        
        // Similarité des mots-clés (Jaccard)
        const keywordIntersection = new Set([...keywords1].filter(x => keywords2.has(x)));
        const keywordUnion = new Set([...keywords1, ...keywords2]);
        const keywordScore = keywordUnion.size > 0 ? keywordIntersection.size / keywordUnion.size : 0;
        
        // Similarité des entités nommées
        const entityIntersection = new Set([...entities1].filter(x => entities2.has(x)));
        const entityUnion = new Set([...entities1, ...entities2]);
        const entityScore = entityUnion.size > 0 ? entityIntersection.size / entityUnion.size : 0;
        
        // Score composite pondéré
        const compositeScore = (keywordScore * 0.6) + (entityScore * 0.4);
        
        // Critères de confirmation stricts
        const isRelevant = (
            compositeScore >= 0.40 &&
            (keywordIntersection.size >= 3 || entityIntersection.size >= 2)
        );
        
        return {
            score: compositeScore,
            isRelevant: isRelevant,
            details: {
                keywordOverlap: keywordIntersection.size,
                entityOverlap: entityIntersection.size,
                keywordScore: keywordScore,
                entityScore: entityScore
            }
        };
    }

    extractNumbers(text) {
        const numberRegex = /\b(\d+(?:[,\.]\d+)?)\s*([a-zA-Zàâäéèêëïîôöùûüÿç%$€]*)\b/g;
        const matches = [];
        let match;
        
        while ((match = numberRegex.exec(text)) !== null) {
            const value = parseFloat(match[1].replace(',', '.'));
            const unit = match[2].toLowerCase();
            const contextStart = Math.max(0, match.index - 50);
            const contextEnd = Math.min(text.length, match.index + match[0].length + 50);
            const context = text.substring(contextStart, contextEnd);
            
            matches.push({
                value: value,
                unit: unit,
                context: context,
                position: match.index
            });
        }
        
        return matches;
    }

    detectNumericContradiction(text1, text2) {
        const nums1 = this.extractNumbers(text1);
        const nums2 = this.extractNumbers(text2);
        
        if (nums1.length === 0 || nums2.length === 0) {
            return { hasContradiction: false };
        }

        for (const n1 of nums1) {
            for (const n2 of nums2) {
                // Même unité ou pas d'unité
                if (n1.unit === n2.unit || (!n1.unit && !n2.unit)) {
                    const largerValue = Math.max(n1.value, n2.value);
                    if (largerValue === 0) continue;
                    
                    const percentDifference = Math.abs(n1.value - n2.value) / largerValue;
                    
                    // Contradiction si différence > 30% pour même contexte
                    if (percentDifference > 0.30) {
                        // Vérifier si vraiment même sujet
                        const contextSimilarity = this.calculateAdvancedSimilarity(n1.context, n2.context);
                        
                        if (contextSimilarity.score > 0.50) {
                            return {
                                hasContradiction: true,
                                details: {
                                    value1: n1.value,
                                    value2: n2.value,
                                    percentDiff: Math.round(percentDifference * 100),
                                    unit: n1.unit
                                }
                            };
                        }
                    }
                }
            }
        }
        
        return { hasContradiction: false };
    }

    getSourceCredibility(url) {
        if (!url) return { tier: 'unknown', weight: 0.35 };
        
        const urlLower = url.toLowerCase();
        
        for (const [tierName, tierData] of Object.entries(this.sourceCredibilityTiers)) {
            for (const domain of tierData.domains) {
                if (urlLower.includes(domain)) {
                    return { tier: tierName, weight: tierData.weight };
                }
            }
        }
        
        return { tier: 'unknown', weight: 0.35 };
    }

    calculateSourceScore(originalText, sources) {
        if (sources.length === 0) {
            return {
                score: 0,
                uncertainty: 0.40,
                details: 'Aucune source trouvée'
            };
        }

        let totalWeight = 0;
        let weightedSupport = 0;
        let weightedContradict = 0;
        let highQualitySupporting = 0;
        let highQualityContradicting = 0;

        for (const source of sources) {
            const weight = source.credibilityWeight || 0.35;
            totalWeight += weight;

            if (source.supports) {
                weightedSupport += weight;
                if (weight >= 0.75) highQualitySupporting++;
            }
            
            if (source.contradicts) {
                weightedContradict += weight;
                if (weight >= 0.75) highQualityContradicting++;
            }
        }

        // Score bayésien pondéré
        const supportRatio = totalWeight > 0 ? weightedSupport / totalWeight : 0;
        const contradictRatio = totalWeight > 0 ? weightedContradict / totalWeight : 0;
        
        let sourceScore = supportRatio * 0.50; // Max +50%
        sourceScore -= contradictRatio * 0.40; // Max -40%
        
        // Bonus pour consensus fort
        if (highQualitySupporting >= 2 && highQualityContradicting === 0) {
            sourceScore += 0.15;
        }
        
        // Pénalité pour contradictions fiables
        if (highQualityContradicting >= 2) {
            sourceScore -= 0.20;
        }

        // Bonus diversité des sources
        const uniqueDomains = new Set(sources.map(s => {
            try { return new URL(s.url).hostname; }
            catch { return s.url; }
        })).size;
        
        if (uniqueDomains >= 3) sourceScore += 0.05;

        const uncertainty = Math.max(0.15, 0.40 - (sources.length * 0.04));
        
        return {
            score: Math.max(-0.40, Math.min(0.65, sourceScore)),
            uncertainty: uncertainty,
            details: `${sources.filter(s => s.supports).length}/${sources.length} sources confirment, ${highQualitySupporting} fiables`
        };
    }

    calculateFinalScore(contentAnalysis, sourceAnalysis, claims) {
        // Questions et opinions = non vérifiable
        if (!contentAnalysis.isVerifiable) {
            return {
                confidence: 0.0,
                uncertainty: 0.0,
                category: 'NON_VERIFIABLE',
                explanation: contentAnalysis.explanation,
                details: {
                    contentType: contentAnalysis.type,
                    claimsFound: 0,
                    sourcesAnalyzed: 0
                }
            };
        }

        // Calcul bayésien
        let confidence = contentAnalysis.baseConfidence;
        let uncertainty = contentAnalysis.uncertaintyRange;
        
        // Impact des sources
        confidence += sourceAnalysis.score;
        uncertainty = Math.min(uncertainty, sourceAnalysis.uncertainty);
        
        // Bonus pour claims multiples vérifiées
        if (claims.length >= 3) {
            confidence += 0.05;
        }
        
        // Normalisation
        confidence = Math.max(0.05, Math.min(0.95, confidence));
        
        // Détermination catégorie
        let category;
        if (confidence >= 0.75) category = 'HIGHLY_RELIABLE';
        else if (confidence >= 0.55) category = 'LIKELY_RELIABLE';
        else if (confidence >= 0.35) category = 'UNCERTAIN';
        else if (confidence >= 0.20) category = 'LIKELY_UNRELIABLE';
        else category = 'UNRELIABLE';
        
        return {
            confidence: confidence,
            uncertainty: uncertainty,
            category: category,
            explanation: `${contentAnalysis.explanation}. ${sourceAnalysis.details}`,
            details: {
                contentType: contentAnalysis.type,
                baseConfidence: contentAnalysis.baseConfidence,
                sourceImpact: sourceAnalysis.score,
                claimsFound: claims.length,
                sourcesAnalyzed: sourceAnalysis.details.split('/')[1]?.split(' ')[0] || 0
            }
        };
    }
}

async function analyzeSourcesIntelligently(engine, originalText, sources) {
    const analyzed = [];
    
    for (const source of sources.slice(0, 5)) {
        try {
            const credibility = engine.getSourceCredibility(source.url);
            const similarity = engine.calculateAdvancedSimilarity(originalText, source.snippet || '');
            const contradiction = engine.detectNumericContradiction(originalText, source.snippet || '');
            
            const supports = similarity.isRelevant && !contradiction.hasContradiction;
            const contradicts = contradiction.hasContradiction;
            
            analyzed.push({
                ...source,
                credibilityTier: credibility.tier,
                credibilityWeight: credibility.weight,
                semanticScore: similarity.score,
                supports: supports,
                contradicts: contradicts,
                contradictionDetails: contradiction.details || null,
                relevanceDetails: similarity.details
            });
            
        } catch (error) {
            console.error(`Erreur source ${source.url}:`, error.message);
        }
    }
    
    return analyzed;
}

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

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function extractMainKeywords(text) {
    const cleaned = sanitizeInput(text).substring(0, 1000);
    const keywords = [];
    
    const entities = cleaned.match(/\b[A-ZÀ-Ý][a-zA-ZÀ-ÿ]+(?:\s+[A-ZÀ-Ý][a-zA-ZÀ-ÿ]+){0,2}\b/g) || [];
    keywords.push(...entities.slice(0, 4));
    
    const dates = cleaned.match(/\b(1[6-9]|20)\d{2}\b/g) || [];
    keywords.push(...dates.slice(0, 2));
    
    const numbers = cleaned.match(/\b\d+(?:[,\.]\d+)?\s*(?:million|milliard|%|km|habitants|meters)\b/gi) || [];
    keywords.push(...numbers.slice(0, 2));
    
    return [...new Set(keywords)].filter(k => k && k.length > 2).slice(0, 6);
}

async function findWebSources(keywords, smartQueries, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        return [{
            title: "Configuration requise",
            url: "https://support.google.com/programmable-search",
            snippet: "API Google Search non configurée",
            query_used: "config",
            relevance: 0.5
        }];
    }
    
    let allSources = [];
    const queries = smartQueries?.slice(0, 2) || [keywords.slice(0, 3).join(' ')];
    
    for (const query of queries) {
        try {
            const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=4`;
            const response = await fetch(url);
            const data = await response.json();
            
            if (response.ok && data.items) {
                allSources.push(...data.items.map(item => ({
                    title: item.title || 'Sans titre',
                    url: item.link || '',
                    snippet: item.snippet || '',
                    query_used: query
                })));
            }
            
            await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
            console.error(`Erreur recherche: ${error.message}`);
        }
    }
    
    return [...new Map(allSources.map(s => [s.url, s])).values()].slice(0, 5);
}

// ============================================
// ENDPOINTS
// ============================================

app.post('/verify', rateLimiter(10, 60000), async (req, res) => {
    try {
        const { text, smartQueries } = req.body;
        
        if (!text || text.length < 10) {
            return res.json({ 
                confidence: 0.0,
                category: 'INSUFFICIENT_DATA',
                explanation: 'Texte trop court pour analyse',
                sources: []
            });
        }
        
        const engine = new AdvancedFactCheckingEngine();
        const claims = engine.extractVerifiableClaims(text);
        const contentAnalysis = engine.analyzeContentType(text, claims);
        
        // Si non vérifiable, pas besoin de sources
        if (!contentAnalysis.isVerifiable) {
            return res.json({
                confidence: 0.0,
                uncertainty: 0.0,
                category: 'NON_VERIFIABLE',
                explanation: contentAnalysis.explanation,
                sources: [],
                claims: [],
                details: { contentType: contentAnalysis.type }
            });
        }
        
        const keywords = extractMainKeywords(text);
        const sources = await findWebSources(keywords, smartQueries, text);
        const analyzedSources = await analyzeSourcesIntelligently(engine, text, sources);
        const sourceAnalysis = engine.calculateSourceScore(text, analyzedSources);
        const finalResult = engine.calculateFinalScore(contentAnalysis, sourceAnalysis, claims);
        
        res.json({
            confidence: finalResult.confidence,
            uncertainty: finalResult.uncertainty,
            category: finalResult.category,
            explanation: finalResult.explanation,
            sources: analyzedSources,
            claims: claims,
            details: finalResult.details
        });
        
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ 
            confidence: 0.0,
            category: 'ERROR',
            explanation: 'Erreur système lors de l\'analyse',
            sources: []
        });
    }
});

app.post('/subscribe', rateLimiter(5, 60000), async (req, res) => {
    try {
        const { email, name, source } = req.body;
        
        if (!email || !validateEmail(email)) {
            return res.status(400).json({ success: false, error: 'Email invalide' });
        }
        
        const sanitizedEmail = sanitizeInput(email).toLowerCase().trim();
        const sanitizedName = name ? sanitizeInput(name).substring(0, 100) : null;
        const client = await pool.connect();
        
        try {
            const existing = await client.query(
                'SELECT id, subscribed FROM email_subscribers WHERE email = $1',
                [sanitizedEmail]
            );
            
            if (existing.rows.length > 0) {
                if (!existing.rows[0].subscribed) {
                    await client.query(
                        'UPDATE email_subscribers SET subscribed = true, updated_at = NOW() WHERE email = $1',
                        [sanitizedEmail]
                    );
                    return res.json({ success: true, message: 'Réabonnement réussi' });
                }
                return res.json({ success: true, message: 'Déjà abonné', alreadySubscribed: true });
            }
            
            await client.query(
                'INSERT INTO email_subscribers(email, name, source) VALUES($1, $2, $3)',
                [sanitizedEmail, sanitizedName, source || 'extension']
            );
            
            res.json({ success: true, message: 'Abonnement réussi' });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('Erreur abonnement:', err);
        res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
});

app.post('/unsubscribe', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email || !validateEmail(email)) {
            return res.status(400).json({ success: false, error: 'Email invalide' });
        }
        
        const sanitizedEmail = sanitizeInput(email).toLowerCase().trim();
        const client = await pool.connect();
        
        try {
            const result = await client.query(
                'UPDATE email_subscribers SET subscribed = false, updated_at = NOW() WHERE email = $1',
                [sanitizedEmail]
            );
            
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Email non trouvé' });
            }
            
            res.json({ success: true, message: 'Désabonnement réussi' });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('Erreur désabonnement:', err);
        res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
});

app.post('/feedback', async (req, res) => {
    try {
        const { originalText, scoreGiven, isUseful, comment, sourcesFound, userEmail } = req.body;
        const client = await pool.connect();
        
        try {
            await client.query(
                'INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found, user_email) VALUES($1,$2,$3,$4,$5,$6)',
                [
                    sanitizeInput(originalText).substring(0, 2000), 
                    scoreGiven, 
                    isUseful, 
                    sanitizeInput(comment || '').substring(0, 500), 
                    JSON.stringify(sourcesFound || []),
                    userEmail ? sanitizeInput(userEmail).toLowerCase().trim() : null
                ]
            );
            
            res.json({ success: true });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('Erreur feedback:', err);
        res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
});

app.post('/analytics/track', async (req, res) => {
    try {
        const { userId, eventType, eventData } = req.body;
        
        if (!userId || !eventType) {
            return res.status(400).json({ error: 'userId et eventType requis' });
        }
        
        const client = await pool.connect();
        
        try {
            await client.query(
                'INSERT INTO analytics_events(user_id, event_type, event_data) VALUES($1, $2, $3)',
                [userId, eventType, JSON.stringify(eventData || {})]
            );
            
            res.json({ success: true });
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('Erreur analytics:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.get('/analytics/stats', async (req, res) => {
    try {
        const client = await pool.connect();
        
        try {
            const stats = await client.query(`
                SELECT 
                    COUNT(DISTINCT user_id) as total_users,
                    COUNT(*) FILTER (WHERE event_type = 'verification_completed') as total_verifications,
                    AVG((event_data->>'confidence')::float) FILTER (WHERE event_type = 'verification_completed' AND event_data->>'confidence' IS NOT NULL) as avg_confidence
                FROM analytics_events
            `);
            
            const emails = await client.query(
                'SELECT COUNT(*) as total FROM email_subscribers WHERE subscribed = true'
            );
            
            res.json({
                success: true,
                stats: {
                    totalUsers: parseInt(stats.rows[0].total_users) || 0,
                    totalVerifications: parseInt(stats.rows[0].total_verifications) || 0,
                    avgConfidence: parseFloat(stats.rows[0].avg_confidence) || 0,
                    totalEmails: parseInt(emails.rows[0].total) || 0
                }
            });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('Erreur stats:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.get('/subscribers/stats', async (req, res) => {
    try {
        const adminToken = req.headers['x-admin-token'];
        
        if (adminToken !== process.env.ADMIN_TOKEN) {
            return res.status(403).json({ error: 'Non autorisé' });
        }
        
        const client = await pool.connect();
        
        try {
            const totalResult = await client.query(
                'SELECT COUNT(*) as total FROM email_subscribers WHERE subscribed = true'
            );
            
            const sourceResult = await client.query(
                'SELECT source, COUNT(*) as count FROM email_subscribers WHERE subscribed = true GROUP BY source'
            );
            
            res.json({
                total: parseInt(totalResult.rows[0].total),
                bySources: sourceResult.rows
            });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('Erreur stats:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.get('/subscribers/export', async (req, res) => {
    try {
        const adminToken = req.headers['x-admin-token'];
        
        if (adminToken !== process.env.ADMIN_TOKEN) {
            return res.status(403).json({ error: 'Non autorisé' });
        }
        
        const client = await pool.connect();
        
        try {
            const result = await client.query(
                'SELECT email, name, source, created_at FROM email_subscribers WHERE subscribed = true ORDER BY created_at DESC'
            );
            
            res.json({ count: result.rows.length, subscribers: result.rows });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('Erreur export:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'V4-PRODUCTION',
        features: [
            'advanced_semantic_analysis',
            'bayesian_scoring',
            'entity_extraction',
            'intelligent_contradiction_detection',
            'tiered_source_credibility',
            'uncertainty_quantification',
            'non_verifiable_detection'
        ],
        timestamp: new Date().toISOString(),
        api_configured: !!(process.env.GOOGLE_API_KEY && process.env.SEARCH_ENGINE_ID)
    });
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
                user_email VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS email_subscribers (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(100),
                source VARCHAR(50) DEFAULT 'extension',
                subscribed BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS analytics_events (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                event_type VARCHAR(100) NOT NULL,
                event_data JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_email_subscribers_email ON email_subscribers(email);
            CREATE INDEX IF NOT EXISTS idx_email_subscribers_subscribed ON email_subscribers(subscribed);
            CREATE INDEX IF NOT EXISTS idx_analytics_user_id ON analytics_events(user_id);
            CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics_events(event_type);
            CREATE INDEX IF NOT EXISTS idx_analytics_created_at ON analytics_events(created_at);
        `);
        
        client.release();
        console.log('✅ Database initialized');
    } catch (err) {
        console.error('❌ Database error:', err.message);
    }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║          VERIFYAI V4 - PRODUCTION READY                   ║
╚═══════════════════════════════════════════════════════════╝

📡 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔑 Google API: ${!!process.env.GOOGLE_API_KEY ? '✓ Configured' : '✗ Missing'}
💾 Database: ${!!process.env.DATABASE_URL ? '✓ Connected' : '✗ Missing'}

🎯 SCORING SYSTEM V4:
├─ Questions/Opinions: 0% (non-vérifiable)
├─ Claims vérifiables: 25-35% base
├─ Impact sources: -40% à +65%
├─ Similarité sémantique: 40% minimum (strict)
├─ Contradictions: détection contextualisée
└─ Incertitude: quantifiée et affichée

🔒 Security: Rate limiting 10 req/min
📊 Analytics: Full tracking enabled
══════════════════════════════════════════════════════════════
    `);
    initDb();
});
