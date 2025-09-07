const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();

// Configuration
app.use(cors({ 
    origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Connexion à la base de données
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Initialisation de la base de données
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
        console.error('❌ Database error:', err);
    }
};

// EXTRACTION DE MOTS-CLÉS AMÉLIORÉE POUR SOURCES PERTINENTES
function extractMainKeywords(text) {
    const cleaned = text.normalize('NFC').replace(/['']/g, "'").substring(0, 1200);
    const keywords = [];
    
    // PRIORITÉ 1: Entités nommées (personnes, lieux, événements)
    const namedEntities = cleaned.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\b/g) || [];
    const filteredEntities = namedEntities.filter(entity => 
        entity.length > 3 && 
        !entity.match(/^(The|This|That|When|Where|What|How|Why|Who|Yes|World|War|Day|May|Victory)$/i)
    );
    keywords.push(...filteredEntities.slice(0, 4));
    
    // PRIORITÉ 2: Dates et années (pour contenu historique)
    const dates = cleaned.match(/\b(19|20)\d{2}\b|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi) || [];
    keywords.push(...dates.slice(0, 2));
    
    // PRIORITÉ 3: Nombres spécifiques et mesures
    const numbers = cleaned.match(/\b\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?\s*(?:million|billion|trillion|percent|%|km²|square\s*kilometers|meters|miles|dollars|euros|kilometres|population)\b/gi) || [];
    keywords.push(...numbers.slice(0, 3));
    
    // PRIORITÉ 4: Termes techniques et concepts spécialisés
    const technicalTerms = cleaned.match(/\b(?:approximately|exactly|officially|capital|area|population|founded|established|located|situated|declared|independence|surrender|treaty|victory|defeat|government|constitution|republic|democracy)\b/gi) || [];
    keywords.push(...technicalTerms.slice(0, 3));
    
    // PRIORITÉ 5: Mots significatifs longs
    const significantWords = cleaned.match(/\b[a-zA-Z]{6,}\b/g) || [];
    const filteredWords = significantWords.filter(word => 
        !word.match(/^(however|therefore|because|through|without|although|sometimes|everything|anything|something|nothing|correct|exactly)$/i)
    );
    keywords.push(...filteredWords.slice(0, 4));
    
    // Nettoyer et déduper avec priorité aux entités nommées
    const unique = [...new Set(keywords)]
        .filter(k => k && k.length > 2)
        .slice(0, 8);
    
    console.log(`🔍 Mots-clés extraits pour recherche: ${unique.join(', ')}`);
    return unique;
}

// NOUVELLE FONCTION POUR EXTRAIRE LES CONCEPTS CLÉS POUR MATCHING
function extractKeyConceptsForMatching(text) {
    const entities = [];
    const keywords = [];
    const context = [];
    
    // Entités nommées (noms propres)
    const namedEntities = text.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2}\b/g) || [];
    entities.push(...namedEntities.filter(e => e.length > 3 && !e.match(/^(World|War|Day|May|Victory|Europe|Asia|Japan|Germany)$/)).slice(0, 5));
    
    // Dates et nombres importants
    const dates = text.match(/\b(19|20)\d{2}\b/g) || [];
    const specificNumbers = text.match(/\b\d{1,3}(?:[,\s]\d{3})*\b/g) || [];
    context.push(...dates, ...specificNumbers.slice(0, 3));
    
    // Mots-clés significatifs
    const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    const stopWords = ['this', 'that', 'with', 'from', 'they', 'were', 'have', 'been', 'will', 'would', 'could', 'should', 'very', 'much', 'more', 'most', 'some', 'many', 'exactly', 'correct'];
    const significantWords = words.filter(w => !stopWords.includes(w)).slice(0, 8);
    keywords.push(...significantWords);
    
    return { entities, keywords, context };
}

// FONCTION AMÉLIORÉE POUR VÉRIFIER LA PERTINENCE DES SOURCES
function isSourceRelevant(source, originalText, minRelevanceScore = 0.35) {
    if (!source || !source.title || !source.snippet) return false;
    
    const sourceContent = (source.title + ' ' + source.snippet).toLowerCase();
    const originalLower = originalText.toLowerCase();
    
    // Extraire les concepts clés du texte original
    const keyConcepts = extractKeyConceptsForMatching(originalText);
    
    let relevanceScore = 0;
    let matches = 0;
    
    // SCORING AMÉLIORÉ
    // 1. Correspondance d'entités nommées (poids fort)
    for (const entity of keyConcepts.entities) {
        const entityLower = entity.toLowerCase();
        if (sourceContent.includes(entityLower)) {
            relevanceScore += 0.4;
            matches++;
            console.log(`  ✅ Entité trouvée: "${entity}"`);
        }
    }
    
    // 2. Correspondance de contexte (dates, lieux, nombres) - POIDS TRÈS FORT
    for (const context of keyConcepts.context) {
        if (sourceContent.includes(context.toLowerCase())) {
            relevanceScore += 0.35;
            matches++;
            console.log(`  ✅ Contexte trouvé: "${context}"`);
        }
    }
    
    // 3. Correspondance de mots-clés principaux (poids moyen)
    let keywordMatches = 0;
    for (const keyword of keyConcepts.keywords) {
        if (sourceContent.includes(keyword.toLowerCase())) {
            keywordMatches++;
        }
    }
    if (keywordMatches >= 3) {
        relevanceScore += 0.3;
        matches++;
        console.log(`  ✅ ${keywordMatches} mots-clés correspondants`);
    } else if (keywordMatches >= 2) {
        relevanceScore += 0.2;
        matches++;
    }
    
    // BONUS pour sources de qualité
    const url = (source.url || source.link || '').toLowerCase();
    if (url.includes('wikipedia.org')) {
        relevanceScore += 0.25;
        console.log(`  🏆 Source Wikipedia`);
    } else if (url.includes('.edu') || url.includes('.gov')) {
        relevanceScore += 0.2;
        console.log(`  🏆 Source académique/gouvernementale`);
    } else if (url.includes('britannica') || url.includes('larousse')) {
        relevanceScore += 0.15;
        console.log(`  🏆 Source encyclopédique`);
    }
    
    // MALUS pour sources douteuses
    if (url.includes('reddit') || url.includes('quora') || url.includes('yahoo.answers')) {
        relevanceScore -= 0.3;
        console.log(`  ❌ Source peu fiable détectée`);
    }
    
    const isRelevant = relevanceScore >= minRelevanceScore;
    console.log(`📊 Source "${source.title?.substring(0, 50)}..." - Score: ${relevanceScore.toFixed(2)} (${matches} matches) - ${isRelevant ? 'ACCEPTÉE' : 'REJETÉE'}`);
    
    return isRelevant;
}

// Fonction améliorée pour analyser le type de contenu
function analyzeContentType(text) {
    const lower = text.toLowerCase().normalize('NFC');
    
    // PATTERN OPINIONS RENFORCÉ - PRIORITÉ ABSOLUE
    const strongOpinionPatterns = [
        /\b(better than|worse than|superior to|inferior to|prefer.*over|tastes better|looks better|sounds better)\b/i,
        /\b(meilleur que|pire que|supérieur à|inférieur à|préfère.*à|goût.*meilleur|plus.*beau)\b/i,
        /\b(i think|i believe|i feel|in my opinion|personally|subjectively)\b/i,
        /\b(je pense|je crois|je trouve|à mon avis|personnellement|subjectivement)\b/i,
        /\b(delicious|disgusting|beautiful|ugly|amazing|terrible|wonderful|awful)\b/i,
        /\b(délicieux|dégoûtant|beau|laid|merveilleux|terrible|magnifique|affreux)\b/i,
        /\b(favorite|favourite|best.*ever|worst.*ever|love.*more|hate.*more)\b/i,
        /\b(favori|préféré|le meilleur|le pire|aime.*plus|déteste.*plus)\b/i,
        /\b(matter of taste|question.*taste|subjective.*matter|personal.*preference)\b/i,
        /\b(question.*goût|affaire.*goût|sujet.*subjectif|préférence.*personnelle)\b/i
    ];
    
    // Vérification STRICTE pour opinions
    for (const pattern of strongOpinionPatterns) {
        if (pattern.test(text)) {
            console.log(`Opinion détectée avec pattern: ${pattern}`);
            return { type: 'OPINION', confidence: 0.95 };
        }
    }
    
    // PATTERN DÉTECTION DE QUESTIONS UTILISATEUR
    const questionPatterns = [
        /^(what|how|why|when|where|which|who|can you|could you|please tell me)/i,
        /^(qu'est-ce que|comment|pourquoi|quand|où|quel|qui|peux-tu|pouvez-vous)/i,
        /\?$/,
        /^(explain|describe|give me|tell me about)/i,
        /^(explique|décris|donne-moi|parle-moi de)/i
    ];
    
    for (const pattern of questionPatterns) {
        if (pattern.test(text.trim()) && text.length < 300) {
            return { type: 'USER_QUESTION', confidence: 0.9 };
        }
    }
    
    // PATTERN FAITS HISTORIQUES avec dates
    if (text.match(/\b(19|20)\d{2}\b/)) {
        const historicalIndicators = [
            'fell', 'founded', 'established', 'died', 'born', 'war', 'ended', 'began',
            'started', 'built', 'discovered', 'invented', 'signed', 'declared',
            'wall', 'berlin', 'revolution', 'independence', 'treaty', 'battle',
            'elected', 'assassinated', 'created', 'launched', 'opened', 'closed',
            'empire', 'dynasty', 'kingdom', 'republic', 'constitution', 'president',
            'victory', 'defeat', 'surrender', 'official', 'europe', 'asia',
            'tombé', 'fondé', 'établi', 'mort', 'né', 'guerre', 'fini', 'commencé',
            'construit', 'découvert', 'inventé', 'signé', 'déclaré', 'mur', 'révolution',
            'indépendance', 'traité', 'bataille', 'élu', 'assassiné', 'créé', 'lancé'
        ];
        
        if (historicalIndicators.some(word => lower.includes(word))) {
            return { type: 'HISTORICAL_FACT', confidence: 0.9 };
        }
    }
    
    // PATTERN FAITS GÉOGRAPHIQUES
    const geoPatterns = [
        /capital.*is|capitale.*de|population.*is|population.*de/i,
        /area.*square|superficie|located in|situé.*en/i,
        /largest city|plus.*grande.*ville|official language|langue.*officielle/i,
        /borders|frontière|elevation|altitude|climate|climat/i,
        /square.*kilometers|km²|square.*miles/i
    ];
    
    if (geoPatterns.some(pattern => pattern.test(text))) {
        return { type: 'GEOGRAPHIC_FACT', confidence: 0.85 };
    }
    
    // PATTERN FAITS SCIENTIFIQUES
    const sciencePatterns = [
        /speed of light|vitesse.*lumière|299.*792.*458|constante.*physique/i,
        /boiling point|point.*ébullition|melting point|point.*fusion/i,
        /atomic number|numéro.*atomique|molecular weight|masse.*molaire/i,
        /scientific name|nom.*scientifique|chemical formula|formule.*chimique/i,
        /relativity|relativité|quantum|quantique|theorem|théorème/i
    ];
    
    if (sciencePatterns.some(pattern => pattern.test(text))) {
        return { type: 'SCIENTIFIC_FACT', confidence: 0.85 };
    }
    
    // PATTERN DÉFINITIONS
    const definitionPatterns = [
        /\w+ is a|est un|refers to|fait référence|means|signifie/i,
        /defined as|défini comme|known as|connu comme|also called|également appelé/i
    ];
    
    if (definitionPatterns.some(pattern => pattern.test(text))) {
        return { type: 'DEFINITION', confidence: 0.7 };
    }
    
    // Texte trop court
    if (text.length < 25) {
        return { type: 'TOO_SHORT', confidence: 0.9 };
    }
    
    // Par défaut
    const factualScore = Math.min(0.6 + (text.length / 1000) * 0.2, 0.8);
    return { type: 'POTENTIAL_FACT', confidence: factualScore };
}

// FONCTION DE CALCUL DE PERTINENCE DÉTAILLÉE
function calculateDetailedRelevance(searchItem, originalText) {
    const title = (searchItem.title || '').toLowerCase();
    const snippet = (searchItem.snippet || '').toLowerCase();
    const url = (searchItem.link || '').toLowerCase();
    
    let score = 0;
    
    // Extraction des concepts du texte original
    const originalConcepts = extractKeyConceptsForMatching(originalText);
    
    // Correspondance d'entités dans le titre (poids fort)
    for (const entity of originalConcepts.entities) {
        if (title.includes(entity.toLowerCase())) {
            score += 0.5;
        }
        if (snippet.includes(entity.toLowerCase())) {
            score += 0.3;
        }
    }
    
    // Correspondance de contexte (dates, nombres)
    for (const context of originalConcepts.context) {
        if (title.includes(context.toLowerCase()) || snippet.includes(context.toLowerCase())) {
            score += 0.4;
        }
    }
    
    // Correspondance de mots-clés
    let keywordMatches = 0;
    for (const keyword of originalConcepts.keywords.slice(0, 5)) {
        if (title.includes(keyword) || snippet.includes(keyword)) {
            keywordMatches++;
        }
    }
    if (keywordMatches >= 3) score += 0.3;
    else if (keywordMatches >= 2) score += 0.2;
    
    // Bonus pour sources fiables
    if (url.includes('wikipedia.org')) score += 0.6;
    else if (url.includes('.edu') || url.includes('.gov')) score += 0.5;
    else if (url.includes('britannica.com')) score += 0.4;
    else if (url.includes('nationalgeographic') || url.includes('history.com')) score += 0.3;
    
    // Malus pour sources peu fiables
    if (url.includes('reddit.com') || url.includes('quora.com')) score -= 0.3;
    if (url.includes('blog') || url.includes('forum')) score -= 0.2;
    
    return Math.min(score, 1.0);
}

// Calculer la pertinence d'une source
function calculateRelevance(item, query) {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const titleWords = (item.title || '').toLowerCase().split(/\s+/);
    const snippetWords = (item.snippet || '').toLowerCase().split(/\s+/);
    
    let relevanceScore = 0;
    
    // Bonus pour mots dans le titre
    for (const qWord of queryWords) {
        if (titleWords.some(tWord => tWord.includes(qWord))) {
            relevanceScore += 0.3;
        }
        if (snippetWords.some(sWord => sWord.includes(qWord))) {
            relevanceScore += 0.1;
        }
    }
    
    // Bonus pour sources de qualité
    const url = (item.link || '').toLowerCase();
    if (url.includes('wikipedia')) relevanceScore += 0.4;
    else if (url.includes('.edu') || url.includes('.gov')) relevanceScore += 0.3;
    else if (url.includes('britannica') || url.includes('larousse')) relevanceScore += 0.2;
    
    return Math.min(relevanceScore, 1.0);
}

// RECHERCHE INTELLIGENTE AVEC FILTRE DE PERTINENCE STRICT
async function findWebSourcesIntelligent(smartQueries, fallbackKeywords, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        console.log('❌ Missing API credentials for intelligent search');
        return [];
    }
    
    let allSources = [];
    console.log(`🔍 Recherche intelligente avec ${smartQueries?.length || 0} requêtes optimisées`);
    
    // Utiliser les requêtes intelligentes
    if (smartQueries && smartQueries.length > 0) {
        for (const [index, query] of smartQueries.slice(0, 3).entries()) {
            try {
                console.log(`🔍 Requête ${index + 1}: "${query}"`);
                const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=6`;
                const response = await fetch(url);
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.items) {
                        const sources = data.items.map(item => ({
                            title: item.title,
                            url: item.link,
                            snippet: item.snippet,
                            type: 'intelligent_search',
                            query_used: query,
                            relevance: calculateDetailedRelevance(item, originalText)
                        }));
                        allSources.push(...sources);
                        console.log(`✅ ${sources.length} sources trouvées pour "${query}"`);
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 250));
                
            } catch (error) {
                console.error(`❌ Erreur requête "${query}":`, error.message);
            }
        }
    }
    
    // Fallback si nécessaire
    if (allSources.length < 2 && fallbackKeywords && fallbackKeywords.length > 0) {
        console.log('🔄 Utilisation des mots-clés de fallback');
        
        try {
            const fallbackQuery = fallbackKeywords.slice(0, 4).join(' ');
            console.log(`🔍 Requête fallback: "${fallbackQuery}"`);
            const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(fallbackQuery)}&num=4`;
            const response = await fetch(url);
            
            if (response.ok) {
                const data = await response.json();
                if (data.items) {
                    const sources = data.items.map(item => ({
                        title: item.title,
                        url: item.link,
                        snippet: item.snippet,
                        type: 'fallback_search',
                        query_used: fallbackQuery,
                        relevance: calculateDetailedRelevance(item, originalText)
                    }));
                    allSources.push(...sources);
                    console.log(`✅ Fallback: ${sources.length} sources supplémentaires`);
                }
            }
        } catch (error) {
            console.error('❌ Erreur recherche fallback:', error.message);
        }
    }
    
    // FILTRAGE STRICT DES SOURCES PERTINENTES
    console.log(`🎯 Filtrage de ${allSources.length} sources avec critères stricts...`);
    const relevantSources = allSources.filter(source => 
        isSourceRelevant(source, originalText, 0.4) // Seuil strict à 0.4
    );
    
    console.log(`🎯 ${relevantSources.length}/${allSources.length} sources pertinentes retenues après filtrage`);
    
    // Déduplication et tri par pertinence
    const uniqueSources = [];
    const seenUrls = new Set();
    
    relevantSources.sort((a, b) => (b.relevance || 0.5) - (a.relevance || 0.5));
    
    for (const source of relevantSources) {
        if (!seenUrls.has(source.url) && uniqueSources.length < 5) {
            seenUrls.add(source.url);
            uniqueSources.push(source);
        }
    }
    
    console.log(`📋 ${uniqueSources.length} sources finales sélectionnées`);
    return uniqueSources;
}

// RECHERCHE STANDARD (fallback)
async function findWebSources(keywords) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID || keywords.length === 0) {
        return [];
    }
    
    const query = keywords.slice(0, 4).join(' ');
    const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=4`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.log('Search API error:', response.status);
            return [];
        }
        const data = await response.json();
        if (!data.items) return [];

        return data.items.map(item => ({
            title: item.title,
            url: item.link,
            snippet: item.snippet,
            type: 'standard_search'
        }));
    } catch (error) {
        console.error('Search error:', error.message);
        return [];
    }
}

// FONCTION DE SCORING FINAL CORRIGÉE
function calculateFinalScore(contentAnalysis, sourceCount, keywords, sources = [], originalText = "") {
    const { type, confidence } = contentAnalysis;
    
    // GESTION PRIORITAIRE DES OPINIONS
    if (type === 'OPINION') {
        console.log('🎯 Opinion détectée - Score faible forcé');
        return {
            score: 0.25,
            explanation: "**Opinion/Subjective** (25%). Personal viewpoint or taste preference, not verifiable fact."
        };
    }
    
    // GESTION DES QUESTIONS UTILISATEUR
    if (type === 'USER_QUESTION') {
        return {
            score: 0.15,
            explanation: "**User Question** (15%). This appears to be a question rather than a factual statement."
        };
    }
    
    // SCORES DE BASE pour contenu factuel (plus conservateurs)
    let baseScore = 0.3;
    let explanation = "";
    
    switch (type) {
        case 'HISTORICAL_FACT':
            baseScore = 0.75; // Réduit car nécessite vérification
            explanation = "**Historical content** - ";
            break;
            
        case 'GEOGRAPHIC_FACT':
            baseScore = 0.70; // Réduit
            explanation = "**Geographic information** - ";
            break;
            
        case 'SCIENTIFIC_FACT':
            baseScore = 0.80;
            explanation = "**Scientific content** - ";
            break;
            
        case 'DEFINITION':
            baseScore = 0.60;
            explanation = "**Definition/explanation** - ";
            break;
            
        case 'POTENTIAL_FACT':
            baseScore = 0.50; // Réduit
            explanation = "**Factual content** - ";
            break;
            
        case 'TOO_SHORT':
            return {
                score: 0.2,
                explanation: "**Insufficient content** (20%). Text too short for analysis."
            };
    }
    
    // BONUS BASÉ SUR LA QUALITÉ ET PERTINENCE DES SOURCES
    let sourceBonus = 0;
    let sourceText = "";
    
    if (sources && sources.length > 0) {
        // Analyser la qualité des sources
        const wikipediaSources = sources.filter(s => s.url && s.url.includes('wikipedia')).length;
        const academicSources = sources.filter(s => s.url && (s.url.includes('.edu') || s.url.includes('.gov'))).length;
        const highRelevanceSources = sources.filter(s => s.relevance && s.relevance > 0.6).length;
        
        // Bonus pour sources de qualité
        if (wikipediaSources >= 2) {
            sourceBonus += 0.15;
            sourceText += "Multiple Wikipedia sources found. ";
        } else if (wikipediaSources >= 1) {
            sourceBonus += 0.12;
            sourceText += "Wikipedia source found. ";
        }
        
        if (academicSources >= 1) {
            sourceBonus += 0.10;
            sourceText += "Academic sources found. ";
        }
        
        // Bonus pour pertinence élevée
        if (highRelevanceSources >= 2) {
            sourceBonus += 0.12;
            sourceText += "Highly relevant sources confirm information.";
        } else if (highRelevanceSources >= 1) {
            sourceBonus += 0.08;
            sourceText += "Relevant sources support this information.";
        } else if (sources.length >= 2) {
            sourceBonus += 0.05;
            sourceText += "Multiple sources found with moderate relevance.";
        } else {
            sourceBonus += 0.03;
            sourceText += "Limited source verification available.";
        }
    } else {
        sourceBonus = 0;
        sourceText += "No relevant sources found for verification.";
    }
    
    // CALCUL FINAL avec plafond réaliste
    const finalScore = Math.min(baseScore + sourceBonus, 0.92);
    const finalPercent = Math.round(finalScore * 100);
    
    // LABELS DE FIABILITÉ ajustés
    let reliabilityLabel = "";
    if (finalPercent >= 85) {
        reliabilityLabel = "Highly reliable";
    } else if (finalPercent >= 70) {
        reliabilityLabel = "Good reliability";
    } else if (finalPercent >= 55) {
        reliabilityLabel = "Moderate reliability";
    } else if (finalPercent >= 40) {
        reliabilityLabel = "Low reliability";
    } else {
        reliabilityLabel = "Very low reliability";
    }
    
    const fullExplanation = `${explanation}**${reliabilityLabel}** (${finalPercent}%). ${sourceText}`;
    
    return {
        score: finalScore,
        explanation: fullExplanation
    };
}

// ENDPOINT PRINCIPAL AVEC RECHERCHE INTELLIGENTE ET DÉTECTION D'OPINIONS
app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType } = req.body;
        
        console.log(`🔍 Analyse demandée - Type: ${analysisType || 'standard'}, Requêtes intelligentes: ${smartQueries ? smartQueries.length : 0}`);
        
        if (!text || text.length < 10) {
            return res.json({ 
                overallConfidence: 0.15, 
                scoringExplanation: "**Insufficient input** (15%). Text too short for meaningful analysis.", 
                keywords: [],
                sources: []
            });
        }
        
        // ANALYSE DU CONTENU avec détection d'opinions renforcée
        const contentAnalysis = analyzeContentType(text);
        console.log(`📊 Analyse du contenu: ${contentAnalysis.type} (confiance: ${(contentAnalysis.confidence * 100).toFixed(0)}%)`);
        
        // Si c'est une opinion, retourner immédiatement un score faible
        if (contentAnalysis.type === 'OPINION') {
            console.log('🎯 Opinion détectée - Réponse immédiate avec score faible');
            return res.json({
                overallConfidence: 0.25,
                sources: [],
                scoringExplanation: "**Opinion/Subjective** (25%). Personal viewpoint or taste preference, not verifiable fact.",
                keywords: extractMainKeywords(text),
                contentType: 'OPINION'
            });
        }
        
        // Si c'est une question utilisateur, score très faible
        if (contentAnalysis.type === 'USER_QUESTION') {
            return res.json({
                overallConfidence: 0.15,
                sources: [],
                scoringExplanation: "**User Question** (15%). This appears to be a question rather than a factual statement.",
                keywords: extractMainKeywords(text),
                contentType: 'USER_QUESTION'
            });
        }
        
        // EXTRACTION DES MOTS-CLÉS
        const keywords = extractMainKeywords(text);
        console.log(`🏷️ Mots-clés extraits: ${keywords.join(', ')}`);
        
        // RECHERCHE DE SOURCES avec filtre de pertinence strict
        let sources = [];
        if (['HISTORICAL_FACT', 'GEOGRAPHIC_FACT', 'SCIENTIFIC_FACT', 'DEFINITION', 'POTENTIAL_FACT'].includes(contentAnalysis.type)) {
            
            if (analysisType === 'intelligent' && smartQueries && smartQueries.length > 0) {
                console.log('🧠 Utilisation de la recherche intelligente avec filtrage de pertinence');
                sources = await findWebSourcesIntelligent(smartQueries, keywords, text);
            } else {
                console.log('🔍 Utilisation de la recherche standard avec filtrage de pertinence');
                const standardSources = await findWebSources(keywords);
                // Appliquer le filtre de pertinence aux sources standard aussi
                sources = standardSources.filter(source => isSourceRelevant(source, text));
            }
            
            console.log(`📄 Total des sources pertinentes trouvées: ${sources.length}`);
        } else {
            console.log(`⏭️ Recherche de sources ignorée pour le type de contenu: ${contentAnalysis.type}`);
        }
        
        // CALCUL DU SCORE FINAL avec prise en compte de la pertinence des sources
        const result = calculateFinalScore(contentAnalysis, sources.length, keywords, sources, text);
        
        const response = {
            overallConfidence: result.score,
            sources: sources,
            scoringExplanation: result.explanation,
            keywords: keywords,
            contentType: contentAnalysis.type
        };
        
        // Métadonnées de debug
        if (analysisType === 'intelligent') {
            response.debugInfo = {
                queriesUsed: smartQueries || [],
                searchMethod: smartQueries && smartQueries.length > 0 ? 'intelligent' : 'fallback',
                sourcesFound: sources.length,
                contentConfidence: contentAnalysis.confidence,
                relevantSourcesRatio: sources.length > 0 ? 1.0 : 0.0
            };
        }
        
        console.log(`✅ Score final: ${Math.round(result.score * 100)}% (${contentAnalysis.type})`);
        res.json(response);
        
    } catch (error) {
        console.error('❌ Erreur de vérification:', error);
        res.status(500).json({ 
            overallConfidence: 0.1,
            scoringExplanation: "**Server error** (10%). Unable to complete analysis.",
            keywords: [],
            sources: []
        });
    }
});

// ENDPOINT FEEDBACK
app.post('/feedback', async (req, res) => {
    try {
        const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
        
        if (!originalText || scoreGiven === undefined || isUseful === undefined) {
            return res.status(400).json({ error: 'Incomplete feedback data' });
        }
        
        const client = await pool.connect();
        
        await client.query(
            'INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)',
            [
                originalText?.substring(0, 5000), 
                scoreGiven, 
                isUseful, 
                comment || '', 
                JSON.stringify(sourcesFound || [])
            ]
        );
        
        client.release();
        console.log(`📝 Feedback reçu: ${isUseful ? 'Positif' : 'Négatif'}`);
        res.json({ success: true });
        
    } catch (err) {
        console.error('❌ Erreur feedback:', err);
        res.status(500).json({ error: 'Server error saving feedback' });
    }
});

// ENDPOINT DEBUG
app.get('/feedback-stats', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(`
            SELECT 
                COUNT(*) as total_feedback,
                COUNT(CASE WHEN is_useful = true THEN 1 END) as positive_feedback,
                COUNT(CASE WHEN is_useful = false THEN 1 END) as negative_feedback,
                AVG(score_given) as avg_score
            FROM feedback 
            WHERE created_at > NOW() - INTERVAL '30 days'
        `);
        client.release();
        
        const stats = result.rows[0];
        res.json({
            total_feedback: parseInt(stats.total_feedback),
            positive_feedback: parseInt(stats.positive_feedback),
            negative_feedback: parseInt(stats.negative_feedback),
            satisfaction_rate: stats.total_feedback > 0 ? Math.round((stats.positive_feedback / stats.total_feedback) * 100) : 0,
            average_score: parseFloat(stats.avg_score) || 0
        });
        
    } catch (err) {
        console.error('❌ Erreur stats:', err);
        res.status(500).json({ error: 'Error retrieving stats' });
    }
});

// ENDPOINT SANTÉ
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '2.2-sources-pertinentes',
        features: ['intelligent_search', 'opinion_detection', 'strict_source_relevance', 'multi_query'],
        timestamp: new Date().toISOString()
    });
});

// DÉMARRAGE DU SERVEUR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 VerifyAI Backend v2.2 - Système de Sources Pertinentes`);
    console.log(`📡 Serveur démarré sur le port ${PORT}`);
    console.log(`🧠 Détection d'opinions renforcée activée`);
    console.log(`🎯 Filtrage strict de pertinence des sources actif`);
    console.log(`🔍 Système de recherche intelligente multi-requêtes prêt`);
    console.log(`📊 Analyse de qualité des sources activée`);
    initDb();
});
