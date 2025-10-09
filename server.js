const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Configuration CORS
app.use(cors({ 
    origin:'*',
    credentials: true
}));
app.use(express.json({ limit: '5mb' }));

// Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ========== 4 AGENTS IA SPÉCIALISÉS (OpenAI GPT-4o-mini) ==========

class AIAgentsService {
    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY;
        this.model = 'gpt-4o-mini';
    }

    async callOpenAI(systemPrompt, userPrompt, maxTokens = 300) {
        if (!this.apiKey) {
            console.warn('⚠️ OpenAI API key manquante - Agent désactivé');
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
            console.error('❌ Erreur appel OpenAI:', error.message);
            return null;
        }
    }

    // 🧠 AGENT 1: Fact-Checker
    async factChecker(text, sources) {
        const systemPrompt = `You are an expert fact-checker. Your role is to verify claims by cross-referencing information with reliable sources. Analyze the text and sources provided, then give:
1. A confidence score (0-100%)
2. Key facts verified or contradicted
3. Main concerns if any
Be concise and precise. Format: JSON with keys: score, verified_facts, concerns`;

        const sourcesText = sources.slice(0, 3).map(s => 
            `Source: ${s.title}\n${s.snippet}`
        ).join('\n\n');

        const userPrompt = `Text to verify:\n"${text.substring(0, 800)}"\n\nSources found:\n${sourcesText}\n\nAnalyze and respond in JSON format.`;

        const result = await this.callOpenAI(systemPrompt, userPrompt, 400);
        
        if (!result) {
            return {
                score: 50,
                verified_facts: ['Agent unavailable'],
                concerns: ['OpenAI API not configured'],
                status: 'unavailable'
            };
        }

        try {
            // Extraire JSON de la réponse
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return { score: 50, verified_facts: [result.substring(0, 100)], concerns: [] };
        } catch (e) {
            return { score: 50, verified_facts: [result.substring(0, 100)], concerns: [] };
        }
    }

    // 🧾 AGENT 2: Source Analyst
    async sourceAnalyst(text, sources) {
        const systemPrompt = `You are a source credibility analyst. Evaluate the quality and reliability of sources. For each source, assess:
1. Credibility level (high/medium/low)
2. Potential biases
3. Overall source quality score (0-100%)
Format: JSON with keys: overall_score, credible_sources, concerns`;

        const sourcesText = sources.map(s => 
            `URL: ${s.url}\nTitle: ${s.title}\nSnippet: ${s.snippet}`
        ).join('\n\n---\n\n');

        const userPrompt = `Analyze these sources for the claim:\n"${text.substring(0, 500)}"\n\nSources:\n${sourcesText}\n\nRespond in JSON format.`;

        const result = await this.callOpenAI(systemPrompt, userPrompt, 400);
        
        if (!result) {
            return {
                overall_score: 50,
                credible_sources: sources.length,
                concerns: ['Agent unavailable'],
                status: 'unavailable'
            };
        }

        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return { overall_score: 50, credible_sources: sources.length, concerns: [] };
        } catch (e) {
            return { overall_score: 50, credible_sources: sources.length, concerns: [] };
        }
    }

    // 🕵️ AGENT 3: Context Guardian
    async contextGuardian(text, sources) {
        const systemPrompt = `You are a context analysis expert. Detect if information is taken out of context or if important context is missing. Check for:
1. Missing temporal context (dates, timeframes)
2. Missing geographic context
3. Partial information presented as complete
4. Misleading omissions
Format: JSON with keys: context_score, missing_context, manipulation_detected`;

        const sourcesText = sources.slice(0, 3).map(s => s.snippet).join('\n');

        const userPrompt = `Analyze this text for context issues:\n"${text.substring(0, 800)}"\n\nRelevant sources:\n${sourcesText}\n\nRespond in JSON format.`;

        const result = await this.callOpenAI(systemPrompt, userPrompt, 400);
        
        if (!result) {
            return {
                context_score: 50,
                missing_context: ['Agent unavailable'],
                manipulation_detected: false,
                status: 'unavailable'
            };
        }

        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return { context_score: 50, missing_context: [], manipulation_detected: false };
        } catch (e) {
            return { context_score: 50, missing_context: [], manipulation_detected: false };
        }
    }

    // 🔄 AGENT 4: Freshness Detector
    async freshnessDetector(text, sources) {
        const systemPrompt = `You are a data freshness analyst. Evaluate if the information is current and up-to-date. Check:
1. If data contains recent dates
2. If information might be outdated
3. If sources are recent
Format: JSON with keys: freshness_score, data_age, outdated_concerns`;

        const sourcesText = sources.slice(0, 3).map(s => 
            `${s.title}\n${s.snippet}`
        ).join('\n\n');

        const userPrompt = `Evaluate data freshness:\n"${text.substring(0, 800)}"\n\nSources:\n${sourcesText}\n\nRespond in JSON format with freshness assessment.`;

        const result = await this.callOpenAI(systemPrompt, userPrompt, 300);
        
        if (!result) {
            return {
                freshness_score: 50,
                data_age: 'unknown',
                outdated_concerns: ['Agent unavailable'],
                status: 'unavailable'
            };
        }

        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return { freshness_score: 50, data_age: 'unknown', outdated_concerns: [] };
        } catch (e) {
            return { freshness_score: 50, data_age: 'unknown', outdated_concerns: [] };
        }
    }

    // Lancer les 4 agents en parallèle
    async runAllAgents(text, sources) {
        console.log('🤖 Lancement des 4 agents IA...');

        const [factCheck, sourceAnalysis, contextAnalysis, freshnessAnalysis] = await Promise.all([
            this.factChecker(text, sources),
            this.sourceAnalyst(text, sources),
            this.contextGuardian(text, sources),
            this.freshnessDetector(text, sources)
        ]);

        console.log('✅ Agents IA terminés');

        return {
            fact_checker: factCheck,
            source_analyst: sourceAnalysis,
            context_guardian: contextAnalysis,
            freshness_detector: freshnessAnalysis
        };
    }
}

// ========== SYSTÈME DE FACT-CHECKING DE BASE ==========

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

        console.log(`🔍 Claims extraits: ${claims.length}`);
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
                reasoning: '**Opinion subjective** (40%) - Point de vue personnel nécessitant d\'autres perspectives.'
            };
        }

        if (text.length < 300 && (/^(what|how|why|when|where|qui|quoi|comment|pourquoi|quand|où)/i.test(text.trim()) || text.includes('?'))) {
            return {
                type: 'QUESTION',
                baseScore: 0.30,
                reasoning: '**Question utilisateur** (30%) - Demande d\'information directe.'
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

        return {
            type: 'GENERAL_INFO',
            baseScore: 0.50,
            reasoning: '**Information générale** (50%) - Contenu informatif standard.'
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
            qualityScore += supportingHigh * 0.15;
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

        console.log(`🎯 Calcul du score équilibré...`);

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

        const finalScore = Math.max(0.15, Math.min(0.92, totalScore));
        
        console.log(`📊 Score équilibré: ${Math.round(finalScore * 100)}%`);
        
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

// ========== VÉRIFIER SI UTILISATEUR EST PRO/BUSINESS ==========
async function checkUserPlan(email) {
    if (!email) return { isPro: false, plan: 'free' };
    
    try {
        const client = await pool.connect();
        const result = await client.query(
            'SELECT plan_type FROM subscriptions WHERE user_email = $1 AND status = $2',
            [email, 'active']
        );
        client.release();
        
        if (result.rows.length === 0) {
            return { isPro: false, plan: 'free' };
        }
        
        const plan = result.rows[0].plan_type.toLowerCase();
        const isPro = ['professional', 'pro', 'business'].includes(plan);
        
        return { isPro, plan };
        
    } catch (error) {
        console.error('Erreur vérification plan:', error);
        return { isPro: false, plan: 'free' };
    }
}

// ========== ENDPOINTS API ==========

app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType, userEmail } = req.body;
        
        console.log(`\n🔍 === ANALYSE AVEC AGENTS IA ===`);
        console.log(`📝 Texte: "${text.substring(0, 80)}..."`);
        console.log(`👤 User: ${userEmail || 'anonymous'}`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                overallConfidence: 0.25,
                scoringExplanation: "**Texte insuffisant** (25%) - Contenu trop court pour analyse.", 
                keywords: [],
                sources: [],
                methodology: "Analyse équilibrée avec détection contextuelle"
            });
        }
        
        // Vérifier le plan utilisateur
        const userPlanInfo = await checkUserPlan(userEmail);
        console.log(`📊 Plan: ${userPlanInfo.plan} (Pro: ${userPlanInfo.isPro})`);
        
        const factChecker = new ImprovedFactChecker();
        const claims = factChecker.extractVerifiableClaims(text);
        const keywords = extractMainKeywords(text);
        const sources = await findWebSources(keywords, smartQueries, text);
        const analyzedSources = await analyzeSourcesWithImprovedLogic(factChecker, text, sources);
        const result = factChecker.calculateBalancedScore(text, analyzedSources, claims);
        
        // ✅ LANCER LES 4 AGENTS IA SI PRO/BUSINESS
        let aiAgentsResults = null;
        if (userPlanInfo.isPro && sources.length > 0) {
            const aiAgents = new AIAgentsService();
            aiAgentsResults = await aiAgents.runAllAgents(text, sources);
        }
        
        const response = {
            overallConfidence: result.score,
            confidence: result.confidence,
            scoringExplanation: result.reasoning,
            sources: analyzedSources,
            keywords: keywords,
            claimsAnalyzed: claims,
            details: result.details,
            methodology: "Analyse équilibrée avec détection contextuelle intelligente",
            // ✅ AJOUT: Résultats des agents IA (null si FREE)
            aiAgents: aiAgentsResults,
            userPlan: userPlanInfo.plan
        };
        
        console.log(`✅ Score équilibré: ${Math.round(result.score * 100)}%`);
        console.log(`📊 ${analyzedSources.length} sources | ${claims.length} claims`);
        if (aiAgentsResults) {
            console.log(`🤖 Agents IA exécutés avec succès`);
        }
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Erreur analyse:', error);
        res.status(500).json({ 
            overallConfidence: 0.20,
            scoringExplanation: "**Erreur système** (20%) - Impossible de terminer l'analyse.",
            keywords: [],
            sources: [],
            aiAgents: null
        });
    }
});

// ========== ENDPOINT SUBSCRIPTION EMAIL ==========

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
                console.log(`✅ Email déjà existant: ${sanitizedEmail}`);
                
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
            
            console.log(`✅ Nouvel abonné enregistré: ${sanitizedEmail} (source: ${sanitizedSource})`);
            
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

// ========== ENDPOINTS ABONNEMENTS STRIPE ==========

app.get('/subscription/status', async (req, res) => {
    try {
        const { email } = req.query;
        
        if (!email) {
            return res.json({ subscribed: false });
        }
        
        const client = await pool.connect();
        const result = await client.query(
            'SELECT * FROM subscriptions WHERE user_email = $1 AND status = $2',
            [email, 'active']
        );
        client.release();
        
        if (result.rows.length === 0) {
            return res.json({ subscribed: false });
        }
        
        const sub = result.rows[0];
        res.json({
            subscribed: true,
            plan: sub.plan_type,
            verificationsUsed: sub.verification_count,
            verificationsLimit: sub.verification_limit
        });
    } catch (error) {
        console.error('Erreur statut abonnement:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

app.post('/admin/activate-subscription', async (req, res) => {
    try {
        const { email, plan } = req.body;
        const adminToken = req.headers['x-admin-token'];
        
        if (adminToken !== process.env.ADMIN_TOKEN) {
            return res.status(403).json({ error: 'Non autorisé' });
        }
        
        const limits = { starter: 200, professional: 800, pro: 800, business: 4000 };
        const client = await pool.connect();
        
        await client.query(`
            INSERT INTO subscriptions (user_email, plan_type, verification_limit, status)
            VALUES ($1, $2, $3, 'active')
            ON CONFLICT (user_email) 
            DO UPDATE SET plan_type = $2, verification_limit = $3, status = 'active', updated_at = NOW()
        `, [email, plan, limits[plan]]);
        
        client.release();
        console.log(`✅ Abonnement activé: ${email} - ${plan}`);
        res.json({ success: true, message: `${email} activé sur plan ${plan}` });
    } catch (error) {
        console.error('Erreur activation:', error);
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

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'VERIFYAI-3.0-AI-AGENTS',
        features: ['balanced_scoring', 'contextual_analysis', 'subscriptions', 'stripe_payments', 'email_capture', 'ai_agents_pro'],
        timestamp: new Date().toISOString(),
        api_configured: !!(process.env.GOOGLE_API_KEY && process.env.SEARCH_ENGINE_ID),
        openai_configured: !!process.env.OPENAI_API_KEY
    });
});

// ========== DATABASE INITIALIZATION ==========

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
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id SERIAL PRIMARY KEY,
                user_email VARCHAR(255) UNIQUE NOT NULL,
                stripe_customer_id VARCHAR(255),
                plan_type VARCHAR(50),
                status VARCHAR(50) DEFAULT 'active',
                verification_count INT DEFAULT 0,
                verification_limit INT DEFAULT 200,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
            
            CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON subscriptions(user_email);
            CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
        `);
        
        client.release();
        console.log('✅ Database ready (feedback + emails + subscriptions)');
    } catch (err) {
        console.error('❌ Database error:', err.message);
    }
};

// ========== STARTUP ==========

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 === VERIFYAI 3.0 + 4 AGENTS IA ===`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔑 Google API: ${!!process.env.GOOGLE_API_KEY ? '✓' : '✗'}`);
    console.log(`🤖 OpenAI API: ${!!process.env.OPENAI_API_KEY ? '✓' : '✗'}`);
    console.log(`💾 Database: ${!!process.env.DATABASE_URL ? '✓' : '✗'}`);
    console.log(`📧 Email Capture: ✓`);
    console.log(`💳 Stripe: ✓`);
    console.log(`🎯 Features: 4 AI Agents (Pro/Business only)`);
    console.log(`==========================================\n`);
    initDb();
});
