// Compatible Node 18+ (fetch natif) et fallback dynamique pour older envs
const fetch = globalThis.fetch || (async (...args) =>
  (await import('node-fetch')).default(...args)
);
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createHash } = require('crypto');

const isProduction = process.env.NODE_ENV === 'production';
const startupWarnings = [];

let chalkModule = null;
try {
    chalkModule = require('chalk');
} catch (err) {
    if (!isProduction) {
        startupWarnings.push('Chalk non disponible — logs sans couleurs.');
    }
}
const chalk = !isProduction && chalkModule ? chalkModule : null;

let rateLimit;
try {
    rateLimit = require('express-rate-limit');
} catch (err) {
    startupWarnings.push('express-rate-limit non disponible — utilisation d\'un limiteur interne.');
    rateLimit = (options = {}) => {
        const windowMs = options.windowMs || 60 * 1000;
        const max = options.max || 30;
        const hits = new Map();
        return (req, res, next) => {
            const now = Date.now();
            const key = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'global';
            const record = hits.get(key) || { count: 0, reset: now + windowMs };
            if (now >= record.reset) {
                record.count = 0;
                record.reset = now + windowMs;
            }
            record.count += 1;
            hits.set(key, record);
            if (record.count > max) {
                res.status(429).json({ error: 'Too many requests' });
                return;
            }
            next();
        };
    };
}

let NodeCacheModule;
try {
    NodeCacheModule = require('node-cache');
} catch (err) {
    startupWarnings.push('node-cache non disponible — utilisation d\'un cache Map interne.');
    NodeCacheModule = class {
        constructor(options = {}) {
            this.store = new Map();
            this.stdTTL = (options.stdTTL || 0) * 1000;
        }
        set(key, value) {
            const expires = this.stdTTL ? Date.now() + this.stdTTL : null;
            this.store.set(key, { value, expires });
            return true;
        }
        get(key) {
            const entry = this.store.get(key);
            if (!entry) return undefined;
            if (entry.expires && entry.expires < Date.now()) {
                this.store.delete(key);
                return undefined;
            }
            return entry.value;
        }
        del(key) {
            this.store.delete(key);
        }
        keys() {
            const now = Date.now();
            const keys = [];
            for (const [key, entry] of this.store.entries()) {
                if (entry.expires && entry.expires < now) {
                    this.store.delete(key);
                    continue;
                }
                keys.push(key);
            }
            return keys;
        }
    };
}

let stringSimilarityModule;
try {
    stringSimilarityModule = require('string-similarity');
} catch (err) {
    startupWarnings.push('string-similarity non disponible — comparaison textuelle simplifiée.');
    stringSimilarityModule = {
        compareTwoStrings: (a = '', b = '') => {
            if (!a || !b) return 0;
            const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
            const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
            const intersection = [...wordsA].filter(word => wordsB.has(word)).length;
            const union = new Set([...wordsA, ...wordsB]).size || 1;
            return intersection / union;
        }
    };
}

const stringSimilarity = stringSimilarityModule;
const NodeCache = NodeCacheModule;

const colorize = (color, message) => {
    if (!chalk) return message;
    if (typeof chalk[color] === 'function') {
        return chalk[color](message);
    }
    return message;
};

// === SECURITY & LOGGING === // [IMPROVED]
const secretValues = [process.env.GOOGLE_API_KEY, process.env.DATABASE_URL].filter(value => typeof value === 'string' && value.length > 0); // [IMPROVED]
const sanitizeLogOutput = (input) => { // [IMPROVED]
    if (!input) { // [IMPROVED]
        return input; // [IMPROVED]
    } // [IMPROVED]
    let output = typeof input === 'string' ? input : JSON.stringify(input); // [IMPROVED]
    for (const secret of secretValues) { // [IMPROVED]
        output = output.split(secret).join('[HIDDEN]'); // [IMPROVED]
    } // [IMPROVED]
    return output; // [IMPROVED]
}; // [IMPROVED]

const logInfo = (message) => { // [IMPROVED]
    if (!isProduction) { // [IMPROVED]
        console.log(colorize('cyan', sanitizeLogOutput(message))); // [IMPROVED]
    } // [IMPROVED]
}; // [IMPROVED]

const logWarn = (message) => { // [IMPROVED]
    if (!isProduction) { // [IMPROVED]
        console.warn(colorize('yellow', sanitizeLogOutput(message))); // [IMPROVED]
    } // [IMPROVED]
}; // [IMPROVED]

const logError = (message, error) => { // [IMPROVED]
    if (!isProduction) { // [IMPROVED]
        const fullMessage = error ? `${sanitizeLogOutput(message)}: ${sanitizeLogOutput(error)}` : sanitizeLogOutput(message); // [IMPROVED]
        console.error(colorize('red', fullMessage)); // [IMPROVED]
    } // [IMPROVED]
}; // [IMPROVED]

startupWarnings.forEach(message => logWarn(message));

const app = express();

const CACHE_TTL_SECONDS = 300;
const MAX_CACHE_ENTRIES = 200;
const CACHE_CHECK_PERIOD_SECONDS = 60;

const createVerificationCache = () => {
    const baseCache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS, checkperiod: CACHE_CHECK_PERIOD_SECONDS });
    const entryOrder = new Map();

    const cleanup = () => {
        const activeKeys = typeof baseCache.keys === 'function' ? baseCache.keys() : Array.from(entryOrder.keys());
        const activeSet = new Set(activeKeys);

        for (const key of entryOrder.keys()) {
            if (!activeSet.has(key)) {
                entryOrder.delete(key);
            }
        }

        let overflow = activeKeys.length - MAX_CACHE_ENTRIES;
        if (overflow <= 0) {
            return;
        }

        const orderedEntries = [...entryOrder.entries()].sort((a, b) => a[1] - b[1]);
        for (const [key] of orderedEntries) {
            if (overflow <= 0) {
                break;
            }
            baseCache.del(key);
            entryOrder.delete(key);
            overflow -= 1;
        }
    };

    return {
        get(key) {
            const value = baseCache.get(key);
            if (value === undefined) {
                entryOrder.delete(key);
            }
            return value;
        },
        set(key, value) {
            baseCache.set(key, value);
            entryOrder.set(key, Date.now());
            cleanup();
        },
        del(key) {
            baseCache.del(key);
            entryOrder.delete(key);
        }
    };
};

const verificationCache = createVerificationCache();
const metrics = {
    totalRequests: 0,
    cacheHits: 0,
    startedAt: Date.now()
};

// === GOOGLE API OPTIMIZATION === // [IMPROVED]
const GOOGLE_CACHE_TTL_MS = 2 * 60 * 1000; // [IMPROVED]
const googleSearchCache = new Map(); // [IMPROVED]
const trustedDomains = ['.edu', '.gov', '.org', 'bbc.com', 'reuters.com', 'lemonde.fr', 'wikipedia.org', 'who.int', 'nature.com', 'science.org']; // [IMPROVED]
const lowTrustDomains = ['reddit', 'forum', 'quora']; // [IMPROVED]
const fallbackTrustedSources = [ // [IMPROVED]
    { title: 'Wikipedia - Informations vérifiées', url: 'https://fr.wikipedia.org', snippet: 'Base encyclopédique fiable.', query_used: 'fallback', domainQuality: 0.75, relevance: 0.65 }, // [IMPROVED]
    { title: 'WHO - Organisation mondiale de la Santé', url: 'https://www.who.int', snippet: 'Données de santé officielles.', query_used: 'fallback', domainQuality: 0.95, relevance: 0.7 }, // [IMPROVED]
    { title: 'Reuters - Actualités internationales', url: 'https://www.reuters.com', snippet: 'Couverture journalistique mondiale.', query_used: 'fallback', domainQuality: 0.9, relevance: 0.68 } // [IMPROVED]
]; // [IMPROVED]

const getCachedGoogleResults = (query) => { // [IMPROVED]
    const entry = googleSearchCache.get(query); // [IMPROVED]
    if (!entry) { // [IMPROVED]
        return null; // [IMPROVED]
    } // [IMPROVED]
    if (Date.now() - entry.timestamp > GOOGLE_CACHE_TTL_MS) { // [IMPROVED]
        googleSearchCache.delete(query); // [IMPROVED]
        return null; // [IMPROVED]
    } // [IMPROVED]
    return entry.data; // [IMPROVED]
}; // [IMPROVED]

const setCachedGoogleResults = (query, data) => { // [IMPROVED]
    googleSearchCache.set(query, { data, timestamp: Date.now() }); // [IMPROVED]
}; // [IMPROVED]

const MAX_TEXT_LENGTH = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1MB
const FETCH_TIMEOUT_MS = 7000;
const MAX_API_DELAY_MS = 200;

// Configuration CORS
const allowedOrigins = [
    /^chrome-extension:\/\/.+/,
    /^http:\/\/localhost:\d+$/,
    /^https:\/\/localhost:\d+$/,
    'https://fact-checker-ia-production.up.railway.app'
];

const isAllowedOrigin = (value) => { // [IMPROVED]
    if (!value) { // [IMPROVED]
        return false; // [IMPROVED]
    } // [IMPROVED]
    return allowedOrigins.some(allowed => { // [IMPROVED]
        if (allowed instanceof RegExp) { // [IMPROVED]
            return allowed.test(value); // [IMPROVED]
        } // [IMPROVED]
        if (typeof allowed === 'string' && allowed.endsWith('*')) { // [IMPROVED]
            const base = allowed.slice(0, -1); // [IMPROVED]
            return value.startsWith(base); // [IMPROVED]
        } // [IMPROVED]
        return value === allowed; // [IMPROVED]
    }); // [IMPROVED]
}; // [IMPROVED]

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) {
            return callback(new Error('Not allowed by CORS')); // [IMPROVED]
        }

        if (isAllowedOrigin(origin)) { // [IMPROVED]
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS')); // [IMPROVED]
        }
    },
    credentials: true
}));

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
});

app.use(limiter);
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => { // [IMPROVED]
    const originHeader = req.headers.origin || ''; // [IMPROVED]
    const refererHeader = req.headers.referer || ''; // [IMPROVED]
    let refererOrigin = ''; // [IMPROVED]
    if (refererHeader) { // [IMPROVED]
        try { // [IMPROVED]
            refererOrigin = new URL(refererHeader).origin; // [IMPROVED]
        } catch (err) { // [IMPROVED]
            refererOrigin = ''; // [IMPROVED]
        } // [IMPROVED]
    } // [IMPROVED]

    const hasValidOrigin = isAllowedOrigin(originHeader); // [IMPROVED]
    const hasValidReferer = isAllowedOrigin(refererHeader) || isAllowedOrigin(refererOrigin); // [IMPROVED]

    if (!hasValidOrigin && !hasValidReferer) { // [IMPROVED]
        return res.status(403).json({ error: 'Forbidden: missing valid origin or referer.' }); // [IMPROVED]
    } // [IMPROVED]

    next(); // [IMPROVED]
}); // [IMPROVED]

app.use((req, res, next) => {
    metrics.totalRequests += 1;
    next();
});

// Database
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    })
  : null;

// ========== SYSTÈME DE FACT-CHECKING AMÉLIORÉ ET FIABLE ==========

class ImprovedFactChecker {
    constructor() {
        this.sourceCredibilityRanks = {
            tier1: { 
                domains: ['edu', 'gov', 'who.int', 'nature.com', 'science.org', 'pubmed.ncbi.nlm.nih.gov', 'insee.fr', 'cia.gov', 'worldbank.org'],
                multiplier: 1.0,
                description: 'Sources académiques et officielles'
            },
            tier2: { 
                domains: ['reuters.com', 'bbc.com', 'lemonde.fr', 'nytimes.com', 'theguardian.com', 'lefigaro.fr', 'economist.com'],
                multiplier: 0.85,
                description: 'Médias avec processus éditorial rigoureux'
            },
            tier3: { 
                domains: ['wikipedia.org', 'britannica.com', 'larousse.fr'],
                multiplier: 0.75,
                description: 'Encyclopédies avec vérification communautaire'
            },
            tier4: { 
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

        // Contextes pour éviter les fausses contradictions
        this.contextPatterns = {
            geographic: {
                city: /\b(ville|city proper|intra.?muros|centre.?ville|downtown)\b/i,
                metro: /\b(métropole|metropolitan|agglomération|agglomeration|urban area|greater)\b/i,
                region: /\b(région|region|area|zone|territoire|territory)\b/i
            },
            temporal: {
                current: /\b(2024|2025|actuellement|currently|now|today)\b/i,
                historical: /\b(19\d{2}|20[01]\d|historiquement|historically|était|was)\b/i
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

        // Claims historiques
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

        logInfo(`🔍 Claims extraits: ${claims.length}`);
        return claims;
    }

    // 2. ANALYSE DU TYPE DE CONTENU - VERSION AMÉLIORÉE
    analyzeContentType(text, claims) {
        const lower = text.toLowerCase();
        
        // Opinion subjective
        const opinionPatterns = [
            /\b(je pense|je crois|à mon avis|personnellement|subjectivement)\b/i,
            /\b(i think|i believe|in my opinion|personally|subjectively)\b/i,
            /\b(meilleur|pire|préfère|favorite|best|worst|better than|worse than)\b/i
        ];
        
        if (opinionPatterns.some(pattern => pattern.test(text))) {
            return {
                type: 'OPINION',
                baseScore: 0.40,
                reasoning: '**Opinion subjective** (40%) - Point de vue personnel nécessitant d\'autres perspectives.'
            };
        }

        // Question directe
        if (text.length < 300 && (/^(what|how|why|when|where|qui|quoi|comment|pourquoi|quand|où)/i.test(text.trim()) || text.includes('?'))) {
            return {
                type: 'QUESTION',
                baseScore: 0.30,
                reasoning: '**Question utilisateur** (30%) - Demande d\'information directe.'
            };
        }

        // Faits avec claims vérifiables
        if (claims.length > 0) {
            const hasScientific = claims.some(c => c.type === 'SCIENTIFIC');
            const hasQuantitative = claims.some(c => c.type === 'QUANTITATIVE');
            const hasHistorical = claims.some(c => c.type === 'HISTORICAL');
            const hasGeographic = claims.some(c => c.type === 'GEOGRAPHIC');
            
            if (hasScientific) {
                return {
                    type: 'SCIENTIFIC_FACT',
                    baseScore: 0.75,
                    reasoning: '**Fait scientifique** (75%) - Information scientifique établie et vérifiable.'
                };
            } else if (hasGeographic) {
                return {
                    type: 'GEOGRAPHIC_FACT',
                    baseScore: 0.70,
                    reasoning: '**Fait géographique** (70%) - Données géographiques officielles vérifiables.'
                };
            } else if (hasQuantitative) {
                return {
                    type: 'STATISTICAL_FACT',
                    baseScore: 0.65,
                    reasoning: '**Données quantitatives** (65%) - Statistiques mesurables et vérifiables.'
                };
            } else if (hasHistorical) {
                return {
                    type: 'HISTORICAL_FACT',
                    baseScore: 0.68,
                    reasoning: '**Fait historique** (68%) - Information historique documentée.'
                };
            }
        }

        // Information générale
        return {
            type: 'GENERAL_INFO',
            baseScore: 0.50,
            reasoning: '**Information générale** (50%) - Contenu informatif standard.'
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
                hasTotal: /\b(total|ensemble|including|avec|with)\b/i.test(text),
                hasPartial: /\b(seulement|only|just|environ|approximately|about)\b/i.test(text)
            }
        };
    }

    // 4. VÉRIFICATION DE CONTEXTES COMPLÉMENTAIRES
    areComplementaryContexts(context1, context2) {
        // Ville vs Métropole = complémentaires
        if ((context1.geographic.hasCity && context2.geographic.hasMetro) ||
            (context1.geographic.hasMetro && context2.geographic.hasCity)) {
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

    // 6. DÉTECTION DE CONTRADICTIONS INTELLIGENTE
    detectIntelligentContradiction(text1, text2) {
        const context1 = this.extractDetailedContext(text1);
        const context2 = this.extractDetailedContext(text2);
        
        // Si contextes complémentaires, pas de contradiction
        if (this.areComplementaryContexts(context1, context2)) {
            return { 
                detected: false, 
                details: { 
                    reason: 'Contextes complémentaires',
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

        // Comparaison intelligente
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
                                reason: 'Contradiction numérique significative'
                            }
                        };
                    }
                }
            }
        }

        return { detected: false, details: null };
    }

    // 7. VÉRIFICATION DE VRAIE CONTRADICTION
    isTrueContradiction(num1, num2, context1, context2) {
        if (JSON.stringify(context1) === JSON.stringify(context2)) {
            return true;
        }
        
        if (this.areComplementaryContexts(context1, context2)) {
            return false;
        }
        
        return Math.abs(num1.value - num2.value) / num1.value > 3.0;
    }

    // 8. ÉVALUATION DE LA QUALITÉ DES SOURCES
    evaluateSourceQuality(sources) {
        if (sources.length === 0) {
            return {
                impact: -0.10,
                confidence: 0,
                reasoning: 'Aucune source de vérification trouvée (-10%).'
            };
        }

        let qualityScore = 0;
        let supportingHigh = sources.filter(s => s.actuallySupports && s.credibilityMultiplier > 0.8).length;
        let supportingAny = sources.filter(s => s.actuallySupports).length;
        let contradictingHigh = sources.filter(s => s.contradicts && s.credibilityMultiplier > 0.8).length;

        // Bonus pour sources de support
        if (supportingHigh > 0) {
            qualityScore += supportingHigh * 0.15;
        } else if (supportingAny > 0) {
            qualityScore += supportingAny * 0.08;
        }

        // Pénalité pour vraies contradictions seulement
        if (contradictingHigh > 0) {
            qualityScore -= contradictingHigh * 0.08;
        }

        // Bonus progressif pour sources multiples
        if (sources.length >= 3) {
            qualityScore += 0.05;
        }

        // Bonus spécial pour sources très fiables
        const tier1Sources = sources.filter(s => s.credibilityMultiplier === 1.0).length;
        if (tier1Sources > 0) {
            qualityScore += tier1Sources * 0.08;
        }

        let reasoning = `Sources analysées: ${supportingAny} confirment`;
        if (contradictingHigh > 0) {
            reasoning += `, ${contradictingHigh} contredisent vraiment`;
        }
        if (supportingHigh > 0) {
            reasoning += `. ${supportingHigh} sources très fiables confirment (+${supportingHigh * 15}%).`;
        }

        return {
            impact: Math.max(-0.15, Math.min(0.30, qualityScore)),
            confidence: Math.min(0.4, sources.length * 0.1),
            reasoning
        };
    }

    // 9. ÉVALUATION DU CONSENSUS
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
            bonus = -0.06;
            reasoning = `Contradictions dominantes: ${contradicting}/${total} sources contredisent (-6%).`;
        } else {
            reasoning = `Pas de consensus clair: sources partagées.`;
        }

        return {
            bonus: Math.max(-0.10, Math.min(0.15, bonus)),
            confidence: Math.min(0.25, total * 0.06),
            reasoning
        };
    }

    // 10. COHÉRENCE CONTEXTUELLE
    evaluateContextualCoherence(originalText, sources) {
        if (sources.length === 0) return { bonus: 0, reasoning: '' };

        let coherenceScore = 0;
        
        // Bonus pour diversité de sources
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

        // Bonus pour mix de types de sources
        const hasTier1 = sources.some(s => s.credibilityTier === 'tier1');
        const hasTier2 = sources.some(s => s.credibilityTier === 'tier2');
        const hasTier3 = sources.some(s => s.credibilityTier === 'tier3');
        
        if ((hasTier1 && hasTier2) || (hasTier1 && hasTier3) || (hasTier2 && hasTier3)) {
            coherenceScore += 0.04;
        }

        // Bonus pour sources récentes
        const hasRecentSources = sources.some(s => 
            s.snippet && /202[3-5]|recent|latest|current/i.test(s.snippet)
        );
        
        if (hasRecentSources && /population|data|statistics|facts/i.test(originalText)) {
            coherenceScore += 0.03;
        }

        let reasoning = '';
        if (coherenceScore > 0) {
            reasoning = `Cohérence contextuelle: sources diversifiées (+${Math.round(coherenceScore * 100)}%).`;
        }

        return {
            bonus: coherenceScore,
            reasoning: reasoning
        };
    }

    // === IMPROVED SCORING SYSTEM === // [IMPROVED]
    // 11. CALCUL FINAL ÉQUILIBRÉ
    calculateBalancedScore(originalText, analyzedSources, claims) {
        let totalScore = 0; // [IMPROVED]
        let confidence = 0; // [IMPROVED]
        const reasoning = []; // [IMPROVED]

        logInfo(`🎯 Calcul du score équilibré...`); // [IMPROVED]

        const claimWeights = { // [IMPROVED]
            SCIENTIFIC: 1.2, // [IMPROVED]
            HISTORICAL: 1.0, // [IMPROVED]
            QUANTITATIVE: 0.9, // [IMPROVED]
            GEOGRAPHIC: 0.8 // [IMPROVED]
        }; // [IMPROVED]

        // 1. Score de base
        const contentType = this.analyzeContentType(originalText, claims); // [IMPROVED]
        totalScore += contentType.baseScore; // [IMPROVED]
        reasoning.push(contentType.reasoning); // [IMPROVED]
        confidence += 0.3; // [IMPROVED]

        // 2. Qualité des sources
        const sourceEval = this.evaluateSourceQuality(analyzedSources); // [IMPROVED]
        totalScore += sourceEval.impact; // [IMPROVED]
        reasoning.push(sourceEval.reasoning); // [IMPROVED]
        confidence += sourceEval.confidence; // [IMPROVED]

        // 3. Consensus
        const consensus = this.evaluateConsensus(analyzedSources); // [IMPROVED]
        totalScore += consensus.bonus; // [IMPROVED]
        if (consensus.reasoning) { // [IMPROVED]
            reasoning.push(consensus.reasoning); // [IMPROVED]
        } // [IMPROVED]
        confidence += consensus.confidence; // [IMPROVED]

        // 4. Cohérence contextuelle
        const contextBonus = this.evaluateContextualCoherence(originalText, analyzedSources); // [IMPROVED]
        totalScore += contextBonus.bonus; // [IMPROVED]
        if (contextBonus.reasoning) { // [IMPROVED]
            reasoning.push(contextBonus.reasoning); // [IMPROVED]
        } // [IMPROVED]

        const relevanceScores = analyzedSources.map(source => typeof source.semanticRelevance === 'number' ? source.semanticRelevance : 0); // [IMPROVED]
        const meanRelevance = relevanceScores.length > 0 ? relevanceScores.reduce((sum, value) => sum + value, 0) / relevanceScores.length : 0; // [IMPROVED]
        const variance = relevanceScores.length > 1 ? relevanceScores.reduce((sum, value) => sum + Math.pow(value - meanRelevance, 2), 0) / relevanceScores.length : 0; // [IMPROVED]
        const varianceAdjustment = variance < 0.04 ? 0.03 : -0.03; // [IMPROVED]
        totalScore += varianceAdjustment; // [IMPROVED]
        if (variance < 0.04) { // [IMPROVED]
            reasoning.push('Variance faible entre les sources (+3%).'); // [IMPROVED]
        } else { // [IMPROVED]
            reasoning.push('Variance élevée entre les sources (-3%).'); // [IMPROVED]
        } // [IMPROVED]

        const hasRecentSources = analyzedSources.some(source => source.containsRecentSignals); // [IMPROVED]
        const hasOlderSources = analyzedSources.some(source => source.containsOlderSignals); // [IMPROVED]
        let freshnessAdjustment = 0; // [IMPROVED]
        if (hasRecentSources) { // [IMPROVED]
            freshnessAdjustment += 0.03; // [IMPROVED]
        } // [IMPROVED]
        if (hasOlderSources) { // [IMPROVED]
            freshnessAdjustment -= 0.02; // [IMPROVED]
        } // [IMPROVED]
        if (freshnessAdjustment !== 0) { // [IMPROVED]
            totalScore += freshnessAdjustment; // [IMPROVED]
            reasoning.push(freshnessAdjustment > 0 ? 'Sources récentes détectées (+3%).' : 'Sources datées détectées (-2%).'); // [IMPROVED]
        } // [IMPROVED]

        const weightFactor = claims.length > 0
            ? Math.max(0.7, Math.min(1.25, claims.reduce((sum, claim) => sum + (claimWeights[claim.type] || 1), 0) / claims.length))
            : 1; // [IMPROVED]
        if (claims.length > 0 && weightFactor !== 1) { // [IMPROVED]
            reasoning.push(`Pondération des claims appliquée (${weightFactor.toFixed(2)}x).`); // [IMPROVED]
        } // [IMPROVED]

        const trustedSupportCount = analyzedSources.filter(source => source.actuallySupports && ['tier1', 'tier2'].includes(source.credibilityTier)).length; // [IMPROVED]
        const trustedBonus = Math.min(0.05, trustedSupportCount * 0.02); // [IMPROVED]
        if (trustedBonus > 0) { // [IMPROVED]
            totalScore += trustedBonus; // [IMPROVED]
            reasoning.push('Multiples sources hautement crédibles confirment (+5% max).'); // [IMPROVED]
        } // [IMPROVED]

        totalScore *= weightFactor; // [IMPROVED]

        const finalScore = Math.max(0.2, Math.min(0.9, totalScore)); // [IMPROVED]

        logInfo(`📊 Score équilibré: ${Math.round(finalScore * 100)}%`); // [IMPROVED]

        const scoringBreakdown = { // [IMPROVED]
            base: Number(contentType.baseScore.toFixed(2)), // [IMPROVED]
            sources: Number(sourceEval.impact.toFixed(2)), // [IMPROVED]
            consensus: Number(consensus.bonus.toFixed(2)), // [IMPROVED]
            context: Number(contextBonus.bonus.toFixed(2)), // [IMPROVED]
            variance: Number(varianceAdjustment.toFixed(2)), // [IMPROVED]
            freshness: Number(freshnessAdjustment.toFixed(2)), // [IMPROVED]
            claimsWeight: Number(weightFactor.toFixed(2)), // [IMPROVED]
            trustedSourcesBonus: Number(trustedBonus.toFixed(2)), // [IMPROVED]
            final: Number(finalScore.toFixed(2)) // [IMPROVED]
        }; // [IMPROVED]

        const reliableSources = analyzedSources.filter(source => source.sourceQuality >= 0.75); // [IMPROVED]
        const supporters = analyzedSources.filter(source => source.actuallySupports).length; // [IMPROVED]
        const consensusLabel = supporters >= Math.max(2, Math.ceil(analyzedSources.length * 0.6)) ? 'consensus fort' : supporters > 0 ? 'consensus modéré' : 'consensus limité'; // [IMPROVED]
        const temporalLabel = freshnessAdjustment > 0 ? 'cohérence temporelle élevée' : freshnessAdjustment < 0 ? 'cohérence temporelle à surveiller' : 'cohérence temporelle stable'; // [IMPROVED]
        const summaryText = `${reliableSources.length} sources fiables ${supporters > 0 ? 'confirment les données' : 'analysées'}, ${consensusLabel} et ${temporalLabel}.`; // [IMPROVED]

        return {
            score: finalScore,
            confidence: Math.min(1.0, confidence + trustedBonus), // [IMPROVED]
            reasoning: reasoning.join(' '),
            details: {
                baseScore: contentType.baseScore,
                sourceImpact: sourceEval.impact,
                consensusBonus: consensus.bonus,
                contextBonus: contextBonus.bonus,
                variance: variance,
                claimsFound: claims.length,
                sourcesAnalyzed: analyzedSources.length,
                supportingSources: supporters,
                contradictingSources: analyzedSources.filter(s => s.contradicts).length,
                contentType: contentType.type,
                trustedSupportCount: trustedSupportCount // [IMPROVED]
            },
            breakdown: scoringBreakdown, // [IMPROVED]
            summaryText // [IMPROVED]
        };
    }

    // MÉTHODES UTILITAIRES

    calculateSemanticSimilarity(text1, text2) {
        if (!text1 || !text2) return { score: 0, confirms: false };
        
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

        const lexicalSimilarity = union.size > 0 ? intersection.size / union.size : 0;
        const semanticSimilarity = stringSimilarity.compareTwoStrings(
            sanitizeInput(text1).toLowerCase(),
            sanitizeInput(text2).toLowerCase()
        );

        const combinedScore = Math.min(1, (lexicalSimilarity * 0.6) + (semanticSimilarity * 0.4));

        return {
            score: combinedScore,
            confirms: combinedScore > 0.2
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

const escapeHtml = (value = '') => String(value) // [IMPROVED]
    .replace(/&/g, '&amp;') // [IMPROVED]
    .replace(/</g, '&lt;') // [IMPROVED]
    .replace(/>/g, '&gt;') // [IMPROVED]
    .replace(/"/g, '&quot;') // [IMPROVED]
    .replace(/'/g, '&#39;'); // [IMPROVED]

// === SOURCE ENRICHMENT === // [IMPROVED]
async function analyzeSourcesWithImprovedLogic(factChecker, originalText, sources) {
    const analyzedSources = [];

    for (const source of sources.slice(0, 5)) {
        try {
            const credibility = factChecker.getSourceCredibilityTier(source.url);
            const semanticMatch = factChecker.calculateSemanticSimilarity(originalText, source.snippet || '');
            const contradiction = factChecker.detectIntelligentContradiction(originalText, source.snippet || '');
            const domainReliability = computeDomainReliabilityScore(source.url); // [IMPROVED]
            const combinedQuality = Math.max(0.1, Math.min(1, ((source.domainQuality || domainReliability.quality) + credibility.multiplier) / 2)); // [IMPROVED]
            const hasRecentYear = /(202[3-5])/i.test(`${source.title || ''} ${source.snippet || ''}`); // [IMPROVED]
            const hasOlderYear = /(201[0-8])/i.test(`${source.title || ''} ${source.snippet || ''}`); // [IMPROVED]
            const safeTitle = (source.title || 'Source'); // [IMPROVED]
            const safeUrl = source.url || ''; // [IMPROVED]
            const anchorTitle = escapeHtml(safeTitle); // [IMPROVED]
            const safeHref = safeUrl.replace(/'/g, '%27'); // [IMPROVED]
            const clickable = safeUrl ? `<a href='${safeHref}' target='_blank' rel='noopener noreferrer'>${anchorTitle}</a>` : anchorTitle; // [IMPROVED]

            const actuallySupports = semanticMatch.confirms && !contradiction.detected && semanticMatch.score > 0.15;

            analyzedSources.push({
                ...source,
                semanticRelevance: semanticMatch.score,
                confirmsContent: semanticMatch.confirms,
                contradicts: contradiction.detected,
                contradictionDetails: contradiction.details,
                credibilityTier: credibility.tier,
                credibilityMultiplier: credibility.multiplier,
                actuallySupports: actuallySupports,
                sourceQuality: Number(combinedQuality.toFixed(2)), // [IMPROVED]
                clickable, // [IMPROVED]
                containsRecentSignals: hasRecentYear, // [IMPROVED]
                containsOlderSignals: hasOlderYear // [IMPROVED]
            });

        } catch (error) {
            logError(`Erreur analyse source ${source.url}`, error.message);

            const credibility = factChecker.getSourceCredibilityTier(source.url);
            analyzedSources.push({
                ...source,
                semanticRelevance: 0.3,
                confirmsContent: false,
                contradicts: false,
                credibilityTier: credibility.tier,
                credibilityMultiplier: credibility.multiplier,
                actuallySupports: false,
                sourceQuality: Number(Math.max(0.1, Math.min(1, credibility.multiplier * 0.6)).toFixed(2)), // [IMPROVED]
                clickable: source.url ? `<a href='${source.url.replace(/'/g, '%27')}' target='_blank' rel='noopener noreferrer'>${escapeHtml(source.title || 'Source')}</a>` : escapeHtml(source.title || 'Source'), // [IMPROVED]
                containsRecentSignals: false, // [IMPROVED]
                containsOlderSignals: false // [IMPROVED]
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
        .substring(0, MAX_TEXT_LENGTH)
        .trim();
}

const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

function truncatePayload(value, maxStringLength, maxArrayLength, depth = 0) {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === 'string') {
        if (value.length > maxStringLength) {
            return `${value.slice(0, maxStringLength)}…`;
        }
        return value;
    }

    if (Array.isArray(value)) {
        const limit = Math.max(1, Math.floor(maxArrayLength / Math.max(depth || 1, 1)));
        return value.slice(0, limit).map(item => truncatePayload(item, maxStringLength, maxArrayLength, depth + 1));
    }

    if (typeof value === 'object') {
        const result = {};
        for (const [key, val] of Object.entries(value)) {
            result[key] = truncatePayload(val, maxStringLength, maxArrayLength, depth + 1);
        }
        return result;
    }

    return value;
}

function enforceResponseSize(payload) {
    const reductionSteps = [
        { maxString: 2000, maxArray: 20 },
        { maxString: 1000, maxArray: 10 },
        { maxString: 400, maxArray: 5 }
    ];

    for (const step of reductionSteps) {
        const truncated = truncatePayload(payload, step.maxString, step.maxArray);
        const size = Buffer.byteLength(JSON.stringify(truncated), 'utf8');
        if (size <= MAX_RESPONSE_BYTES) {
            return truncated;
        }
    }

    return {
        error: 'Response exceeded maximum size and was truncated.',
        truncated: true
    };
}

function sendSafeJson(res, payload) {
    res.json(enforceResponseSize(payload));
}

function createCacheKey(prefix, data) {
    return `${prefix}:${createHash('sha1').update(JSON.stringify(data)).digest('hex')}`;
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
        logError('Erreur extraction keywords', e.message);
        return [];
    }
}

const computeDomainReliabilityScore = (url = '') => { // [IMPROVED]
    const lowerUrl = url.toLowerCase(); // [IMPROVED]
    let bonus = 0; // [IMPROVED]
    let quality = 0.55; // [IMPROVED]
    if (!lowerUrl) { // [IMPROVED]
        return { bonus: -0.05, quality: 0.4 }; // [IMPROVED]
    } // [IMPROVED]

    for (const domain of trustedDomains) { // [IMPROVED]
        if (lowerUrl.includes(domain)) { // [IMPROVED]
            bonus += 0.18; // [IMPROVED]
            quality = Math.max(quality, 0.85); // [IMPROVED]
        } // [IMPROVED]
    } // [IMPROVED]

    if (lowerUrl.includes('.edu') || lowerUrl.endsWith('.edu/')) { // [IMPROVED]
        bonus += 0.1; // [IMPROVED]
        quality = Math.max(quality, 0.92); // [IMPROVED]
    } // [IMPROVED]
    if (lowerUrl.includes('.gov') || lowerUrl.endsWith('.gov/')) { // [IMPROVED]
        bonus += 0.12; // [IMPROVED]
        quality = Math.max(quality, 0.94); // [IMPROVED]
    } // [IMPROVED]

    if (lowTrustDomains.some(domain => lowerUrl.includes(domain))) { // [IMPROVED]
        bonus -= 0.25; // [IMPROVED]
        quality = Math.min(quality, 0.3); // [IMPROVED]
    } // [IMPROVED]

    return { bonus: Math.max(-0.35, Math.min(0.4, bonus)), quality: Math.max(0.1, Math.min(1, quality)) }; // [IMPROVED]
}; // [IMPROVED]

const computeTextualRelevanceScore = (reference, title, snippet) => { // [IMPROVED]
    if (!reference) { // [IMPROVED]
        return 0.1; // [IMPROVED]
    } // [IMPROVED]
    const sanitize = (text) => text.toLowerCase().replace(/[^a-z0-9à-ÿ\s]/gi, ' '); // [IMPROVED]
    const referenceWords = new Set(sanitize(reference).split(/\s+/).filter(word => word.length > 3)); // [IMPROVED]
    if (referenceWords.size === 0) { // [IMPROVED]
        return 0.1; // [IMPROVED]
    } // [IMPROVED]
    const combined = `${sanitize(title || '')} ${sanitize(snippet || '')}`; // [IMPROVED]
    let matches = 0; // [IMPROVED]
    for (const word of referenceWords) { // [IMPROVED]
        if (combined.includes(word)) { // [IMPROVED]
            matches += 1; // [IMPROVED]
        } // [IMPROVED]
    } // [IMPROVED]
    return Math.max(0.05, Math.min(1, matches / referenceWords.size)); // [IMPROVED]
}; // [IMPROVED]

const evaluateRelevanceScore = (result, originalText, query) => { // [IMPROVED]
    const { title, snippet, url } = result; // [IMPROVED]
    const queryScore = computeTextualRelevanceScore(query, title, snippet); // [IMPROVED]
    const contextScore = computeTextualRelevanceScore(originalText, title, snippet); // [IMPROVED]
    const domainReliability = computeDomainReliabilityScore(url); // [IMPROVED]
    let score = 0.2 + (queryScore * 0.45) + (contextScore * 0.25) + domainReliability.bonus; // [IMPROVED]
    score = Math.max(0.1, Math.min(1, score)); // [IMPROVED]
    return { score, domainReliability }; // [IMPROVED]
}; // [IMPROVED]

const deduplicateSources = (sources) => { // [IMPROVED]
    const unique = []; // [IMPROVED]
    for (const candidate of sources) { // [IMPROVED]
        const isDuplicate = unique.some(existing => { // [IMPROVED]
            if (existing.url && candidate.url && existing.url === candidate.url) { // [IMPROVED]
                return true; // [IMPROVED]
            } // [IMPROVED]
            const titleSimilarity = stringSimilarity.compareTwoStrings((existing.title || '').toLowerCase(), (candidate.title || '').toLowerCase()); // [IMPROVED]
            const snippetSimilarity = stringSimilarity.compareTwoStrings((existing.snippet || '').toLowerCase(), (candidate.snippet || '').toLowerCase()); // [IMPROVED]
            return titleSimilarity > 0.8 || snippetSimilarity > 0.8; // [IMPROVED]
        }); // [IMPROVED]
        if (!isDuplicate) { // [IMPROVED]
            unique.push(candidate); // [IMPROVED]
        } // [IMPROVED]
    } // [IMPROVED]
    return unique; // [IMPROVED]
}; // [IMPROVED]

const queryGoogleSearch = async (query, numResults = 4) => { // [IMPROVED]
    const cached = getCachedGoogleResults(query); // [IMPROVED]
    if (cached) { // [IMPROVED]
        return { items: cached, cacheHit: true }; // [IMPROVED]
    } // [IMPROVED]

    const retryDelays = [500, 1000, 2000]; // [IMPROVED]
    let lastError = null; // [IMPROVED]

    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) { // [IMPROVED]
        try { // [IMPROVED]
            const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(process.env.GOOGLE_API_KEY)}&cx=${encodeURIComponent(process.env.SEARCH_ENGINE_ID)}&q=${encodeURIComponent(query)}&num=${numResults}`; // [IMPROVED]
            const response = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS); // [IMPROVED]
            const data = await response.json(); // [IMPROVED]

            if (response.ok && Array.isArray(data.items)) { // [IMPROVED]
                setCachedGoogleResults(query, data.items); // [IMPROVED]
                return { items: data.items, cacheHit: false }; // [IMPROVED]
            } // [IMPROVED]

            if (response.status === 429 || response.status === 503) { // [IMPROVED]
                lastError = `HTTP_${response.status}`; // [IMPROVED]
                await delay(retryDelays[attempt]); // [IMPROVED]
                continue; // [IMPROVED]
            } // [IMPROVED]

            lastError = data?.error?.message || `HTTP_${response.status}`; // [IMPROVED]
            break; // [IMPROVED]
        } catch (error) { // [IMPROVED]
            lastError = error.message; // [IMPROVED]
            await delay(retryDelays[attempt]); // [IMPROVED]
        } // [IMPROVED]
    } // [IMPROVED]

    return { items: [], error: lastError || 'Google API temporarily unavailable' }; // [IMPROVED]
}; // [IMPROVED]

async function findWebSources(keywords, smartQueries, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        logWarn('API credentials manquantes - sources mock');
        return { sources: fallbackTrustedSources.slice(0, 3), error: 'Missing Google API credentials' }; // [IMPROVED]
    }

    let allSources = []; // [IMPROVED]
    let apiUnavailable = false; // [IMPROVED]

    if (smartQueries && smartQueries.length > 0) { // [IMPROVED]
        for (let index = 0; index < Math.min(2, smartQueries.length); index += 1) { // [IMPROVED]
            const query = smartQueries[index]; // [IMPROVED]
            const delayMs = Math.min(index * MAX_API_DELAY_MS, MAX_API_DELAY_MS); // [IMPROVED]
            if (delayMs > 0) { // [IMPROVED]
                await delay(delayMs); // [IMPROVED]
            } // [IMPROVED]
            const result = await queryGoogleSearch(query, 4); // [IMPROVED]
            if (Array.isArray(result.items) && result.items.length > 0) { // [IMPROVED]
                const mapped = result.items.map(item => { // [IMPROVED]
                    const sanitized = { // [IMPROVED]
                        title: item.title || 'Sans titre', // [IMPROVED]
                        url: item.link || '', // [IMPROVED]
                        snippet: item.snippet || 'Pas de description', // [IMPROVED]
                        query_used: query // [IMPROVED]
                    }; // [IMPROVED]
                    const relevanceData = evaluateRelevanceScore(sanitized, originalText, query); // [IMPROVED]
                    return { ...sanitized, relevance: relevanceData.score, domainQuality: relevanceData.domainReliability.quality }; // [IMPROVED]
                }); // [IMPROVED]
                allSources.push(...mapped); // [IMPROVED]
            } else if (result.error) { // [IMPROVED]
                apiUnavailable = true; // [IMPROVED]
                logWarn(`Google search temporary issue for query: ${sanitizeLogOutput(query)} (${result.error})`); // [IMPROVED]
            } // [IMPROVED]
        } // [IMPROVED]
    } // [IMPROVED]

    if (allSources.length < 2 && keywords.length > 0) { // [IMPROVED]
        const fallbackQuery = keywords.slice(0, 3).join(' '); // [IMPROVED]
        const result = await queryGoogleSearch(fallbackQuery, 5); // [IMPROVED]
        if (Array.isArray(result.items) && result.items.length > 0) { // [IMPROVED]
            const mapped = result.items.map(item => { // [IMPROVED]
                const sanitized = { // [IMPROVED]
                    title: item.title || 'Sans titre', // [IMPROVED]
                    url: item.link || '', // [IMPROVED]
                    snippet: item.snippet || 'Pas de description', // [IMPROVED]
                    query_used: fallbackQuery // [IMPROVED]
                }; // [IMPROVED]
                const relevanceData = evaluateRelevanceScore(sanitized, originalText, fallbackQuery); // [IMPROVED]
                return { ...sanitized, relevance: relevanceData.score, domainQuality: relevanceData.domainReliability.quality }; // [IMPROVED]
            }); // [IMPROVED]
            allSources.push(...mapped); // [IMPROVED]
        } else if (result.error) { // [IMPROVED]
            apiUnavailable = true; // [IMPROVED]
            logWarn(`Google fallback query failed: ${sanitizeLogOutput(result.error)}`); // [IMPROVED]
        } // [IMPROVED]
    } // [IMPROVED]

    if (allSources.length === 0 && apiUnavailable) { // [IMPROVED]
        return { error: 'Google API temporarily unavailable', sources: [] }; // [IMPROVED]
    } // [IMPROVED]

    const deduped = deduplicateSources(allSources); // [IMPROVED]
    deduped.sort((a, b) => b.relevance - a.relevance); // [IMPROVED]

    let finalSources = deduped.slice(0, 5); // [IMPROVED]
    if (finalSources.length < 3) { // [IMPROVED]
        const needed = 3 - finalSources.length; // [IMPROVED]
        finalSources = finalSources.concat(fallbackTrustedSources.slice(0, needed)); // [IMPROVED]
    } // [IMPROVED]

    finalSources = finalSources.slice(0, 5); // [IMPROVED]

    logInfo(`📋 ${finalSources.length} sources uniques trouvées`); // [IMPROVED]
    return { sources: finalSources }; // [IMPROVED]
}

function calculateRelevance(item, originalText) { // [IMPROVED]
    return evaluateRelevanceScore(item, originalText, item.query_used || ''); // [IMPROVED]
}

// ========== ENDPOINTS API ==========

// Endpoint principal avec système amélioré
app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType, forceRefresh } = req.body || {};

        const sanitizedInput = typeof text === 'string' ? text : '';
        logInfo(`\n🔍 === ANALYSE ÉQUILIBRÉE ===`);
        logInfo(`📝 Texte: "${sanitizedInput.substring(0, 80)}..."`);

        if (!sanitizedInput || sanitizedInput.length < 10) {
            return sendSafeJson(res, {
                overallConfidence: 0.25,
                scoringExplanation: "**Texte insuffisant** (25%) - Contenu trop court pour analyse.",
                keywords: [],
                sources: [],
                methodology: "Analyse équilibrée avec détection contextuelle"
            });
        }

        if (sanitizedInput.length > MAX_TEXT_LENGTH) {
            res.status(413);
            return sendSafeJson(res, {
                error: `Text length exceeds maximum of ${MAX_TEXT_LENGTH} characters.`
            });
        }

        const sanitizedSmartQueries = Array.isArray(smartQueries)
            ? smartQueries.map(query => sanitizeInput(query))
            : [];

        const cacheKey = createCacheKey('verify', {
            text: sanitizeInput(sanitizedInput),
            smartQueries: sanitizedSmartQueries,
            analysisType: typeof analysisType === 'string' ? sanitizeInput(analysisType) : ''
        });
        const bypassCache = forceRefresh === true;
        if (!bypassCache) {
            const cached = verificationCache.get(cacheKey);
            if (cached) {
                metrics.cacheHits += 1;
                return sendSafeJson(res, cached);
            }
        }

        const factChecker = new ImprovedFactChecker();

        const claims = factChecker.extractVerifiableClaims(sanitizedInput);
        const keywords = extractMainKeywords(sanitizedInput);
        const sourceResult = await findWebSources(keywords, sanitizedSmartQueries, sanitizedInput); // [IMPROVED]
        const sources = Array.isArray(sourceResult.sources) ? sourceResult.sources : []; // [IMPROVED]
        const analyzedSources = await analyzeSourcesWithImprovedLogic(factChecker, sanitizedInput, sources); // [IMPROVED]
        const result = factChecker.calculateBalancedScore(sanitizedInput, analyzedSources, claims); // [IMPROVED]
        const verifiedByMultipleTrustedSources = analyzedSources.filter(source => source.actuallySupports && source.sourceQuality >= 0.75).length >= 3; // [IMPROVED]

        const reliabilityLabel =
            result.score > 0.85 ? 'Highly Reliable' :
            result.score > 0.6 ? 'Mostly Reliable' :
            result.score > 0.4 ? 'Uncertain' :
            'Low Reliability';

        const response = {
            overallConfidence: result.score,
            confidence: result.confidence,
            scoringExplanation: result.reasoning,
            sources: analyzedSources,
            keywords,
            claimsAnalyzed: claims,
            details: result.details,
            methodology: "Analyse équilibrée avec détection contextuelle intelligente",
            reliabilityLabel,
            scoringBreakdown: result.breakdown, // [IMPROVED]
            summaryText: result.summaryText, // [IMPROVED]
            verifiedByMultipleTrustedSources, // [IMPROVED]
            sourceFetchError: sourceResult.error // [IMPROVED]
        };

        verificationCache.set(cacheKey, response);

        logInfo(`✅ Score équilibré: ${Math.round(result.score * 100)}% (confiance: ${Math.round(result.confidence * 100)}%)`);
        logInfo(`📊 ${analyzedSources.length} sources | ${claims.length} claims | ${analyzedSources.filter(s => s.actuallySupports).length} confirment`);
        logInfo(`===============================\n`);

        return sendSafeJson(res, response);

    } catch (error) {
        logError('❌ Erreur analyse équilibrée', error);
        res.status(500);
        return sendSafeJson(res, {
            overallConfidence: 0.20,
            scoringExplanation: "**Erreur système** (20%) - Impossible de terminer l'analyse.",
            keywords: [],
            sources: [],
            error: !isProduction ? error?.message : undefined
        });
    }
});

// Endpoint VerifyAI pour extension Chrome
app.post('/verify/ai', async (req, res) => {
    try {
        const { model, prompt, response: modelResponse, forceRefresh } = req.body || {};

        const allowedModels = ['ChatGPT', 'Claude', 'Gemini'];
        if (!allowedModels.includes(model)) {
            res.status(400);
            return sendSafeJson(res, {
                error: 'Invalid model specified. Allowed values: ChatGPT, Claude, Gemini.'
            });
        }

        const sanitizedPrompt = typeof prompt === 'string' ? sanitizeInput(prompt) : '';
        const sanitizedResponse = sanitizeInput(modelResponse);

        if (!sanitizedResponse || sanitizedResponse.length < 10) {
            res.status(400);
            return sendSafeJson(res, {
                error: 'Response text is required for verification.'
            });
        }

        if (sanitizedResponse.length > MAX_TEXT_LENGTH) {
            res.status(413);
            return sendSafeJson(res, {
                error: `Response text exceeds maximum of ${MAX_TEXT_LENGTH} characters.`
            });
        }

        const cacheKey = createCacheKey('verify_ai', {
            model,
            prompt: sanitizedPrompt,
            response: sanitizedResponse
        });
        const bypassCache = forceRefresh === true;
        if (!bypassCache) {
            const cached = verificationCache.get(cacheKey);
            if (cached) {
                metrics.cacheHits += 1;
                return sendSafeJson(res, cached);
            }
        }

        const factChecker = new ImprovedFactChecker();
        const claims = factChecker.extractVerifiableClaims(sanitizedResponse);
        const keywords = extractMainKeywords(sanitizedResponse);
        const smartQueries = sanitizedPrompt ? extractMainKeywords(sanitizedPrompt) : [];
        const sourceResult = await findWebSources(keywords, smartQueries, sanitizedResponse); // [IMPROVED]
        const sources = Array.isArray(sourceResult.sources) ? sourceResult.sources : []; // [IMPROVED]
        const analyzedSources = await analyzeSourcesWithImprovedLogic(factChecker, sanitizedResponse, sources); // [IMPROVED]
        const result = factChecker.calculateBalancedScore(sanitizedResponse, analyzedSources, claims); // [IMPROVED]
        const verifiedByMultipleTrustedSources = analyzedSources.filter(source => source.actuallySupports && source.sourceQuality >= 0.75).length >= 3; // [IMPROVED]

        const reliabilityLabel =
            result.score > 0.85 ? 'Highly Reliable' :
            result.score > 0.6 ? 'Mostly Reliable' :
            result.score > 0.4 ? 'Uncertain' :
            'Low Reliability';

        const responsePayload = {
            modelAnalyzed: model,
            reliabilityScore: result.score,
            reasoningSummary: result.reasoning,
            sources: analyzedSources,
            claims,
            keywords,
            overallConfidence: result.score,
            reliabilityLabel,
            scoringBreakdown: result.breakdown, // [IMPROVED]
            summaryText: result.summaryText, // [IMPROVED]
            verifiedByMultipleTrustedSources, // [IMPROVED]
            sourceFetchError: sourceResult.error // [IMPROVED]
        };

        verificationCache.set(cacheKey, responsePayload);

        return sendSafeJson(res, responsePayload);
    } catch (error) {
        logError('❌ Erreur VerifyAI', error);
        res.status(500);
        return sendSafeJson(res, {
            error: 'Erreur lors de la vérification du modèle.'
        });
    }
});

// Endpoint de comparaison multi-modèles
app.post('/compare/ai', async (req, res) => {
    try {
        const { prompt, responses } = req.body || {};

        if (!prompt || typeof prompt !== 'string' || !responses || typeof responses !== 'object') {
            res.status(400);
            return sendSafeJson(res, {
                success: false,
                error: 'Prompt and responses are required for comparison.'
            });
        }

        const responseEntries = Object.entries(responses).filter(([model, text]) => typeof text === 'string' && text.trim().length > 0);

        if (responseEntries.length === 0) {
            res.status(400);
            return sendSafeJson(res, {
                success: false,
                error: 'At least one model response must be provided.'
            });
        }

        if (prompt.length > MAX_TEXT_LENGTH) {
            res.status(413);
            return sendSafeJson(res, {
                success: false,
                error: `Prompt exceeds maximum of ${MAX_TEXT_LENGTH} characters.`
            });
        }

        const factChecker = new ImprovedFactChecker();
        const sanitizedPrompt = sanitizeInput(prompt);
        const promptKeywords = extractMainKeywords(sanitizedPrompt);
        const smartQueries = promptKeywords;
        const promptClaims = factChecker.extractVerifiableClaims(sanitizedPrompt);

        const comparison = [];

        for (const [modelName, rawResponse] of responseEntries) {
            if (rawResponse.length > MAX_TEXT_LENGTH) {
                comparison.push({
                    model: modelName,
                    score: 0,
                    confidence: 0,
                    summary: `Réponse rejetée: dépasse ${MAX_TEXT_LENGTH} caractères.`,
                    sourcesCount: 0
                });
                continue;
            }

            const sanitizedResponse = sanitizeInput(rawResponse);

            if (!sanitizedResponse || sanitizedResponse.length < 10) {
                comparison.push({
                    model: modelName,
                    score: 0,
                    confidence: 0,
                    summary: 'Réponse insuffisante pour une analyse fiable.',
                    sourcesCount: 0
                });
                continue;
            }

            const responseClaims = factChecker.extractVerifiableClaims(sanitizedResponse);
            const responseKeywords = extractMainKeywords(sanitizedResponse);
            const combinedKeywords = Array.from(new Set([...promptKeywords, ...responseKeywords]));

            const sourceResult = await findWebSources(combinedKeywords, smartQueries, sanitizedResponse); // [IMPROVED]
            const sources = Array.isArray(sourceResult.sources) ? sourceResult.sources : []; // [IMPROVED]
            const analyzedSources = await analyzeSourcesWithImprovedLogic(factChecker, sanitizedResponse, sources); // [IMPROVED]
            const scoringClaims = responseClaims.length > 0 ? responseClaims : promptClaims;
            const result = factChecker.calculateBalancedScore(sanitizedResponse, analyzedSources, scoringClaims); // [IMPROVED]
            const verifiedByMultipleTrustedSources = analyzedSources.filter(source => source.actuallySupports && source.sourceQuality >= 0.75).length >= 3; // [IMPROVED]

            comparison.push({
                model: modelName,
                score: Number(result.score.toFixed(2)),
                confidence: Number(result.confidence.toFixed(2)),
                summary: result.reasoning,
                summaryText: result.summaryText, // [IMPROVED]
                scoringBreakdown: result.breakdown, // [IMPROVED]
                sourcesCount: analyzedSources.length,
                verifiedByMultipleTrustedSources, // [IMPROVED]
                sourceFetchError: sourceResult.error // [IMPROVED]
            });
        }

        const bestModelEntry = comparison.reduce((best, current) => {
            if (!best || current.score > best.score) {
                return current;
            }
            return best;
        }, null);

        const scoringBreakdownMap = comparison.reduce((acc, entry) => { // [IMPROVED]
            if (entry.model && entry.scoringBreakdown) { // [IMPROVED]
                acc[entry.model] = entry.scoringBreakdown; // [IMPROVED]
            } // [IMPROVED]
            return acc; // [IMPROVED]
        }, {}); // [IMPROVED]

        return sendSafeJson(res, {
            success: true,
            prompt: sanitizedPrompt,
            comparison,
            bestModel: bestModelEntry ? bestModelEntry.model : null,
            scoringBreakdown: scoringBreakdownMap // [IMPROVED]
        });
    } catch (error) {
        logError('❌ Erreur comparaison AI', error);
        res.status(500);
        return sendSafeJson(res, {
            success: false,
            error: 'Erreur lors de la comparaison des modèles.'
        });
    }
});

// Endpoint feedback
app.post('/feedback', async (req, res) => {
  if (!pool) {
    logWarn(`⚠️ DB désactivée — feedback non stocké: ${JSON.stringify(req.body || {})}`);
    return sendSafeJson(res, { success: true, message: 'Feedback reçu (non stocké)' });
  }

  const client = await pool.connect();
  try {
    const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;

    // 🧩 Logs de diagnostic
    logInfo(`📩 Feedback reçu - texte: ${sanitizeInput(originalText || '').substring(0, 120)}`);
    logInfo(`📦 Body complet: ${JSON.stringify(req.body || {})}`);

    // 🔍 Détection améliorée du sondage VerifyAI Pro
    if (originalText && originalText.trim().toLowerCase() === 'verifyai pro survey') {
      let surveyPayload;
      try {
        surveyPayload =
          typeof comment === 'string' && comment.trim().startsWith('{')
            ? JSON.parse(comment)
            : comment || {};
      } catch (parseError) {
        logError('❌ Invalid survey payload', parseError);
        res.status(400);
        return sendSafeJson(res, { success: false, error: 'Invalid survey data' });
      }

      const {
        willing = '',
        features = [],
        comment: surveyComment = '',
        email = ''
      } = surveyPayload || {};

      const sanitizedWilling = sanitizeInput(willing).substring(0, 255);
      const sanitizedFeatures = Array.isArray(features)
        ? features.map(f => sanitizeInput(f).substring(0, 255)).filter(Boolean)
        : [];
      const sanitizedSurveyComment = sanitizeInput(surveyComment || '').substring(0, 2000);
      const sanitizedEmail = sanitizeInput(email || '').substring(0, 320);

      logInfo(
        `🧾 Insertion pro_survey => ${JSON.stringify({
          willing: sanitizedWilling,
          features: sanitizedFeatures,
          comment: sanitizedSurveyComment,
          email: sanitizedEmail
        })}`
      );

      await client.query(
        'INSERT INTO pro_survey(willing, features, comment, email) VALUES($1, $2::text[], $3, $4)',
        [
          sanitizedWilling || null,
          sanitizedFeatures.length
            ? `{${sanitizedFeatures.map(f => `"${f.replace(/"/g, '""')}"`).join(',')}}`
            : '{}',
          sanitizedSurveyComment || null,
          sanitizedEmail || null
        ]
      );

      logInfo(
        `🧩 Pro Survey enregistré — willing: ${sanitizedWilling || 'N/A'}, features: [${sanitizedFeatures.join(', ')}], email: ${sanitizedEmail || 'N/A'}`
      );
    } else {
      // 🔁 Feedback IA classique
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

      logInfo(`📝 Feedback IA - ${isUseful ? 'Utile' : 'Pas utile'} (score: ${scoreGiven})`);
    }

    return sendSafeJson(res, { success: true, message: 'Feedback enregistré' });
  } catch (err) {
    logError('❌ Erreur feedback globale', err);
    res.status(500);
    return sendSafeJson(res, { error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// Endpoint health
app.get('/health', (req, res) => {
    return sendSafeJson(res, {
        status: 'ok',
        version: 'VERIFYAI-SERVER-2.3',
        features: ['balanced_scoring', 'contextual_analysis', 'intelligent_contradictions', 'source_verification'],
        timestamp: new Date().toISOString(),
        api_configured: !!(process.env.GOOGLE_API_KEY && process.env.SEARCH_ENGINE_ID)
    });
});

app.get('/metrics', (req, res) => {
    const uptimeSeconds = Math.round((Date.now() - metrics.startedAt) / 1000);
    return sendSafeJson(res, {
        totalRequests: metrics.totalRequests,
        uptime: uptimeSeconds,
        dbConnected: !!pool,
        cacheHits: metrics.cacheHits
    });
});

// Database initialization
const initDb = async () => {
    if (!pool) {
        logWarn('⚠️ DATABASE_URL absente — DB désactivée.');
        return null;
    }

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
        await client.query(`
            CREATE TABLE IF NOT EXISTS pro_survey (
                id SERIAL PRIMARY KEY,
                willing TEXT,
                features TEXT[],
                comment TEXT,
                email TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        client.release();
        logInfo('✅ Database ready');
    } catch (err) {
        logError('❌ Database error', err.message);
    }
};

// Startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 === VERIFYAI BALANCED SERVER ===`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔑 Google API configured: ${!!process.env.GOOGLE_API_KEY}`);
    console.log(`💾 Database configured: ${!!process.env.DATABASE_URL}`);
    console.log(`⚖️  Features: Balanced scoring, Contextual analysis, Smart contradictions`);
    console.log(`🧩 VerifyAI Integration active: Model verification endpoint ready`);
    console.log(`=====================================\n`);
    initDb();
});
