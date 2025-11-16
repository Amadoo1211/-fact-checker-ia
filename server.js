// Compatible Node 18+ (fetch natif) et fallback dynamique pour older envs
const fetch = globalThis.fetch || (async (...args) =>
  (await import('node-fetch')).default(...args)
);
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createHash } = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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

let francModule = null;
try {
    francModule = require('franc');
} catch (err) {
    startupWarnings.push('franc non disponible — heuristique de langue utilisée.');
}

const colorize = (color, message) => {
    if (!chalk) return message;
    if (typeof chalk[color] === 'function') {
        return chalk[color](message);
    }
    return message;
};

const logInfo = (message) => {
    if (!isProduction) {
        console.log(colorize('cyan', message));
    }
};

const logWarn = (message) => {
    if (!isProduction) {
        console.warn(colorize('yellow', message));
    }
};

const logError = (message, error) => {
    if (!isProduction) {
        const fullMessage = error ? `${message}: ${error}` : message;
        console.error(colorize('red', fullMessage));
    }
};

startupWarnings.forEach(message => logWarn(message));

const FREE_MODE_PROMPT = `
You are VerifyAI Assistant. Provide clear, safe, concise replies.
Never invent sources or pretend to search the web. Match the user's language.
`;

const PRO_DEEP_ANALYSIS_PROMPT = `
You are VerifyAI Pro — Deep Analysis Mode.

Your job is to provide deeper, more structured, expert-level reasoning.
Do NOT invent facts or pretend to search the web.

==========================
WHAT MAKES YOU PRO
==========================
1. Extract and classify factual claims.
2. Evaluate strength of each claim:
   - Strong evidence likely
   - Possibly true but unclear
   - Weak or unsupported
   - Potentially false
3. Identify missing context, logical gaps, manipulation, contradictions.
4. Provide deep reasoning but readable structure.
5. Always explain WHY you reach a conclusion.
6. Match the user's language automatically.

==========================
OUTPUT FORMAT
==========================
1. Short Summary
2. Extracted Claims
3. Evaluation of Each Claim
4. Missing Context
5. Risk of Misinformation
6. Logical Coherence Check
7. What Needs Verification
8. Final Assessment
`;

const PRO_RESEARCH_EXPANSION_PROMPT = `
You are VerifyAI Pro — Research Expansion Mode.

You expand knowledge safely WITHOUT pretending to search the web.
Use general world knowledge only (no hallucinated sources).

==========================
WHAT YOU DO
==========================
1. Provide broad context and conceptual clarity.
2. Compare viewpoints when relevant.
3. Explain what type of evidence normally supports the claim.
4. Identify uncertainties and limitations.
5. Match the user's language.

==========================
OUTPUT FORMAT
==========================
1. Overview
2. What is generally known
3. Agreement among experts
4. Uncertainties or debates
5. What typically requires verification
6. How to interpret safely
7. Clear takeaway
`;

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

// Simple in-memory chat usage tracking for free users (per 24h window)
const freeChatUsage = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 60 * 60 });

function getFreeUsageKey(userId) {
    const safeId = typeof userId === 'string' && userId.trim() ? userId.trim() : 'anonymous';
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return `chat_free_usage:${safeId}:${today}`;
}

function incrementAndCheckFreeUsage(userId, maxPerDay = 30) {
    const key = getFreeUsageKey(userId);
    const current = freeChatUsage.get(key) || 0;
    const next = current + 1;
    freeChatUsage.set(key, next);
    return {
        allowed: next <= maxPerDay,
        used: next,
        limit: maxPerDay
    };
}
const metrics = {
    totalRequests: 0,
    cacheHits: 0,
    startedAt: Date.now()
};

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

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) {
            return callback(null, true);
        }

        const isAllowed = allowedOrigins.some(allowed => {
            if (allowed instanceof RegExp) {
                return allowed.test(origin);
            }
            if (typeof allowed === 'string' && allowed.endsWith('*')) {
                const base = allowed.slice(0, -1);
                return origin.startsWith(base);
            }
            return origin === allowed;
        });

        if (isAllowed) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
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

// Stripe webhook endpoint requires the raw body for signature verification.
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const sig = req.headers['stripe-signature'];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!sig || !webhookSecret) {
            return res.status(400).send('Missing webhook signature');
        }

        let event;

        try {
            event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        } catch (err) {
            logError('❌ Webhook signature verification failed', err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const userId = session.metadata?.verifyai_user_id;
                const subscriptionId = session.subscription;
                const customerId = session.customer;

                if (userId && subscriptionId) {
                    await upsertSubscription(userId, {
                        stripe_customer_id: customerId,
                        stripe_subscription_id: subscriptionId,
                        status: 'active',
                        current_period_end: null
                    });
                }
                break;
            }

            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                const subscriptionId = invoice.subscription;
                const periodEndUnix = invoice?.lines?.data?.[0]?.period?.end;
                const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;

                if (subscriptionId) {
                    await updateSubscriptionStatus(subscriptionId, {
                        status: 'active',
                        current_period_end: currentPeriodEnd
                    });
                }
                break;
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object;

                if (subscription?.id) {
                    await updateSubscriptionStatus(subscription.id, {
                        status: 'canceled'
                    });
                }
                break;
            }

            default:
                break;
        }

        res.status(200).send('OK');
    } catch (err) {
        logError('❌ Webhook processing failed', err.message || err);
        res.status(500).send('Internal server error');
    }
});

app.use(express.json({ limit: '5mb' }));

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

    // 11. CALCUL FINAL ÉQUILIBRÉ
    calculateBalancedScore(originalText, analyzedSources, claims) {
        let totalScore = 0;
        let confidence = 0;
        const reasoning = [];

        logInfo(`🎯 Calcul du score équilibré...`);

        // 1. Score de base
        const contentType = this.analyzeContentType(originalText, claims);
        totalScore += contentType.baseScore;
        reasoning.push(contentType.reasoning);
        confidence += 0.3;

        // 2. Qualité des sources
        const sourceEval = this.evaluateSourceQuality(analyzedSources);
        totalScore += sourceEval.impact;
        reasoning.push(sourceEval.reasoning);
        confidence += sourceEval.confidence;

        // 3. Consensus
        const consensus = this.evaluateConsensus(analyzedSources);
        totalScore += consensus.bonus;
        if (consensus.reasoning) {
            reasoning.push(consensus.reasoning);
        }
        confidence += consensus.confidence;

        // 4. Cohérence contextuelle
        const contextBonus = this.evaluateContextualCoherence(originalText, analyzedSources);
        totalScore += contextBonus.bonus;
        if (contextBonus.reasoning) {
            reasoning.push(contextBonus.reasoning);
        }

        const finalScore = Math.max(0.15, Math.min(0.92, totalScore));
        
        logInfo(`📊 Score équilibré: ${Math.round(finalScore * 100)}%`);
        
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

async function analyzeSourcesWithImprovedLogic(factChecker, originalText, sources) {
    const analyzedSources = [];
    
    for (const source of sources.slice(0, 5)) {
        try {
            const credibility = factChecker.getSourceCredibilityTier(source.url);
            const semanticMatch = factChecker.calculateSemanticSimilarity(originalText, source.snippet || '');
            const contradiction = factChecker.detectIntelligentContradiction(originalText, source.snippet || '');
            
            const actuallySupports = semanticMatch.confirms && !contradiction.detected && semanticMatch.score > 0.15;
            
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
            logError(`Erreur analyse source ${source.url}`, error.message);
            
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

async function upsertSubscription(userId, data = {}) {
    if (!userId) {
        return;
    }

    if (!pool) {
        logWarn('⚠️ Database not configured — skipping subscription sync.');
        return;
    }

    const client = await pool.connect();

    try {
        const query = `INSERT INTO subscriptions (
                user_id,
                stripe_customer_id,
                stripe_subscription_id,
                status,
                current_period_end
            ) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id) DO UPDATE SET
                stripe_customer_id = EXCLUDED.stripe_customer_id,
                stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                status = EXCLUDED.status,
                current_period_end = EXCLUDED.current_period_end,
                updated_at = NOW()`;

        await client.query(query, [
            userId,
            data.stripe_customer_id || null,
            data.stripe_subscription_id || null,
            data.status || 'inactive',
            data.current_period_end || null
        ]);
    } catch (err) {
        logError('❌ Failed to upsert subscription', err.message || err);
        throw err;
    } finally {
        client.release();
    }
}

async function updateSubscriptionStatus(subscriptionId, updates = {}) {
    if (!subscriptionId) {
        return;
    }

    if (!pool) {
        logWarn('⚠️ Database not configured — skipping subscription status update.');
        return;
    }

    const fields = [];
    const values = [];
    let index = 1;

    if (updates.status) {
        fields.push(`status = $${index++}`);
        values.push(updates.status);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'current_period_end')) {
        fields.push(`current_period_end = $${index++}`);
        values.push(updates.current_period_end || null);
    }

    if (!fields.length) {
        return;
    }

    values.push(subscriptionId);

    const client = await pool.connect();

    try {
        const query = `UPDATE subscriptions SET ${fields.join(', ')}, updated_at = NOW() WHERE stripe_subscription_id = $${index}`;
        const result = await client.query(query, values);

        if (result.rowCount === 0) {
            logWarn(`⚠️ Subscription ${subscriptionId} not found for status update.`);
        }
    } catch (err) {
        logError('❌ Failed to update subscription status', err.message || err);
        throw err;
    } finally {
        client.release();
    }
}

async function isUserPro(userId) {
    if (!userId || !pool) return false;

    const client = await pool.connect();

    try {
        const { rows } = await client.query(
            `SELECT status, current_period_end FROM subscriptions WHERE user_id = $1 LIMIT 1`,
            [userId]
        );

        if (rows.length === 0) {
            return false;
        }

        const { status, current_period_end: currentPeriodEnd } = rows[0];

        if (!status) {
            return false;
        }

        const normalizedStatus = status.toLowerCase();

        if (!['active', 'trialing'].includes(normalizedStatus)) {
            return false;
        }

        if (!currentPeriodEnd) {
            return true;
        }

        const expiration = new Date(currentPeriodEnd);
        return Number.isFinite(expiration.getTime()) && expiration > new Date();
    } catch (err) {
        logError('❌ Failed to check user subscription', err.message || err);
        return false;
    } finally {
        client.release();
    }
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

const ISO3_TO_ISO1 = {
    eng: 'en',
    fra: 'fr',
    ita: 'it',
    spa: 'es',
    deu: 'de',
    ger: 'de',
    jpn: 'ja',
    tur: 'tr',
    hin: 'hi',
    rus: 'ru'
};

const SUMMARY_TRANSLATIONS = {
    en: {
        label: 'Analysis Summary',
        reliability: {
            veryHigh: 'The statement appears highly reliable ({score}%).',
            mostly: 'The statement appears mostly reliable ({score}%).',
            uncertain: 'Reliability remains uncertain ({score}%).',
            low: 'The statement appears unreliable ({score}%).'
        },
        positive: {
            recentConsistent: 'Recent and consistent data from multiple sources.',
            recent: 'Recent information identified across the sources.',
            consistent: 'Sources present consistent information overall.',
            limited: 'Some relevant data identified, though limited.',
            none: 'Insufficient data to judge recency or consistency.'
        },
        warning: {
            none: 'No major contradictions detected.',
            minor: 'Minor contradictions found.',
            major: 'Significant contradictions detected — review carefully.'
        },
        sources: {
            diverse: 'Verified and diverse sources.',
            limited: 'Verified sources but limited diversity.',
            scarce: 'Verified sources but very few in number.',
            none: 'No reliable sources identified.'
        }
    },
    fr: {
        label: 'Résumé de l’analyse',
        reliability: {
            veryHigh: 'Le texte semble très fiable ({score}%).',
            mostly: 'Le texte semble globalement fiable ({score}%).',
            uncertain: 'La fiabilité du texte reste incertaine ({score}%).',
            low: 'Le texte semble peu fiable ({score}%).'
        },
        positive: {
            recentConsistent: 'Données récentes et cohérentes entre les sources.',
            recent: 'Informations récentes identifiées dans les sources.',
            consistent: 'Les sources présentent une information cohérente.',
            limited: 'Quelques données pertinentes mais limitées.',
            none: 'Données exploitables insuffisantes.'
        },
        warning: {
            none: 'Aucune contradiction majeure détectée.',
            minor: 'Quelques contradictions mineures observées.',
            major: 'Contradictions importantes détectées.'
        },
        sources: {
            diverse: 'Sources vérifiées et diversifiées.',
            limited: 'Sources vérifiées mais diversité limitée.',
            scarce: 'Sources vérifiées mais très peu nombreuses.',
            none: 'Aucune source fiable n’a été identifiée.'
        }
    },
    es: {
        label: 'Resumen del análisis',
        reliability: {
            veryHigh: 'La afirmación parece muy confiable ({score}%).',
            mostly: 'La afirmación parece mayormente confiable ({score}%).',
            uncertain: 'La fiabilidad sigue siendo incierta ({score}%).',
            low: 'La afirmación parece poco confiable ({score}%).'
        },
        positive: {
            recentConsistent: 'Datos recientes y coherentes entre las fuentes.',
            recent: 'Información reciente identificada en las fuentes.',
            consistent: 'Las fuentes muestran información coherente.',
            limited: 'Algunos datos relevantes pero limitados.',
            none: 'Datos insuficientes para evaluar actualidad o coherencia.'
        },
        warning: {
            none: 'No se detectaron contradicciones importantes.',
            minor: 'Se observaron contradicciones menores.',
            major: 'Se detectaron contradicciones significativas.'
        },
        sources: {
            diverse: 'Fuentes verificadas y diversas.',
            limited: 'Fuentes verificadas pero con diversidad limitada.',
            scarce: 'Fuentes verificadas pero muy escasas.',
            none: 'No se identificaron fuentes confiables.'
        }
    },
    de: {
        label: 'Analysezusammenfassung',
        reliability: {
            veryHigh: 'Die Aussage wirkt sehr zuverlässig ({score}%).',
            mostly: 'Die Aussage wirkt überwiegend zuverlässig ({score}%).',
            uncertain: 'Die Zuverlässigkeit bleibt unklar ({score}%).',
            low: 'Die Aussage wirkt wenig zuverlässig ({score}%).'
        },
        positive: {
            recentConsistent: 'Aktuelle und übereinstimmende Daten aus mehreren Quellen.',
            recent: 'Aktuelle Informationen wurden in den Quellen gefunden.',
            consistent: 'Die Quellen liefern insgesamt stimmige Informationen.',
            limited: 'Einige relevante, aber begrenzte Daten vorhanden.',
            none: 'Zu wenige Daten für eine Einschätzung.'
        },
        warning: {
            none: 'Keine größeren Widersprüche festgestellt.',
            minor: 'Einige geringfügige Widersprüche festgestellt.',
            major: 'Deutliche Widersprüche erkannt.'
        },
        sources: {
            diverse: 'Geprüfte und vielfältige Quellen.',
            limited: 'Geprüfte Quellen, aber begrenzte Vielfalt.',
            scarce: 'Geprüfte Quellen, jedoch sehr wenige.',
            none: 'Keine verlässlichen Quellen gefunden.'
        }
    },
    it: {
        label: "Riepilogo dell'analisi",
        reliability: {
            veryHigh: 'L’affermazione risulta molto affidabile ({score}%).',
            mostly: 'L’affermazione risulta per lo più affidabile ({score}%).',
            uncertain: 'L’affidabilità rimane incerta ({score}%).',
            low: 'L’affermazione risulta poco affidabile ({score}%).'
        },
        positive: {
            recentConsistent: 'Dati recenti e coerenti tra le fonti.',
            recent: 'Informazioni recenti rilevate nelle fonti.',
            consistent: 'Le fonti mostrano informazioni coerenti.',
            limited: 'Alcuni dati pertinenti ma limitati.',
            none: 'Dati insufficienti per valutarne l’attualità o la coerenza.'
        },
        warning: {
            none: 'Nessuna contraddizione rilevante individuata.',
            minor: 'Osservate lievi contraddizioni.',
            major: 'Contraddizioni significative rilevate.'
        },
        sources: {
            diverse: 'Fonti verificate e diversificate.',
            limited: 'Fonti verificate ma con diversità limitata.',
            scarce: 'Fonti verificate ma molto poche.',
            none: 'Nessuna fonte affidabile identificata.'
        }
    },
    ja: {
        label: '分析の概要',
        reliability: {
            veryHigh: 'この記述は非常に信頼できると判断されます（{score}%）。',
            mostly: 'この記述は概ね信頼できると判断されます（{score}%）。',
            uncertain: 'この記述の信頼性は不確かです（{score}%）。',
            low: 'この記述は信頼性が低いと判断されます（{score}%）。'
        },
        positive: {
            recentConsistent: '複数の情報源で最新かつ一貫したデータが確認されました。',
            recent: '情報源から最新の情報が確認されました。',
            consistent: '情報源の内容は概ね一致しています。',
            limited: '関連するデータはあるものの量は限られています。',
            none: '新しいデータや一貫性を判断する情報が不足しています。'
        },
        warning: {
            none: '大きな矛盾は確認されませんでした。',
            minor: 'いくつか小さな矛盾が見つかりました。',
            major: '重大な矛盾が検出されました。'
        },
        sources: {
            diverse: '検証済みで多様な情報源です。',
            limited: '検証済みですが情報源の多様性は限定的です。',
            scarce: '検証済みの情報源はあるものの非常に少ないです。',
            none: '信頼できる情報源は確認できませんでした。'
        }
    },
    tr: {
        label: 'Analiz Özeti',
        reliability: {
            veryHigh: 'Açıklama son derece güvenilir görünüyor ({score}%).',
            mostly: 'Açıklama çoğunlukla güvenilir görünüyor ({score}%).',
            uncertain: 'Güvenilirlik belirsiz kalıyor ({score}%).',
            low: 'Açıklama güvenilir görünmüyor ({score}%).'
        },
        positive: {
            recentConsistent: 'Birden fazla kaynaktan güncel ve tutarlı veriler.',
            recent: 'Kaynaklarda güncel bilgiler bulundu.',
            consistent: 'Kaynaklar genel olarak tutarlı bilgiler sunuyor.',
            limited: 'Bazı ilgili veriler mevcut ancak sınırlı.',
            none: 'Güncellik veya tutarlılığı değerlendirmek için veri yetersiz.'
        },
        warning: {
            none: 'Önemli bir çelişki tespit edilmedi.',
            minor: 'Küçük çelişkiler gözlemlendi.',
            major: 'Önemli çelişkiler tespit edildi.'
        },
        sources: {
            diverse: 'Doğrulanmış ve çeşitli kaynaklar.',
            limited: 'Doğrulanmış kaynaklar ancak çeşitlilik sınırlı.',
            scarce: 'Doğrulanmış ancak çok az sayıda kaynak.',
            none: 'Güvenilir kaynak bulunamadı.'
        }
    },
    hi: {
        label: 'विश्लेषण सारांश',
        reliability: {
            veryHigh: 'कथन अत्यंत विश्वसनीय प्रतीत होता है ({score}%).',
            mostly: 'कथन अधिकांश रूप से विश्वसनीय प्रतीत होता है ({score}%).',
            uncertain: 'विश्वसनीयता अनिश्चित बनी हुई है ({score}%).',
            low: 'कथन कम विश्वसनीय प्रतीत होता है ({score}%).'
        },
        positive: {
            recentConsistent: 'कई स्रोतों से हाल का और सुसंगत डेटा मिला।',
            recent: 'स्रोतों में हाल की जानकारी पहचानी गई।',
            consistent: 'स्रोतों में जानकारी अधिकांशतः सुसंगत है।',
            limited: 'कुछ प्रासंगिक डेटा उपलब्ध हैं लेकिन सीमित।',
            none: 'नवीनता या सुसंगतता आँकने के लिए डेटा अपर्याप्त है।'
        },
        warning: {
            none: 'कोई प्रमुख विरोधाभास नहीं मिला।',
            minor: 'कुछ छोटे विरोधाभास पाए गए।',
            major: 'महत्वपूर्ण विरोधाभास पाए गए।'
        },
        sources: {
            diverse: 'सत्यापित और विविध स्रोत।',
            limited: 'सत्यापित स्रोत लेकिन विविधता सीमित।',
            scarce: 'सत्यापित स्रोत बहुत कम हैं।',
            none: 'कोई विश्वसनीय स्रोत नहीं मिला।'
        }
    },
    ru: {
        label: 'Резюме анализа',
        reliability: {
            veryHigh: 'Утверждение выглядит очень надёжным ({score}%).',
            mostly: 'Утверждение выглядит в основном надёжным ({score}%).',
            uncertain: 'Надёжность остаётся неопределённой ({score}%).',
            low: 'Утверждение выглядит ненадёжным ({score}%).'
        },
        positive: {
            recentConsistent: 'Актуальные и согласованные данные из нескольких источников.',
            recent: 'В источниках найдены актуальные сведения.',
            consistent: 'Источники дают в целом согласованную информацию.',
            limited: 'Есть некоторые релевантные, но ограниченные данные.',
            none: 'Недостаточно данных для оценки актуальности или согласованности.'
        },
        warning: {
            none: 'Существенных противоречий не обнаружено.',
            minor: 'Обнаружены небольшие противоречия.',
            major: 'Обнаружены значительные противоречия.'
        },
        sources: {
            diverse: 'Проверенные и разнообразные источники.',
            limited: 'Проверенные источники, но ограниченное разнообразие.',
            scarce: 'Проверенных источников очень мало.',
            none: 'Надёжные источники не найдены.'
        }
    }
};

const LANGUAGE_HEURISTICS = [
    { regex: /[àâäéèêëîïôöùûüçœ]/i, code: 'fr' },
    { regex: /[áéíóúñü¿¡]/i, code: 'es' },
    { regex: /[äöüß]/i, code: 'de' },
    { regex: /[àèéìòù]/i, code: 'it' },
    { regex: /[ぁ-んァ-ン一-龥]/, code: 'ja' },
    { regex: /[ğüşöçıİ]/i, code: 'tr' },
    { regex: /[\u0900-\u097F]/, code: 'hi' },
    { regex: /[а-яё]/i, code: 'ru' }
];

function detectLanguageCode(text) {
    const cleaned = sanitizeInput(text || '');
    if (!cleaned) {
        return 'en';
    }

    let detected = null;

    if (francModule) {
        try {
            const iso3 = francModule(cleaned, { minLength: Math.min(10, Math.max(3, cleaned.length)) });
            if (iso3 && iso3 !== 'und') {
                detected = ISO3_TO_ISO1[iso3] || null;
            }
        } catch (error) {
            logWarn(`Erreur détection de langue via franc: ${error.message}`);
        }
    }

    if (!detected) {
        for (const heuristic of LANGUAGE_HEURISTICS) {
            if (heuristic.regex.test(cleaned)) {
                detected = heuristic.code;
                break;
            }
        }
    }

    return detected || 'en';
}

function resolveTemplate(textPack, section, key, replacements) {
    const sectionPack = textPack[section] || {};
    const fallbackPack = SUMMARY_TRANSLATIONS.en[section] || {};
    const template = sectionPack[key] || fallbackPack[key] || '';

    return template.replace(/\{(\w+)\}/g, (_, token) => {
        const value = replacements[token];
        return value !== undefined ? value : `{${token}}`;
    });
}

function createLocalizedSummary(languageCode, result = {}, analyzedSources = []) {
    const lang = SUMMARY_TRANSLATIONS[languageCode] ? languageCode : 'en';
    const textPack = SUMMARY_TRANSLATIONS[lang];

    const score = typeof result.score === 'number' ? result.score : 0;
    const scorePercent = Math.round(Math.max(0, Math.min(1, score)) * 100);

    const totalSources = Array.isArray(analyzedSources) ? analyzedSources.length : 0;
    const supportingCount = Array.isArray(analyzedSources)
        ? analyzedSources.filter(source => source?.actuallySupports).length
        : 0;
    const contradictionCount = Array.isArray(analyzedSources)
        ? analyzedSources.filter(source => source?.contradicts).length
        : 0;

    const supportRatio = totalSources > 0 ? supportingCount / totalSources : 0;
    const contradictionRatio = totalSources > 0 ? contradictionCount / totalSources : 0;

    const domainSet = new Set();
    if (Array.isArray(analyzedSources)) {
        for (const source of analyzedSources) {
            if (!source || !source.url) continue;
            try {
                const hostname = new URL(source.url).hostname;
                domainSet.add(hostname);
            } catch {
                domainSet.add(source.url);
            }
        }
    }

    const hasRecentSources = Array.isArray(analyzedSources) && analyzedSources.some(source => {
        const snippet = `${source?.snippet || ''} ${source?.title || ''}`;
        return /202[0-5]|recent|latest|nouveau|nouvelle|récent|reciente|aktuell|aktuellen|aggiornato|aggiornata|最新|最近|güncel|हालिया|последн/iu.test(snippet);
    });

    let positiveKey = 'limited';
    if (totalSources === 0) {
        positiveKey = 'none';
    } else if (hasRecentSources && supportRatio >= 0.6) {
        positiveKey = 'recentConsistent';
    } else if (hasRecentSources) {
        positiveKey = 'recent';
    } else if (supportRatio >= 0.6) {
        positiveKey = 'consistent';
    }

    let warningKey = 'none';
    if (contradictionRatio > 0.5) {
        warningKey = 'major';
    } else if (contradictionCount > 0) {
        warningKey = 'minor';
    }

    let sourcesKey = 'limited';
    if (totalSources === 0) {
        sourcesKey = 'none';
    } else if (domainSet.size >= 3) {
        sourcesKey = 'diverse';
    } else if (totalSources <= 1) {
        sourcesKey = 'scarce';
    }

    const reliabilityKey = score >= 0.85
        ? 'veryHigh'
        : score >= 0.65
            ? 'mostly'
            : score >= 0.45
                ? 'uncertain'
                : 'low';

    const replacements = {
        score: scorePercent,
        contradictions: contradictionCount,
        sources: totalSources
    };

    const summaryLines = [
        `🔍 ${resolveTemplate(textPack, 'reliability', reliabilityKey, replacements)}`,
        `➕ ${resolveTemplate(textPack, 'positive', positiveKey, replacements)}`,
        `⚠️ ${resolveTemplate(textPack, 'warning', warningKey, replacements)}`,
        `✅ ${resolveTemplate(textPack, 'sources', sourcesKey, replacements)}`
    ];

    return {
        label: textPack.label,
        text: summaryLines.join('\n')
    };
}

async function findWebSources(keywords, smartQueries, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        logWarn('API credentials manquantes - sources mock');
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
        const queryPromises = smartQueries.slice(0, 2).map((query, index) => (async () => {
            const delayMs = Math.min(index * MAX_API_DELAY_MS, MAX_API_DELAY_MS);
            if (delayMs > 0) {
                await delay(delayMs);
            }

            try {
                const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=4`;
                const response = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
                const data = await response.json();

                if (response.ok && data.items) {
                    return data.items.map(item => ({
                        title: item.title || 'Sans titre',
                        url: item.link || '',
                        snippet: item.snippet || 'Pas de description',
                        query_used: query,
                        relevance: calculateRelevance(item, originalText)
                    }));
                }

                return [];
            } catch (error) {
                logError(`Erreur recherche pour "${query}"`, error.message);
                return [];
            }
        })());

        const results = await Promise.allSettled(queryPromises);
        for (const result of results) {
            if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                allSources.push(...result.value);
            }
        }
    }

    if (allSources.length < 2 && keywords.length > 0) {
        try {
            await delay(MAX_API_DELAY_MS);
            const fallbackQuery = keywords.slice(0, 3).join(' ');
            const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(fallbackQuery)}&num=3`;

            const response = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
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
            logError('Erreur recherche fallback', error.message);
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
    
    logInfo(`📋 ${uniqueSources.length} sources uniques trouvées`);
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
        const sources = await findWebSources(keywords, sanitizedSmartQueries, sanitizedInput);
        const analyzedSources = await analyzeSourcesWithImprovedLogic(factChecker, sanitizedInput, sources);
        const result = factChecker.calculateBalancedScore(sanitizedInput, analyzedSources, claims);

        const languageDetected = detectLanguageCode(sanitizedInput);
        const localizedSummary = createLocalizedSummary(languageDetected, result, analyzedSources);

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
            languageDetected,
            summaryLabel: localizedSummary.label,
            summaryText: localizedSummary.text
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
        const sources = await findWebSources(keywords, smartQueries, sanitizedResponse);
        const analyzedSources = await analyzeSourcesWithImprovedLogic(factChecker, sanitizedResponse, sources);
        const result = factChecker.calculateBalancedScore(sanitizedResponse, analyzedSources, claims);

        const languageDetected = detectLanguageCode(sanitizedResponse);
        const localizedSummary = createLocalizedSummary(languageDetected, result, analyzedSources);

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
            languageDetected,
            summaryLabel: localizedSummary.label,
            summaryText: localizedSummary.text
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

            const sources = await findWebSources(combinedKeywords, smartQueries, sanitizedResponse);
            const analyzedSources = await analyzeSourcesWithImprovedLogic(factChecker, sanitizedResponse, sources);
            const scoringClaims = responseClaims.length > 0 ? responseClaims : promptClaims;
            const result = factChecker.calculateBalancedScore(sanitizedResponse, analyzedSources, scoringClaims);

            comparison.push({
                model: modelName,
                score: Number(result.score.toFixed(2)),
                confidence: Number(result.confidence.toFixed(2)),
                summary: result.reasoning,
                sourcesCount: analyzedSources.length
            });
        }

        const bestModelEntry = comparison.reduce((best, current) => {
            if (!best || current.score > best.score) {
                return current;
            }
            return best;
        }, null);

        return sendSafeJson(res, {
            success: true,
            prompt: sanitizedPrompt,
            comparison,
            bestModel: bestModelEntry ? bestModelEntry.model : null
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

app.post('/billing/create-checkout-session', async (req, res) => {
  try {
    const { userId, plan } = req.body || {};

    if (!userId || typeof userId !== 'string') {
      return sendSafeJson(res.status(400), { error: 'Missing or invalid userId' });
    }

    const priceId =
      plan === 'yearly'
        ? process.env.STRIPE_PRICE_ID_YEARLY || process.env.STRIPE_PRICE_ID_MONTHLY
        : process.env.STRIPE_PRICE_ID_MONTHLY;

    if (!priceId) {
      return sendSafeJson(res.status(500), { error: 'Stripe price id not configured' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      metadata: {
        verifyai_user_id: userId
      },
      success_url:
        (process.env.VERIFYAI_DASHBOARD_URL || 'https://verifyai.app') + '?checkout=success',
      cancel_url:
        (process.env.VERIFYAI_DASHBOARD_URL || 'https://verifyai.app') + '?checkout=cancel'
    });

    return sendSafeJson(res, { url: session.url });
  } catch (error) {
    logError('❌ Erreur Stripe create-checkout-session', error?.message || error);
    res.status(500);
    return sendSafeJson(res, {
      error:
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'Unexpected error.'
    });
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
        await client.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id SERIAL PRIMARY KEY,
                user_id TEXT UNIQUE NOT NULL,
                stripe_customer_id TEXT,
                stripe_subscription_id TEXT UNIQUE,
                status TEXT NOT NULL DEFAULT 'inactive',
                current_period_end TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
app.post('/chat', async (req, res) => {
    try {
        const { message, userMode } = req.body || {};
        const userId = req.headers['x-verifyai-user'] || req.body.userId;
        const userIsPro = await isUserPro(userId);

        // Free-tier gating: simple per-day limit for non-Pro users
        if (!userIsPro) {
            const quota = incrementAndCheckFreeUsage(userId, 30); // 30 free messages/day MVP
            if (!quota.allowed) {
                return sendSafeJson(res.status(403), {
                    error: 'Free plan limit reached for today. Please upgrade to VerifyAI Pro to continue using the assistant.',
                    code: 'FREE_LIMIT_REACHED',
                    usage: {
                        used: quota.used,
                        limit: quota.limit
                    }
                });
            }
        }

        if (typeof message !== 'string') {
            throw new Error('Message must be a string.');
        }

        const trimmedMessage = message.trim();
        const normalizedMode = typeof userMode === 'string' ? userMode : 'free';

        if (!trimmedMessage) {
            throw new Error('Message is required.');
        }

        if (trimmedMessage.length > 4000) {
            throw new Error('Message exceeds 4000 characters.');
        }

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OpenAI API key not configured.');
        }

        const allowedModes = new Set(['free', 'pro_deep', 'pro_research']);
        const effectiveMode = allowedModes.has(normalizedMode) ? normalizedMode : 'free';

        let systemPrompt = FREE_MODE_PROMPT;
        if (userIsPro) {
            if (effectiveMode === 'pro_deep') {
                systemPrompt = PRO_DEEP_ANALYSIS_PROMPT;
            } else if (effectiveMode === 'pro_research') {
                systemPrompt = PRO_RESEARCH_EXPANSION_PROMPT;
            }
        }

        const payload = {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: trimmedMessage }
            ]
        };

        const response = await fetchWithTimeout(
            'https://api.openai.com/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            },
            6000
        );

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`OpenAI API error: ${errorBody || response.statusText}`);
        }

        const data = await response.json();
        const reply = data?.choices?.[0]?.message?.content?.trim();

        if (!reply) {
            throw new Error('No response from OpenAI.');
        }

        return sendSafeJson(res, { reply });
    } catch (error) {
        logError('❌ Erreur chat VerifyAI', error?.message || error);
        res.status(500);
        return sendSafeJson(res, {
            error: typeof error?.message === 'string' && error.message.trim()
                ? error.message
                : 'Unexpected error.'
        });
    }
});
