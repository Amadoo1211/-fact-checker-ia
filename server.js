// Fonction améliortée pour analyser le type de contenu
function analyzeContentType(text) {
    const lower = text.toLowerCase().normalize('NFC');
    
    // PATTERN OPINIONS RENFORCÉ - PRIORITÉ ABSOLUE
    const strongOpinionPatterns = [
        // Comparaisons subjectives directes
        /\b(better than|worse than|superior to|inferior to|prefer.*over|tastes better|looks better|sounds better)\b/i,
        /\b(meilleur que|pire que|supérieur à|inférieur à|préfère.*à|goût.*meilleur|plus.*beau)\b/i,
        
        // Expressions d'opinion personnelle
        /\b(i think|i believe|i feel|in my opinion|personally|subjectively)\b/i,
        /\b(je pense|je crois|je trouve|à mon avis|personnellement|subjectivement)\b/i,
        
        // Jugements esthétiques/gustatifs
        /\b(delicious|disgusting|beautiful|ugly|amazing|terrible|wonderful|awful)\b/i,
        /\b(délicieux|dégoûtant|beau|laid|merveilleux|terrible|magnifique|affreux)\b/i,
        
        // Préférences explicites
        /\b(favorite|favourite|best.*ever|worst.*ever|love.*more|hate.*more)\b/i,
        /\b(favori|préféré|le meilleur|le pire|aime.*plus|déteste.*plus)\b/i,
        
        // Questions de goût
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
            'tombé', 'fondé', 'établi', 'mort', 'né', 'guerre', 'fini', 'commencé',
            'construit', 'découvert', 'inventé', 'signé', 'déclaré', 'mur', 'révolution',
            'indépendance', 'traité', 'bataille', 'élu', 'assassiné', 'créé', 'lancé'
        ];
        
        if (historicalIndicators.some(word => lower.includes(word))) {
            return { type: 'HISTORICAL_FACT', confidence: 0.9 };
        }
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
    
    // PATTERN FAITS GÉOGRAPHIQUES
    const geoPatterns = [
        /capital.*is|capitale.*de|population.*is|population.*de/i,
        /area.*square|superficie|located in|situé.*en/i,
        /largest city|plus.*grande.*ville|official language|langue.*officielle/i,
        /borders|frontière|elevation|altitude|climate|climat/i
    ];
    
    if (geoPatterns.some(pattern => pattern.test(text))) {
        return { type: 'GEOGRAPHIC_FACT', confidence: 0.85 };
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

// Fonction améliorée pour vérifier la pertinence des sources
function isSourceRelevant(source, originalText) {
    const sourceText = (source.title + ' ' + source.snippet).toLowerCase();
    const queryWords = originalText.toLowerCase().match(/\b\w{4,}\b/g) || [];
    
    // Filtrer les mots vides
    const stopWords = ['this', 'that', 'with', 'from', 'they', 'were', 'have', 'been', 'will', 'would', 'could', 'should', 'pour', 'avec', 'dans', 'elle', 'vous', 'sont', 'être'];
    const relevantWords = queryWords.filter(word => 
        !stopWords.includes(word) && word.length > 3
    );
    
    // Compter les correspondances
    const matchingWords = relevantWords.filter(word => 
        sourceText.includes(word)
    );
    
    const relevanceScore = matchingWords.length / Math.max(relevantWords.length, 1);
    
    // Seuil de pertinence : au moins 40% des mots importants
    return relevanceScore >= 0.4;
}

// Fonction modifiée de recherche avec filtre de pertinence
async function findWebSourcesIntelligent(smartQueries, fallbackKeywords, originalText) {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

    if (!API_KEY || !SEARCH_ENGINE_ID) {
        console.log('Missing API credentials for intelligent search');
        return [];
    }
    
    let allSources = [];
    
    // Utiliser les requêtes intelligentes
    if (smartQueries && smartQueries.length > 0) {
        console.log('🔍 Using intelligent queries:', smartQueries);
        
        for (const [index, query] of smartQueries.slice(0, 2).entries()) {
            try {
                console.log(`🔍 Query ${index + 1}: "${query}"`);
                const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=4`;
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
                            relevance: calculateRelevance(item, query)
                        }));
                        allSources.push(...sources);
                        console.log(`✅ Found ${sources.length} sources for query "${query}"`);
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 200));
                
            } catch (error) {
                console.error(`❌ Error with intelligent query "${query}":`, error.message);
            }
        }
    }
    
    // Fallback si nécessaire
    if (allSources.length < 2 && fallbackKeywords && fallbackKeywords.length > 0) {
        console.log('🔄 Using fallback keywords:', fallbackKeywords);
        
        try {
            const fallbackQuery = fallbackKeywords.slice(0, 4).join(' ');
            console.log(`🔍 Fallback query: "${fallbackQuery}"`);
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
                        relevance: calculateRelevance(item, fallbackQuery)
                    }));
                    allSources.push(...sources);
                    console.log(`✅ Fallback found ${sources.length} additional sources`);
                }
            }
        } catch (error) {
            console.error('❌ Fallback search error:', error.message);
        }
    }
    
    // FILTRER LES SOURCES PERTINENTES
    const relevantSources = allSources.filter(source => 
        isSourceRelevant(source, originalText)
    );
    
    console.log(`🎯 Filtered to ${relevantSources.length}/${allSources.length} relevant sources`);
    
    // Déduplication et tri
    const uniqueSources = [];
    const seenUrls = new Set();
    
    relevantSources.sort((a, b) => (b.relevance || 0.5) - (a.relevance || 0.5));
    
    for (const source of relevantSources) {
        if (!seenUrls.has(source.url)) {
            seenUrls.add(source.url);
            uniqueSources.push(source);
        }
    }
    
    return uniqueSources.slice(0, 6);
}

// Fonction de scoring corrigée
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
    
    // SCORES DE BASE pour contenu factuel
    let baseScore = 0.3;
    let explanation = "";
    
    switch (type) {
        case 'HISTORICAL_FACT':
            baseScore = 0.80;
            explanation = "**Historical content detected** - ";
            break;
            
        case 'GEOGRAPHIC_FACT':
            baseScore = 0.75;
            explanation = "**Geographic information** - ";
            break;
            
        case 'SCIENTIFIC_FACT':
            baseScore = 0.85;
            explanation = "**Scientific content** - ";
            break;
            
        case 'DEFINITION':
            baseScore = 0.65;
            explanation = "**Definition/explanation** - ";
            break;
            
        case 'POTENTIAL_FACT':
            baseScore = 0.55;
            explanation = "**Factual content** - ";
            break;
            
        case 'TOO_SHORT':
            return {
                score: 0.2,
                explanation: "**Insufficient content** (20%). Text too short for analysis."
            };
    }
    
    // BONUS selon sources PERTINENTES
    let sourceBonus = 0;
    let sourceText = "";
    
    if (sources && sources.length > 0) {
        const wikipediaSources = sources.filter(s => s.url && s.url.includes('wikipedia')).length;
        const academicSources = sources.filter(s => s.url && (s.url.includes('.edu') || s.url.includes('.gov'))).length;
        
        if (wikipediaSources > 0) {
            sourceBonus += 0.15;
            sourceText += "Wikipedia sources found. ";
        }
        if (academicSources > 0) {
            sourceBonus += 0.12;
            sourceText += "Academic sources found. ";
        }
    }
    
    if (sourceCount >= 3) {
        sourceBonus += 0.10;
        sourceText += "Multiple sources confirm this information.";
    } else if (sourceCount === 2) {
        sourceBonus += 0.08;
        sourceText += "Two sources found supporting this information.";
    } else if (sourceCount === 1) {
        sourceBonus += 0.05;
        sourceText += "One relevant source found.";
    } else {
        sourceBonus = 0;
        sourceText += "No relevant sources found for verification.";
    }
    
    // CALCUL FINAL
    const finalScore = Math.min(baseScore + sourceBonus, 0.96);
    const finalPercent = Math.round(finalScore * 100);
    
    // LABELS DE FIABILITÉ
    let reliabilityLabel = "";
    if (finalPercent >= 90) {
        reliabilityLabel = "Highly reliable";
    } else if (finalPercent >= 75) {
        reliabilityLabel = "Good reliability";
    } else if (finalPercent >= 60) {
        reliabilityLabel = "Moderate reliability";
    } else if (finalPercent >= 45) {
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

// ENDPOINT PRINCIPAL corrigé
app.post('/verify', async (req, res) => {
    try {
        const { text, smartQueries, analysisType } = req.body;
        
        console.log(`🔍 Analysis request - Type: ${analysisType || 'standard'}, Smart queries: ${smartQueries ? smartQueries.length : 0}`);
        
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
        console.log(`📊 Content analysis: ${contentAnalysis.type} (confidence: ${(contentAnalysis.confidence * 100).toFixed(0)}%)`);
        
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
        console.log(`🏷️ Keywords extracted: ${keywords.join(', ')}`);
        
        // RECHERCHE DE SOURCES avec filtre de pertinence
        let sources = [];
        if (['HISTORICAL_FACT', 'GEOGRAPHIC_FACT', 'SCIENTIFIC_FACT', 'DEFINITION', 'POTENTIAL_FACT'].includes(contentAnalysis.type)) {
            
            if (analysisType === 'intelligent' && smartQueries && smartQueries.length > 0) {
                console.log('🧠 Using intelligent search with relevance filtering');
                sources = await findWebSourcesIntelligent(smartQueries, keywords, text);
            } else {
                console.log('🔍 Using standard search with relevance filtering');
                const standardSources = await findWebSources(keywords);
                // Appliquer le filtre de pertinence aux sources standard aussi
                sources = standardSources.filter(source => isSourceRelevant(source, text));
            }
            
            console.log(`📄 Total relevant sources found: ${sources.length}`);
        } else {
            console.log(`⏭️ Skipping source search for content type: ${contentAnalysis.type}`);
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
                relevantSourcesRatio: sources.length > 0 ? 1.0 : 0.0 // Toutes les sources retournées sont pertinentes maintenant
            };
        }
        
        console.log(`✅ Final score: ${Math.round(result.score * 100)}% (${contentAnalysis.type})`);
        res.json(response);
        
    } catch (error) {
        console.error('❌ Verification error:', error);
        res.status(500).json({ 
            overallConfidence: 0.1,
            scoringExplanation: "**Server error** (10%). Unable to complete analysis.",
            keywords: [],
            sources: []
        });
    }
});
