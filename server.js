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

function extractIntelligentClaims(text) {
  return text.split(/[.!?]+/)
    .filter(s => s.trim().length > 20)
    .map(s => s.trim())
    .slice(0, 4);
}

// ============ EXTRACTION DE MOTS-CLÉS ROBUSTE ============
function extractBestKeywords(text) {
  const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'dans', 'sur', 'avec', 'par', 'pour', 'sans', 'qui', 'que', 'est', 'sont', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'that', 'this']);
  
  // Nettoyage initial
  const cleaned = text
    .replace(/^(Bien sûr|Voici|Certainement|Il est important de noter)/i, '')
    .replace(/["""'']/g, '')
    .trim();
  
  // Extraction de différents types de mots-clés
  const properNouns = cleaned.match(/\b[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+(?:\s+[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+)*\b/g) || [];
  const places = cleaned.match(/\b(Paris|Londres|Tokyo|Berlin|Rome|Madrid|Moscou|New York|Washington|France|Allemagne|Japon|États-Unis|Canada)\b/gi) || [];
  const scientificTerms = cleaned.match(/\b(Einstein|Marie Curie|Newton|Darwin|radioactivité|polonium|radium|physique|chimie|relativité|gravité|évolution)\b/gi) || [];
  const dates = cleaned.match(/\b(?:1[0-9]{3}|20[0-2][0-9])\b/g) || [];
  
  // Combinaison et nettoyage
  let keywords = [...properNouns, ...places, ...scientificTerms, ...dates];
  
  // Si pas assez de mots-clés, extraction de mots importants
  if (keywords.length < 3) {
    const importantWords = cleaned
      .toLowerCase()
      .split(/\s+/)
      .filter(word => 
        word.length > 4 && 
        !stopWords.has(word) &&
        !/^\d+$/.test(word)
      )
      .slice(0, 3);
    keywords.push(...importantWords);
  }
  
  // Déduplication et limitation
  keywords = [...new Set(keywords.map(k => k.trim()))];
  return keywords.slice(0, 7);
}

// ============ CALCUL DE PERTINENCE STRICT ============
function calculateRelevance(claim, sourceContent) {
  const claimKeywords = extractBestKeywords(claim);
  const sourceText = (sourceContent || '').toLowerCase();
  
  if (claimKeywords.length === 0) return 0;
  
  let relevanceScore = 0;
  let matchCount = 0;
  
  claimKeywords.forEach(keyword => {
    const keywordLower = keyword.toLowerCase();
    if (sourceText.includes(keywordLower)) {
      matchCount++;
      // Score basé sur la longueur du mot-clé (plus c'est spécifique, mieux c'est)
      if (keyword.length > 8) {
        relevanceScore += 0.5;
      } else if (keyword.length > 5) {
        relevanceScore += 0.4;
      } else {
        relevanceScore += 0.3;
      }
    }
  });
  
  // Bonus pour correspondances multiples
  if (matchCount >= 3) relevanceScore += 0.3;
  else if (matchCount >= 2) relevanceScore += 0.2;
  
  // Pénalité si aucune correspondance
  if (matchCount === 0) return 0.02;
  
  return Math.min(relevanceScore, 1.0);
}

// ============ DÉTECTION D'OPINIONS STRICTE ============
function isStrongOpinionContent(text) {
  const textLower = text.toLowerCase();
  
  // Patterns d'opinion très clairs FR et EN
  const opinionPatterns = [
    // Français
    /\b(plus belle?|plus beau|meilleure?|pire)\s+(.*?)\s+(du monde|de tous les temps|jamais|de l'univers)\b/i,
    /\b(meilleur|pire|préféré|favori)\s+(film|restaurant|musique|artiste|livre)\b/i,
    /\bquel est (le|la|votre) (meilleur|préféré|favori)\b/i,
    /\b(j'aime|je déteste|j'adore|je préfère)\b/i,
    /\b(subjectif|opinion|point de vue|selon moi|à mon avis)\b/i,
    // Anglais
    /\b(best|worst|greatest|most beautiful)\s+(.*?)\s+(in the world|ever|of all time)\b/i,
    /\b(favorite|favourite|best|worst)\s+(movie|restaurant|music|artist|book)\b/i,
    /\bwhat is (the|your) (best|favorite)\b/i,
    /\b(I love|I hate|I prefer|I think)\b/i,
    /\b(subjective|opinion|perspective|in my view)\b/i
  ];
  
  return opinionPatterns.some(pattern => pattern.test(textLower));
}

// ============ RECHERCHE WIKIPEDIA AMÉLIORÉE ============
async function searchWikipediaAdvanced(claimText) {
  const sources = [];
  const keywords = extractBestKeywords(claimText);
  
  if (keywords.length === 0) return [];
  
  for (const lang of ['fr', 'en']) {
    try {
      const searchQuery = keywords.slice(0, 3).join(' ');
      const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchQuery)}&format=json&origin=*&srlimit=3`;
      
      const response = await fetch(searchUrl, { timeout: 5000 });
      const data = await response.json();
      
      if (data.query?.search) {
        for (const article of data.query.search.slice(0, 2)) {
          const content = await fetchWikipediaContent(lang, article.title, claimText);
          if (content && content.relevanceScore > 0.15) {
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
    console.warn('Wikipedia fetch error:', error.message);
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
      return data.search.map(item => {
        const relevanceScore = calculateRelevance(claimText, `${item.label} ${item.description || ''}`);
        return {
          title: `Wikidata: ${item.label}`,
          url: `https://www.wikidata.org/wiki/${item.id}`,
          snippet: (item.description || 'Entité de données structurées') + ' - Base de données de faits vérifiables.',
          reliability: 0.88,
          sourceCategory: 'database',
          relevanceScore: relevanceScore,
          lastUpdated: new Date().toISOString()
        };
      }).filter(s => s.relevanceScore > 0.1);
    }
  } catch (error) {
    console.warn('Wikidata error:', error.message);
  }
  
  return [];
}

// ============ RECHERCHE DUCKDUCKGO ============
async function searchDuckDuckGo(claimText) {
  const keywords = extractBestKeywords(claimText);
  if (keywords.length === 0) return [];
  
  try {
    const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(keywords.slice(0, 2).join(' '))}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(searchUrl, { timeout: 5000 });
    const data = await response.json();
    
    if (data.Abstract && data.Abstract.length > 50) {
      const relevanceScore = calculateRelevance(claimText, data.Abstract);
      
      if (relevanceScore > 0.15) {
        return [{
          title: `DuckDuckGo: ${data.Heading || 'Résultat instantané'}`,
          url: data.AbstractURL || 'https://duckduckgo.com/',
          snippet: data.Abstract.substring(0, 200) + '...',
          reliability: 0.75,
          sourceCategory: 'search_engine',
          relevanceScore: relevanceScore,
          lastUpdated: new Date().toISOString()
        }];
      }
    }
  } catch (error) {
    console.warn('DuckDuckGo error:', error.message);
  }
  
  return [];
}

// ============ DÉDUPLICATION ET CLASSEMENT ============
function deduplicateAndRankSources(sources) {
  const seen = new Set();
  const deduplicated = [];
  
  sources.forEach(source => {
    try {
      const domain = new URL(source.url).hostname.replace('www.', '');
      const key = `${domain}-${source.title.substring(0, 30)}`;
      
      if (!seen.has(key) && deduplicated.length < 10) {
        seen.add(key);
        deduplicated.push(source);
      }
    } catch (e) {
      // Si URL invalide, on garde quand même la source
      if (deduplicated.length < 10) {
        deduplicated.push(source);
      }
    }
  });
  
  // Tri par pertinence et fiabilité
  return deduplicated.sort((a, b) => {
    const scoreA = (a.relevanceScore || 0) * (a.reliability || 0.5);
    const scoreB = (b.relevanceScore || 0) * (b.reliability || 0.5);
    return scoreB - scoreA;
  });
}

// ============ CALCUL DU SCORE DE CONFIANCE V3 ============
function calculateConfidenceScoreV3(text, sources) {
  // 1. DÉTECTION D'OPINION PRÉCOCE
  if (isStrongOpinionContent(text)) {
    console.log("🎯 Opinion détectée -> Score forcé à 25%");
    return {
      finalScore: 0.25,
      details: {
        finalPercentage: 25,
        sourceBreakdown: {
          total: sources.length,
          relevant: 0,
          encyclopedia: 0,
          database: 0
        }
      },
      contentType: 'OPINION'
    };
  }
  
  // 2. ANALYSE POUR CONTENU FACTUEL
  const relevantSources = sources.filter(s => (s.relevanceScore || 0) > 0.3);
  const highQualitySources = relevantSources.filter(s => s.relevanceScore > 0.5);
  
  // Catégorisation des sources
  const encyclopediaSources = relevantSources.filter(s => s.sourceCategory === 'encyclopedia');
  const databaseSources = relevantSources.filter(s => s.sourceCategory === 'database');
  const searchSources = relevantSources.filter(s => s.sourceCategory === 'search_engine');
  
  // 3. CALCUL DU SCORE
  let baseScore = 30; // Score de base pour contenu factuel
  let sourceBonus = 0;
  let qualityBonus = 0;
  
  // Bonus basé sur le nombre de sources pertinentes
  if (relevantSources.length >= 5) {
    sourceBonus = 40;
  } else if (relevantSources.length >= 3) {
    sourceBonus = 30;
  } else if (relevantSources.length >= 2) {
    sourceBonus = 20;
  } else if (relevantSources.length >= 1) {
    sourceBonus = 10;
  } else {
    baseScore = 20; // Réduction si aucune source pertinente
  }
  
  // Bonus pour sources de haute qualité
  encyclopediaSources.forEach(s => {
    qualityBonus += 8 * (s.relevanceScore || 0.5);
  });
  
  databaseSources.forEach(s => {
    qualityBonus += 10 * (s.relevanceScore || 0.5);
  });
  
  if (highQualitySources.length >= 3) {
    qualityBonus += 15;
  }
  
  // Bonus pour diversité des sources
  const sourceTypes = new Set(relevantSources.map(s => s.sourceCategory));
  if (sourceTypes.size >= 3) {
    qualityBonus += 10;
  } else if (sourceTypes.size >= 2) {
    qualityBonus += 5;
  }
  
  // Calcul final
  const totalScore = baseScore + sourceBonus + qualityBonus;
  const finalPercentage = Math.min(95, Math.max(15, totalScore));
  
  console.log(`📊 Score calculé: Base=${baseScore}, Sources=${sourceBonus}, Qualité=${qualityBonus} -> ${finalPercentage}%`);
  
  return {
    finalScore: finalPercentage / 100,
    details: {
      finalPercentage: finalPercentage,
      sourceBreakdown: {
        total: sources.length,
        relevant: relevantSources.length,
        highQuality: highQualitySources.length,
        encyclopedia: encyclopediaSources.length,
        database: databaseSources.length,
        searchEngine: searchSources.length
      }
    },
    contentType: 'FACTUEL'
  };
}

// ============ GÉNÉRATION D'EXPLICATION ============
function generateScoringExplanation(details, sources) {
  const { finalPercentage, sourceBreakdown } = details;
  const relevantCount = sourceBreakdown.relevant || 0;
  
  let explanation = "";
  
  if (finalPercentage >= 80) {
    explanation = `Score très élevé grâce à ${relevantCount} sources hautement pertinentes qui confirment les faits`;
  } else if (finalPercentage >= 60) {
    explanation = `Score élevé avec ${relevantCount} sources fiables trouvées`;
  } else if (finalPercentage >= 40) {
    explanation = `Score modéré basé sur ${relevantCount} sources disponibles`;
  } else if (finalPercentage >= 25) {
    explanation = `Score faible dû à peu de sources pertinentes (${relevantCount})`;
  } else {
    explanation = `Score très faible - sources insuffisantes ou contenu subjectif`;
  }
  
  // Ajout de détails sur les types de sources
  const sourceTypes = [];
  if (sourceBreakdown.encyclopedia > 0) {
    sourceTypes.push(`${sourceBreakdown.encyclopedia} encyclopédie(s)`);
  }
  if (sourceBreakdown.database > 0) {
    sourceTypes.push(`${sourceBreakdown.database} base(s) de données`);
  }
  if (sourceBreakdown.searchEngine > 0) {
    sourceTypes.push(`${sourceBreakdown.searchEngine} moteur(s) de recherche`);
  }
  
  if (sourceTypes.length > 0) {
    explanation += `, incluant ${sourceTypes.join(', ')}`;
  }
  
  explanation += '.';
  return explanation;
}

// ============ FONCTION PRINCIPALE DE FACT-CHECKING ============
async function performComprehensiveFactCheck(text) {
  const cleanedText = cleanText(text);
  const keywords = extractBestKeywords(cleanedText);
  
  console.log('🔍 Analyse:', cleanedText.substring(0, 100));
  console.log('🔑 Mots-clés extraits:', keywords);
  
  // Cas spécial : Opinion détectée
  if (isStrongOpinionContent(cleanedText)) {
    console.log('⚠️ Contenu d\'opinion détecté');
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
        title: "🧐 Ceci est une opinion subjective",
        explanation: "L'analyse factuelle n'est pas applicable aux opinions personnelles. Les goûts et préférences varient selon les individus.",
        prompts: [
          `Quels sont les faits objectifs sur "${keywords[0] || 'ce sujet'}" ?`,
          "Quelles sont les différentes perspectives sur cette question ?",
          "Existe-t-il des données mesurables à ce sujet ?"
        ]
      }
    };
  }
  
  // Recherche de sources en parallèle
  console.log('🔎 Recherche de sources...');
  const searchPromises = [
    searchWikipediaAdvanced(cleanedText),
    searchWikidata(cleanedText),
    searchDuckDuckGo(cleanedText)
  ];
  
  let allSources = [];
  
  try {
    const results = await Promise.allSettled(searchPromises);
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        console.log(`✅ Source ${index + 1}: ${result.value.length} résultats`);
        allSources = allSources.concat(result.value);
      } else {
        console.log(`❌ Source ${index + 1}: Échec`);
      }
    });
  } catch (error) {
    console.error('Erreur recherche:', error);
  }
  
  // Déduplication et classement
  const rankedSources = deduplicateAndRankSources(allSources);
  console.log(`📚 Total: ${rankedSources.length} sources uniques`);
  
  // Calcul du score
  const scoringAnalysis = calculateConfidenceScoreV3(cleanedText, rankedSources);
  
  // Génération de l'explication
  const scoringExplanation = generateScoringExplanation(
    scoringAnalysis.details,
    rankedSources
  );
  
  return {
    overallConfidence: scoringAnalysis.finalScore,
    sources: rankedSources,
    extractedKeywords: keywords,
    contradictions: [],
    scoringExplanation: scoringExplanation,
    scoringDetails: scoringAnalysis.details
  };
}

// ============ ROUTES API ============
app.get("/", (req, res) => {
  res.send("✅ API Fact-Checker IA Pro V2.0 - Production Ready");
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "OK",
    version: "2.0",
    features: "Multi-sources + Opinion detection + Smart scoring",
    timestamp: new Date().toISOString()
  });
});

app.post('/verify', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || text.length < 10) {
      return res.status(400).json({ 
        error: 'Le texte est requis et doit contenir au moins 10 caractères.' 
      });
    }
    
    // Vérification du cache
    const cacheKey = `verify_${Buffer.from(text.substring(0, 100)).toString('base64')}`;
    const cached = cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log('📦 Réponse depuis le cache');
      return res.json(cached.data);
    }
    
    // Analyse
    console.log('\n=== NOUVELLE REQUÊTE ===');
    const result = await performComprehensiveFactCheck(text);
    
    // Mise en cache
    cache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });
    
    res.json(result);
  } catch (error) {
    console.error('❌ Erreur /verify:', error);
    res.status(500).json({ 
      error: 'Échec de la vérification',
      message: error.message 
    });
  }
});

// ============ DÉMARRAGE SERVEUR ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Fact-Checker IA Pro V2.0 démarré sur port ${PORT}`);
  console.log(`📊 Features: Multi-sources, Opinion detection, Smart scoring`);
  console.log(`⏱️ Cache: ${CACHE_TTL / 1000}s`);
});
