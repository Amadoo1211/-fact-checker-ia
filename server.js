const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

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
            console.log(`⚠️ Rate limit dépassé pour IP: ${ip}`);
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
    let cleaned = 0;
    for (const [ip, requests] of requestCounts.entries()) {
        const recent = requests.filter(time => now - time < 600000);
        if (recent.length === 0) {
            requestCounts.delete(ip);
            cleaned++;
        } else {
            requestCounts.set(ip, recent);
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 ${cleaned} IPs nettoyées du rate limiter`);
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

class ReliableScoringEngine {
    constructor() {
        this.sourceCredibilityRanks = {
            tier1: { 
                domains: ['edu', 'gov', 'who.int', 'nature.com', 'science.org', 'pubmed.ncbi.nlm.nih.gov', 'insee.fr', 'cia.gov', 'worldbank.org', 'nih.gov', 'cdc.gov'],
                multiplier: 1.0,
                description: 'Sources académiques et officielles'
            },
            tier2: { 
                domains: ['reuters.com', 'bbc.com', 'lemonde.fr', 'nytimes.com', 'theguardian.com', 'lefigaro.fr', 'economist.com', 'apnews.com', 'france24.com'],
                multiplier: 0.85,
                description: 'Médias avec processus éditorial rigoureux'
            },
            tier3: { 
                domains: ['scholar.google.com', 'jstor.org', 'researchgate.net', 'arxiv.org'],
                multiplier: 0.90,
                description: 'Bases de données scientifiques'
            },
            tier4: { 
                domains: ['wikipedia.org', 'britannica.com', 'larousse.fr'],
                multiplier: 0.75,
                description: 'Encyclopédies avec vérification communautaire'
            },
            unreliable: {
                domains: ['reddit.com', 'quora.com', 'yahoo.answers', 'answers.com', 'facebook.com', 'twitter.com'],
                multiplier: 0.25,
                description: 'Sources non éditorialisées'
            }
        };

        this.contextPatterns = {
            geographic: {
                city: /\b(ville|city proper|intra.?muros|centre.?ville|downtown|municipality)\b/i,
                metro: /\b(métropole|metropolitan|agglomération|agglomeration|urban area|greater|aire urbaine)\b/i,
                region: /\b(région|region|area|zone|territoire|territory|département|province)\b/i
            },
            temporal: {
                current: /\b(2024|2025|actuellement|currently|now|today|recent|récent)\b/i,
                historical: /\b(19\d{2}|20[01]\d|historiquement|historically|était|was|ancien|former)\b/i
            }
        };
    }

    extractVerifiableClaims(text) {
        const claims = [];
        const cleanText = sanitizeInput(text);
        
        // AMÉLIORATION: Détection scientifique plus large
        const sciClaims = cleanText.match(/\b(vitesse.*lumière|point.*ébullition|formule.*chimique|speed.*light|boiling.*point|chemical.*formula|299.*792.*458|température|temperature|masse|mass|densité|density|gravity|gravité|constante|constant|loi.*physique|physics.*law|einstein|relativity|relativité)\b/gi);
        if (sciClaims) {
            claims.push(...sciClaims.slice(0, 3).map(claim => ({
                type: 'SCIENTIFIC',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.96
            })));
        }
        
        const numberClaims = cleanText.match(/\b\d+([,\.]\d+)?\s*(millions?|milliards?|billions?|%|pour\s*cent|kilomètres?|km|mètres?|habitants?|personnes?|années?|ans|dollars?|\$|euros?|€)\b/gi);
        if (numberClaims) {
            claims.push(...numberClaims.slice(0, 3).map(claim => ({
                type: 'QUANTITATIVE',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.92
            })));
        }

        const historicalClaims = cleanText.match(/\b(en|in|depuis|from|until|de|du)\s+(19|20)\d{2}.*?(fondé|créé|né|mort|established|founded|born|died|independence|indépendance|guerre|war|treaty|traité)\b/gi);
        if (historicalClaims) {
            claims.push(...historicalClaims.slice(0, 2).map(claim => ({
                type: 'HISTORICAL',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.88
            })));
        }

        const geoClaims = cleanText.match(/\b(capitale|capital|population|superficie|area|situé|located|se trouve|is located|habitants)\s+(de|of|dans|in)\s+[A-Z][a-zA-ZÀ-ÿ\s]+\b/gi);
        if (geoClaims) {
            claims.push(...geoClaims.slice(0, 2).map(claim => ({
                type: 'GEOGRAPHIC',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.96
            })));
        }

        console.log(`🔍 Claims extraits: ${claims.length} (${claims.map(c => c.type).join(', ')})`);
        return claims;
    }

    analyzeContentType(text, claims) {
        const lower = text.toLowerCase();
        
        // PRIORITÉ: Détection faits scientifiques AVANT opinion
        if (claims.length > 0) {
            const hasScientific = claims.some(c => c.type === 'SCIENTIFIC');
            const hasQuantitative = claims.some(c => c.type === 'QUANTITATIVE');
            const hasHistorical = claims.some(c => c.type === 'HISTORICAL');
            const hasGeographic = claims.some(c => c.type === 'GEOGRAPHIC');
            
            if (hasScientific) {
                return {
                    type: 'SCIENTIFIC_FACT',
                    baseScore: 0.60, // AUGMENTÉ de 0.50 à 0.60
                    reasoning: '**Fait scientifique** (60% base) - Information scientifique vérifiable.'
                };
            } else if (hasGeographic) {
                return {
                    type: 'GEOGRAPHIC_FACT',
                    baseScore: 0.55, // AUGMENTÉ de 0.50 à 0.55
                    reasoning: '**Fait géographique** (55% base) - Données géographiques vérifiables.'
                };
            } else if (hasQuantitative) {
                return {
                    type: 'STATISTICAL_FACT',
                    baseScore: 0.50, // AUGMENTÉ de 0.40 à 0.50
                    reasoning: '**Données quantitatives** (50% base) - Statistiques mesurables.'
                };
            } else if (hasHistorical) {
                return {
                    type: 'HISTORICAL_FACT',
                    baseScore: 0.50, // AUGMENTÉ de 0.40 à 0.50
                    reasoning: '**Fait historique** (50% base) - Information historique documentée.'
                };
            }
        }
        
        // Opinions détectées APRÈS
        const opinionPatterns = [
            /\b(je pense|je crois|à mon avis|personnellement|subjectivement|selon moi)\b/i,
            /\b(i think|i believe|in my opinion|personally|subjectively|i feel)\b/i,
            /\b(meilleur|pire|préfère|favorite|best|worst)\b/i
        ];
        
        if (opinionPatterns.some(pattern => pattern.test(text))) {
            return {
                type: 'OPINION',
                baseScore: 0.30,
                reasoning: '**Opinion subjective** (30%) - Point de vue personnel nécessitant validation.'
            };
        }

        if (text.length < 300 && (/^(what|how|why|when|where|which|who|can you|could you|please|qu|quoi|comment|pourquoi|quand|où)/i.test(text.trim()) || text.includes('?'))) {
            return {
                type: 'QUESTION',
                baseScore: 0.30,
                reasoning: '**Question utilisateur** (30%) - Demande d\'information nécessitant vérification.'
            };
        }

        return {
            type: 'GENERAL_INFO',
            baseScore: 0.40, // AUGMENTÉ de 0.30 à 0.40
            reasoning: '**Information générale** (40%) - Contenu informatif standard.'
        };
    }

    extractDetailedContext(text) {
        return {
            geographic: {
                hasCity: this.contextPatterns.geographic.city.test(text),
                hasMetro: this.contextPatterns.geographic.metro.test(text),
                hasRegion: this.contextPatterns.geographic.region.test(text)
            },
            temporal: {
                isCurrent: this.contextPatterns.temporal.current.test(text),
                isHistorical: this.contextPatterns.temporal.historical.test(text)
            },
            measurement: {
                hasTotal: /\b(total|ensemble|including|avec|with|all|tous)\b/i.test(text),
                hasPartial: /\b(seulement|only|just|environ|approximately|about|roughly)\b/i.test(text)
            }
        };
    }

    areComplementaryContexts(context1, context2) {
        if ((context1.geographic.hasCity && context2.geographic.hasMetro) ||
            (context1.geographic.hasMetro && context2.geographic.hasCity)) {
            return true;
        }

        if ((context1.geographic.hasCity && context2.geographic.hasRegion) ||
            (context1.geographic.hasRegion && context2.geographic.hasCity)) {
            return true;
        }

        if ((context1.temporal.isCurrent && context2.temporal.isHistorical) ||
            (context1.temporal.isHistorical && context2.temporal.isCurrent)) {
            return true;
        }

        if ((context1.measurement.hasTotal && context2.measurement.hasPartial) ||
            (context1.measurement.hasPartial && context2.measurement.hasTotal)) {
            return true;
        }

        return false;
    }

    extractNumbersWithContext(text) {
        const numberMatches = text.match(/\b\d+([,\.]\d+)?\b/g) || [];
        return numberMatches.map(match => ({
            value: parseFloat(match.replace(',', '.')),
            context: this.extractDetailedContext(text)
        }));
    }

    detectIntelligentContradiction(text1, text2) {
        const context1 = this.extractDetailedContext(text1);
        const context2 = this.extractDetailedContext(text2);
        
        if (this.areComplementaryContexts(context1, context2)) {
            return { 
                detected: false, 
                details: { 
                    reason: 'Contextes complémentaires détectés',
                    context1: context1,
                    context2: context2
                }
            };
        }

        const nums1 = this.extractNumbersWithContext(text1);
        const nums2 = this.extractNumbersWithContext(text2);

        if (nums1.length === 0 || nums2.length === 0) {
            return { detected: false, details: null };
        }

        for (const num1 of nums1) {
            for (const num2 of nums2) {
                if (num1.value > 0 && Math.abs(num1.value - num2.value) / num1.value > 0.5) {
                    if (this.isTrueContradiction(num1, num2, context1, context2)) {
                        return {
                            detected: true,
                            details: { 
                                original: num1.value, 
                                source: num2.value, 
                                difference: Math.abs(num1.value - num2.value) / num1.value,
                                reason: 'Contradiction numérique détectée'
                            }
                        };
                    }
                }
            }
        }

        return { detected: false, details: null };
    }

    isTrueContradiction(num1, num2, context1, context2) {
        if (JSON.stringify(context1) === JSON.stringify(context2)) {
            return Math.abs(num1.value - num2.value) / num1.value > 0.5;
        }
        
        if (this.areComplementaryContexts(context1, context2)) {
            return false;
        }
        
        return Math.abs(num1.value - num2.value) / num1.value > 2.0;
    }

    evaluateSourceQuality(sources) {
        if (sources.length === 0) {
            return {
                impact: -0.15,
                confidence: 0,
                reasoning: 'Aucune source de vérification trouvée (-15%).'
            };
        }

        let qualityScore = 0;
        let supportingHigh = sources.filter(s => s.actuallySupports && s.credibilityMultiplier >= 0.85).length;
        let supportingAny = sources.filter(s => s.actuallySupports).length;
        let contradictingHigh = sources.filter(s => s.contradicts && s.credibilityMultiplier >= 0.70).length;

        if (supportingHigh > 0) {
            qualityScore += supportingHigh * 0.15;
        } else if (supportingAny > 0) {
            qualityScore += supportingAny * 0.08;
        }

        if (contradictingHigh > 0) {
            qualityScore -= contradictingHigh * 0.15;
        }

        if (sources.length >= 3) {
            qualityScore += 0.04;
        }
        if (sources.length >= 5) {
            qualityScore += 0.03;
        }

        const tier1Sources = sources.filter(s => s.credibilityMultiplier === 1.0).length;
        if (tier1Sources > 0) {
            qualityScore += tier1Sources * 0.10;
        }

        let reasoning = `Sources: ${supportingAny} confirment`;
        if (contradictingHigh > 0) {
            reasoning += `, ${contradictingHigh} contredisent (-${Math.round(contradictingHigh * 15)}%)`;
        }
        if (supportingHigh > 0) {
            reasoning += `. ${supportingHigh} sources très fiables (+${Math.round(supportingHigh * 15)}%).`;
        }

        return {
            impact: Math.max(-0.20, Math.min(0.35, qualityScore)),
            confidence: Math.min(0.5, sources.length * 0.12),
            reasoning
        };
    }

    evaluateConsensus(sources) {
        if (sources.length < 2) {
            return { bonus: 0, confidence: 0, reasoning: '' };
        }

        const supporting = sources.filter(s => s.actuallySupports).length;
        const contradicting = sources.filter(s => s.contradicts).length;
        const total = sources.length;

        const supportRatio = supporting / total;
        const contradictRatio = contradicting / total;
        
        let bonus = 0;
        let reasoning = '';

        if (supportRatio >= 0.8 && supporting >= 2) {
            bonus = 0.12;
            reasoning = `Consensus très fort: ${supporting}/${total} sources confirment (+12%).`;
        } else if (supportRatio >= 0.6 && supporting >= 2) {
            bonus = 0.08;
            reasoning = `Bon consensus: ${supporting}/${total} sources confirment (+8%).`;
        } else if (supportRatio >= 0.4 && supporting >= 1) {
            bonus = 0.04;
            reasoning = `Consensus modéré: ${supporting}/${total} sources confirment (+4%).`;
        } else if (contradictRatio > 0.5) {
            bonus = -0.12;
            reasoning = `Contradictions dominantes: ${contradicting}/${total} sources contredisent (-12%).`;
        } else {
            reasoning = `Pas de consensus clair: sources partagées.`;
        }

        return {
            bonus: Math.max(-0.15, Math.min(0.15, bonus)),
            confidence: Math.min(0.30, total * 0.08),
            reasoning
        };
    }

    evaluateContextualCoherence(originalText, sources) {
        if (sources.length === 0) return { bonus: 0, reasoning: '' };

        let coherenceScore = 0;
        
        const uniqueDomains = new Set(sources.map(s => {
            try {
                return new URL(s.url).hostname;
            } catch {
                return s.url;
            }
        })).size;
        
        if (uniqueDomains >= 3) {
            coherenceScore += 0.03;
        }
        if (uniqueDomains >= 5) {
            coherenceScore += 0.02;
        }

        const hasTier1 = sources.some(s => s.credibilityTier === 'tier1');
        const hasTier2 = sources.some(s => s.credibilityTier === 'tier2');
        const hasTier3 = sources.some(s => s.credibilityTier === 'tier3');
        const hasTier4 = sources.some(s => s.credibilityTier === 'tier4');
        
        const tierCount = [hasTier1, hasTier2, hasTier3, hasTier4].filter(Boolean).length;
        
        if (tierCount >= 3) {
            coherenceScore += 0.04;
        } else if (tierCount >= 2) {
            coherenceScore += 0.02;
        }

        const hasRecentSources = sources.some(s => 
            s.snippet && /202[3-5]|recent|latest|current|récent|actuel/i.test(s.snippet)
        );
        
        if (hasRecentSources && /population|data|statistics|facts|données|statistiques/i.test(originalText)) {
            coherenceScore += 0.03;
        }

        let reasoning = '';
        if (coherenceScore > 0) {
            reasoning = `Cohérence contextuelle: ${uniqueDomains} domaines, ${tierCount} tiers (+${Math.round(coherenceScore * 100)}%).`;
        }

        return {
            bonus: coherenceScore,
            reasoning: reasoning
        };
    }

    calculateBalancedScore(originalText, analyzedSources, claims) {
        let totalScore = 0;
        let confidence = 0;
        const reasoning = [];

        console.log(`🎯 Calcul du score V3 OPTIMISÉ...`);

        const contentType = this.analyzeContentType(originalText, claims);
        totalScore += contentType.baseScore;
        reasoning.push(contentType.reasoning);
        confidence += 0.35;

        const sourceEval = this.evaluateSourceQuality(analyzedSources);
        totalScore += sourceEval.impact;
        reasoning.push(sourceEval.reasoning);
        confidence += sourceEval.confidence;

        const consensus = this.evaluateConsensus(analyzedSources);
        totalScore += consensus.bonus;
        if (consensus.reasoning) {
            reasoning.push(consensus.reasoning);
        }
        confidence += consensus.confidence;

        const contextBonus = this.evaluateContextualCoherence(originalText, analyzedSources);
        totalScore += contextBonus.bonus;
        if (contextBonus.reasoning) {
            reasoning.push(contextBonus.reasoning);
        }

        const finalScore = Math.max(0.15, Math.min(0.90, totalScore));
        
        console.log(`📊 Score V3: ${Math.round(finalScore * 100)}% (type: ${contentType.type})`);
        
        return {
            score: finalScore,
            confidence: Math.min(1.0, confidence),
            reasoning: reasoning.join(' '),
            details: {
                baseScore: contentType.baseScore,
                sourceImpact: sourceEval.impact,
                consensusBonus: consensus.bonus,
                contextBonus: contextBonus.bonus,
                claimsFound: claims.length,
                sourcesAnalyzed: analyzedSources.length,
                supportingSources: analyzedSources.filter(s => s.actuallySupports).length,
                contradictingSources: analyzedSources.filter(s => s.contradicts).length,
                contentType: contentType.type
            }
        };
    }

    calculateSemanticSimilarity(text1, text2) {
        if (!text1 || !text2) return { score: 0, confirms: false };
        
        const stopWords = new Set(['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'mais', 'dans', 'sur', 'pour', 'avec', 'par', 'a', 'an', 'is', 'are', 'was', 'were']);
        
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
            confirms: similarity > 0.50 && intersection.size >= 3
        };
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

async function analyzeSourcesWithImprovedLogic(factChecker, originalText, sources) {
    const analyzedSources = [];
    
    for (const source of sources.slice(0, 5)) {
        try {
            const credibility = factChecker.getSourceCredibilityTier(source.url);
            const semanticMatch = factChecker.calculateSemanticSimilarity(originalText, source.snippet || '');
            const contradiction = factChecker.detectIntelligentContradiction(originalText, source.snippet || '');
            
            const actuallySupports = semanticMatch.confirms && !contradiction.detected && semanticMatch.score > 0.50;
            
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
            
            const credibility = factChecker.getSourceCredibilityTier(source.url);
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
    
    return analyzedSources;
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
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function extractMainKeywords(text) {
    const cleaned = sanitizeInput(text).substring(0, 1000);
    const keywords = [];
    
    try {
        const namedEntities = cleaned.match(/\b[A-Z][a-zA-ZÀ-ÿ]+(?:\s+[A-Z][a-zA-ZÀ-ÿ]+){0,2}\b/g) || [];
        keywords.push(...namedEntities.slice(0, 4));
        
        const dates = cleaned.match(/\b(19|20)\d{2}\b/g) || [];
        keywords.push(...dates.slice(0, 2));
        
        const numbersWithUnits = cleaned.match(/\b\d+([,\.]\d+)?\s*(?:million|milliard|%|km|habitants|meters)\b/gi) || [];
        keywords.push(...numbersWithUnits.slice(0, 2));
        
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
    
    const originalWords = original.split(/\s+/).filter(w => w.length > 3).slice(0, 8);
    let commonWords = 0;
    
    for (const word of originalWords) {
        if (title.includes(word) || snippet.includes(word)) {
            commonWords++;
        }
    }
    
    score += (commonWords / Math.max(originalWords.length, 1)) * 0.4;
    
    if (url.includes('wikipedia')) score += 0.25;
    else if (url.includes('.edu') || url.includes('.gov')) score += 0.2;
    else if (url.includes('britannica') || url.includes('nature.com')) score += 0.15;
    
    if (url.includes('reddit') || url.includes('forum')) score -= 0.15;
    
    return Math.max(0.1, Math.min(1, score));
}

app.post('/verify', rateLimiter(10, 60000), async (req, res) => {
    try {
        const { text, smartQueries, analysisType } = req.body;
        
        console.log(`\n🔍 === ANALYSE V3 OPTIMISÉ ===`);
        console.log(`📝 Texte: "${text.substring(0, 80)}..."`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                overallConfidence: 0.20,
                scoringExplanation: "**Texte insuffisant** (20%) - Contenu trop court pour analyse.", 
                keywords: [],
                sources: [],
                methodology: "Scoring V3 - Optimisé"
            });
        }
        
        const factChecker = new ReliableScoringEngine();
        const claims = factChecker.extractVerifiableClaims(text);
        const keywords = extractMainKeywords(text);
        const sources = await findWebSources(keywords, smartQueries, text);
        const analyzedSources = await analyzeSourcesWithImprovedLogic(factChecker, text, sources);
        const result = factChecker.calculateBalancedScore(text, analyzedSources, claims);
        
        const response = {
            overallConfidence: result.score,
            confidence: result.confidence,
            scoringExplanation: result.reasoning,
            sources: analyzedSources,
            keywords: keywords,
            claimsAnalyzed: claims,
            details: result.details,
            methodology: "Scoring V3 - Optimisé"
        };
        
        console.log(`✅ Score V3: ${Math.round(result.score * 100)}%`);
        console.log(`📊 ${analyzedSources.length} sources | ${claims.length} claims | ${analyzedSources.filter(s => s.actuallySupports).length} confirment`);
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Erreur analyse:', error);
        res.status(500).json({ 
            overallConfidence: 0.20,
            scoringExplanation: "**Erreur système** (20%) - Impossible de terminer l'analyse.",
            keywords: [],
            sources: [],
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
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
        const subscriptionSource = source || 'extension';
        
        const client = await pool.connect();
        
        try {
            const existingUser = await client.query(
                'SELECT id, subscribed FROM email_subscribers WHERE email = $1',
                [sanitizedEmail]
            );
            
            if (existingUser.rows.length > 0) {
                if (!existingUser.rows[0].subscribed) {
                    await client.query(
                        'UPDATE email_subscribers SET subscribed = true, updated_at = NOW() WHERE email = $1',
                        [sanitizedEmail]
                    );
                    console.log(`📧 Réabonnement: ${sanitizedEmail}`);
                    return res.json({ success: true, message: 'Réabonnement réussi', alreadySubscribed: false });
                }
                
                console.log(`📧 Déjà abonné: ${sanitizedEmail}`);
                return res.json({ success: true, message: 'Déjà abonné', alreadySubscribed: true });
            }
            
            await client.query(
                'INSERT INTO email_subscribers(email, name, source) VALUES($1, $2, $3)',
                [sanitizedEmail, sanitizedName, subscriptionSource]
            );
            
            console.log(`📧 Nouvel abonné: ${sanitizedEmail} (${subscriptionSource})`);
            res.json({ success: true, message: 'Abonnement réussi', alreadySubscribed: false });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('❌ Erreur abonnement:', err);
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
            
            console.log(`📝 Feedback: ${isUseful ? 'Utile' : 'Pas utile'} - Score: ${scoreGiven}`);
            res.json({ success: true });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('❌ Erreur feedback:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'V3-OPTIMIZED',
        features: [
            'scoring_v3_optimized', 
            'scientific_facts_60_percent',
            'rate_limiting',
            'email_capture',
            'analytics_tracking'
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
        
        client.release();
        console.log('✅ Database ready');
    } catch (err) {
        console.error('❌ Database error:', err.message);
    }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 === VERIFYAI V3 OPTIMISÉ ===`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`⚡ Scoring: Scientifique 60% | Géo 55% | Stats 50%`);
    console.log(`🔒 Rate Limiting: 10 req/min`);
    console.log(`============================================\n`);
    initDb();
});
