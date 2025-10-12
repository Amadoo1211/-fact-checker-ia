const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const app = express();

app.use(cors({ 
    origin:'*',
    credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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

// ========= UTILITAIRES DE LANGUE =========

function normalizeLang(lang) {
    if (!lang || typeof lang !== 'string') {
        return null;
    }
    const lowered = lang.toLowerCase();
    if (lowered.startsWith('fr')) return 'fr';
    if (lowered.startsWith('en')) return 'en';
    return null;
}

function detectLanguageFromText(text = '') {
    if (!text) return 'en';
    const lower = text.toLowerCase();
    const accentRegex = /[àâäçéèêëîïôöùûüÿœ]/i;
    const frenchIndicators = [' selon ', ' croissance ', ' rapport ', ' données ', ' année ', 'source'];
    const englishIndicators = [' according to ', ' growth ', ' report ', ' data ', ' year '];

    const frenchScore = frenchIndicators.reduce((score, word) => score + (lower.includes(word) ? 1 : 0), 0) + (accentRegex.test(text) ? 2 : 0);
    const englishScore = englishIndicators.reduce((score, word) => score + (lower.includes(word) ? 1 : 0), 0);

    if (frenchScore === englishScore) {
        return accentRegex.test(text) ? 'fr' : 'en';
    }

    return frenchScore > englishScore ? 'fr' : 'en';
}

// ========== 4 AGENTS IA (OTTO) ==========

class AIAgentsService {
    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY;
        this.model = 'gpt-4o-mini';
        this.defaultFallbackScore = 60;
        this.parseFallbackScore = 70;
        this.languageStrings = {
            fr: {
                globalInstruction: 'Analyse le texte ci-dessous pour détecter les hallucinations, vérifier la fiabilité et les sources. Fournis un rapport structuré en français.',
                agentUnavailable: 'Agent non disponible.',
                parseError: "Impossible d'interpréter la réponse de l'agent.",
                summaryHigh: 'Otto dit : Mon analyse montre un contenu globalement fiable.',
                summaryMedium: 'Otto dit : Mon analyse détecte quelques signaux à surveiller.',
                summaryLow: 'Otto dit : Mon analyse révèle plusieurs incohérences importantes.',
                quickFallback: 'Analyse rapide indisponible.',
                quickPrompt: 'Donne un score de fiabilité global (0-100) et une explication courte en français.',
                quickSummaryKey: 'explication',
                riskLevels: { low: 'Faible', medium: 'Modéré', high: 'Élevé' },
                recommendations: {
                    low: 'Convient pour usage professionnel.',
                    medium: 'Relecture humaine recommandée.',
                    high: 'Vérification approfondie nécessaire avant diffusion.'
                },
                ottoMessage: 'Analyse complète effectuée avec 5 agents Otto.',
                aiNotesFallback: "Analyse d'origine IA indisponible."
            },
            en: {
                globalInstruction: 'Analyze the text below for hallucinations, reliability, and sources. Provide a structured report in English.',
                agentUnavailable: 'Agent unavailable.',
                parseError: 'Unable to parse agent response.',
                summaryHigh: 'Otto says: My analysis shows the content is largely reliable.',
                summaryMedium: 'Otto says: My analysis flags a few elements that need attention.',
                summaryLow: 'Otto says: My analysis reveals several critical inconsistencies.',
                quickFallback: 'Quick analysis unavailable.',
                quickPrompt: 'Provide an overall reliability score (0-100) and a short explanation in English.',
                quickSummaryKey: 'explanation',
                riskLevels: { low: 'Low', medium: 'Moderate', high: 'High' },
                recommendations: {
                    low: 'Suitable for professional use.',
                    medium: 'Human review recommended.',
                    high: 'Thorough verification required before distribution.'
                },
                ottoMessage: 'Full analysis completed with 5 Otto agents.',
                aiNotesFallback: 'AI origin analysis unavailable.'
            }
        };
        this.ottoPersona = {
            fr: "Tu es Otto, un auditeur d'études B2B. Ton rôle est d’évaluer la fiabilité du contenu. Sois neutre, précis, factuel et professionnel. Écris toujours dans la langue détectée du texte. Otto ne doit jamais donner d’avis subjectif.",
        };
        this.ottoPersona.en = 'You are Otto, a B2B study auditor. Your role is to evaluate content reliability. Stay neutral, precise, factual, and professional. Always respond in the detected language. Otto must never provide subjective opinions.';
    }

    localize(lang, key) {
        const normalized = normalizeLang(lang) || 'en';
        return this.languageStrings[normalized][key] || this.languageStrings.en[key];
    }

    resolveLanguage(preferredLang, text) {
        return normalizeLang(preferredLang) || detectLanguageFromText(text);
    }

    getOttoPersonaPrompt(lang) {
        const normalized = normalizeLang(lang) || 'en';
        return this.ottoPersona[normalized] || this.ottoPersona.en;
    }

    getGlobalInstruction(lang) {
        return this.localize(lang, 'globalInstruction');
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

    clampScore(value, fallback) {
        if (typeof value === 'number' && !Number.isNaN(value)) {
            return Math.max(0, Math.min(100, Math.round(value)));
        }
        return fallback;
    }

    parseJsonFromResponse(result) {
        if (!result) return null;
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        try {
            return JSON.parse(jsonMatch[0]);
        } catch (error) {
            console.error('Parse error JSON:', error.message);
            return null;
        }
    }

    extractScore(data, rawContent, fallback) {
        if (data && typeof data.score === 'number') {
            return this.clampScore(data.score, fallback);
        }

        if (typeof data === 'number') {
            return this.clampScore(data, fallback);
        }

        if (typeof rawContent === 'string') {
            const match = rawContent.match(/score[^\d]*(\d{1,3})/i);
            if (match) {
                return this.clampScore(parseInt(match[1], 10), fallback);
            }
        }

        return fallback;
    }

    buildSourcesText(sources, lang, limit = 3) {
        const selected = sources.slice(0, limit);
        const isFrench = normalizeLang(lang) === 'fr';
        return selected.map(s => {
            const header = isFrench ? 'Source' : 'Source';
            return `${header}: ${s.title}\nURL: ${s.url}\n${s.snippet || ''}`;
        }).join('\n\n---\n\n');
    }

    buildFactCheckerPrompts(text, sources, lang) {
        const instruction = this.getGlobalInstruction(lang);
        const isFrench = normalizeLang(lang) === 'fr';
        const schema = `\n{\n  "score": 0-100,\n  "summary": "string",\n  "verified_claims": [\n    {"claim": "text", "source": "source name"}\n  ],\n  "unverified_claims": [\n    {"claim": "text", "reason": "why"}\n  ],\n  "hallucinated_references": [\n    {"reference": "text", "reason": "why it is invented"}\n  ]\n}`;
        const roleInstruction = isFrench
            ? "Tu es l'agent Fact Checker. Vérifie chaque affirmation, liste celles confirmées et celles non vérifiées."
            : 'You are the Fact Checker agent. Verify each claim, listing confirmed and unverified ones.';
        const systemPrompt = `${instruction}\n${this.getOttoPersonaPrompt(lang)}\n${roleInstruction}\nRespecte strictement le schéma JSON suivant :${schema}`;

        const userPrompt = `${isFrench ? 'Texte à analyser' : 'Text to verify'}:\n"${text.substring(0, 1800)}"\n\n${isFrench ? 'Sources disponibles' : 'Available sources'}:\n${this.buildSourcesText(sources, lang, 3)}\n\n${isFrench ? 'Liste les hallucinations, omissions ou affirmations inventées. Réponds uniquement en JSON.' : 'List hallucinations, omissions, or invented statements. Return JSON only.'}`;

        return { systemPrompt, userPrompt };
    }

    async factChecker(text, sources, lang) {
        const fallback = {
            name: 'Fact Checker',
            score: this.defaultFallbackScore,
            description: this.localize(lang, 'agentUnavailable'),
            verified_claims: [],
            unverified_claims: [],
            hallucinated_references: []
        };

        const { systemPrompt, userPrompt } = this.buildFactCheckerPrompts(text, sources, lang);
        const result = await this.callOpenAI(systemPrompt, userPrompt, 700);

        if (!result) {
            return fallback;
        }

        const parsed = this.parseJsonFromResponse(result) || {};
        const score = this.extractScore(parsed, result, this.parseFallbackScore);

        return {
            name: 'Fact Checker',
            score,
            description: parsed.summary || this.localize(lang, 'parseError'),
            verified_claims: Array.isArray(parsed.verified_claims) ? parsed.verified_claims : [],
            unverified_claims: Array.isArray(parsed.unverified_claims) ? parsed.unverified_claims : [],
            hallucinated_references: Array.isArray(parsed.hallucinated_references) ? parsed.hallucinated_references : []
        };
    }
    buildSourceAnalystPrompts(text, sources, lang) {
        const instruction = this.getGlobalInstruction(lang);
        const isFrench = normalizeLang(lang) === 'fr';
        const schema = `\n{\n  "score": 0-100,\n  "summary": "string",\n  "reliable_sources": [\n    {"citation": "string", "url": "string"}\n  ],\n  "fake_sources": [\n    {"citation": "string", "reason": "string"}\n  ]\n}`;
        const roleInstruction = isFrench
            ? "Tu es l'agent Source Analyst. Évalue la fiabilité de chaque source et signale celles qui semblent inventées."
            : 'You are the Source Analyst agent. Evaluate the reliability of each source and flag invented references.';
        const systemPrompt = `${instruction}\n${this.getOttoPersonaPrompt(lang)}\n${roleInstruction}\nRespecte strictement le schéma JSON suivant :${schema}`;

        const userPrompt = `${isFrench ? 'Contexte du texte' : 'Text context'}:\n"${text.substring(0, 900)}"\n\n${isFrench ? 'Sources à analyser' : 'Sources to review'}:\n${this.buildSourcesText(sources, lang, 5)}\n\n${isFrench ? 'Indique les sources crédibles et celles qui sont inventées ou ne corroborent pas le texte. Réponds en JSON.' : 'Indicate credible sources and any that appear invented or unsupported. Respond in JSON only.'}`;

        return { systemPrompt, userPrompt };
    }

    async sourceAnalyst(text, sources, lang) {
        const fallback = {
            name: 'Source Analyst',
            score: this.defaultFallbackScore,
            description: this.localize(lang, 'agentUnavailable'),
            reliable_sources: [],
            fake_sources: []
        };

        const { systemPrompt, userPrompt } = this.buildSourceAnalystPrompts(text, sources, lang);
        const result = await this.callOpenAI(systemPrompt, userPrompt, 650);

        if (!result) {
            return fallback;
        }

        const parsed = this.parseJsonFromResponse(result) || {};
        const score = this.extractScore(parsed, result, this.parseFallbackScore);

        return {
            name: 'Source Analyst',
            score,
            description: parsed.summary || this.localize(lang, 'parseError'),
            reliable_sources: Array.isArray(parsed.reliable_sources) ? parsed.reliable_sources : (Array.isArray(parsed.real_sources) ? parsed.real_sources : []),
            fake_sources: Array.isArray(parsed.fake_sources) ? parsed.fake_sources : []
        };
    }

    buildContextGuardianPrompts(text, sources, lang) {
        const instruction = this.getGlobalInstruction(lang);
        const isFrench = normalizeLang(lang) === 'fr';
        const schema = `\n{\n  "score": 0-100,\n  "summary": "string",\n  "omissions": [\n    {"type": "string", "description": "string"}\n  ],\n  "manipulation": true/false\n}`;
        const roleInstruction = isFrench
            ? "Tu es l'agent Context Guardian. Signale les omissions majeures et indique s'il y a manipulation contextuelle."
            : 'You are the Context Guardian agent. Highlight major omissions and note if context manipulation is present.';
        const systemPrompt = `${instruction}\n${this.getOttoPersonaPrompt(lang)}\n${roleInstruction}\nRespecte strictement le schéma JSON suivant :${schema}`;

        const userPrompt = `${isFrench ? 'Texte à auditer' : 'Text to audit'}:\n"${text.substring(0, 1800)}"\n\n${isFrench ? 'Aide contextuelle (extraits de sources)' : 'Context from sources'}:\n${this.buildSourcesText(sources, lang, 3)}\n\n${isFrench ? 'Liste les omissions clés et précise si le texte manipule le contexte. Réponds uniquement en JSON.' : 'List key omissions and indicate if the context is manipulated. Return JSON only.'}`;

        return { systemPrompt, userPrompt };
    }

    async contextGuardian(text, sources, lang) {
        const fallback = {
            name: 'Context Guardian',
            score: this.defaultFallbackScore,
            description: this.localize(lang, 'agentUnavailable'),
            omissions: [],
            manipulation: false
        };

        const { systemPrompt, userPrompt } = this.buildContextGuardianPrompts(text, sources, lang);
        const result = await this.callOpenAI(systemPrompt, userPrompt, 600);

        if (!result) {
            return fallback;
        }

        const parsed = this.parseJsonFromResponse(result) || {};
        const score = this.extractScore(parsed, result, this.parseFallbackScore);

        return {
            name: 'Context Guardian',
            score,
            description: parsed.summary || this.localize(lang, 'parseError'),
            omissions: Array.isArray(parsed.omissions) ? parsed.omissions : [],
            manipulation: typeof parsed.manipulation === 'boolean' ? parsed.manipulation : (typeof parsed.manipulation_detected === 'boolean' ? parsed.manipulation_detected : false)
        };
    }

    buildFreshnessPrompts(text, sources, lang) {
        const instruction = this.getGlobalInstruction(lang);
        const isFrench = normalizeLang(lang) === 'fr';
        const schema = `\n{\n  "score": 0-100,\n  "summary": "string",\n  "outdated_data": [\n    {"data_point": "string", "age": "string"}\n  ],\n  "recent_data": [\n    {"data_point": "string", "age": "string"}\n  ]\n}`;
        const roleInstruction = isFrench
            ? "Tu es l'agent Freshness Detector. Évalue la fraîcheur des données et signale les informations obsolètes."
            : 'You are the Freshness Detector agent. Evaluate data freshness and flag outdated information.';
        const systemPrompt = `${instruction}\n${this.getOttoPersonaPrompt(lang)}\n${roleInstruction}\nRespecte strictement le schéma JSON suivant :${schema}`;

        const userPrompt = `${isFrench ? 'Texte analysé' : 'Text under review'}:\n"${text.substring(0, 1800)}"\n\n${isFrench ? 'Sources associées' : 'Associated sources'}:\n${this.buildSourcesText(sources, lang, 3)}\n\n${isFrench ? 'Identifie les données récentes et obsolètes. Réponds en JSON uniquement.' : 'Identify recent and outdated data. Respond in JSON only.'}`;

        return { systemPrompt, userPrompt };
    }

    async freshnessDetector(text, sources, lang) {
        const fallback = {
            name: 'Freshness Detector',
            score: this.defaultFallbackScore,
            description: this.localize(lang, 'agentUnavailable'),
            outdated_data: [],
            recent_data: []
        };

        const { systemPrompt, userPrompt } = this.buildFreshnessPrompts(text, sources, lang);
        const result = await this.callOpenAI(systemPrompt, userPrompt, 600);

        if (!result) {
            return fallback;
        }

        const parsed = this.parseJsonFromResponse(result) || {};
        const score = this.extractScore(parsed, result, this.parseFallbackScore);

        return {
            name: 'Freshness Detector',
            score,
            description: parsed.summary || this.localize(lang, 'parseError'),
            outdated_data: Array.isArray(parsed.outdated_data) ? parsed.outdated_data : [],
            recent_data: Array.isArray(parsed.recent_data) ? parsed.recent_data : []
        };
    }

    // 🧠 Otto v1.7 Upgrade - AI Detector agent
    buildAIDetectorPrompts(text, lang) {
        const isFrench = normalizeLang(lang) === 'fr';
        const persona = this.getOttoPersonaPrompt(lang);
        const instruction = isFrench
            ? "Tu es l'agent AI Detector. Estime la probabilité que le texte soit généré par une IA (GPT, Claude, Gemini...)."
            : 'You are the AI Detector agent. Estimate the likelihood the text was generated by an AI model (GPT, Claude, Gemini...).';
        const schema = `\n{\n  "ai_likelihood": 0-100,\n  "detected_model": "string",\n  "reason": "string"\n}`;
        const systemPrompt = `${this.getGlobalInstruction(lang)}\n${persona}\n${instruction}\nReturn valid JSON only using this schema:${schema}`;
        const userPrompt = `${isFrench ? 'Texte à évaluer' : 'Text to evaluate'}:\n"${text.substring(0, 1800)}"\n\n${isFrench ? 'Donne uniquement le JSON demandé.' : 'Respond with JSON only.'}`;
        return { systemPrompt, userPrompt };
    }

    async aiDetector(text, lang) {
        const fallbackScore = this.defaultFallbackScore;
        const normalizedLang = this.resolveLanguage(lang, text);
        const { systemPrompt, userPrompt } = this.buildAIDetectorPrompts(text, normalizedLang);
        const result = await this.callOpenAI(systemPrompt, userPrompt, 400);

        if (!result) {
            return {
                name: 'AI Detector',
                score: fallbackScore,
                ai_likelihood: fallbackScore,
                detected_model: normalizedLang === 'fr' ? 'Inconnu' : 'Unknown',
                notes: this.languageStrings[normalizedLang].aiNotesFallback || this.languageStrings.en.aiNotesFallback
            };
        }

        const parsed = this.parseJsonFromResponse(result) || {};
        const likelihood = this.clampScore(parsed.ai_likelihood, this.parseFallbackScore);
        const detectedModel = typeof parsed.detected_model === 'string' && parsed.detected_model.trim().length > 0
            ? parsed.detected_model.trim()
            : (likelihood > 60
                ? (normalizedLang === 'fr' ? 'Probablement IA' : 'Likely AI')
                : (normalizedLang === 'fr' ? 'Probablement humain' : 'Likely human'));
        const reason = typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
            ? parsed.reason.trim()
            : (normalizedLang === 'fr' ? 'Analyse IA limitée.' : 'Limited AI analysis.');

        return {
            name: 'AI Detector',
            score: likelihood,
            ai_likelihood: likelihood,
            detected_model: detectedModel,
            notes: reason
        };
    }


    buildQuickAutoPrompts(text, lang) {
        const instruction = this.getGlobalInstruction(lang);
        const isFrench = normalizeLang(lang) === 'fr';
        const schema = `
{
  "score": 0-100,
  "explanation": "string"
}`;
        const systemPrompt = `${instruction}
${isFrench
            ? 'Fais une synthèse express en français avec un score global.'
            : 'Provide a quick overall synthesis in English with a global score.'}
Respecte ce format JSON :${schema}`;

        const userPrompt = `${isFrench ? 'Texte à évaluer rapidement' : 'Text for quick evaluation'}:
"${text.substring(0, 1500)}"

${this.localize(lang, 'quickPrompt')}
Réponds uniquement en JSON.`;

        return { systemPrompt, userPrompt };
    }

    async quickAutoVerify(text, lang) {
        const targetLang = this.resolveLanguage(lang, text);
        const { systemPrompt, userPrompt } = this.buildQuickAutoPrompts(text, targetLang);
        const result = await this.callOpenAI(systemPrompt, userPrompt, 250);

        if (!result) {
            return {
                score: this.defaultFallbackScore,
                explanation: this.localize(targetLang, 'quickFallback'),
                language: targetLang
            };
        }

        const parsed = this.parseJsonFromResponse(result) || {};
        const score = this.extractScore(parsed, result, this.parseFallbackScore);
        const explanation = parsed.explanation || parsed.explication || this.localize(targetLang, 'parseError');

        return {
            score,
            explanation,
            language: targetLang
        };
    }
    async runAgentWithTiming(label, fn) {
        const start = Date.now();
        try {
            const result = await fn();
            const duration = Date.now() - start;
            console.log(`⏱️ [Otto][${label}] ${duration}ms`);
            return result;
        } catch (error) {
            const duration = Date.now() - start;
            console.error(`❌ [Otto][${label}] Erreur après ${duration}ms:`, error.message);
            return {
                name: label,
                score: this.defaultFallbackScore,
                description: error.message,
                details: []
            };
        }
    }

    buildSummaryFromScore(avgScore, lang) {
        if (avgScore >= 75) {
            return this.localize(lang, 'summaryHigh');
        }
        if (avgScore >= 55) {
            return this.localize(lang, 'summaryMedium');
        }
        return this.localize(lang, 'summaryLow');
    }

    // 🧠 Otto v1.7 Upgrade - Risk & recommendation helpers
    determineRiskLevel(trustIndex, aiLikelihood = 0) {
        if (typeof aiLikelihood === 'number' && aiLikelihood > 85) {
            return 'high';
        }
        if (trustIndex < 55 || aiLikelihood > 70) {
            return 'high';
        }
        if (trustIndex < 75 || aiLikelihood > 50) {
            return 'medium';
        }
        return 'low';
    }

    localizeRiskLevel(level, lang) {
        const normalized = normalizeLang(lang) || 'en';
        const strings = this.languageStrings[normalized] || this.languageStrings.en;
        return (strings.riskLevels && strings.riskLevels[level]) || this.languageStrings.en.riskLevels[level] || level;
    }

    getRecommendation(level, lang) {
        const normalized = normalizeLang(lang) || 'en';
        const strings = this.languageStrings[normalized] || this.languageStrings.en;
        return (strings.recommendations && strings.recommendations[level]) || this.languageStrings.en.recommendations[level] || '';
    }

    getOttoMessage(lang) {
        const normalized = normalizeLang(lang) || 'en';
        const strings = this.languageStrings[normalized] || this.languageStrings.en;
        return strings.ottoMessage || this.languageStrings.en.ottoMessage;
    }

    async runAllAgents(text, sources, lang) {
        const targetLang = this.resolveLanguage(lang, text);
        console.log('🤖 Lancement des agents Otto (langue détectée):', targetLang);

        const [factChecker, sourceAnalyst, contextGuardian, freshnessDetector, aiDetector] = await Promise.all([
            this.runAgentWithTiming('Fact Checker', () => this.factChecker(text, sources, targetLang)),
            this.runAgentWithTiming('Source Analyst', () => this.sourceAnalyst(text, sources, targetLang)),
            this.runAgentWithTiming('Context Guardian', () => this.contextGuardian(text, sources, targetLang)),
            this.runAgentWithTiming('Freshness Detector', () => this.freshnessDetector(text, sources, targetLang)),
            this.runAgentWithTiming('AI Detector', () => this.aiDetector(text, targetLang))
        ]);

        const safeScore = (value) => (typeof value === 'number' && !Number.isNaN(value) ? value : this.defaultFallbackScore);
        const factScore = safeScore(factChecker.score);
        const sourceScore = safeScore(sourceAnalyst.score);
        const contextScore = safeScore(contextGuardian.score);
        const freshnessScore = safeScore(freshnessDetector.score);

        const aiLikelihood = safeScore(aiDetector.ai_likelihood);
        const aiAdjustment = (100 - aiLikelihood) * 0.1;
        let trustIndex = (factScore * 0.3) + (sourceScore * 0.25) + (contextScore * 0.2) + (freshnessScore * 0.15) + aiAdjustment;
        if (aiLikelihood > 70) {
            trustIndex -= 10;
        }
        trustIndex = this.clampScore(trustIndex, this.defaultFallbackScore);

        const riskLevelKey = this.determineRiskLevel(trustIndex, aiLikelihood);
        const riskLevel = this.localizeRiskLevel(riskLevelKey, targetLang);
        const recommendation = this.getRecommendation(riskLevelKey, targetLang);
        const summary = this.buildSummaryFromScore(trustIndex, targetLang);
        const message = this.getOttoMessage(targetLang);

        const hallucinationsSet = new Set();
        const addHallucination = (value) => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed.length > 0) {
                    hallucinationsSet.add(trimmed);
                }
            }
        };

        (Array.isArray(factChecker.hallucinated_references) ? factChecker.hallucinated_references : []).forEach((ref) => {
            if (ref && typeof ref === 'object') {
                addHallucination(ref.reference || ref.citation || ref.note);
            }
        });
        (Array.isArray(factChecker.unverified_claims) ? factChecker.unverified_claims : []).forEach((claim) => {
            if (claim && typeof claim === 'object') {
                const composed = [claim.claim, claim.reason].filter(Boolean).join(' - ');
                addHallucination(composed);
            }
        });
        (Array.isArray(sourceAnalyst.fake_sources) ? sourceAnalyst.fake_sources : []).forEach((fake) => {
            if (fake && typeof fake === 'object') {
                addHallucination(fake.citation || fake.reference || fake.reason);
            }
        });

        const agentsPayload = {
            ai_detector: {
                score: safeScore(aiDetector.score),
                ai_likelihood: aiLikelihood,
                detected_model: aiDetector.detected_model,
                notes: aiDetector.notes
            },
            fact_checker: {
                score: factScore,
                description: factChecker.description,
                verified_claims: Array.isArray(factChecker.verified_claims) ? factChecker.verified_claims : [],
                unverified_claims: Array.isArray(factChecker.unverified_claims) ? factChecker.unverified_claims : [],
                hallucinated_references: Array.isArray(factChecker.hallucinated_references) ? factChecker.hallucinated_references : []
            },
            source_analyst: {
                score: sourceScore,
                description: sourceAnalyst.description,
                reliable_sources: Array.isArray(sourceAnalyst.reliable_sources) ? sourceAnalyst.reliable_sources : [],
                fake_sources: Array.isArray(sourceAnalyst.fake_sources) ? sourceAnalyst.fake_sources : []
            },
            context_guardian: {
                score: contextScore,
                description: contextGuardian.description,
                omissions: Array.isArray(contextGuardian.omissions) ? contextGuardian.omissions : [],
                manipulation: typeof contextGuardian.manipulation === 'boolean' ? contextGuardian.manipulation : false
            },
            freshness_detector: {
                score: freshnessScore,
                description: freshnessDetector.description,
                outdated_data: Array.isArray(freshnessDetector.outdated_data) ? freshnessDetector.outdated_data : [],
                recent_data: Array.isArray(freshnessDetector.recent_data) ? freshnessDetector.recent_data : []
            }
        };

        return {
            language: targetLang,
            trustIndex,
            riskLevel,
            recommendation,
            summary,
            message,
            aiLikelihood,
            hallucinations: Array.from(hallucinationsSet),
            agents: agentsPayload
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

function generateContextualQueries(text, keywords = []) {
    const sanitized = sanitizeInput(text);
    if (!sanitized) return [];

    const queries = [];
    const keywordList = [...new Set((keywords || []).filter(Boolean))];

    const stopWords = new Set(['le', 'la', 'les', 'de', 'des', 'du', 'the', 'and', 'for', 'with', 'dans', 'pour', 'une', 'un', 'et']);
    const entityMatches = sanitized.match(/\b[A-Z][\wÀ-ÿ']+(?:\s+[A-Z][\wÀ-ÿ']+){0,2}\b/g) || [];
    const entities = entityMatches
        .map(entity => entity.trim())
        .filter(entity => entity.length > 2 && !stopWords.has(entity.toLowerCase()));
    const uniqueEntities = [...new Set(entities)].slice(0, 6);

    const eventKeywords = (sanitized.match(/\b(scandale|rapport|enquête|sanctions?|controverse|erreurs?|hallucinations?|intelligence artificielle|IA|AI|fact-check|fraude|remboursement)\b/gi) || [])
        .map(word => word.toLowerCase());
    const uniqueEventKeywords = [...new Set(eventKeywords)];

    if (uniqueEntities.length >= 2) {
        const secondEntity = uniqueEntities[1] || '';
        const eventWord = uniqueEventKeywords[0] || keywordList[0] || '';
        queries.push(`${uniqueEntities[0]} ${secondEntity} ${eventWord}`.trim());
    }

    if (uniqueEntities.length >= 1 && uniqueEventKeywords.length > 0) {
        queries.push(`${uniqueEntities[0]} ${uniqueEventKeywords.slice(0, 2).join(' ')}`.trim());
    }

    if (keywordList.length >= 2) {
        queries.push(`${keywordList[0]} ${keywordList[1]} fact check`.trim());
    }

    const years = sanitized.match(/\b(19|20)\d{2}\b/g) || [];
    if (years.length > 0 && uniqueEntities.length > 0) {
        queries.push(`${uniqueEntities[0]} ${years[0]} news`);
    }

    const locations = sanitized.match(/\b(Australie|Australia|France|États-Unis|USA|Canada|Europe|Sydney|Melbourne|Paris|Canberra|Brisbane)\b/gi) || [];
    if (locations.length > 0 && uniqueEntities.length > 0) {
        queries.push(`${uniqueEntities[0]} ${locations[0]} scandale`);
    }

    const informativeSentences = sanitized
        .split(/[.!?]/)
        .map(sentence => sentence.trim())
        .filter(sentence => sentence.length > 0 && /\d{4}|million|milliard|scandale|rapport|sanction|hallucination|IA|AI|enquête|fact-check|rembourser/i.test(sentence))
        .slice(0, 2);

    informativeSentences.forEach(sentence => {
        const words = sentence
            .split(/\s+/)
            .filter(word => word.length > 3)
            .slice(0, 8)
            .join(' ');
        if (words.length > 0) {
            queries.push(words);
        }
    });

    return [...new Set(queries)]
        .map(query => query.trim())
        .filter(query => query.length > 0)
        .slice(0, 5);
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

    const contextualQueries = generateContextualQueries(originalText, keywords);
    const combinedQueries = [];

    if (smartQueries && smartQueries.length > 0) {
        combinedQueries.push(...smartQueries.filter(Boolean).slice(0, 3));
    }

    contextualQueries.forEach(query => {
        if (!combinedQueries.includes(query)) {
            combinedQueries.push(query);
        }
    });

    if (combinedQueries.length > 0) {
        for (const query of combinedQueries.slice(0, 5)) {
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
        const { text, smartQueries, userEmail } = req.body;
        
        console.log(`\n=== VÉRIFICATION CLASSIQUE ===`);
        console.log(`📝 Texte: "${text.substring(0, 80)}..."`);
        console.log(`👤 User: ${userEmail || 'anonymous'}`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                overallConfidence: 0.25,
                scoringExplanation: "Texte insuffisant (25%) - Contenu trop court pour analyse.", 
                keywords: [],
                sources: [],
                methodology: "Analyse équilibrée avec détection contextuelle"
            });
        }
        
        let userPlan = 'free';
        let userId = null;
        
        if (userEmail) {
            const user = await getUserByEmail(userEmail);
            if (user) {
                userId = user.id;
                userPlan = user.plan;
                
                const limitCheck = await checkVerificationLimit(userId);
                if (!limitCheck.allowed) {
                    return res.status(429).json({
                        success: false,
                        error: 'Limite atteinte',
                        message: userPlan === 'free' 
                            ? 'Limite de 3 vérifications/jour atteinte. Passez à STARTER, PRO ou BUSINESS' 
                            : `Limite quotidienne atteinte (${userPlan.toUpperCase()}). Passez au plan supérieur`,
                        remaining: 0,
                        plan: userPlan
                    });
                }
                console.log(`📊 Plan: ${userPlan} | Restant: ${limitCheck.remaining}`);
            }
        }
        
        const factChecker = new ImprovedFactChecker();
        const claims = factChecker.extractVerifiableClaims(text);
        const keywords = extractMainKeywords(text);
        const sources = await findWebSources(keywords, smartQueries, text);
        const analyzedSources = await analyzeSourcesWithImprovedLogic(factChecker, text, sources);
        const result = factChecker.calculateBalancedScore(text, analyzedSources, claims);
        
        if (userId) await incrementVerificationCount(userId);
        
        const response = {
            overallConfidence: result.score,
            confidence: result.confidence,
            scoringExplanation: result.reasoning,
            sources: analyzedSources,
            keywords: keywords,
            claimsAnalyzed: claims,
            details: result.details,
            methodology: "Analyse équilibrée avec détection contextuelle intelligente",
            userPlan: userPlan
        };
        
        console.log(`✅ Score: ${Math.round(result.score * 100)}%`);
        console.log(`📚 ${analyzedSources.length} sources | ${claims.length} claims`);
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Erreur analyse:', error);
        res.status(500).json({ 
            overallConfidence: 0.20,
            scoringExplanation: "Erreur système (20%) - Impossible de terminer l'analyse.",
            keywords: [],
            sources: []
        });
    }
});

app.post('/verify-auto', async (req, res) => {
    const aiAgents = new AIAgentsService();
    try {
        const { text, lang } = req.body || {};

        console.log(`\n=== ANALYSE AUTO (rapide) ===`);
        if (!text || typeof text !== 'string' || text.trim().length < 10) {
            return res.status(400).json({
                success: false,
                error: 'Texte insuffisant pour une vérification rapide'
            });
        }

        const quickResult = await aiAgents.quickAutoVerify(text, lang);

        return res.json({
            success: true,
            score: quickResult.score,
            explanation: quickResult.explanation,
            language: quickResult.language
        });
    } catch (error) {
        console.error('❌ Erreur analyse auto:', error);
        const fallbackLang = aiAgents.resolveLanguage(req.body?.lang, req.body?.text || '');
        return res.status(500).json({
            success: false,
            score: aiAgents.defaultFallbackScore,
            explanation: aiAgents.localize(fallbackLang, 'agentUnavailable'),
            language: fallbackLang
        });
    }
});

// ========== ROUTE ANALYSE OTTO (APPROFONDIE) ==========
app.post('/verify-otto', async (req, res) => {
    try {
        const { text, smartQueries, userEmail, lang } = req.body;
        
        console.log(`\n=== ANALYSE OTTO ===`);
        console.log(`📝 Texte: "${text.substring(0, 80)}..."`);
        console.log(`👤 User: ${userEmail || 'anonymous'}`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                success: false,
                error: "Texte insuffisant pour analyse Otto"
            });
        }
        
        if (!userEmail) {
            return res.status(401).json({
                success: false,
                error: 'Authentification requise pour Otto'
            });
        }
        
        const user = await getUserByEmail(userEmail);
        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Utilisateur non trouvé'
            });
        }
        
        const ottoLimit = await checkOttoLimit(user.id);
        if (!ottoLimit.allowed) {
            const message = user.plan === 'free' 
                ? 'Limite Otto FREE: 1 analyse/semaine atteinte. Renouvellement lundi 00h00. Passez à STARTER pour 5 Otto/jour'
                : `Limite Otto atteinte (${user.plan.toUpperCase()}). Passez au plan supérieur`;
            
            return res.status(429).json({
                success: false,
                error: 'Limite Otto atteinte',
                message: message,
                remaining: 0,
                plan: user.plan,
                resetType: ottoLimit.resetType
            });
        }
        
        console.log(`📊 Plan: ${user.plan} | Otto restant: ${ottoLimit.remaining}`);
        
        const keywords = extractMainKeywords(text);
        const sources = await findWebSources(keywords, smartQueries, text);
        
        if (sources.length === 0) {
            return res.json({
                success: false,
                error: 'Aucune source trouvée pour analyse Otto'
            });
        }
        
        const aiAgents = new AIAgentsService();
        const targetLang = aiAgents.resolveLanguage(lang, text);
        const ottoResults = await aiAgents.runAllAgents(text, sources, targetLang);

        await incrementOttoCount(user.id, user.plan);

        // 🧠 Otto v1.7 Upgrade - Response payload enrichi
        const ottoPayload = {
            trust_index: ottoResults.trustIndex,
            risk_level: ottoResults.riskLevel,
            ai_likelihood: ottoResults.aiLikelihood,
            summary: ottoResults.summary,
            recommendation: ottoResults.recommendation,
            hallucinations_detected: ottoResults.hallucinations,
            message: ottoResults.message
        };

        const response = {
            success: true,
            otto: ottoPayload,
            agents: ottoResults.agents,
            sources: sources,
            userPlan: user.plan,
            language: ottoResults.language
        };

        console.log(`✅ Otto terminé | TrustIndex: ${ottoResults.trustIndex}% | AI likelihood: ${ottoResults.aiLikelihood}% | Langue: ${ottoResults.language}`);

        res.json(response);
        
    } catch (error) {
        console.error('❌ Erreur analyse Otto:', error);
        res.status(500).json({ 
            success: false,
            error: "Erreur système lors de l'analyse Otto"
        });
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
