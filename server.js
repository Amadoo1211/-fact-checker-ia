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

// ========== SYSTÈME DE FACT-CHECKING AMÉLIORÉ ET FIABLE ==========

class ImprovedFactChecker {
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
                domains: ['wikipedia.org', 'britannica.com', 'larousse.fr'],
                multiplier: 0.75,
                description: 'Encyclopédies avec vérification communautaire'
            },
            tier4: { 
                domains: ['scholar.google.com', 'jstor.org', 'researchgate.net', 'arxiv.org'],
                multiplier: 0.9,
                description: 'Bases de données scientifiques'
            },
            unreliable: {
                domains: ['reddit.com', 'quora.com', 'yahoo.answers', 'answers.com', 'facebook.com', 'twitter.com'],
                multiplier: 0.25,
                description: 'Sources non éditorialisées'
            }
        };

        // Contextes pour éviter les fausses contradictions
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

    // 1. EXTRACTION DE CLAIMS VÉRIFIABLES
    extractVerifiableClaims(text) {
        const claims = [];
        const cleanText = sanitizeInput(text);
        
        // Claims quantitatifs (renforcés)
        const numberClaims = cleanText.match(/\b\d+([,\.]\d+)?\s*(millions?|milliards?|billions?|%|pour\s*cent|kilomètres?|km|mètres?|habitants?|personnes?|années?|ans|dollars?|\$|euros?|€)\b/gi);
        if (numberClaims) {
            claims.push(...numberClaims.slice(0, 3).map(claim => ({
                type: 'QUANTITATIVE',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.92
            })));
        }

        // Claims historiques (améliorés)
        const historicalClaims = cleanText.match(/\b(en|in|depuis|from|until|de|du)\s+(19|20)\d{2}.*?(fondé|créé|né|mort|established|founded|born|died|independence|indépendance|guerre|war|treaty|traité)\b/gi);
        if (historicalClaims) {
            claims.push(...historicalClaims.slice(0, 2).map(claim => ({
                type: 'HISTORICAL',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.88
            })));
        }

        // Claims géographiques (enrichis)
        const geoClaims = cleanText.match(/\b(capitale|capital|population|superficie|area|situé|located|se trouve|is located|habitants)\s+(de|of|dans|in)\s+[A-Z][a-zA-ZÀ-ÿ\s]+\b/gi);
        if (geoClaims) {
            claims.push(...geoClaims.slice(0, 2).map(claim => ({
                type: 'GEOGRAPHIC',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.96
            })));
        }

        // Claims scientifiques (élargis)
        const sciClaims = cleanText.match(/\b(vitesse.*lumière|point.*ébullition|formule.*chimique|speed.*light|boiling.*point|chemical.*formula|299.*792.*458|température|temperature|masse|mass|densité|density|gravity|gravité)\b/gi);
        if (sciClaims) {
            claims.push(...sciClaims.slice(0, 2).map(claim => ({
                type: 'SCIENTIFIC',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.94
            })));
        }

        console.log(`🔍 Claims extraits: ${claims.length} (avg confidence: ${claims.reduce((sum, c) => sum + c.confidence, 0) / Math.max(claims.length, 1)})`);
        return claims;
    }

    // 2. ANALYSE DU TYPE DE CONTENU - SCORES OPTIMISÉS
    analyzeContentType(text, claims) {
        const lower = text.toLowerCase();
        
        // Opinion subjective (AUGMENTÉE: 40% → 55%)
        const opinionPatterns = [
            /\b(je pense|je crois|à mon avis|personnellement|subjectivement|selon moi)\b/i,
            /\b(i think|i believe|in my opinion|personally|subjectively|i feel)\b/i,
            /\b(meilleur|pire|préfère|favorite|best|worst)\b/i
        ];
        
        if (opinionPatterns.some(pattern => pattern.test(text))) {
            return {
                type: 'OPINION',
                baseScore: 0.55,
                reasoning: '**Opinion subjective** (55%) - Point de vue personnel qui peut être étayé.'
            };
        }

        // Question directe (AUGMENTÉE: 30% → 45%)
        if (text.length < 300 && (/^(what|how|why|when|where|which|who|can you|could you|please|qu|quoi|comment|pourquoi|quand|où)/i.test(text.trim()) || text.includes('?'))) {
            return {
                type: 'QUESTION',
                baseScore: 0.45,
                reasoning: '**Question utilisateur** (45%) - Demande d\'information directe avec réponse factuelle.'
            };
        }

        // Faits avec claims vérifiables (TOUS AUGMENTÉS)
        if (claims.length > 0) {
            const hasScientific = claims.some(c => c.type === 'SCIENTIFIC');
            const hasQuantitative = claims.some(c => c.type === 'QUANTITATIVE');
            const hasHistorical = claims.some(c => c.type === 'HISTORICAL');
            const hasGeographic = claims.some(c => c.type === 'GEOGRAPHIC');
            
            if (hasScientific) {
                return {
                    type: 'SCIENTIFIC_FACT',
                    baseScore: 0.78,
                    reasoning: '**Fait scientifique** (78%) - Information scientifique établie et hautement vérifiable.'
                };
            } else if (hasGeographic) {
                return {
                    type: 'GEOGRAPHIC_FACT',
                    baseScore: 0.74,
                    reasoning: '**Fait géographique** (74%) - Données géographiques officielles facilement vérifiables.'
                };
            } else if (hasQuantitative) {
                return {
                    type: 'STATISTICAL_FACT',
                    baseScore: 0.68,
                    reasoning: '**Données quantitatives** (68%) - Statistiques mesurables et vérifiables.'
                };
            } else if (hasHistorical) {
                return {
                    type: 'HISTORICAL_FACT',
                    baseScore: 0.71,
                    reasoning: '**Fait historique** (71%) - Information historique documentée et vérifiable.'
                };
            }
        }

        // Information générale (AUGMENTÉE: 50% → 58%)
        return {
            type: 'GENERAL_INFO',
            baseScore: 0.58,
            reasoning: '**Information générale** (58%) - Contenu informatif standard avec vérifiabilité moyenne.'
        };
    }

    // 3. EXTRACTION DE CONTEXTE DÉTAILLÉ
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

    // 4. VÉRIFICATION DE CONTEXTES COMPLÉMENTAIRES (améliorée)
    areComplementaryContexts(context1, context2) {
        // Ville vs Métropole = complémentaires
        if ((context1.geographic.hasCity && context2.geographic.hasMetro) ||
            (context1.geographic.hasMetro && context2.geographic.hasCity)) {
            return true;
        }

        // Ville vs Région = complémentaires
        if ((context1.geographic.hasCity && context2.geographic.hasRegion) ||
            (context1.geographic.hasRegion && context2.geographic.hasCity)) {
            return true;
        }

        // Données historiques vs actuelles = complémentaires
        if ((context1.temporal.isCurrent && context2.temporal.isHistorical) ||
            (context1.temporal.isHistorical && context2.temporal.isCurrent)) {
            return true;
        }

        // Total vs partiel = complémentaires
        if ((context1.measurement.hasTotal && context2.measurement.hasPartial) ||
            (context1.measurement.hasPartial && context2.measurement.hasTotal)) {
            return true;
        }

        return false;
    }

    // 5. EXTRACTION DE NOMBRES AVEC CONTEXTE
    extractNumbersWithContext(text) {
        const numberMatches = text.match(/\b\d+([,\.]\d+)?\b/g) || [];
        return numberMatches.map(match => ({
            value: parseFloat(match.replace(',', '.')),
            context: this.extractDetailedContext(text)
        }));
    }

    // 6. DÉTECTION DE CONTRADICTIONS INTELLIGENTE (seuil assoupli)
    detectIntelligentContradiction(text1, text2) {
        const context1 = this.extractDetailedContext(text1);
        const context2 = this.extractDetailedContext(text2);
        
        // Si contextes complémentaires, pas de contradiction
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

        // SEUIL ASSOUPLI: 50% → 150%
        for (const num1 of nums1) {
            for (const num2 of nums2) {
                if (num1.value > 0 && Math.abs(num1.value - num2.value) / num1.value > 1.5) {
                    if (this.isTrueContradiction(num1, num2, context1, context2)) {
                        return {
                            detected: true,
                            details: { 
                                original: num1.value, 
                                source: num2.value, 
                                difference: Math.abs(num1.value - num2.value) / num1.value,
                                reason: 'Contradiction numérique majeure confirmée'
                            }
                        };
                    }
                }
            }
        }

        return { detected: false, details: null };
    }

    // 7. VÉRIFICATION DE VRAIE CONTRADICTION (renforcée)
    isTrueContradiction(num1, num2, context1, context2) {
        // Même contexte exact = vraie contradiction si différence > 150%
        if (JSON.stringify(context1) === JSON.stringify(context2)) {
            return Math.abs(num1.value - num2.value) / num1.value > 1.5;
        }
        
        // Contextes complémentaires = jamais contradiction
        if (this.areComplementaryContexts(context1, context2)) {
            return false;
        }
        
        // Contextes différents = contradiction seulement si TRÈS grande différence (>400%)
        return Math.abs(num1.value - num2.value) / num1.value > 4.0;
    }

    // 8. ÉVALUATION DE LA QUALITÉ DES SOURCES (impact renforcé)
    evaluateSourceQuality(sources) {
        if (sources.length === 0) {
            return {
                impact: -0.12,
                confidence: 0,
                reasoning: 'Aucune source de vérification trouvée (-12%).'
            };
        }

        let qualityScore = 0;
        let supportingHigh = sources.filter(s => s.actuallySupports && s.credibilityMultiplier >= 0.85).length;
        let supportingAny = sources.filter(s => s.actuallySupports).length;
        let contradictingHigh = sources.filter(s => s.contradicts && s.credibilityMultiplier >= 0.85).length;

        // BONUS RENFORCÉS
        if (supportingHigh > 0) {
            qualityScore += supportingHigh * 0.20;
        } else if (supportingAny > 0) {
            qualityScore += supportingAny * 0.12;
        }

        // PÉNALITÉ RENFORCÉE
        if (contradictingHigh > 0) {
            qualityScore -= contradictingHigh * 0.15;
        }

        // BONUS PROGRESSIF AMÉLIORÉ
        if (sources.length >= 3) {
            qualityScore += 0.06;
        }
        if (sources.length >= 5) {
            qualityScore += 0.04;
        }

        // BONUS TIER1 RENFORCÉ
        const tier1Sources = sources.filter(s => s.credibilityMultiplier === 1.0).length;
        if (tier1Sources > 0) {
            qualityScore += tier1Sources * 0.10;
        }

        let reasoning = `Sources: ${supportingAny} confirment`;
        if (contradictingHigh > 0) {
            reasoning += `, ${contradictingHigh} contredisent (${Math.round(contradictingHigh * 15)}%)`;
        }
        if (supportingHigh > 0) {
            reasoning += `. ${supportingHigh} sources très fiables (+${supportingHigh * 20}%).`;
        }

        return {
            impact: Math.max(-0.20, Math.min(0.35, qualityScore)),
            confidence: Math.min(0.5, sources.length * 0.12),
            reasoning
        };
    }

    // 9. ÉVALUATION DU CONSENSUS (bonus renforcés)
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

        // BONUS RENFORCÉS
        if (supportRatio >= 0.8 && supporting >= 2) {
            bonus = 0.18;
            reasoning = `Consensus très fort: ${supporting}/${total} sources confirment (+18%).`;
        } else if (supportRatio >= 0.6 && supporting >= 2) {
            bonus = 0.12;
            reasoning = `Bon consensus: ${supporting}/${total} sources confirment (+12%).`;
        } else if (supportRatio >= 0.4 && supporting >= 1) {
            bonus = 0.06;
            reasoning = `Consensus modéré: ${supporting}/${total} sources confirment (+6%).`;
        } else if (contradictRatio > 0.5) {
            bonus = -0.10;
            reasoning = `Contradictions dominantes: ${contradicting}/${total} sources contredisent (-10%).`;
        } else {
            reasoning = `Pas de consensus clair: sources partagées.`;
        }

        return {
            bonus: Math.max(-0.15, Math.min(0.20, bonus)),
            confidence: Math.min(0.30, total * 0.08),
            reasoning
        };
    }

    // 10. COHÉRENCE CONTEXTUELLE (améliorée)
    evaluateContextualCoherence(originalText, sources) {
        if (sources.length === 0) return { bonus: 0, reasoning: '' };

        let coherenceScore = 0;
        
        // BONUS DIVERSITÉ AMÉLIORÉ
        const uniqueDomains = new Set(sources.map(s => {
            try {
                return new URL(s.url).hostname;
            } catch {
                return s.url;
            }
        })).size;
        
        if (uniqueDomains >= 3) {
            coherenceScore += 0.05;
        }
        if (uniqueDomains >= 5) {
            coherenceScore += 0.03;
        }

        // BONUS MIX TIERS RENFORCÉ
        const hasTier1 = sources.some(s => s.credibilityTier === 'tier1');
        const hasTier2 = sources.some(s => s.credibilityTier === 'tier2');
        const hasTier3 = sources.some(s => s.credibilityTier === 'tier3');
        const hasTier4 = sources.some(s => s.credibilityTier === 'tier4');
        
        const tierCount = [hasTier1, hasTier2, hasTier3, hasTier4].filter(Boolean).length;
        
        if (tierCount >= 3) {
            coherenceScore += 0.06;
        } else if (tierCount >= 2) {
            coherenceScore += 0.04;
        }

        // BONUS SOURCES RÉCENTES AUGMENTÉ
        const hasRecentSources = sources.some(s => 
            s.snippet && /202[3-5]|recent|latest|current|récent|actuel/i.test(s.snippet)
        );
        
        if (hasRecentSources && /population|data|statistics|facts|données|statistiques/i.test(originalText)) {
            coherenceScore += 0.04;
        }

        let reasoning = '';
        if (coherenceScore > 0) {
            reasoning = `Cohérence contextuelle: ${uniqueDomains} domaines, ${tierCount} tiers sources (+${Math.round(coherenceScore * 100)}%).`;
        }

        return {
            bonus: coherenceScore,
            reasoning: reasoning
        };
    }

    // 11. CALCUL FINAL OPTIMISÉ
    calculateBalancedScore(originalText, analyzedSources, claims) {
        let totalScore = 0;
        let confidence = 0;
        const reasoning = [];

        console.log(`🎯 Calcul du score optimisé...`);

        // 1. Score de base (CONFIANCE AUGMENTÉE)
        const contentType = this.analyzeContentType(originalText, claims);
        totalScore += contentType.baseScore;
        reasoning.push(contentType.reasoning);
        confidence += 0.35;

        // 2. Qualité des sources (inchangé)
        const sourceEval = this.evaluateSourceQuality(analyzedSources);
        totalScore += sourceEval.impact;
        reasoning.push(sourceEval.reasoning);
        confidence += sourceEval.confidence;

        // 3. Consensus (inchangé)
        const consensus = this.evaluateConsensus(analyzedSources);
        totalScore += consensus.bonus;
        if (consensus.reasoning) {
            reasoning.push(consensus.reasoning);
        }
        confidence += consensus.confidence;

        // 4. Cohérence contextuelle (inchangé)
        const contextBonus = this.evaluateContextualCoherence(originalText, analyzedSources);
        totalScore += contextBonus.bonus;
        if (contextBonus.reasoning) {
            reasoning.push(contextBonus.reasoning);
        }

        // RANGE AJUSTÉ: 15-92% → 20-95%
        const finalScore = Math.max(0.20, Math.min(0.95, totalScore));
        
        console.log(`📊 Score optimisé: ${Math.round(finalScore * 100)}% (confiance: ${Math.round(confidence * 100)}%)`);
        
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

    // MÉTHODES UTILITAIRES

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
        
        // SEUIL RENFORCÉ: 15% → 30% + minimum 2 mots communs
        return {
            score: similarity,
            confirms: similarity > 0.30 && intersection.size >= 2
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

// ========== FONCTION D'ANALYSE DES SOURCES AMÉLIORÉE ==========

async function analyzeSourcesWithImprovedLogic(factChecker, originalText, sources) {
    const analyzedSources = [];
    
    for (const source of sources.slice(0, 5)) {
        try {
            const credibility = factChecker.getSourceCredibilityTier(source.url);
            const semanticMatch = factChecker.calculateSemanticSimilarity(originalText, source.snippet || '');
            const contradiction = factChecker.detectIntelligentContradiction(originalText, source.snippet || '');
            
            // SEUIL AUGMENTÉ: 0.15 → 0.30
            const actuallySupports = semanticMatch.confirms && !contradiction.detected && semanticMatch.score > 0.30;
            
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

function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
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

// Endpoint principal avec système amélioré
app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType } = req.body;
        
        console.log(`\n🔍 === ANALYSE OPTIMISÉE V2.0 ===`);
        console.log(`📝 Texte: "${text.substring(0, 80)}..."`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                overallConfidence: 0.25,
                scoringExplanation: "**Texte insuffisant** (25%) - Contenu trop court pour analyse.", 
                keywords: [],
                sources: [],
                methodology: "Analyse optimisée avec scoring fiable"
            });
        }
        
        const factChecker = new ImprovedFactChecker();
        
        // 1. Extraction des claims vérifiables
        const claims = factChecker.extractVerifiableClaims(text);
        
        // 2. Extraction des mots-clés
        const keywords = extractMainKeywords(text);
        
        // 3. Recherche de sources
        const sources = await findWebSources(keywords, smartQueries, text);
        
        // 4. Analyse sémantique améliorée
        const analyzedSources = await analyzeSourcesWithImprovedLogic(factChecker, text, sources);
        
        // 5. Calcul du score équilibré
        const result = factChecker.calculateBalancedScore(text, analyzedSources, claims);
        
        const response = {
            overallConfidence: result.score,
            confidence: result.confidence,
            scoringExplanation: result.reasoning,
            sources: analyzedSources,
            keywords: keywords,
            claimsAnalyzed: claims,
            details: result.details,
            methodology: "Analyse optimisée V2.0 - scoring fiable et précis"
        };
        
        console.log(`✅ Score optimisé: ${Math.round(result.score * 100)}% (confiance: ${Math.round(result.confidence * 100)}%)`);
        console.log(`📊 ${analyzedSources.length} sources | ${claims.length} claims | ${analyzedSources.filter(s => s.actuallySupports).length} confirment`);
        console.log(`===============================\n`);
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Erreur analyse équilibrée:', error);
        res.status(500).json({ 
            overallConfidence: 0.20,
            scoringExplanation: "**Erreur système** (20%) - Impossible de terminer l'analyse.",
            keywords: [],
            sources: [],
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ========== ENDPOINTS EMAIL ==========

app.post('/subscribe', async (req, res) => {
    try {
        const { email, name, source } = req.body;
        
        if (!email || !validateEmail(email)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email invalide' 
            });
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
                    return res.json({ 
                        success: true, 
                        message: 'Réabonnement réussi',
                        alreadySubscribed: false
                    });
                }
                
                console.log(`📧 Déjà abonné: ${sanitizedEmail}`);
                return res.json({ 
                    success: true, 
                    message: 'Déjà abonné',
                    alreadySubscribed: true
                });
            }
            
            await client.query(
                'INSERT INTO email_subscribers(email, name, source) VALUES($1, $2, $3)',
                [sanitizedEmail, sanitizedName, subscriptionSource]
            );
            
            console.log(`📧 Nouvel abonné: ${sanitizedEmail} (${subscriptionSource})`);
            
            res.json({ 
                success: true, 
                message: 'Abonnement réussi',
                alreadySubscribed: false
            });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('❌ Erreur abonnement:', err);
        res.status(500).json({ 
            success: false, 
            error: 'Erreur serveur' 
        });
    }
});

app.post('/unsubscribe', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email || !validateEmail(email)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email invalide' 
            });
        }
        
        const sanitizedEmail = sanitizeInput(email).toLowerCase().trim();
        
        const client = await pool.connect();
        
        try {
            const result = await client.query(
                'UPDATE email_subscribers SET subscribed = false, updated_at = NOW() WHERE email = $1',
                [sanitizedEmail]
            );
            
            if (result.rowCount === 0) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Email non trouvé' 
                });
            }
            
            console.log(`📧 Désabonnement: ${sanitizedEmail}`);
            
            res.json({ 
                success: true, 
                message: 'Désabonnement réussi' 
            });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('❌ Erreur désabonnement:', err);
        res.status(500).json({ 
            success: false, 
            error: 'Erreur serveur' 
        });
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
            
            const recentResult = await client.query(
                'SELECT COUNT(*) as recent FROM email_subscribers WHERE subscribed = true AND created_at > NOW() - INTERVAL \'7 days\''
            );
            
            res.json({
                total: parseInt(totalResult.rows[0].total),
                bySources: sourceResult.rows,
                lastWeek: parseInt(recentResult.rows[0].recent)
            });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('❌ Erreur stats:', err);
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
            
            res.json({
                count: result.rows.length,
                subscribers: result.rows
            });
            
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('❌ Erreur export:', err);
        res.status(500).json({ error: 'Erreur serveur' });
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
            
            if (userEmail && validateEmail(userEmail)) {
                const sanitizedEmail = sanitizeInput(userEmail).toLowerCase().trim();
                
                const existingUser = await client.query(
                    'SELECT id FROM email_subscribers WHERE email = $1',
                    [sanitizedEmail]
                );
                
                if (existingUser.rows.length === 0) {
                    await client.query(
                        'INSERT INTO email_subscribers(email, source) VALUES($1, $2) ON CONFLICT DO NOTHING',
                        [sanitizedEmail, 'feedback']
                    );
                    console.log(`📧 Nouvel abonné via feedback: ${sanitizedEmail}`);
                }
            }
            
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
        version: 'OPTIMIZED-FACTCHECKER-V2.0',
        features: [
            'optimized_scoring', 
            'reliable_algorithm',
            'contextual_analysis', 
            'intelligent_contradictions', 
            'source_verification',
            'email_capture',
            'subscriber_management'
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
            CREATE INDEX IF NOT EXISTS idx_email_subscribers_email ON email_subscribers(email);
            CREATE INDEX IF NOT EXISTS idx_email_subscribers_subscribed ON email_subscribers(subscribed);
        `);
        
        client.release();
        console.log('✅ Database ready');
    } catch (err) {
        console.error('❌ Database error:', err.message);
    }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 === VERIFYAI OPTIMIZED SERVER V2.0 ===`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔑 Google API: ${!!process.env.GOOGLE_API_KEY ? 'Configured' : 'Missing'}`);
    console.log(`💾 Database: ${!!process.env.DATABASE_URL ? 'Connected' : 'Missing'}`);
    console.log(`⚡ Features: Optimized scoring V2.0, Email management`);
    console.log(`============================================\n`);
    initDb();
});
