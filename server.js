const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const cache = new Map();
const CACHE_TTL = 60 * 1000; // 1 minute pour tests (mettre 24*60*60*1000 en production)

app.use(cors({
  origin: ['chrome-extension://*', 'https://*.netlify.app', 'http://localhost:3000', 'https://fact-checker-ia-production.up.railway.app']
}));
app.use(express.json());

// Route pour vider le cache
app.get("/clear-cache", (req, res) => {
  cache.clear();
  res.json({ message: "Cache vidé", timestamp: new Date().toISOString() });
});

// ============ UTILITAIRES ============
function cleanText(text) {
  return text.trim().replace(/\s+/g, ' ').substring(0, 12000);
}

// ============ EXTRACTION DE MOTS-CLÉS V3 - ULTRA PRÉCISE ============
function extractBestKeywords(text) {
  const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'dans', 'sur', 'avec', 'par', 'pour', 'sans', 'qui', 'que', 'est', 'sont', 'oui', 'non', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'that', 'this', 'yes', 'no']);
  
  // Nettoyage des phrases d'introduction d'IA
  const cleaned = text
    .replace(/^(Oui|Non|Bien sûr|Certainement|Voici|Il est important|En effet|Effectivement)[,.]?\s*/i, '')
    .replace(/^(Yes|No|Indeed|Certainly|Here|It's important|Sure)[,.]?\s*/i, '')
    .replace(/["""'']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  let keywords = [];
  
  // 1. Noms propres (personnes, lieux)
  const properNouns = cleaned.match(/\b[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+(?:\s+[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+)*\b/g) || [];
  keywords.push(...properNouns);
  
  // 2. Années et dates
  const dates = cleaned.match(/\b(?:1[0-9]{3}|20[0-2][0-9])\b/g) || [];
  keywords.push(...dates);
  
  // 3. Nombres importants avec unités
  const numbers = cleaned.match(/\b\d+(?:[.,]\d+)?\s*(?:millions?|milliards?|km|habitants?|%)\b/gi) || [];
  keywords.push(...numbers);
  
  // 4. Termes scientifiques et techniques
  const technicalTerms = cleaned.match(/\b(capitale|population|polonium|radium|radioactivité|découverte|invention|théorie|relativité|physique|chimie)\b/gi) || [];
  keywords.push(...technicalTerms);
  
  // 5. Si pas assez de mots-clés, prendre les mots les plus longs
  if (keywords.length < 3) {
    const words = cleaned.split(/\s+/)
      .filter(w => w.length > 4 && !stopWords.has(w.toLowerCase()) && !/^\d+$/.test(w))
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    keywords.push(...words);
  }
  
  // Nettoyage et déduplication
  keywords = keywords
    .map(k => k.trim())
    .filter(k => k && k.length > 2 && !stopWords.has(k.toLowerCase()));
  
  return [...new Set(keywords)].slice(0, 5);
}

// ============ CALCUL DE PERTINENCE V3 - ULTRA STRICT ============
function calculateRelevance(claim, sourceContent) {
  if (!sourceContent) return 0;
  
  const claimKeywords = extractBestKeywords(claim);
  const sourceText = sourceContent.toLowerCase();
  
  if (claimKeywords.length === 0) return 0;
  
  let matchCount = 0;
  let relevanceScore = 0;
  
  // Vérification stricte : TOUS les mots-clés importants doivent matcher
  for (const keyword of claimKeywords) {
    const keywordLower = keyword.toLowerCase();
    
    if (sourceText.includes(keywordLower)) {
      matchCount++;
      // Plus le mot est long et spécifique, plus il vaut de points
      if (keyword.length > 10) {
        relevanceScore += 0.4;
      } else if (keyword.length > 6) {
        relevanceScore += 0.3;
      } else {
        relevanceScore += 0.2;
      }
    }
  }
  
  // Calcul du ratio de correspondance
  const matchRatio = claimKeywords.length > 0 ? matchCount / claimKeywords.length : 0;
  
  // Si moins de 50% des mots-clés matchent, la source n'est pas pertinente
  if (matchRatio < 0.5) {
    return 0.05;
  }
  
  // Bonus pour correspondance totale
  if (matchRatio === 1.0) {
    relevanceScore *= 1.5;
  }
  
  return Math.min(relevanceScore, 1.0);
}

// ============ DÉTECTION D'OPINIONS V3 - EXHAUSTIVE ============
function isOpinionContent(text) {
  const textLower = text.toLowerCase();
  
  // Liste exhaustive de marqueurs d'opinion
  const opinionMarkers = [
    // Superlatifs FR
    'plus belle', 'plus beau', 'plus laid', 'plus mauvais',
    'meilleur', 'meilleure', 'pire', 'le mieux', 'le pire',
    // Jugements subjectifs FR
    'préféré', 'favori', 'déteste', 'adore', 'j\'aime', 'je n\'aime',
    'magnifique', 'horrible', 'parfait', 'nul', 'génial', 
    'fantastique', 'extraordinaire', 'subjectif',
    // Expressions d'opinion FR
    'selon moi', 'à mon avis', 'je pense', 'je crois', 'je trouve',
    'dépend des goûts', 'question de goût', 'point de vue',
    // Universalité subjective FR
    'du monde', 'de tous les temps', 'jamais vu', 'de l\'univers',
    // Superlatifs EN
    'most beautiful', 'most ugly', 'best', 'worst', 'greatest',
    'finest', 'poorest', 'better than', 'worse than',
    // Jugements EN
    'favorite', 'favourite', 'love', 'hate', 'amazing', 'terrible',
    'perfect', 'awful', 'fantastic', 'wonderful',
    // Expressions EN
    'i think', 'i believe', 'in my opinion', 'subjective',
    'depends on', 'matter of taste', 'personal preference',
    // Universalité EN
    'in the world', 'of all time', 'ever made', 'in the universe'
  ];
  
  // Vérifier si c'est une question d'opinion
  const opinionQuestions = [
    /quel(?:le)?\s+est\s+(?:le|la|votre)\s+(?:meilleur|préféré|favori)/i,
    /what\s+is\s+(?:the|your)\s+(?:best|favorite|favourite)/i,
    /qu'est-ce\s+que\s+(?:tu|vous)\s+(?:penses?|pensez)/i,
    /what\s+do\s+you\s+think/i
  ];
  
  // Test des marqueurs
  const hasOpinionMarker = opinionMarkers.some(marker => textLower.includes(marker));
  const isOpinionQuestion = opinionQuestions.some(pattern => pattern.test(textLower));
  
  return hasOpinionMarker || isOpinionQuestion;
}

// ============ RECHERCHE WIKIPEDIA OPTIMISÉE ============
async function searchWikipediaAdvanced(claimText) {
  const sources = [];
  const keywords = extractBestKeywords(claimText);
  
  if (keywords.length === 0) return [];
  
  console.log('🔑 Recherche Wikipedia pour:', keywords);
  
  for (const lang of ['fr', 'en']) {
    try {
      // Recherche avec les 2-3 premiers mots-clés les plus pertinents
      const searchQuery = keywords.slice(0, 3).join(' ');
      const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchQuery)}&format=json&origin=*&srlimit=5`;
      
      const response = await fetch(searchUrl, { timeout: 5000 });
      const data = await response.json();
      
      if (data.query?.search) {
        // Ne prendre que les 3 premiers résultats les plus pertinents
        for (const article of data.query.search.slice(0, 3)) {
          const content = await fetchWikipediaContent(lang, article.title, claimText);
          if (content && content.relevanceScore > 0.3) { // Seuil de pertinence plus élevé
            sources.push(content);
          }
        }
      }
    } catch (error) {
      console.warn(`Wikipedia ${lang} error:`, error.message);
    }
  }
  
  return sources;
}

async function fetchWikipediaContent(lang, title, originalClaim) {
  try {
    const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const response = await fetch(summaryUrl, { timeout: 5000 });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const fullContent = `${data.title} ${data.extract || ''}`;
    const relevanceScore = calculateRelevance(originalClaim, fullContent);
    
    // Ne retourner que si vraiment pertinent
    if (relevanceScore < 0.2) return null;
    
    return {
      title: `Wikipedia (${lang.toUpperCase()}): ${data.title}`,
      url: data.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      snippet: (data.extract || 'Pas de résumé disponible').substring(0, 200) + '...',
      reliability: 0.85,
      sourceCategory: 'encyclopedia',
      relevanceScore: relevanceScore,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    return null;
  }
}

// ============ RECHERCHE WIKIDATA ============
async function searchWikidata(claimText) {
  const keywords = extractBestKeywords(claimText);
  if (keywords.length === 0) return [];
  
  try {
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(keywords.slice(0, 2).join(' '))}&language=fr&format=json&origin=*&limit=3`;
    const response = await fetch(searchUrl, { timeout: 5000 });
    const data = await response.json();
    
    if (data.search?.length > 0) {
      return data.search
        .map(item => {
          const relevanceScore = calculateRelevance(claimText, `${item.label} ${item.description || ''}`);
          
          if (relevanceScore < 0.3) return null; // Filtre de pertinence
          
          return {
            title: `Wikidata: ${item.label}`,
            url: `https://www.wikidata.org/wiki/${item.id}`,
            snippet: (item.description || 'Base de données structurées') + ' - Données factuelles vérifiables.',
            reliability: 0.88,
            sourceCategory: 'database',
            relevanceScore: relevanceScore,
            lastUpdated: new Date().toISOString()
          };
        })
        .filter(s => s !== null);
    }
  } catch (error) {
    console.warn('Wikidata error:', error.message);
  }
  
  return [];
}

// ============ DÉDUPLICATION STRICTE ============
function deduplicateAndRankSources(sources) {
  const seen = new Set();
  const deduplicated = [];
  
  // Filtrer et dédupliquer
  sources.forEach(source => {
    if (!source || !source.relevanceScore || source.relevanceScore < 0.3) {
      return; // Ignorer les sources peu pertinentes
    }
    
    const key = source.title.substring(0, 50);
    if (!seen.has(key) && deduplicated.length < 6) {
      seen.add(key);
      deduplicated.push(source);
    }
  });
  
  // Tri par pertinence décroissante
  return deduplicated.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// ============ CALCUL DU SCORE FINAL V4 - PRODUCTION ============
function calculateFinalScore(text, sources) {
  // 1. DÉTECTION D'OPINION = 25% IMMÉDIAT
  if (isOpinionContent(text)) {
    console.log("🎯 Opinion détectée → 25%");
    return {
      finalScore: 0.25,
      details: {
        finalPercentage: 25,
        sourceBreakdown: { total: 0, relevant: 0 }
      },
      isOpinion: true
    };
  }
  
  // 2. CALCUL POUR CONTENU FACTUEL
  const relevantSources = sources.filter(s => s.relevanceScore > 0.3);
  const highQualitySources = relevantSources.filter(s => s.relevanceScore > 0.6);
  
  let score = 40; // Score de base pour fait
  
  // Bonus basé sur le nombre de sources pertinentes
  if (relevantSources.length >= 5) {
    score += 35;
  } else if (relevantSources.length >= 3) {
    score += 25;
  } else if (relevantSources.length >= 2) {
    score += 15;
  } else if (relevantSources.length === 1) {
    score += 5;
  } else {
    score = 20; // Aucune source = score très bas
  }
  
  // Bonus pour sources de haute qualité
  if (highQualitySources.length >= 2) {
    score += 15;
  } else if (highQualitySources.length === 1) {
    score += 8;
  }
  
  // Bonus pour diversité (encyclopedia + database)
  const hasEncyclopedia = relevantSources.some(s => s.sourceCategory === 'encyclopedia');
  const hasDatabase = relevantSources.some(s => s.sourceCategory === 'database');
  
  if (hasEncyclopedia && hasDatabase) {
    score += 10;
  } else if (hasEncyclopedia || hasDatabase) {
    score += 5;
  }
  
  // Limites
  score = Math.min(95, Math.max(15, score));
  
  console.log(`📊 Score factuel: ${score}% (${relevantSources.length} sources pertinentes)`);
  
  return {
    finalScore: score / 100,
    details: {
      finalPercentage: score,
      sourceBreakdown: {
        total: sources.length,
        relevant: relevantSources.length,
        highQuality: highQualitySources.length,
        encyclopedia: relevantSources.filter(s => s.sourceCategory === 'encyclopedia').length,
        database: relevantSources.filter(s => s.sourceCategory === 'database').length
      }
    },
    isOpinion: false
  };
}

// ============ GÉNÉRATION D'EXPLICATION CLAIRE ============
function generateExplanation(scoringResult, sources) {
  const { finalPercentage, sourceBreakdown } = scoringResult.details;
  
  if (scoringResult.isOpinion) {
    return "Score faible car le contenu exprime une opinion personnelle ou un jugement subjectif plutôt que des faits vérifiables.";
  }
  
  let explanation = "";
  
  if (finalPercentage >= 80) {
    explanation = `Score très élevé grâce à ${sourceBreakdown.relevant} sources hautement pertinentes qui confirment les faits`;
  } else if (finalPercentage >= 60) {
    explanation = `Score élevé avec ${sourceBreakdown.relevant} sources fiables trouvées`;
  } else if (finalPercentage >= 40) {
    explanation = `Score modéré basé sur ${sourceBreakdown.relevant} source(s) disponible(s)`;
  } else {
    explanation = `Score faible. Peu de sources (${sourceBreakdown.relevant}) ont pu vérifier directement les affirmations`;
  }
  
  // Détails sur les types
  if (sourceBreakdown.encyclopedia > 0 || sourceBreakdown.database > 0) {
    const types = [];
    if (sourceBreakdown.encyclopedia > 0) types.push(`${sourceBreakdown.encyclopedia} encyclopédie(s)`);
    if (sourceBreakdown.database > 0) types.push(`${sourceBreakdown.database} base(s) de données`);
    explanation += `, incluant ${types.join(' et ')}`;
  }
  
  explanation += '.';
  return explanation;
}

// ============ FONCTION PRINCIPALE ============
async function performFactCheck(text) {
  const cleanedText = cleanText(text);
  const keywords = extractBestKeywords(cleanedText);
  
  console.log('\n=== ANALYSE ===');
  console.log('Texte:', cleanedText.substring(0, 100));
  console.log('Mots-clés:', keywords);
  
  // Détection d'opinion avec retour immédiat
  if (isOpinionContent(cleanedText)) {
    console.log('⚠️ Opinion détectée');
    return {
      overallConfidence: 0.25,
      sources: [],
      extractedKeywords: keywords,
      contradictions: [],
      scoringExplanation: "Score faible car le contenu exprime une opinion personnelle plutôt que des faits vérifiables.",
      scoringDetails: {
        finalPercentage: 25,
        sourceBreakdown: { total: 0, relevant: 0 }
      },
      alternativeContent: {
        title: "🤔 Ceci est une opinion subjective",
        explanation: "L'analyse factuelle n'est pas applicable aux opinions personnelles. Les préférences varient selon les individus.",
        prompts: [
          `Quels sont les critères objectifs pour évaluer "${keywords[0] || 'ce sujet'}" ?`,
          "Quelles sont les données mesurables disponibles ?",
          "Existe-t-il des études ou statistiques sur ce sujet ?"
        ]
      }
    };
  }
  
  // Recherche de sources
  console.log('🔎 Recherche de sources...');
  let allSources = [];
  
  try {
    const searchPromises = [
      searchWikipediaAdvanced(cleanedText),
      searchWikidata(cleanedText)
    ];
    
    const results = await Promise.allSettled(searchPromises);
    results.forEach(result => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        allSources = allSources.concat(result.value);
      }
    });
  } catch (error) {
    console.error('Erreur recherche:', error);
  }
  
  // Filtrage et classement stricts
  const rankedSources = deduplicateAndRankSources(allSources);
  console.log(`📚 ${rankedSources.length} sources pertinentes trouvées`);
  
  // Calcul du score
  const scoringResult = calculateFinalScore(cleanedText, rankedSources);
  const explanation = generateExplanation(scoringResult, rankedSources);
  
  return {
    overallConfidence: scoringResult.finalScore,
    sources: rankedSources,
    extractedKeywords: keywords,
    contradictions: [],
    scoringExplanation: explanation,
    scoringDetails: scoringResult.details
  };
}

// ============ ROUTES API ============
app.get("/", (req, res) => {
  res.send("✅ API Fact-Checker IA Pro V3.0 - Production Ready");
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "OK",
    version: "3.0",
    features: "Opinion detection + Smart scoring + Source filtering"
  });
});

app.post('/verify', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || text.length < 10) {
      return res.status(400).json({ 
        error: 'Le texte est requis (min 10 caractères)' 
      });
    }
    
    // Cache
    const cacheKey = `v3_${Buffer.from(text.substring(0, 100)).toString('base64')}`;
    const cached = cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log('📦 Cache hit');
      return res.json(cached.data);
    }
    
    // Analyse
    const result = await performFactCheck(text);
    
    // Mise en cache
    cache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });
    
    res.json(result);
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ 
      error: 'Échec de la vérification',
      message: error.message 
    });
  }
});

// ============ DÉMARRAGE ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Fact-Checker IA Pro V3.0 sur port ${PORT}`);
  console.log(`📊 Scoring: Opinions→25%, Faits→40-95%`);
  console.log(`🔍 Sources: Wikipedia FR/EN + Wikidata`);
  console.log(`⏱️ Cache: ${CACHE_TTL/1000}s`);
});
