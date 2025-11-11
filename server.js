// Compatible Node 18+ (fetch natif) et fallback dynamique pour older envs
const fetch = globalThis.fetch || (async (...args) =>
  (await import('node-fetch')).default(...args)
);
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createHash } = require('crypto');

let francDetector;
try {
    ({ franc: francDetector } = require('franc-min'));
} catch (err) {
    francDetector = () => 'und';
    console.warn('franc-min non disponible — détection linguistique désactivée.');
}

let iso6393to1;
try {
    iso6393to1 = require('iso-639-3-to-1');
} catch (err) {
    iso6393to1 = {};
    console.warn('iso-639-3-to-1 non disponible — utilisation du fallback EN.');
}

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

const RELIABILITY_LABELS = {
    en: { high: "Highly reliable", medium: "Mostly reliable", low: "Limited reliability", very_low: "Low reliability" },
    fr: { high: "Haute fiabilité", medium: "Fiabilité partielle", low: "Fiabilité incertaine", very_low: "Faible fiabilité" },
    es: { high: "Alta fiabilidad", medium: "Fiabilidad parcial", low: "Fiabilidad incierta", very_low: "Baja fiabilidad" },
    de: { high: "Hohe Zuverlässigkeit", medium: "Teilweise zuverlässig", low: "Unklare Zuverlässigkeit", very_low: "Geringe Zuverlässigkeit" },
    tr: { high: "Yüksek güvenilirlik", medium: "Kısmen güvenilir", low: "Belirsiz güvenilirlik", very_low: "Düşük güvenilirlik" },
    ru: { high: "Высокая достоверность", medium: "Частичная достоверность", low: "Сомнительная достоверность", very_low: "Низкая достоверность" },
    ja: { high: "高い信頼性", medium: "部分的に信頼できる", low: "信頼性が不確か", very_low: "信頼性が低い" },
    hi: { high: "उच्च विश्वसनीयता", medium: "आंशिक विश्वसनीयता", low: "अनिश्चित विश्वसनीयता", very_low: "कम विश्वसनीयता" },
    zh: { high: "高度可靠", medium: "部分可靠", low: "可靠性不确定", very_low: "可靠性低" }
};

const ANALYSIS_SUMMARIES = {
    en: {
        high: "✅ Highly reliable and coherent with trusted sources.",
        medium: "⚠️ Partially correct — some details may differ.",
        low: "❓ Uncertain reliability — limited or mixed evidence.",
        very_low: "❌ Likely incorrect or contradicted by sources."
    },
    fr: {
        high: "✅ Information fiable et cohérente avec les sources de confiance.",
        medium: "⚠️ Partiellement correct — certains détails peuvent différer.",
        low: "❓ Fiabilité incertaine — preuves limitées ou mixtes.",
        very_low: "❌ Probablement inexact ou contredit par les sources."
    },
    es: {
        high: "✅ Información fiable y coherente con fuentes de confianza.",
        medium: "⚠️ Parcialmente correcta: algunos detalles pueden diferir.",
        low: "❓ Fiabilidad incierta — evidencias limitadas o contradictorias.",
        very_low: "❌ Probablemente incorrecto o contradicho por las fuentes."
    },
    de: {
        high: "✅ Sehr zuverlässig und durch vertrauenswürdige Quellen bestätigt.",
        medium: "⚠️ Teilweise korrekt – einige Details können abweichen.",
        low: "❓ Zuverlässigkeit unklar – begrenzte oder gemischte Belege.",
        very_low: "❌ Wahrscheinlich falsch oder durch Quellen widerlegt."
    },
    tr: {
        high: "✅ Güvenilir kaynaklarla uyumlu ve yüksek güvenilirlikte.",
        medium: "⚠️ Kısmen doğru — bazı detaylar farklı olabilir.",
        low: "❓ Güvenilirlik belirsiz — sınırlı veya karışık kanıtlar.",
        very_low: "❌ Muhtemelen yanlış veya kaynaklarca çürütülmüş."
    },
    ru: {
        high: "✅ Информация достоверна и подтверждена надежными источниками.",
        medium: "⚠️ Частично верно — некоторые детали могут отличаться.",
        low: "❓ Достоверность сомнительна — ограниченные или противоречивые данные.",
        very_low: "❌ Вероятно неверно или опровергнуто источниками."
    },
    ja: {
        high: "✅ 信頼できる情報源と一致しており非常に信頼できます。",
        medium: "⚠️ 部分的に正しい可能性があります — 詳細に相違があるかもしれません。",
        low: "❓ 信頼性が不確かです — 裏付けが限られているか矛盾しています。",
        very_low: "❌ 情報源によって誤りとされている可能性が高いです。"
    },
    hi: {
        high: "✅ विश्वसनीय स्रोतों से मेल खाता है और अत्यधिक विश्वसनीय है।",
        medium: "⚠️ आंशिक रूप से सही — कुछ विवरण अलग हो सकते हैं।",
        low: "❓ विश्वसनीयता अनिश्चित — सीमित या मिश्रित प्रमाण।",
        very_low: "❌ संभवतः गलत या स्रोतों द्वारा खंडित।"
    },
    zh: {
        high: "✅ 与可信来源一致，信息高度可靠。",
        medium: "⚠️ 部分正确——某些细节可能不同。",
        low: "❓ 可靠性不确定——证据有限或矛盾。",
        very_low: "❌ 可能不正确或被来源驳斥。"
    }
};

const SOURCE_PREFIX = {
    en: 'Sources',
    fr: 'Sources',
    es: 'Fuentes',
    de: 'Quellen',
    tr: 'Kaynaklar',
    ru: 'Источники',
    ja: '情報源',
    hi: 'स्रोत',
    zh: '来源'
};

const normalizeLanguageCode = (code) => {
    if (!code || typeof code !== 'string') {
        return 'en';
    }
    return code.toLowerCase();
};

function detectLanguage(text) {
    const cleaned = typeof text === 'string' ? text.trim() : '';
    if (!cleaned || cleaned.length < 20) {
        return 'en';
    }
    const lang3 = francDetector(cleaned, { minLength: 20 }) || 'und';
    if (lang3 === 'und') {
        return 'en';
    }
    const mapped = iso6393to1[lang3];
    if (typeof mapped === 'string' && mapped.length === 2) {
        return normalizeLanguageCode(mapped);
    }
    return 'en';
}

const getReliabilityLabel = (language, category) => {
    const lang = normalizeLanguageCode(language);
    const dictionary = RELIABILITY_LABELS[lang] || RELIABILITY_LABELS.en;
    return dictionary[category] || RELIABILITY_LABELS.en[category] || RELIABILITY_LABELS.en.low;
};

const getAnalysisSummaryMessage = (language, category) => {
    const lang = normalizeLanguageCode(language);
    const dictionary = ANALYSIS_SUMMARIES[lang] || ANALYSIS_SUMMARIES.en;
    return dictionary[category] || ANALYSIS_SUMMARIES.en[category] || ANALYSIS_SUMMARIES.en.low;
};

const getSourcesPrefix = (language) => {
    const lang = normalizeLanguageCode(language);
    return SOURCE_PREFIX[lang] || SOURCE_PREFIX.en;
};

const categorizeScore = (score) => {
    if (score >= 0.85) {
        return 'high';
    }
    if (score >= 0.6) {
        return 'medium';
    }
    if (score >= 0.4) {
        return 'low';
    }
    return 'very_low';
};

const buildSourcesMarkdown = (mainSources, language) => {
    if (!Array.isArray(mainSources) || mainSources.length === 0) {
        return '';
    }
    return `${getSourcesPrefix(language)}: ${mainSources.map(source => `[${source.title}](${source.url})`).join(', ')}.`;
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
const GOOGLE_CACHE_TTL_MS = 2 * 60 * 1000;
const googleSearchCache = new Map();

const PRIORITY_DOMAINS = [
    '.gov', '.edu', '.int', '.org',
    'wikipedia.org', 'nature.com', 'bbc.com', 'reuters.com', 'who.int', 'un.org', 'data.gov'
];

const SECONDARY_TRUSTED_DOMAINS = [
    'science.org', 'science.gov', 'statista.com', 'nationalgeographic.com',
    'apnews.com', 'nytimes.com', 'lemonde.fr', 'britannica.com'
];

const LOW_TRUST_HINTS = ['reddit', 'forum', 'quora', 'blogspot', 'facebook', 'twitter'];

const getCachedGoogleResults = (query) => {
    const entry = googleSearchCache.get(query);
    if (!entry) {
        return null;
    }
    if (Date.now() - entry.timestamp > GOOGLE_CACHE_TTL_MS) {
        googleSearchCache.delete(query);
        return null;
    }
    return entry.data;
};

const setCachedGoogleResults = (query, data) => {
    googleSearchCache.set(query, { data, timestamp: Date.now() });
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
        if (!Array.isArray(sources) || sources.length === 0) {
            return { adjustment: -0.1, supporting: 0, contradicting: 0, reliable: 0 };
        }

        let adjustment = 0;
        let supporting = 0;
        let contradicting = 0;
        let reliable = 0;

        for (const source of sources) {
            const credibility = typeof source.credibility === 'number' ? source.credibility : 0.6;
            if (source.supports) {
                supporting += 1;
                adjustment += 0.04 + (credibility * 0.04);
            }
            if (source.contradicts) {
                contradicting += 1;
                adjustment -= 0.06;
            }
            if (credibility >= 0.75) {
                reliable += 1;
            }
        }

        if (supporting === 0) {
            adjustment -= 0.04;
        }

        adjustment = Math.max(-0.18, Math.min(0.18, adjustment));

        return {
            adjustment,
            supporting,
            contradicting,
            reliable
        };
    }

    // 9. ÉVALUATION DU CONSENSUS
    evaluateConsensus(sources) {
        if (!Array.isArray(sources) || sources.length === 0) {
            return { adjustment: 0, level: 'none', supporting: 0, contradicting: 0 };
        }

        const total = sources.length;
        const supporting = sources.filter(source => source.supports).length;
        const contradicting = sources.filter(source => source.contradicts).length;

        let adjustment = 0;

        if (supporting >= 2) {
            const ratio = supporting / total;
            if (ratio >= 0.75) {
                adjustment += 0.06;
            } else if (ratio >= 0.5) {
                adjustment += 0.04;
            } else {
                adjustment += 0.02;
            }
        } else if (supporting === 1) {
            adjustment += 0.015;
        }

        if (contradicting > 0) {
            if (contradicting >= supporting) {
                adjustment -= 0.05;
            } else {
                adjustment -= 0.02;
            }
        }

        adjustment = Math.max(-0.08, Math.min(0.08, adjustment));

        let level = 'weak';
        if (supporting >= 3 && supporting / total >= 0.7) {
            level = 'strong';
        } else if (supporting >= 2) {
            level = 'moderate';
        } else if (supporting === 1) {
            level = 'light';
        } else if (contradicting > 0) {
            level = 'contradictory';
        }

        return {
            adjustment,
            level,
            supporting,
            contradicting
        };
    }

    // 10. COHÉRENCE CONTEXTUELLE
    evaluateContextualCoherence(originalText, sources) {
        if (!Array.isArray(sources) || sources.length === 0) {
            return { adjustment: 0, details: { diversityBonus: 0, freshnessBonus: 0 } };
        }

        const domains = new Set();
        const categories = new Set();
        let hasRecent = false;
        const currentYear = new Date().getFullYear();

        for (const source of sources) {
            if (source.domain) {
                domains.add(source.domain);
            }
            if (source.category) {
                categories.add(source.category);
            }
            if (source.year && currentYear - source.year <= 3) {
                hasRecent = true;
            }
        }

        let adjustment = 0;
        let diversityBonus = 0;
        let freshnessBonus = 0;

        if (domains.size >= 3) {
            diversityBonus = 0.03;
            adjustment += diversityBonus;
        }

        if (categories.size >= 2) {
            adjustment += 0.02;
        }

        if (hasRecent) {
            freshnessBonus = 0.02;
            adjustment += freshnessBonus;
        }

        adjustment = Math.max(0, Math.min(0.06, adjustment));

        return {
            adjustment,
            details: {
                diversityBonus: Number(diversityBonus.toFixed(2)),
                freshnessBonus: Number(freshnessBonus.toFixed(2))
            }
        };
    }

    // === SCORING RÉÉQUILIBRÉ ===
    calculateBalancedScore(originalText, analyzedSources, claims, language = 'en') {
        const safeLanguage = normalizeLanguageCode(language);
        const contentType = this.analyzeContentType(originalText, Array.isArray(claims) ? claims : []);
        const baseScore = contentType?.baseScore ?? 0.5;

        const quality = this.evaluateSourceQuality(analyzedSources);
        const consensus = this.evaluateConsensus(analyzedSources);
        const coherence = this.evaluateContextualCoherence(originalText, analyzedSources);

        let score = baseScore + quality.adjustment + consensus.adjustment + coherence.adjustment;
        score = Math.max(0.15, Math.min(0.92, score));

        const category = categorizeScore(score);
        const reliabilityLabel = getReliabilityLabel(safeLanguage, category);
        const analysisSummary = getAnalysisSummaryMessage(safeLanguage, category);

        const breakdown = {
            baseScore: Number(baseScore.toFixed(2)),
            sourceQuality: Number(quality.adjustment.toFixed(2)),
            consensus: Number(consensus.adjustment.toFixed(2)),
            contextual: Number(coherence.adjustment.toFixed(2)),
            supportingSources: quality.supporting,
            contradictingSources: quality.contradicting,
            reliableSources: quality.reliable
        };

        return {
            score,
            confidence: Math.min(1, Math.max(0.2, score + (quality.reliable > 0 ? 0.05 : -0.05))),
            reasoning: analysisSummary,
            details: breakdown,
            breakdown,
            summaryText: analysisSummary,
            reliabilityLabel,
            reliabilityLevel: category
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
function enrichSourcesForScoring(factChecker, originalText, rawSources) {
    if (!Array.isArray(rawSources)) {
        return [];
    }

    const CONTRADICTION_HINTS = ['not', 'no', 'false', 'incorrect', 'fake', 'hoax', 'denied', 'refuted', 'debunk'];
    const enriched = [];

    for (const source of rawSources) {
        if (!source || !source.url) {
            continue;
        }

        const credibilityInfo = typeof source.credibility === 'number' ? {
            credibility: source.credibility,
            category: source.category || 'generic',
            domain: source.domain || extractHostname(source.url)
        } : scoreDomainTrust(source.url);

        const similarity = factChecker.calculateSemanticSimilarity(originalText, `${source.title || ''} ${source.snippet || ''}`);
        const combinedText = `${source.title || ''} ${source.snippet || ''}`.toLowerCase();
        const supports = similarity.score >= 0.25;
        const contradicts = similarity.score >= 0.18 && CONTRADICTION_HINTS.some(hint => combinedText.includes(hint));

        const yearMatch = combinedText.match(/(20\d{2})/);
        const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

        enriched.push({
            title: source.title || 'Source',
            url: source.url,
            snippet: source.snippet || '',
            relevance: typeof source.relevance === 'number' ? Number(source.relevance) : 0.5,
            credibility: credibilityInfo.credibility,
            category: credibilityInfo.category,
            domain: credibilityInfo.domain,
            supports,
            contradicts,
            similarity: Number(similarity.score.toFixed(3)),
            year: Number.isInteger(year) ? year : null
        });
    }

    return enriched;
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

const scoreDomainTrust = (url = '') => {
    const lowerUrl = (url || '').toLowerCase();
    if (!lowerUrl) {
        return { credibility: 0.55, category: 'generic', domain: '' };
    }

    let domain = '';
    try {
        domain = new URL(url).hostname.replace(/^www\./, '');
    } catch (error) {
        domain = lowerUrl.replace(/^https?:\/\//, '').split('/')[0];
    }

    let credibility = 0.6;
    let category = 'generic';
    const loweredDomain = domain.toLowerCase();

    if (PRIORITY_DOMAINS.some(item => loweredDomain.endsWith(item.replace(/^[.]/, '')) || loweredDomain.includes(item))) {
        credibility = 0.88;
        category = 'priority';
    } else if (SECONDARY_TRUSTED_DOMAINS.some(item => loweredDomain.includes(item))) {
        credibility = 0.78;
        category = 'trusted';
    }

    if (/\.(gov|edu|int|org)(\.|$)/.test(loweredDomain)) {
        credibility = Math.max(credibility, 0.9);
        category = 'institutional';
    }

    if (LOW_TRUST_HINTS.some(hint => loweredDomain.includes(hint))) {
        credibility = Math.min(credibility, 0.45);
        category = 'low';
    }

    return {
        credibility: Number(Math.max(0.3, Math.min(0.95, credibility)).toFixed(2)),
        category,
        domain: loweredDomain
    };
};

const calculateTextRelevance = (reference, title = '', snippet = '') => {
    const normalizedReference = sanitizeInput(reference).toLowerCase();
    const combined = `${title || ''} ${snippet || ''}`.toLowerCase();
    if (!normalizedReference || !combined) {
        return 0.2;
    }

    const similarity = stringSimilarity.compareTwoStrings(normalizedReference, combined);
    const tokens = new Set(normalizedReference.split(/\s+/).filter(word => word.length > 3));
    let matches = 0;
    tokens.forEach(token => {
        if (combined.includes(token)) {
            matches += 1;
        }
    });

    const keywordScore = tokens.size > 0 ? matches / tokens.size : 0;
    return Math.max(0.1, Math.min(1, (similarity * 0.6) + (keywordScore * 0.4)));
};

const deduplicateByUrl = (sources) => {
    const seen = new Set();
    return sources.filter(source => {
        if (!source.url) {
            return false;
        }
        const key = source.url.split('#')[0];
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
};

const buildKeywordSet = (keywords, originalText) => {
    const set = new Set();
    if (Array.isArray(keywords)) {
        keywords.filter(Boolean).forEach(keyword => {
            keyword.toLowerCase().split(/\s+/).forEach(word => set.add(word));
        });
    }
    sanitizeInput(originalText).toLowerCase().split(/\s+/).forEach(word => {
        if (word.length > 3) {
            set.add(word);
        }
    });
    return set;
};

const queryGoogleSearch = async (query, language = 'en', numResults = 6) => {
    const cacheKey = `${language || 'any'}::${numResults}::${query}`;
    const cached = getCachedGoogleResults(cacheKey);
    if (cached) {
        return { items: cached, cacheHit: true };
    }

    const params = new URLSearchParams({
        key: process.env.GOOGLE_API_KEY,
        cx: process.env.SEARCH_ENGINE_ID,
        q: query,
        num: String(numResults)
    });
    if (language && typeof language === 'string' && language.length === 2) {
        params.set('lr', `lang_${language}`);
    }

    try {
        const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;
        const response = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
        const data = await response.json();
        if (response.ok && Array.isArray(data.items)) {
            setCachedGoogleResults(cacheKey, data.items);
            return { items: data.items, cacheHit: false };
        }
        return { items: [], error: data?.error?.message || `HTTP_${response.status}` };
    } catch (error) {
        return { items: [], error: error.message };
    }
};

const extractHostname = (url = '') => {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./, '');
    } catch (err) {
        return url.replace(/^www\./, '');
    }
};

async function findWebSources(keywords, smartQueries, originalText, language = 'en') {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        logWarn('API credentials manquantes - impossibilité de consulter Google Custom Search.');
        return { sources: [], scoringSources: [], error: 'Missing Google API credentials' };
    }

    const normalizedLanguage = normalizeLanguageCode(language || 'en');
    const preparedQueries = [];
    const safeSmartQueries = Array.isArray(smartQueries) ? smartQueries.filter(Boolean) : [];
    const safeKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];

    for (const query of safeSmartQueries.slice(0, 3)) {
        preparedQueries.push(query);
    }

    if (preparedQueries.length === 0 && safeKeywords.length > 0) {
        preparedQueries.push(safeKeywords.slice(0, 4).join(' '));
    }

    if (preparedQueries.length === 0 && originalText) {
        preparedQueries.push(sanitizeInput(originalText).split(/\s+/).slice(0, 6).join(' '));
    }

    if (preparedQueries.length === 0) {
        return { sources: [], scoringSources: [], error: 'No query provided' };
    }

    const keywordSet = buildKeywordSet(safeKeywords, originalText);
    const collected = [];
    const seenQueries = new Set();

    for (let index = 0; index < preparedQueries.length; index += 1) {
        const query = preparedQueries[index];
        if (!query || seenQueries.has(query)) {
            continue;
        }
        seenQueries.add(query);

        if (index > 0) {
            await delay(Math.min(index * MAX_API_DELAY_MS, MAX_API_DELAY_MS));
        }

        const { items, error } = await queryGoogleSearch(query, normalizedLanguage, 8);
        if (error) {
            logWarn(`Google Custom Search error: ${sanitizeLogOutput(error)} (query: ${sanitizeLogOutput(query)})`);
        }
        if (!Array.isArray(items)) {
            continue;
        }

        for (const item of items) {
            const title = item?.title || 'Source';
            const url = item?.link || '';
            const snippet = item?.snippet || '';
            if (!url) {
                continue;
            }

            const domainInfo = scoreDomainTrust(url);
            const relevance = calculateTextRelevance(originalText, title, snippet);
            const combinedScore = (relevance * 0.6) + (domainInfo.credibility * 0.4);

            const contentLower = `${title} ${snippet}`.toLowerCase();
            let keywordMatch = keywordSet.size === 0;
            if (!keywordMatch) {
                for (const word of keywordSet) {
                    if (contentLower.includes(word)) {
                        keywordMatch = true;
                        break;
                    }
                }
            }

            if (!keywordMatch) {
                continue;
            }

            collected.push({
                title,
                url,
                snippet,
                relevance: Number(relevance.toFixed(2)),
                score: Number(combinedScore.toFixed(3)),
                credibility: domainInfo.credibility,
                category: domainInfo.category,
                domain: domainInfo.domain
            });
        }
    }

    const deduped = deduplicateByUrl(collected)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

    const sources = deduped.slice(0, 5).map(item => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        relevance: item.relevance
    }));

    const markdown = buildSourcesMarkdown(sources, normalizedLanguage);

    return {
        sources,
        scoringSources: deduped,
        mainSourcesMarkdown: markdown
    };
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
            const fallbackLanguage = detectLanguage(sanitizedInput);
            const fallbackLabel = getReliabilityLabel(fallbackLanguage, 'very_low');
            const details = {
                baseScore: 0,
                freshnessBonus: 0,
                consistencyBonus: 0,
                supportingSources: 0,
                contradictingSources: 0,
                credibleSources: 0
            };
            const analysisSummary = getAnalysisSummaryMessage(fallbackLanguage, 'very_low');
            return sendSafeJson(res, {
                summary: "Texte insuffisant pour une vérification fiable.",
                score: 0.25,
                reliabilityLabel: fallbackLabel,
                languageDetected: fallbackLanguage,
                language: fallbackLanguage,
                mainSources: [],
                mainSourcesMarkdown: '',
                details,
                overallConfidence: 0.25,
                confidence: 0.25,
                analysisSummary,
                keywords: [],
                sources: [],
                methodology: "Analyse équilibrée restaurée",
                reliabilityLevel: 'very_low',
                scoringBreakdown: details,
                summaryText: "Texte insuffisant pour une vérification fiable.",
                sourceFetchError: 'Input too short'
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
        const detectedLanguage = detectLanguage(sanitizedInput);
        const sourceResult = await findWebSources(keywords, sanitizedSmartQueries, sanitizedInput, detectedLanguage);
        const userSources = Array.isArray(sourceResult.sources) ? sourceResult.sources : [];
        const scoringSources = Array.isArray(sourceResult.scoringSources) && sourceResult.scoringSources.length > 0
            ? sourceResult.scoringSources
            : userSources;
        const analyzedSources = enrichSourcesForScoring(factChecker, sanitizedInput, scoringSources);
        const result = factChecker.calculateBalancedScore(sanitizedInput, analyzedSources, claims, detectedLanguage);

        const mainSourcesMarkdown = sourceResult.mainSourcesMarkdown && sourceResult.mainSourcesMarkdown.length > 0
            ? sourceResult.mainSourcesMarkdown
            : buildSourcesMarkdown(userSources, detectedLanguage);

        const response = {
            summary: result.summaryText,
            score: Number(result.score.toFixed(2)),
            reliabilityLabel: result.reliabilityLabel,
            languageDetected: detectedLanguage,
            language: detectedLanguage,
            analysisSummary: result.summaryText,
            overallConfidence: Number(result.score.toFixed(2)),
            confidence: Number(result.confidence.toFixed(2)),
            sources: userSources,
            mainSources: userSources,
            mainSourcesMarkdown,
            keywords,
            claimsAnalyzed: claims,
            methodology: "Analyse équilibrée restaurée",
            reliabilityLevel: result.reliabilityLevel,
            scoringBreakdown: result.breakdown,
            scoringDetails: result.details,
            sourceAnalysis: analyzedSources,
            sourceFetchError: sourceResult.error
        };

        verificationCache.set(cacheKey, response);

        logInfo(`✅ Score équilibré: ${Math.round(result.score * 100)}% (confiance: ${Math.round(result.confidence * 100)}%)`);
        logInfo(`📊 ${analyzedSources.length} sources utilisées | ${claims.length} faits détectés | ${analyzedSources.filter(s => s.supports).length} confirment`);
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
        const detectedLanguage = detectLanguage(sanitizedResponse);
        const sourceResult = await findWebSources(keywords, smartQueries, sanitizedResponse, detectedLanguage);
        const sources = Array.isArray(sourceResult.sources) ? sourceResult.sources : [];
        const scoringSources = Array.isArray(sourceResult.scoringSources) && sourceResult.scoringSources.length > 0
            ? sourceResult.scoringSources
            : sources;
        const analyzedSources = enrichSourcesForScoring(factChecker, sanitizedResponse, scoringSources);
        const result = factChecker.calculateBalancedScore(sanitizedResponse, analyzedSources, claims, detectedLanguage);

        const mainSources = sources;
        const mainSourcesMarkdown = sourceResult.mainSourcesMarkdown && sourceResult.mainSourcesMarkdown.length > 0
            ? sourceResult.mainSourcesMarkdown
            : buildSourcesMarkdown(mainSources, detectedLanguage);

        const responsePayload = {
            modelAnalyzed: model,
            summary: result.summaryText,
            score: Number(result.score.toFixed(2)),
            reliabilityScore: result.score,
            reasoningSummary: result.reasoning,
            analysisSummary: result.summaryText,
            sources,
            claims,
            keywords,
            language: detectedLanguage,
            mainSources,
            mainSourcesMarkdown,
            overallConfidence: result.score,
            reliabilityLabel: result.reliabilityLabel,
            reliabilityLevel: result.reliabilityLevel,
            details: result.details,
            scoringBreakdown: result.breakdown,
            summaryText: result.summaryText,
            sourceAnalysis: analyzedSources,
            sourceFetchError: sourceResult.error
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
                const fallbackLanguage = detectLanguage(rawResponse);
                comparison.push({
                    model: modelName,
                    score: 0,
                    confidence: 0,
                    summary: `Réponse rejetée: dépasse ${MAX_TEXT_LENGTH} caractères.`,
                    reliabilityLabel: getReliabilityLabel(fallbackLanguage, 'very_low'),
                    language: fallbackLanguage,
                    details: {
                        baseScore: 0,
                        freshnessBonus: 0,
                        consistencyBonus: 0,
                        supportingSources: 0,
                        contradictingSources: 0,
                        credibleSources: 0
                    },
                    mainSources: [],
                    mainSourcesMarkdown: '',
                    summaryText: `Réponse rejetée: dépasse ${MAX_TEXT_LENGTH} caractères.`,
                    scoringBreakdown: null,
                    sourcesCount: 0,
                    verifiedByMultipleTrustedSources: false,
                    sourceFetchError: 'Input too long'
                });
                continue;
            }

            const sanitizedResponse = sanitizeInput(rawResponse);

        if (!sanitizedResponse || sanitizedResponse.length < 10) {
            const fallbackLanguage = detectLanguage(rawResponse);
            const analysisSummary = getAnalysisSummaryMessage(fallbackLanguage, 'very_low');
            comparison.push({
                model: modelName,
                score: 0,
                confidence: 0,
                summary: 'Réponse insuffisante pour une analyse fiable.',
                reliabilityLabel: getReliabilityLabel(fallbackLanguage, 'very_low'),
                language: fallbackLanguage,
                analysisSummary,
                details: {
                    baseScore: 0,
                    sourceQuality: 0,
                    consensus: 0,
                    contextual: 0,
                    supportingSources: 0,
                    contradictingSources: 0,
                    reliableSources: 0
                },
                mainSources: [],
                mainSourcesMarkdown: '',
                summaryText: 'Réponse insuffisante pour une analyse fiable.',
                scoringBreakdown: null,
                sourcesCount: 0,
                sourceAnalysis: [],
                sourceFetchError: 'Input too short'
            });
            continue;
        }

            const detectedLanguage = detectLanguage(sanitizedResponse);
            const responseClaims = factChecker.extractVerifiableClaims(sanitizedResponse);
            const responseKeywords = extractMainKeywords(sanitizedResponse);
            const combinedKeywords = Array.from(new Set([...promptKeywords, ...responseKeywords]));

            const sourceResult = await findWebSources(combinedKeywords, smartQueries, sanitizedResponse, detectedLanguage);
            const sources = Array.isArray(sourceResult.sources) ? sourceResult.sources : [];
            const scoringSources = Array.isArray(sourceResult.scoringSources) && sourceResult.scoringSources.length > 0
                ? sourceResult.scoringSources
                : sources;
            const analyzedSources = enrichSourcesForScoring(factChecker, sanitizedResponse, scoringSources);
            const scoringClaims = responseClaims.length > 0 ? responseClaims : promptClaims;
            const result = factChecker.calculateBalancedScore(sanitizedResponse, analyzedSources, scoringClaims, detectedLanguage);

            const mainSources = sources;
            const mainSourcesMarkdown = sourceResult.mainSourcesMarkdown && sourceResult.mainSourcesMarkdown.length > 0
                ? sourceResult.mainSourcesMarkdown
                : buildSourcesMarkdown(mainSources, detectedLanguage);

            comparison.push({
                model: modelName,
                score: Number(result.score.toFixed(2)),
                confidence: Number(result.confidence.toFixed(2)),
                summary: result.summaryText,
                reliabilityLabel: result.reliabilityLabel,
                language: detectedLanguage,
                details: result.details,
                mainSources,
                mainSourcesMarkdown,
                analysisSummary: result.summaryText,
                summaryText: result.summaryText,
                scoringBreakdown: result.breakdown,
                sourcesCount: analyzedSources.length,
                sourceAnalysis: analyzedSources,
                sourceFetchError: sourceResult.error
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
