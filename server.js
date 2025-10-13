// --- Polyfill pour Node < 20 (Railway + Codex compat) ---
try {
    const { Blob, File } = require('buffer');
    const { fetch, FormData, Headers, Request, Response } = require('undici');

    if (!globalThis.fetch) globalThis.fetch = fetch;
    if (!globalThis.Headers) globalThis.Headers = Headers;
    if (!globalThis.Request) globalThis.Request = Request;
    if (!globalThis.Response) globalThis.Response = Response;
    if (!globalThis.FormData) globalThis.FormData = FormData;
    if (!globalThis.Blob) globalThis.Blob = Blob;
    if (!globalThis.File) globalThis.File = File;

    console.log('✅ Polyfills Blob/FormData/Fetch chargés pour Node < 20');
} catch (err) {
    console.warn('⚠️ Échec du polyfill Node < 20:', err.message);
}

// --- Polyfill for ReadableStream on Node < 20 ---
if (typeof ReadableStream === 'undefined') {
    global.ReadableStream = require('stream/web').ReadableStream;
}

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const pdfParse = require('pdf-parse');
const cheerio = require('cheerio');
const multer = require('multer');
const app = express();

let openai = null;
try {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} catch (error) {
    console.warn('⚠️ Client OpenAI non initialisé pour l\'analyse documentaire:', error.message);
}

app.use(cors({ 
    origin:'*',
    credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 25 * 1024 * 1024 // 25 MB
    }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const TRUSTED_DOMAINS = [
    'oecd.org',
    'imf.org',
    'worldbank.org',
    'who.int',
    'un.org',
    'ilo.org',
    'weforum.org',
    'banquemondiale.org',
    'data.gov',
    'europa.eu',
    'gouvernement.fr'
];

const MAX_SOURCE_CHARACTERS = 15000;
const MAX_PROMPT_SOURCES = 3;
const SOURCE_PROMPT_EXCERPT_LENGTH = 2000;

const parseUrlSafely = (value) => {
    try {
        return new URL(value);
    } catch (error) {
        return null;
    }
};

const isTrustedDomain = (value) => {
    const parsed = parseUrlSafely(value);
    if (!parsed) return false;
    const hostname = parsed.hostname.toLowerCase();
    return TRUSTED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
};

const cleanExtractedText = (text = '') => text.replace(/\s+/g, ' ').trim();

const extractTrustedSourceContent = async (targetUrl) => {
    const parsedUrl = parseUrlSafely(targetUrl);
    const hostname = parsedUrl?.hostname?.toLowerCase() || 'invalid-domain';
    console.log(`🔗 Source fetch attempt: ${hostname}`);

    if (!parsedUrl) {
        const error = new Error('invalid url');
        error.code = 'INVALID_URL';
        throw error;
    }

    if (!isTrustedDomain(targetUrl)) {
        const error = new Error('untrusted domain');
        error.code = 'UNTRUSTED_DOMAIN';
        throw error;
    }

    const response = await fetch(targetUrl);
    if (!response.ok) {
        const error = new Error(`failed to fetch: ${response.status}`);
        error.code = 'FETCH_FAILED';
        throw error;
    }

    const pathname = parsedUrl.pathname.toLowerCase();
    let textContent = '';

    if (pathname.endsWith('.pdf')) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const parsedPdf = await pdfParse(buffer);
        textContent = parsedPdf.text || '';
    } else {
        const html = await response.text();
        const $ = cheerio.load(html);
        $('script, style, noscript, iframe').remove();
        textContent = $('body').text();
    }

    const cleanedContent = cleanExtractedText(textContent).substring(0, MAX_SOURCE_CHARACTERS);

    return {
        domain: hostname,
        content: cleanedContent
    };
};

const ADMIN_EMAIL = 'nory.benali89@gmail.com';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// LIMITES SELON PLANS
const PLAN_LIMITS = {
    free: {
        dailyVerifications: 3,
        weeklyOtto: 1
    },
    starter: {
        dailyVerifications: 10,
        dailyOtto: 5
    },
    pro: {
        dailyVerifications: 30,
        dailyOtto: Infinity
    },
    business: {
        dailyVerifications: Infinity,
        dailyOtto: Infinity
    }
};

const userUsage = {};

const getISOWeekIdentifier = (date) => {
    const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
    return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

function getUserUsage(email) {
    if (!userUsage[email]) {
        const now = new Date();
        userUsage[email] = {
            checksToday: 0,
            checksWeek: 0,
            ottoToday: 0,
            ottoWeek: 0,
            lastReset: now.toISOString().slice(0, 10),
            lastWeek: getISOWeekIdentifier(now)
        };
    }
    return userUsage[email];
}

function resetUsageIfNeeded(usage) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (usage.lastReset !== today) {
        usage.checksToday = 0;
        usage.ottoToday = 0;
        usage.lastReset = today;
    }

    const currentWeek = getISOWeekIdentifier(now);
    if (usage.lastWeek !== currentWeek) {
        usage.checksWeek = 0;
        usage.ottoWeek = 0;
        usage.lastWeek = currentWeek;
    }
}

async function resolveUserPlan(email) {
    if (!email) return 'free';
    const user = await getUserByEmail(email);
    return user?.plan || 'free';
}

// ========== 4 AGENTS IA (OTTO) ==========

class AIAgentsService {
    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY;
        this.model = 'gpt-4o-mini';
    }

    async callOpenAI(systemPrompt, userPrompt, maxTokens = 500) {
        if (!this.apiKey) {
            console.warn('OpenAI API key manquante - Agent désactivé');
            return null;
        }

        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    max_tokens: maxTokens,
                    temperature: 0.3
                })
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = await response.json();
            return data.choices[0].message.content;

        } catch (error) {
            console.error('Erreur appel OpenAI:', error.message);
            return null;
        }
    }

    async factChecker(text, sources) {
        const systemPrompt = `You are an expert fact-checker. Analyze the text and identify:
1. VERIFIED claims (with proof from sources)
2. UNVERIFIED/FALSE claims (with explanation why)
3. Overall confidence score (0-100)

Return ONLY valid JSON:
{
  "score": 75,
  "verified_claims": [
    {"claim": "exact quote", "status": "verified", "source": "source name", "confidence": 95}
  ],
  "unverified_claims": [
    {"claim": "exact quote", "status": "false", "reason": "why it's false or unverified"}
  ],
  "summary": "brief overall assessment"
}`;

        const sourcesText = sources.slice(0, 3).map(s => 
            `Source: ${s.title}\nURL: ${s.url}\n${s.snippet}`
        ).join('\n\n---\n\n');

        const userPrompt = `Analyze this text and extract specific claims:

TEXT TO VERIFY:
"${text.substring(0, 1200)}"

SOURCES AVAILABLE:
${sourcesText}

Identify specific factual claims (statistics, dates, names, events) and verify each one against the sources. Return JSON only.`;

        const result = await this.callOpenAI(systemPrompt, userPrompt, 600);
        
        if (!result) {
            return {
                score: 50,
                verified_claims: [],
                unverified_claims: [{ claim: "Analysis unavailable", status: "unavailable", reason: "OpenAI API not configured" }],
                summary: "Agent unavailable"
            };
        }

        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (!parsed.verified_claims) parsed.verified_claims = [];
                if (!parsed.unverified_claims) parsed.unverified_claims = [];
                if (!parsed.score) parsed.score = 50;
                return parsed;
            }
            return { 
                score: 50, 
                verified_claims: [], 
                unverified_claims: [{ claim: result.substring(0, 150), status: "error", reason: "Could not parse response" }],
                summary: "Parsing error"
            };
        } catch (e) {
            console.error('Parse error fact_checker:', e);
            return { 
                score: 50, 
                verified_claims: [], 
                unverified_claims: [{ claim: "Parse error", status: "error", reason: e.message }],
                summary: "Error"
            };
        }
    }

    async sourceAnalyst(text, sources) {
        const systemPrompt = `You are a source credibility analyst. For each source provided, determine:
1. If it's a REAL source (exists and is credible)
2. If it's a FAKE/INVENTED source (doesn't exist or is unreliable)
3. Overall source quality score (0-100)

Return ONLY valid JSON:
{
  "score": 80,
  "real_sources": [
    {"citation": "source name", "status": "verified", "url": "url", "credibility": "high/medium/low"}
  ],
  "fake_sources": [
    {"citation": "source name", "status": "not_found", "reason": "why it's fake"}
  ],
  "summary": "brief assessment"
}`;

        const sourcesText = sources.map(s => 
            `Title: ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}`
        ).join('\n\n---\n\n');

        const userPrompt = `Analyze these sources and determine if they are real and credible:

TEXT CONTEXT:
"${text.substring(0, 600)}"

SOURCES TO ANALYZE:
${sourcesText}

Check if sources actually exist, are credible, and support the claims. Return JSON only.`;

        const result = await this.callOpenAI(systemPrompt, userPrompt, 600);
        
        if (!result) {
            return {
                score: 50,
                real_sources: sources.map(s => ({ citation: s.title, status: "unknown", url: s.url, credibility: "unknown" })),
                fake_sources: [],
                summary: "Agent unavailable"
            };
        }

        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (!parsed.real_sources) parsed.real_sources = [];
                if (!parsed.fake_sources) parsed.fake_sources = [];
                if (!parsed.score) parsed.score = 50;
                return parsed;
            }
            return { 
                score: 50, 
                real_sources: [], 
                fake_sources: [{ citation: "Parse error", status: "error", reason: "Could not parse response" }],
                summary: "Error"
            };
        } catch (e) {
            console.error('Parse error source_analyst:', e);
            return { 
                score: 50, 
                real_sources: [], 
                fake_sources: [{ citation: "Error", status: "error", reason: e.message }],
                summary: "Error"
            };
        }
    }

    async contextGuardian(text, sources) {
        const systemPrompt = `You are a context analysis expert. Identify what important information is MISSING or OMITTED from the text:
1. Missing temporal context (dates, timeframes)
2. Missing geographic context
3. Missing important facts
4. Context manipulation score (0-100, where 0 = complete, 100 = heavily manipulated)

Return ONLY valid JSON:
{
  "context_score": 25,
  "omissions": [
    {"type": "temporal/geographic/fact", "description": "what's missing", "importance": "critical/important/minor"}
  ],
  "manipulation_detected": true/false,
  "summary": "brief assessment"
}`;

        const sourcesText = sources.slice(0, 3).map(s => s.snippet).join('\n');

        const userPrompt = `Analyze what's MISSING from this text:

TEXT:
"${text.substring(0, 1200)}"

SOURCES FOR CONTEXT:
${sourcesText}

What important information is omitted? What context is missing? Return JSON only.`;

        const result = await this.callOpenAI(systemPrompt, userPrompt, 500);
        
        if (!result) {
            return {
                context_score: 50,
                omissions: [{ type: "unknown", description: "Analysis unavailable", importance: "unknown" }],
                manipulation_detected: false,
                summary: "Agent unavailable"
            };
        }

        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (!parsed.omissions) parsed.omissions = [];
                if (!parsed.context_score) parsed.context_score = 50;
                if (parsed.manipulation_detected === undefined) parsed.manipulation_detected = false;
                return parsed;
            }
            return { 
                context_score: 50, 
                omissions: [{ type: "error", description: "Parse error", importance: "unknown" }], 
                manipulation_detected: false,
                summary: "Error"
            };
        } catch (e) {
            console.error('Parse error context_guardian:', e);
            return { 
                context_score: 50, 
                omissions: [{ type: "error", description: e.message, importance: "unknown" }], 
                manipulation_detected: false,
                summary: "Error"
            };
        }
    }

    async freshnessDetector(text, sources) {
        const systemPrompt = `You are a data freshness analyst. Identify:
1. Recent data (< 6 months old)
2. Outdated data (> 18 months old)
3. Freshness score (0-100, where 100 = very recent)

Return ONLY valid JSON:
{
  "freshness_score": 75,
  "recent_data": [
    {"data_point": "what data", "age": "how old", "relevance": "why it matters"}
  ],
  "outdated_data": [
    {"data_point": "what data", "age": "how old", "concern": "why it's a problem"}
  ],
  "summary": "brief assessment"
}`;

        const sourcesText = sources.slice(0, 3).map(s => 
            `${s.title}\n${s.snippet}`
        ).join('\n\n');

        const userPrompt = `Evaluate data freshness:

TEXT:
"${text.substring(0, 1200)}"

SOURCES:
${sourcesText}

Identify recent vs outdated information. Return JSON only.`;

        const result = await this.callOpenAI(systemPrompt, userPrompt, 500);
        
        if (!result) {
            return {
                freshness_score: 50,
                recent_data: [],
                outdated_data: [{ data_point: "Unknown", age: "unknown", concern: "Analysis unavailable" }],
                summary: "Agent unavailable"
            };
        }

        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (!parsed.recent_data) parsed.recent_data = [];
                if (!parsed.outdated_data) parsed.outdated_data = [];
                if (!parsed.freshness_score) parsed.freshness_score = 50;
                return parsed;
            }
            return { 
                freshness_score: 50, 
                recent_data: [], 
                outdated_data: [{ data_point: "Parse error", age: "unknown", concern: "Could not parse" }],
                summary: "Error"
            };
        } catch (e) {
            console.error('Parse error freshness_detector:', e);
            return { 
                freshness_score: 50, 
                recent_data: [], 
                outdated_data: [{ data_point: "Error", age: "unknown", concern: e.message }],
                summary: "Error"
            };
        }
    }

    async runAllAgents(text, sources) {
        console.log('🤖 Lancement des 4 agents Otto...');

        const [factCheck, sourceAnalysis, contextAnalysis, freshnessAnalysis] = await Promise.all([
            this.factChecker(text, sources),
            this.sourceAnalyst(text, sources),
            this.contextGuardian(text, sources),
            this.freshnessDetector(text, sources)
        ]);

        console.log('✅ Agents Otto terminés:');
        console.log(`   Fact Checker: ${factCheck.verified_claims?.length || 0} vérifiées, ${factCheck.unverified_claims?.length || 0} non vérifiées`);
        console.log(`   Source Analyst: ${sourceAnalysis.real_sources?.length || 0} réelles, ${sourceAnalysis.fake_sources?.length || 0} fake`);
        console.log(`   Context Guardian: ${contextAnalysis.omissions?.length || 0} omissions`);
        console.log(`   Freshness: ${freshnessAnalysis.recent_data?.length || 0} récentes, ${freshnessAnalysis.outdated_data?.length || 0} obsolètes`);

        return {
            fact_checker: factCheck,
            source_analyst: sourceAnalysis,
            context_guardian: contextAnalysis,
            freshness_detector: freshnessAnalysis
        };
    }
}

// ========== FACT-CHECKING CLASSIQUE ==========

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

    extractVerifiableClaims(text) {
        const claims = [];
        const cleanText = sanitizeInput(text);
        
        const numberClaims = cleanText.match(/\b\d+([,\.]\d+)?\s*(millions?|milliards?|billions?|%|pour\s*cent|kilomètres?|km|habitants?|années?|ans|dollars?|\$|euros?|€)\b/gi);
        if (numberClaims) {
            claims.push(...numberClaims.slice(0, 3).map(claim => ({
                type: 'QUANTITATIVE',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.9
            })));
        }

        const historicalClaims = cleanText.match(/\b(en|in|depuis|from|until)\s+(19|20)\d{2}.*?(fondé|créé|né|mort|established|founded|born|died|independence|indépendance|guerre|war)\b/gi);
        if (historicalClaims) {
            claims.push(...historicalClaims.slice(0, 2).map(claim => ({
                type: 'HISTORICAL',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.85
            })));
        }

        const geoClaims = cleanText.match(/\b(capitale|capital|population|superficie|area|situé|located)\s+(de|of|dans|in)\s+[A-Z][a-zA-ZÀ-ÿ\s]+\b/gi);
        if (geoClaims) {
            claims.push(...geoClaims.slice(0, 2).map(claim => ({
                type: 'GEOGRAPHIC',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.95
            })));
        }

        const sciClaims = cleanText.match(/\b(vitesse.*lumière|point.*ébullition|formule.*chimique|speed.*light|boiling.*point|chemical.*formula|299.*792.*458|température|temperature)\b/gi);
        if (sciClaims) {
            claims.push(...sciClaims.slice(0, 2).map(claim => ({
                type: 'SCIENTIFIC',
                text: claim.trim(),
                verifiable: true,
                confidence: 0.92
            })));
        }

        console.log(`📋 Claims extraits: ${claims.length}`);
        return claims;
    }

    analyzeContentType(text, claims) {
        const lower = text.toLowerCase();
        
        const opinionPatterns = [
            /\b(je pense|je crois|à mon avis|personnellement|subjectivement)\b/i,
            /\b(i think|i believe|in my opinion|personally|subjectively)\b/i,
            /\b(meilleur|pire|préfère|favorite|best|worst|better than|worse than)\b/i
        ];
        
        if (opinionPatterns.some(pattern => pattern.test(text))) {
            return {
                type: 'OPINION',
                baseScore: 0.40,
                reasoning: 'Opinion subjective (40%) - Point de vue personnel nécessitant d\'autres perspectives.'
            };
        }

        if (text.length < 300 && (/^(what|how|why|when|where|qui|quoi|comment|pourquoi|quand|où)/i.test(text.trim()) || text.includes('?'))) {
            return {
                type: 'QUESTION',
                baseScore: 0.30,
                reasoning: 'Question utilisateur (30%) - Demande d\'information directe.'
            };
        }

        if (claims.length > 0) {
            const hasScientific = claims.some(c => c.type === 'SCIENTIFIC');
            const hasQuantitative = claims.some(c => c.type === 'QUANTITATIVE');
            const hasHistorical = claims.some(c => c.type === 'HISTORICAL');
            const hasGeographic = claims.some(c => c.type === 'GEOGRAPHIC');
            
            if (hasScientific) {
                return {
                    type: 'SCIENTIFIC_FACT',
                    baseScore: 0.75,
                    reasoning: 'Fait scientifique (75%) - Information scientifique établie et vérifiable.'
                };
            } else if (hasGeographic) {
                return {
                    type: 'GEOGRAPHIC_FACT',
                    baseScore: 0.70,
                    reasoning: 'Fait géographique (70%) - Données géographiques officielles vérifiables.'
                };
            } else if (hasQuantitative) {
                return {
                    type: 'STATISTICAL_FACT',
                    baseScore: 0.72,
                    reasoning: 'Données quantitatives (72%) - Statistiques mesurables et vérifiables.'
                };
            } else if (hasHistorical) {
                return {
                    type: 'HISTORICAL_FACT',
                    baseScore: 0.68,
                    reasoning: 'Fait historique (68%) - Information historique documentée.'
                };
            }
        }

        return {
            type: 'GENERAL_INFO',
            baseScore: 0.50,
            reasoning: 'Information générale (50%) - Contenu informatif standard.'
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
                hasTotal: /\b(total|ensemble|including|avec|with)\b/i.test(text),
                hasPartial: /\b(seulement|only|just|environ|approximately|about)\b/i.test(text)
            }
        };
    }

    areComplementaryContexts(context1, context2) {
        if ((context1.geographic.hasCity && context2.geographic.hasMetro) ||
            (context1.geographic.hasMetro && context2.geographic.hasCity)) {
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

    isTrueContradiction(num1, num2, context1, context2) {
        if (JSON.stringify(context1) === JSON.stringify(context2)) {
            return true;
        }
        
        if (this.areComplementaryContexts(context1, context2)) {
            return false;
        }
        
        return Math.abs(num1.value - num2.value) / num1.value > 3.0;
    }

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

        if (supportingHigh > 0) {
            qualityScore += supportingHigh * 0.20;
        } else if (supportingAny >= 3) {
            qualityScore += 0.15;
        } else if (supportingAny > 0) {
            qualityScore += supportingAny * 0.08;
        }

        if (contradictingHigh > 0) {
            qualityScore -= contradictingHigh * 0.08;
        }

        if (sources.length >= 3) {
            qualityScore += 0.05;
        }

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

        const hasTier1 = sources.some(s => s.credibilityTier === 'tier1');
        const hasTier2 = sources.some(s => s.credibilityTier === 'tier2');
        const hasTier3 = sources.some(s => s.credibilityTier === 'tier3');
        
        if ((hasTier1 && hasTier2) || (hasTier1 && hasTier3) || (hasTier2 && hasTier3)) {
            coherenceScore += 0.04;
        }

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

    calculateBalancedScore(originalText, analyzedSources, claims) {
        let totalScore = 0;
        let confidence = 0;
        const reasoning = [];

        console.log(`📊 Calcul du score équilibré...`);

        const contentType = this.analyzeContentType(originalText, claims);
        totalScore += contentType.baseScore;
        reasoning.push(contentType.reasoning);
        confidence += 0.3;

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

        // SCORING DYNAMIQUE
        const baseConfidence = contentType.baseScore;
        const sourceBonus = sourceEval.impact;
        const consensusBonus = consensus.bonus;
        const contextBonusValue = contextBonus.bonus;

        let finalScore = baseConfidence + sourceBonus + consensusBonus + contextBonusValue;

        const tier1Count = analyzedSources.filter(s => s.credibilityTier === 'tier1').length;
        const supportingHigh = analyzedSources.filter(s => s.actuallySupports && s.credibilityMultiplier > 0.8).length;

        if (tier1Count >= 3 && supportingHigh >= 2) {
            finalScore = Math.min(0.95, finalScore + 0.10);
        }

        finalScore = Math.max(0.25, Math.min(0.95, finalScore));

        // ✅ RETURN AJOUTÉ (c'était le bug!)
        return {
            score: finalScore,
            confidence: Math.min(1.0, confidence),
            reasoning: reasoning.join(' '),
            details: {
                contentType: contentType.type,
                baseScore: contentType.baseScore,
                sourceImpact: sourceEval.impact,
                consensusBonus: consensus.bonus,
                contextBonus: contextBonus.bonus
            }
        };
    }

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
        
        const similarity = union.size > 0 ? intersection.size / union.size : 0;
        
        return {
            score: similarity,
            confirms: similarity > 0.15
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
            console.error(`❌ Erreur analyse source ${source.url}:`, error.message);
            
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
        console.error('❌ Erreur extraction keywords:', e.message);
        return [];
    }
}

async function findWebSources(keywords, smartQueries, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        console.log('⚠️ API credentials manquantes - sources mock');
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
                console.error(`❌ Erreur recherche pour "${query}":`, error.message);
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
            console.error('❌ Erreur recherche fallback:', error.message);
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
    
    console.log(`🔍 ${uniqueSources.length} sources uniques trouvées`);
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
    
    return Math.max(0.1, Math.min(1.0, score));
}

// ========== GESTION UTILISATEURS ==========

async function getUserByEmail(email) {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

async function checkAndResetCounters(user) {
    const client = await pool.connect();
    try {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const lastCheckDate = user.last_check_date || '';
        
        if (lastCheckDate !== today) {
            await client.query(
                'UPDATE users SET daily_checks_used = 0, daily_otto_analysis = 0, last_check_date = $1 WHERE id = $2',
                [today, user.id]
            );
            user.daily_checks_used = 0;
            user.daily_otto_analysis = 0;
        }
        
        if (user.plan === 'free') {
            const lastWeeklyReset = user.weekly_reset_date ? new Date(user.weekly_reset_date) : null;
            const currentDayOfWeek = now.getDay();
            
            if (currentDayOfWeek === 1 && (!lastWeeklyReset || lastWeeklyReset.toISOString().split('T')[0] !== today)) {
                await client.query(
                    'UPDATE users SET weekly_otto_analysis = 0, weekly_reset_date = $1 WHERE id = $2',
                    [today, user.id]
                );
                user.weekly_otto_analysis = 0;
            }
        }
        
        return user;
    } finally {
        client.release();
    }
}

async function checkVerificationLimit(userId) {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
        if (!result.rows[0]) return { allowed: false, remaining: 0 };
        
        let user = result.rows[0];
        user = await checkAndResetCounters(user);
        
        if (user.role === 'admin') return { allowed: true, remaining: 999, plan: user.plan };
        
        const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
        const dailyLimit = limits.dailyVerifications;
        
        if (dailyLimit === Infinity) {
            return { allowed: true, remaining: Infinity, plan: user.plan };
        }
        
        if (user.daily_checks_used >= dailyLimit) {
            return { allowed: false, remaining: 0, plan: user.plan };
        }
        
        return { allowed: true, remaining: dailyLimit - user.daily_checks_used, plan: user.plan };
    } finally {
        client.release();
    }
}

async function checkOttoLimit(userId) {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
        if (!result.rows[0]) return { allowed: false, remaining: 0 };
        
        let user = result.rows[0];
        user = await checkAndResetCounters(user);
        
        if (user.role === 'admin') return { allowed: true, remaining: 999, plan: user.plan };
        
        const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
        
        if (user.plan === 'free') {
            const weeklyLimit = limits.weeklyOtto;
            if (user.weekly_otto_analysis >= weeklyLimit) {
                return { allowed: false, remaining: 0, plan: user.plan, resetType: 'weekly' };
            }
            return { allowed: true, remaining: weeklyLimit - user.weekly_otto_analysis, plan: user.plan, resetType: 'weekly' };
        } else if (user.plan === 'starter') {
            const dailyLimit = limits.dailyOtto;
            if (user.daily_otto_analysis >= dailyLimit) {
                return { allowed: false, remaining: 0, plan: user.plan, resetType: 'daily' };
            }
            return { allowed: true, remaining: dailyLimit - user.daily_otto_analysis, plan: user.plan, resetType: 'daily' };
        } else {
            return { allowed: true, remaining: Infinity, plan: user.plan, resetType: 'none' };
        }
    } finally {
        client.release();
    }
}

async function incrementVerificationCount(userId) {
    const client = await pool.connect();
    try {
        await client.query('UPDATE users SET daily_checks_used = daily_checks_used + 1 WHERE id = $1', [userId]);
    } finally {
        client.release();
    }
}

async function incrementOttoCount(userId, plan) {
    const client = await pool.connect();
    try {
        if (plan === 'free') {
            await client.query('UPDATE users SET weekly_otto_analysis = weekly_otto_analysis + 1 WHERE id = $1', [userId]);
        } else {
            await client.query('UPDATE users SET daily_otto_analysis = daily_otto_analysis + 1 WHERE id = $1', [userId]);
        }
    } finally {
        client.release();
    }
}

async function runDocumentaryAnalysis(text) {
    const cleanText = text.trim().slice(0, 1000);

    const keywordPrompt = `
  Extrait les 3 à 6 mots-clés essentiels du texte suivant pour une recherche documentaire :
  """${cleanText}"""
  Retourne uniquement les mots-clés, séparés par des virgules.
  `;

    let keywords = [];

    if (openai?.chat?.completions?.create) {
        try {
            const keywordResponse = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: keywordPrompt }],
            });

            const rawKeywords = keywordResponse?.choices?.[0]?.message?.content || '';
            keywords = rawKeywords
                .split(',')
                .map(k => k.trim())
                .filter(k => k.length > 2)
                .slice(0, 6);
        } catch (error) {
            console.warn('⚠️ Erreur OpenAI (analyse documentaire):', error.message);
        }
    }

    if (!keywords.length) {
        const stopwords = new Set([
            'la', 'le', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'en', 'au', 'aux', 'dans', 'par', 'pour', 'sur',
            'avec', 'sans', 'plus', 'moins', 'entre', 'selon', 'que', 'qui', 'quoi', 'dont', 'est', 'sont', 'ete', 'etre',
            'fait', 'faire', 'cette', 'ces', 'son', 'sa', 'ses', 'leur', 'leurs'
        ]);

        keywords = Array.from(
            new Set(
                cleanText
                    .toLowerCase()
                    .normalize('NFD')
                    .replace(/\p{Diacritic}/gu, '')
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .split(/\s+/)
                    .map(word => word.trim())
                    .filter(word => word.length > 2 && !stopwords.has(word))
            )
        ).slice(0, 6);
    } else {
        const deduped = [];
        const seen = new Set();
        for (const keyword of keywords) {
            const lower = keyword.toLowerCase();
            if (lower && !seen.has(lower)) {
                seen.add(lower);
                deduped.push(keyword);
            }
        }
        keywords = deduped.slice(0, 6);
    }

    if (!keywords.length) {
        keywords = ['information'];
    }

    const limitedKeywords = keywords.slice(0, 5);
    const sources = limitedKeywords.map((kw, i) => ({
        title: `Source ${i + 1} : ${kw}`,
        url: `https://www.google.com/search?q=${encodeURIComponent(kw)}`,
        status: 'analyse en cours',
    }));

    const hasNumbers = /\d+/.test(text);
    const hasSourcesMentioned = /(source|rapport|étude|wikipedia|insee|giec|nasa)/i.test(text);
    const diversity = keywords.length >= 4 ? 10 : 0;

    let score = 50;
    if (hasNumbers) score += 10;
    if (hasSourcesMentioned) score += 15;
    score += diversity;

    const summary = `Analyse documentaire effectuée : ${keywords.length} mots-clés détectés (${keywords.join(', ')}).`;

    return {
        score: Math.min(Math.round(score), 100),
        summary,
        sources,
    };
}

// ========== ROUTES ==========

app.post('/auth/signup', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) return res.status(400).json({ success: false, error: 'Email et mot de passe requis' });
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return res.status(400).json({ success: false, error: 'Email invalide' });
        if (password.length < 6) return res.status(400).json({ success: false, error: 'Mot de passe trop court (min 6)' });
        
        const existing = await getUserByEmail(email);
        if (existing) return res.status(400).json({ success: false, error: 'Email déjà utilisé' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const client = await pool.connect();
        const result = await client.query(
            `INSERT INTO users (email, password_hash, role, plan, daily_checks_used, daily_otto_analysis, weekly_otto_analysis, last_check_date, weekly_reset_date) 
             VALUES ($1, $2, 'user', 'free', 0, 0, 0, CURRENT_DATE, CURRENT_DATE) 
             RETURNING id, email, role, plan`,
            [email.toLowerCase(), hashedPassword]
        );
        client.release();
        
        console.log(`✅ Nouveau compte FREE créé: ${email}`);
        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        console.error('❌ Erreur signup:', error);
        res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
});

app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ success: false, error: 'Email et mot de passe requis' });
        
        const user = await getUserByEmail(email);
        if (!user) return res.status(401).json({ success: false, error: 'Email ou mot de passe incorrect' });
        
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(401).json({ success: false, error: 'Email ou mot de passe incorrect' });
        
        console.log(`✅ Connexion: ${email} (${user.plan})`);
        res.json({ success: true, user: { id: user.id, email: user.email, plan: user.plan, role: user.role } });
    } catch (error) {
        console.error('❌ Erreur login:', error);
        res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
});

// ========== ROUTE VÉRIFICATION CLASSIQUE ==========
app.post('/verify', async (req, res) => {
    try {
        const { text, userEmail } = req.body || {};

        if (!text || !userEmail) {
            return res.status(400).json({ error: 'Texte ou email manquant' });
        }

        const usage = getUserUsage(userEmail);
        resetUsageIfNeeded(usage);

        const plan = await resolveUserPlan(userEmail);
        const normalizedPlan = typeof plan === 'string' ? plan.toLowerCase() : 'free';
        const limitConfig = PLAN_LIMITS[normalizedPlan] || PLAN_LIMITS.free;
        const dailyLimit = limitConfig.dailyVerifications;

        if (Number.isFinite(dailyLimit) && usage.checksToday >= dailyLimit) {
            return res.status(403).json({ error: 'Limite quotidienne atteinte' });
        }

        const result = await runDocumentaryAnalysis(text);

        usage.checksToday++;
        usage.checksWeek++;

        res.json({
            ...result,
            usage: {
                today: usage.checksToday,
                week: usage.checksWeek
            }
        });
    } catch (error) {
        console.error('Erreur /verify :', error);
        res.status(500).json({ error: 'Erreur interne' });
    }
});

// ========== ROUTE RÉCUPÉRATION SOURCES FIABLES ==========
app.post('/fetch-source', async (req, res) => {
    const { url } = req.body || {};

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'invalid url' });
    }

    try {
        const { content } = await extractTrustedSourceContent(url.trim());
        return res.json({ content });
    } catch (error) {
        if (error.code === 'UNTRUSTED_DOMAIN') {
            return res.status(400).json({ error: 'untrusted domain' });
        }
        if (error.code === 'INVALID_URL') {
            return res.status(400).json({ error: 'invalid url' });
        }

        console.error('❌ Erreur récupération source:', error.message || error);
        return res.status(500).json({ error: 'failed to fetch source' });
    }
});

// ====== Analyse Otto améliorée ======
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const getOttoBarColor = (trustIndex) => {
    if (trustIndex >= 75) {
        return '#22c55e';
    }
    if (trustIndex >= 50) {
        return '#f97316';
    }
    return '#ef4444';
};

async function runOttoAnalysis(text) {
    const apiKey = process.env.OPENAI_API_KEY;
    const prompt = `Tu es Otto, un auditeur d'information.
Ton rôle est d'évaluer la fiabilité d’un texte en analysant :
1️⃣ La véracité des faits.
2️⃣ La crédibilité et la diversité des sources citées.
3️⃣ La clarté du contexte et des méthodologies.
4️⃣ La fraîcheur et l’actualité des informations.

Analyse le texte suivant :
"""${text}"""

Fournis une synthèse brève et neutre (3 à 5 phrases) qui résume :
- Ce qui est vérifiable.
- Ce qui manque.
- Ce qui semble cohérent ou douteux.`;

    if (!apiKey) {
        console.warn('⚠️ OPENAI_API_KEY manquant - résumé Otto dégradé.');
        return 'Résumé indisponible : configurez une clé OpenAI pour obtenir une analyse détaillée.';
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                max_tokens: 400
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        const data = await response.json();
        return data?.choices?.[0]?.message?.content?.trim() || 'Analyse Otto indisponible.';
    } catch (error) {
        console.error('❌ Erreur OpenAI Otto:', error.message || error);
        return 'Analyse Otto indisponible pour le moment.';
    }
}

function evaluateOttoAgents(text) {
    const normalized = text.toLowerCase();
    const sourceKeywords = ['giec', 'nasa', 'noaa', 'unesco', 'mckinsey', 'rapport', 'étude', 'source', 'publication', 'journal'];
    const riskKeywords = ['rumeur', 'controversé', 'non confirmé', 'hoax'];
    const claimKeywords = ['affirme', 'déclare', 'selon', 'prétend', 'annonce', 'indique'];
    const recencyIndicators = ['2020', '2021', '2022', '2023', '2024', '2025', 'récent', 'récente', 'nouveau', 'nouvelle étude'];
    const temporalIndicators = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre', '202', '20'];

    const sourceMatches = sourceKeywords.reduce((count, keyword) => count + (normalized.includes(keyword) ? 1 : 0), 0);
    const hasSources = sourceMatches > 0;
    const hasMultipleSources = sourceMatches > 2;
    const hasClaims = claimKeywords.some(keyword => normalized.includes(keyword));
    const hasNumbers = /(\d+\s?%|\d{4})/.test(text);
    const hasRecency = recencyIndicators.some(keyword => normalized.includes(keyword));
    const hasContextualDetails = text.length > 220 || temporalIndicators.some(keyword => normalized.includes(keyword));
    const hasWarnings = riskKeywords.some(keyword => normalized.includes(keyword));

    const factCheckerScore = clamp(65 + (hasSources ? 15 : 0) + (hasClaims ? 0 : 5) + (hasWarnings ? -20 : 0) + (hasNumbers && !hasSources ? -10 : 0), 25, 95);
    const sourceAnalystScore = clamp(55 + (hasSources ? 20 : -10) + (hasMultipleSources ? 10 : 0) + (hasWarnings ? -15 : 0), 20, 92);
    const contextGuardianScore = clamp(60 + (hasContextualDetails ? 10 : -15) + (hasSources ? 5 : 0) + (hasClaims && !hasContextualDetails ? -10 : 0), 25, 90);
    const freshnessDetectorScore = clamp(58 + (hasRecency ? 20 : -8) + (hasNumbers ? 5 : 0), 20, 95);

    const agents = [
        {
            name: 'Fact Checker',
            score: factCheckerScore,
            comment: hasSources
                ? 'Contexte: Le texte cite des références identifiées ou des données précises. Ce que l’agent constate: la plupart des affirmations semblent alignées avec les éléments fournis. Ce que l’agent suggère pour améliorer la fiabilité: ajouter les passages exacts ou les chiffres clés des sources pour verrouiller la vérification.'
                : hasClaims
                    ? 'Contexte: Plusieurs affirmations structurent le discours mais elles ne s’appuient pas sur des preuves explicites. Ce que l’agent constate: ces déclarations restent difficiles à corroborer sans trace citée. Ce que l’agent suggère pour améliorer la fiabilité: inclure des références vérifiables ou des chiffres précis pour chaque affirmation sensible.'
                    : 'Contexte: Le texte demeure général et évite les faits chiffrés ou engagements fermes. Ce que l’agent constate: il y a peu d’éléments susceptibles d’être validés objectivement. Ce que l’agent suggère pour améliorer la fiabilité: introduire quelques données vérifiables ou indiquer les sources d’origine lorsque c’est pertinent.'
        },
        {
            name: 'Source Analyst',
            score: sourceAnalystScore,
            comment: hasSources
                ? hasMultipleSources
                    ? 'Contexte: Le texte mobilise plusieurs références externes distinctes. Ce que l’agent constate: la diversité des sources réduit le risque de biais et renforce la cohérence générale. Ce que l’agent suggère pour améliorer la fiabilité: conserver cette pluralité et ajouter, si possible, les liens directs ou références bibliographiques complètes.'
                    : 'Contexte: Une source principale est citée pour appuyer l’argumentation. Ce que l’agent constate: la fiabilité dépend fortement de cette référence unique. Ce que l’agent suggère pour améliorer la fiabilité: croiser l’information avec au moins une seconde source indépendante ou plus spécialisée.'
                : 'Contexte: Aucun renvoi explicite vers une publication ou un organisme n’est mentionné. Ce que l’agent constate: l’origine de l’information reste opaque et difficile à évaluer. Ce que l’agent suggère pour améliorer la fiabilité: indiquer clairement les rapports, études ou médias consultés afin d’ouvrir la vérification.'
        },
        {
            name: 'Context Guardian',
            score: contextGuardianScore,
            comment: hasContextualDetails
                ? 'Contexte: Le texte intègre des détails méthodologiques, géographiques ou temporels suffisants. Ce que l’agent constate: les conditions d’application sont claires et réduisent les interprétations abusives. Ce que l’agent suggère pour améliorer la fiabilité: rappeler explicitement les limites ou hypothèses clés pour compléter ce cadrage déjà solide.'
                : 'Contexte: Les indications sur la période, le lieu ou la méthode sont limitées ou absentes. Ce que l’agent constate: le lecteur doit supposer plusieurs paramètres implicites. Ce que l’agent suggère pour améliorer la fiabilité: préciser les dates, périmètres ou conditions de collecte afin de situer correctement l’information.'
        },
        {
            name: 'Freshness Detector',
            score: freshnessDetectorScore,
            comment: hasRecency
                ? 'Contexte: Le texte évoque des données ou événements récents et identifiables. Ce que l’agent constate: les repères temporels suggèrent une information encore d’actualité. Ce que l’agent suggère pour améliorer la fiabilité: préciser la date de publication des sources citées pour confirmer la fraîcheur.'
                : 'Contexte: Les éléments cités ne fournissent pas de repère temporel clair. Ce que l’agent constate: certaines données pourraient être dépassées sans que cela soit signalé. Ce que l’agent suggère pour améliorer la fiabilité: indiquer explicitement l’année ou la période de référence et vérifier si des mises à jour existent.'
        }
    ];

    const trustIndex = Math.round(
        agents[0].score * 0.4 +
        agents[1].score * 0.3 +
        agents[2].score * 0.2 +
        agents[3].score * 0.1
    );

    const risk = trustIndex >= 75 ? 'Faible' : trustIndex >= 50 ? 'Moyen' : 'Élevé';
    const barColor = getOttoBarColor(trustIndex);

    return { trustIndex, risk, agents, barColor };
}

// ========== ROUTE ANALYSE OTTO (APPROFONDIE) ==========
app.post('/verify-otto', async (req, res) => {
    try {
        const { text, userEmail } = req.body || {};

        if (!text || !userEmail) {
            return res.status(400).json({ error: 'Texte ou email manquant' });
        }

        const usage = getUserUsage(userEmail);
        resetUsageIfNeeded(usage);

        const plan = await resolveUserPlan(userEmail);
        const normalizedPlan = typeof plan === 'string' ? plan.toLowerCase() : 'free';
        const limitConfig = PLAN_LIMITS[normalizedPlan] || PLAN_LIMITS.free;

        if (normalizedPlan === 'free') {
            const weeklyLimit = limitConfig.weeklyOtto ?? Infinity;
            if (Number.isFinite(weeklyLimit) && usage.ottoWeek >= weeklyLimit) {
                return res.status(403).json({ error: 'Limite hebdomadaire Otto atteinte' });
            }
        } else {
            const dailyLimit = limitConfig.dailyOtto ?? Infinity;
            if (Number.isFinite(dailyLimit) && usage.ottoToday >= dailyLimit) {
                return res.status(403).json({ error: 'Limite quotidienne Otto atteinte' });
            }
        }

        console.log('🚀 [OTTO] Audit démarré');

        const summary = await runOttoAnalysis(text.trim());
        const { trustIndex, risk, agents, barColor } = evaluateOttoAgents(text);

        usage.ottoToday++;
        usage.ottoWeek++;

        console.log(`✅ [OTTO] Indice calculé: ${trustIndex}% | Risque ${risk}`);

        return res.json({
            trustIndex,
            risk,
            summary,
            agents,
            barColor,
            usage: {
                today: usage.ottoToday,
                week: usage.ottoWeek
            }
        });

    } catch (error) {
        console.error('❌ Erreur Otto :', error);
        return res.status(500).json({ error: 'Erreur interne Otto' });
    }
});

// ========== AUTRES ROUTES ==========

app.post('/subscribe', async (req, res) => {
    try {
        const { email, name, source } = req.body;
        
        console.log(`📧 Nouvelle inscription email:`);
        console.log(`   Email: ${email}`);
        console.log(`   Nom: ${name || 'Non fourni'}`);
        console.log(`   Source: ${source || 'unknown'}`);
        
        if (!email || typeof email !== 'string') {
            return res.status(400).json({ 
                success: false, 
                error: 'Email invalide' 
            });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Format email invalide' 
            });
        }
        
        const sanitizedEmail = email.toLowerCase().trim().substring(0, 255);
        const sanitizedName = name ? name.trim().substring(0, 100) : null;
        const sanitizedSource = source ? source.substring(0, 50) : 'unknown';
        
        const client = await pool.connect();
        
        try {
            const existingUser = await client.query(
                'SELECT * FROM emails WHERE email = $1',
                [sanitizedEmail]
            );
            
            if (existingUser.rows.length > 0) {
                console.log(`⚠️ Email déjà existant: ${sanitizedEmail}`);
                
                return res.json({ 
                    success: true, 
                    message: 'Email already subscribed',
                    alreadySubscribed: true
                });
            }
            
            await client.query(
                'INSERT INTO emails (email, name, source, created_at) VALUES ($1, $2, $3, NOW())',
                [sanitizedEmail, sanitizedName, sanitizedSource]
            );
            
            console.log(`✅ Nouvel abonné: ${sanitizedEmail} (${sanitizedSource})`);
            
            res.json({ 
                success: true, 
                message: 'Successfully subscribed',
                alreadySubscribed: false
            });
            
        } finally {
            client.release();
        }
        
    } catch (error) {
        console.error('❌ Erreur subscription:', error);
        
        if (error.message.includes('column')) {
            try {
                const client = await pool.connect();
                await client.query(
                    'INSERT INTO emails (email) VALUES ($1)',
                    [email.toLowerCase().trim()]
                );
                client.release();
                
                console.log(`✅ Email enregistré (mode simple): ${email}`);
                return res.json({ success: true, message: 'Subscribed' });
            } catch (err2) {
                console.error('❌ Erreur insertion simple:', err2);
            }
        }
        
        res.status(500).json({ 
            success: false, 
            error: 'Erreur serveur lors de l\'inscription' 
        });
    }
});

app.get('/check-email', async (req, res) => {
    try {
        const { email } = req.query;
        
        if (!email) {
            return res.json({ subscribed: false });
        }
        
        const client = await pool.connect();
        const result = await client.query(
            'SELECT email, created_at FROM emails WHERE email = $1',
            [email.toLowerCase().trim()]
        );
        client.release();
        
        if (result.rows.length > 0) {
            res.json({ 
                subscribed: true,
                subscribedAt: result.rows[0].created_at
            });
        } else {
            res.json({ subscribed: false });
        }
        
    } catch (error) {
        console.error('❌ Erreur check email:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

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

app.post('/stripe/webhook', async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
        console.warn('⚠️ Stripe non configuré');
        return res.status(400).send('Stripe not configured');
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('❌ Webhook error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`\n💳 Stripe Event: ${event.type}`);

    try {
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const customerEmail = session.customer_email || session.customer_details?.email;
            const amountPaid = session.amount_total / 100;

            if (!customerEmail) {
                console.error('❌ Email manquant');
                return res.json({ received: true });
            }

            console.log(`💰 Paiement: ${customerEmail} - ${amountPaid}€`);

            let planType = 'starter';
            if (amountPaid >= 119) planType = 'business';
            else if (amountPaid >= 39) planType = 'pro';
            else if (amountPaid >= 14) planType = 'starter';

            const client = await pool.connect();
            const userResult = await client.query('SELECT id FROM users WHERE email = $1', [customerEmail.toLowerCase()]);

            if (userResult.rows.length === 0) {
                console.error(`❌ User non trouvé: ${customerEmail}`);
                client.release();
                return res.json({ received: true });
            }

            await client.query(
                `UPDATE users 
                 SET plan = $1, 
                     stripe_customer_id = $2, 
                     stripe_subscription_id = $3,
                     updated_at = NOW()
                 WHERE id = $4`,
                [planType, session.customer, session.subscription, userResult.rows[0].id]
            );
            client.release();

            console.log(`✅ ${customerEmail} upgradé vers ${planType.toUpperCase()}`);
        }

        if (event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;
            const client = await pool.connect();
            await client.query(
                `UPDATE users SET plan = 'free', stripe_subscription_id = NULL WHERE stripe_subscription_id = $1`,
                [subscription.id]
            );
            client.release();
            console.log(`❌ Abonnement annulé → FREE`);
        }

        res.json({ received: true });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).json({ error: 'Webhook failed' });
    }
});

app.get('/admin/users', async (req, res) => {
    try {
        const { adminEmail } = req.query;
        if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: 'Accès refusé' });
        
        const client = await pool.connect();
        const result = await client.query(
            `SELECT id, email, plan, role, daily_checks_used, daily_otto_analysis, weekly_otto_analysis, created_at 
             FROM users ORDER BY created_at DESC`
        );
        client.release();
        
        const stats = {
            total: result.rows.length,
            free: result.rows.filter(u => u.plan === 'free').length,
            starter: result.rows.filter(u => u.plan === 'starter').length,
            pro: result.rows.filter(u => u.plan === 'pro').length,
            business: result.rows.filter(u => u.plan === 'business').length,
            revenue: (
                result.rows.filter(u => u.plan === 'starter').length * 14.99 +
                result.rows.filter(u => u.plan === 'pro').length * 39.99 +
                result.rows.filter(u => u.plan === 'business').length * 119.99
            )
        };
        
        res.json({ success: true, users: result.rows, stats: stats });
    } catch (error) {
        console.error('❌ Erreur admin/users:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.post('/admin/upgrade-user', async (req, res) => {
    try {
        const { adminEmail, userEmail, plan } = req.body;
        if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: 'Accès refusé' });
        
        const client = await pool.connect();
        await client.query('UPDATE users SET plan = $1, updated_at = NOW() WHERE email = $2', [plan, userEmail.toLowerCase()]);
        client.release();
        
        console.log(`✅ ${userEmail} → ${plan} (par admin)`);
        res.json({ success: true, message: `${userEmail} upgradé vers ${plan}` });
    } catch (error) {
        console.error('❌ Erreur upgrade:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.delete('/admin/delete-user', async (req, res) => {
    try {
        const { adminEmail, userEmail } = req.body;
        if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: 'Accès refusé' });
        
        const client = await pool.connect();
        await client.query('DELETE FROM users WHERE email = $1', [userEmail.toLowerCase()]);
        client.release();
        
        console.log(`✅ ${userEmail} supprimé`);
        res.json({ success: true, message: `${userEmail} supprimé` });
    } catch (error) {
        console.error('❌ Erreur suppression:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'VERIFYAI-OTTO-v1.1-FIXED',
        plans: [
            'FREE (3 vérif/jour + 1 Otto/semaine)', 
            'STARTER (10 vérif/jour + 5 Otto/jour)', 
            'PRO (30 vérif/jour + Otto illimité)', 
            'BUSINESS (illimité + Otto illimité)'
        ],
        features: [
            'balanced_scoring_fixed', 
            'contextual_analysis', 
            'auth', 
            'stripe_webhook', 
            'otto_analysis', 
            'daily_weekly_limits',
            'admin_panel'
        ],
        timestamp: new Date().toISOString(),
        api_configured: !!(process.env.GOOGLE_API_KEY && process.env.SEARCH_ENGINE_ID),
        openai_configured: !!process.env.OPENAI_API_KEY,
        stripe_configured: !!stripe
    });
});

const initDb = async () => {
    try {
        const client = await pool.connect();
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'user',
                plan VARCHAR(50) DEFAULT 'free',
                stripe_customer_id VARCHAR(255),
                stripe_subscription_id VARCHAR(255),
                daily_checks_used INT DEFAULT 0,
                daily_otto_analysis INT DEFAULT 0,
                weekly_otto_analysis INT DEFAULT 0,
                last_check_date DATE,
                weekly_reset_date DATE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
            
            CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
            CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);
        `);
        
        console.log('✅ Table users créée/mise à jour');
        
        try {
            await client.query(`
                ALTER TABLE users 
                ADD COLUMN IF NOT EXISTS daily_otto_analysis INT DEFAULT 0,
                ADD COLUMN IF NOT EXISTS weekly_otto_analysis INT DEFAULT 0,
                ADD COLUMN IF NOT EXISTS weekly_reset_date DATE DEFAULT CURRENT_DATE;
            `);
            console.log('✅ Colonnes Otto ajoutées');
        } catch (err) {
            console.log('⚠️ Colonnes Otto déjà présentes ou erreur:', err.message);
        }
        
        const adminExists = await client.query('SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL]);
        
        if (adminExists.rows.length === 0) {
            const adminPassword = await bcrypt.hash('Admin2025!', 10);
            await client.query(
                `INSERT INTO users (email, password_hash, role, plan) 
                 VALUES ($1, $2, 'admin', 'business')`,
                [ADMIN_EMAIL, adminPassword]
            );
            console.log(`✅ Compte ADMIN créé: ${ADMIN_EMAIL}`);
            console.log(`🔑 Mot de passe par défaut: Admin2025!`);
            console.log(`⚠️ CHANGE CE MOT DE PASSE IMMÉDIATEMENT`);
        }
        
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
            CREATE TABLE IF NOT EXISTS emails (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(100),
                source VARCHAR(50),
                created_at TIMESTAMP DEFAULT NOW()
            );
            
            CREATE INDEX IF NOT EXISTS idx_emails_email ON emails(email);
            CREATE INDEX IF NOT EXISTS idx_emails_created ON emails(created_at);
        `);
        
        console.log('✅ Table emails vérifiée/créée');
        
        client.release();
        console.log('✅ Database ready');
    } catch (err) {
        console.error('❌ Database error:', err.message);
    }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n╔═══════════════════════════════════════╗`);
    console.log(`║  VERIFYAI avec OTTO - v1.1 FIXED     ║`);
    console.log(`╚═══════════════════════════════════════╝`);
    console.log(`\n🚀 Serveur démarré:`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`\n🔑 API Status:`);
    console.log(`   Google API: ${!!process.env.GOOGLE_API_KEY ? '✅ OK' : '❌ MANQUANT'}`);
    console.log(`   OpenAI API: ${!!process.env.OPENAI_API_KEY ? '✅ OK' : '❌ MANQUANT'}`);
    console.log(`   Stripe: ${!!stripe ? '✅ OK' : '❌ MANQUANT'}`);
    console.log(`   Webhook Secret: ${!!STRIPE_WEBHOOK_SECRET ? '✅ OK' : '❌ MANQUANT'}`);
    console.log(`   Database: ${!!process.env.DATABASE_URL ? '✅ OK' : '❌ MANQUANT'}`);
    console.log(`\n👤 Admin: ${ADMIN_EMAIL}`);
    console.log(`\n📋 Plans disponibles:`);
    console.log(`   FREE: 3 vérif/jour + 1 Otto/semaine`);
    console.log(`   STARTER: 10 vérif/jour + 5 Otto/jour (14.99€)`);
    console.log(`   PRO: 30 vérif/jour + Otto illimité (39.99€)`);
    console.log(`   BUSINESS: Illimité + Otto illimité (119.99€)`);
    console.log(`\n🛣️  Routes disponibles:`);
    console.log(`   POST /verify - Vérification classique (AUTO)`);
    console.log(`   POST /verify-otto - Analyse Otto (COLLER)`);
    console.log(`   POST /auth/signup - Inscription`);
    console.log(`   POST /auth/login - Connexion`);
    console.log(`   POST /stripe/webhook - Paiements Stripe`);
    console.log(`   GET  /health - Status serveur`);
    console.log(`\n✅ BUG CORRIGÉ: calculateBalancedScore() retourne maintenant un objet valide`);
    console.log(`==========================================\n`);
    initDb();
});
