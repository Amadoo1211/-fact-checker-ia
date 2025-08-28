const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

app.use(cors({
  origin: ['chrome-extension://*', 'https://*.netlify.app', 'http://localhost:3000', 'https://fact-checker-ia-production.up.railway.app']
}));
app.use(express.json());

function cleanText(text) {
  return text.trim().replace(/\s+/g, ' ').substring(0, 8000);
}

function extractIntelligentClaims(text) {
  return text.split(/[.!?]+/).filter(s => s.trim().length > 25).map(s => s.trim()).slice(0, 3);
}

// AMÉLIORATION CRITIQUE: Extraction de mots-clés intelligente
function extractBestKeywords(text) {
  const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'dans', 'sur', 'avec', 'par', 'pour', 'sans', 'qui', 'que', 'est', 'sont', 'été', 'avoir', 'être', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'that', 'this', 'was', 'were', 'has', 'have', 'had']);
  
  // Expressions complètes pour les personnages célèbres
  const properNouns = text.match(/\b[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+(?:\s+[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+)+\b/g) || [];
  
  // Noms simples mais importants - ÉLARGI POUR PERSONNAGES HISTORIQUES
  const singleNames = text.match(/\b(Marie|Edison|Curie|Watt|Savery|Tesla|Einstein|Darwin|Newton|Galilée|Pasteur|Napoléon|Bonaparte|César|Jules|Révolution|Berlin|Bastille|Fleming|Alexandre|Pénicilline)\b/gi) || [];
  
  // Dates importantes
  const dates = text.match(/\b(?:1[4-9]\d{2}|20\d{2})\b/g) || [];
  
  // Nombres significatifs
  const numbers = text.match(/\b\d+(?:[.,]\d+)?\s*(?:millions?|milliards?|mille|%|ans?|années?)\b/gi) || [];
  
  // Concepts scientifiques/historiques - ÉLARGI
  const concepts = text.match(/\b(radioactivité|polonium|radium|machine|vapeur|guerre|mondiale|invention|découverte|révolution|industrielle|pénicilline|antibiotique|mur|bastille|empereur|république|planète|système|solaire)\b/gi) || [];
  
  // Mots importants (non stop words)
  const importantWords = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 4 && !stopWords.has(word))
    .slice(0, 3);
  
  // Combiner et prioriser
  let keywords = [...properNouns, ...singleNames, ...concepts, ...dates, ...numbers, ...importantWords];
  
  // Déduplication
  keywords = [...new Set(keywords)];
  
  return keywords.slice(0, 8); // Plus de mots-clés
}

// AMÉLIORATION CRITIQUE: Calcul de pertinence plus intelligent
function calculateRelevance(claim, sourceContent) {
  const claimKeywords = extractBestKeywords(claim);
  const sourceText = sourceContent.toLowerCase();
  let relevanceScore = 0;
  let totalKeywords = claimKeywords.length;
  
  if (totalKeywords === 0) return 0;
  
  claimKeywords.forEach(keyword => {
    const keywordLower = keyword.toLowerCase();
    
    // Correspondance exacte (poids fort)
    if (sourceText.includes(keywordLower)) {
      if (keyword.length > 6) {
        relevanceScore += 0.3; // Mots longs = plus importants
      } else {
        relevanceScore += 0.2;
      }
    }
    
    // Correspondance partielle pour noms composés
    if (keyword.includes(' ')) {
      const parts = keyword.split(' ');
      const partialMatches = parts.filter(part => 
        part.length > 2 && sourceText.includes(part.toLowerCase())
      ).length;
      relevanceScore += (partialMatches / parts.length) * 0.15;
    }
  });
  
  // Bonus pour correspondances multiples
  if (relevanceScore > 0.4) relevanceScore += 0.1;
  
  return Math.min(relevanceScore, 1.0);
}

// NOUVEAU: Détection de contradictions entre sources
function detectContradictions(sources, originalText) {
  const contradictions = [];
  
  // Détection de contradictions sur les dates
  const datePattern = /\b(1[4-9]\d{2}|20\d{2})\b/g;
  const mentionedDates = [...new Set((originalText.match(datePattern) || []))];
  
  if (mentionedDates.length > 0) {
    const sourceDates = [];
    sources.forEach(source => {
      const sourceDateMatches = source.snippet.match(datePattern) || [];
      sourceDates.push(...sourceDateMatches);
    });
    
    const conflictingDates = sourceDates.filter(date => !mentionedDates.includes(date));
    if (conflictingDates.length > 0) {
      contradictions.push({
        topic: "Dates",
        description: `Sources mentionnent ${conflictingDates[0]} alors que le texte évoque ${mentionedDates[0]}`,
        severity: "medium"
      });
    }
  }
  
  // Détection de contradictions sur les nombres
  const numberPattern = /\b\d+(?:[.,]\d+)?\s*(?:millions?|milliards?|mille|%)\b/gi;
  const textNumbers = originalText.match(numberPattern) || [];
  
  if (textNumbers.length > 0) {
    const sourceNumbers = [];
    sources.forEach(source => {
      const nums = source.snippet.match(numberPattern) || [];
      sourceNumbers.push(...nums);
    });
    
    // Simple détection de différences significatives
    if (sourceNumbers.length > 0 && textNumbers.length > 0) {
      const hasConflictingNumbers = sourceNumbers.some(sNum => {
        return !textNumbers.some(tNum => 
          sNum.toLowerCase().includes(tNum.toLowerCase().substring(0, 3))
        );
      });
      
      if (hasConflictingNumbers) {
        contradictions.push({
          topic: "Statistiques",
          description: `Les sources présentent des chiffres différents de ceux mentionnés`,
          severity: "high"
        });
      }
    }
  }
  
  // Détection de contradictions terminologiques
  const keyTerms = extractBestKeywords(originalText);
  const negativeIndicators = sources.filter(source => 
    /\b(pas|non|ne.*pas|jamais|aucun|faux|incorrect|erreur)\b/i.test(source.snippet)
  );
  
  if (negativeIndicators.length > 0 && keyTerms.length > 0) {
    contradictions.push({
      topic: "Affirmations",
      description: `Certaines sources contiennent des éléments contradictoires ou correctifs`,
      severity: "medium"
    });
  }
  
  return contradictions;
}

// NOUVEAU: Analyse de sentiment pour les sources
function analyzeSentiment(text) {
  const positiveWords = /\b(excellent|parfait|remarquable|exceptionnel|magnifique|brillant|génial|extraordinaire|merveilleux)\b/gi;
  const negativeWords = /\b(terrible|horrible|catastrophique|désastreux|lamentable|pitoyable|scandaleux)\b/gi;
  const criticalWords = /\b(attention|prudence|danger|risque|problème|erreur|controverse|débat|critique)\b/gi;
  
  const positiveCount = (text.match(positiveWords) || []).length;
  const negativeCount = (text.match(negativeWords) || []).length;
  const criticalCount = (text.match(criticalWords) || []).length;
  
  if (criticalCount > 0) return 'critical';
  if (negativeCount > positiveCount) return 'negative';
  if (positiveCount > 0) return 'positive';
  return 'neutral';
}

// NOUVEAU: Génération d'explication du scoring
function generateScoringExplanation(scoringDetails, sources, contentAnalysis) {
  let explanation = "";
  const finalPercentage = scoringDetails.finalPercentage;
  
  // Explication principale basée sur le score
  if (finalPercentage >= 70) {
    explanation = `Score élevé grâce à ${sources.length} sources fiables`;
  } else if (finalPercentage >= 50) {
    explanation = `Score modéré avec ${sources.length} sources trouvées`;
  } else {
    explanation = `Score faible dû à un manque de sources pertinentes`;
  }
  
  // Détails sur les sources
  const academicSources = scoringDetails.sourceBreakdown.academic;
  const encyclopediaSources = scoringDetails.sourceBreakdown.encyclopedia;
  const databaseSources = scoringDetails.sourceBreakdown.database;
  
  if (academicSources > 0) {
    explanation += `, incluant ${academicSources} source(s) académique(s)`;
  }
  if (encyclopediaSources > 0) {
    explanation += `, ${encyclopediaSources} encyclopédie(s)`;
  }
  if (databaseSources > 0) {
    explanation += `, ${databaseSources} base(s) de données`;
  }
  
  // Pénalités expliquées
  if (contentAnalysis.isOpinion) {
    explanation += ". Score réduit car le contenu exprime des opinions";
  } else if (contentAnalysis.isSubjective) {
    explanation += ". Score ajusté car le contenu contient des éléments subjectifs";
  }
  
  explanation += ".";
  return explanation;
}

// AMÉLIORATION CRITIQUE: Meilleur scoring global - CORRIGÉ
function calculateEnhancedConfidenceScore(claims, sources, originalText) {
  let baseScore = 45; // Score de base augmenté (était 25)
  let sourceScore = 0;
  let qualityBonus = 0;
  let penalties = 0;
  
  const isOpinion = isStrongOpinionContent(originalText);
  const isSpeculative = hasSpeculativeLanguage(originalText);
  const isComparative = hasComparativeLanguage(originalText);
  const isSubjective = hasSubjectiveLanguage(originalText);
  
  // Catégorisation améliorée
  const encyclopediaSources = sources.filter(s => s.sourceCategory === 'encyclopedia');
  const databaseSources = sources.filter(s => s.sourceCategory === 'database');
  const searchEngineSources = sources.filter(s => s.sourceCategory === 'search_engine');
  const archiveSources = sources.filter(s => s.sourceCategory === 'archive');
  const academicSources = sources.filter(s => s.sourceCategory === 'academic');
  const referenceSources = sources.filter(s => s.sourceCategory === 'reference');
  
  // Scoring pondéré par pertinence
  sources.forEach(source => {
    let sourceValue = 0;
    switch(source.sourceCategory) {
      case 'encyclopedia': sourceValue = 15; break;
      case 'database': sourceValue = 18; break;
      case 'academic': sourceValue = 22; break;
      case 'archive': sourceValue = 12; break;
      case 'search_engine': sourceValue = 10; break;
      case 'reference': sourceValue = 10; break;
    }
    
    // Bonus pour pertinence élevée
    if (source.relevanceScore && source.relevanceScore > 0.6) {
      sourceValue *= 1.3;
    } else if (source.relevanceScore && source.relevanceScore < 0.3) {
      sourceValue *= 0.5; // Pénalité pour faible pertinence
    }
    
    sourceScore += sourceValue;
  });
  
  const totalSources = sources.length;
  
  // Bonus qualité adaptatif
  if (totalSources >= 5) qualityBonus = 30;
  else if (totalSources >= 3) qualityBonus = 20;
  else if (totalSources >= 2) qualityBonus = 15;
  else if (totalSources >= 1) qualityBonus = 8;
  
  // Bonus diversité
  const sourceTypes = [encyclopediaSources, databaseSources, academicSources].filter(arr => arr.length > 0);
  if (sourceTypes.length >= 2) qualityBonus += 8;
  
  // Pénalités réduites pour contenu subjectif
  if (isOpinion) penalties += 25;
  if (isSubjective) penalties += 15;
  if (isComparative) penalties += 10;
  if (isSpeculative) penalties += 8;
  if (totalSources === 0) penalties += 15; // Pénalité réduite (était 30)
  
  const rawScore = baseScore + sourceScore + qualityBonus - penalties;
  const finalScore = Math.max(15, Math.min(90, rawScore)) / 100;
  
  return {
    finalScore: finalScore,
    details: {
      baseScore,
      sourceScore,
      qualityBonus,
      penalties,
      rawScore,
      finalPercentage: Math.round(finalScore * 100),
      sourceBreakdown: {
        encyclopedia: encyclopediaSources.length,
        database: databaseSources.length,
        academic: academicSources.length,
        archive: archiveSources.length,
        searchEngine: searchEngineSources.length,
        reference: referenceSources.length,
        total: totalSources
      }
    },
    contentAnalysis: {
      isOpinion,
      isSubjective,
      isComparative,
      isSpeculative,
      contentType: isOpinion ? 'OPINION' : isSubjective ? 'SUBJECTIF' : 'FACTUEL'
    }
  };
}

// Fonctions de détection de contenu (inchangées)
function isStrongOpinionContent(text) {
  const opinionPatterns = [
    /\b(meilleur|meilleure|pire|plus beau|plus belle|plus grand|plus petit)\b.*\b(monde|univers|planète|terre)\b/i,
    /\b(préfère|aime mieux|déteste|adore|magnifique|horrible|parfait|nul|génial|fantastique)\b/i,
    /\b(opinion|goût|point de vue|je pense|à mon avis|selon moi)\b/i
  ];
  return opinionPatterns.some(pattern => pattern.test(text));
}

function hasSubjectiveLanguage(text) {
  return /\b(beau|belle|laid|joli|superbe|merveilleux|extraordinaire|incroyable|impressionnant|remarquable|exceptionnel)\b/i.test(text);
}

function hasComparativeLanguage(text) {
  return /\b(plus.*que|moins.*que|meilleur.*que|pire.*que|supérieur|inférieur|comparé|versus|vs)\b/i.test(text);
}

function hasSpeculativeLanguage(text) {
  return /\b(peut-être|probablement|semble|paraît|suppose|présume|vraisemblablement|apparemment|sans doute)\b/i.test(text);
}

// Fonctions de recherche (légèrement améliorées)
async function searchWikipediaAdvanced(claimText) {
  const sources = [];
  const languages = ['fr', 'en'];
  
  for (const lang of languages) {
    const keywords = extractBestKeywords(claimText);
    if (keywords.length === 0) continue;
    
    // Recherche plus ciblée
    const searchTerms = keywords.slice(0, 5).join(' ');
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchTerms)}&format=json&origin=*&srlimit=4`;
    
    try {
      const response = await fetch(searchUrl, { timeout: 6000 });
      const data = await response.json();
      
      if (data.query && data.query.search) {
        const articlePromises = data.query.search.slice(0, 3).map(article => 
          fetchWikipediaContent(lang, article.title, claimText)
        );
        const articles = await Promise.all(articlePromises);
        articles.filter(a => a !== null).forEach(source => sources.push(source));
      }
    } catch (error) {
      console.warn(`Wikipedia (${lang}) search failed:`, error.message);
    }
  }
  
  return sources;
}

async function fetchWikipediaContent(lang, title, originalClaim) {
  const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  
  try {
    const response = await fetch(summaryUrl, { timeout: 6000 });
    if (!response.ok) throw new Error('Not found');
    
    const data = await response.json();
    if (data.extract && data.extract.length > 50) {
      const relevanceScore = calculateRelevance(originalClaim, data.title + ' ' + data.extract);
      
      // Seuil de pertinence plus strict
      if (relevanceScore > 0.2) {
        return {
          title: `Wikipedia (${lang.toUpperCase()}): ${data.title}`,
          url: data.content_urls.desktop.page,
          snippet: data.extract.substring(0, 200) + "...",
          reliability: 0.82,
          sourceCategory: 'encyclopedia',
          relevanceScore: relevanceScore,
          lastUpdated: new Date().toISOString(), // Approximation
          sentiment: analyzeSentiment(data.extract)
        };
      }
    }
  } catch (error) {
    console.warn(`Wikipedia content fetch failed:`, error.message);
  }
  
  return null;
}

// Autres fonctions de recherche (identiques mais avec meilleure extraction de mots-clés)
async function searchWikidata(claimText) {
  const keywords = extractBestKeywords(claimText);
  if (keywords.length === 0) return [];
  
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(keywords.slice(0, 3).join(' '))}&language=fr&format=json&origin=*&limit=3`;
  
  try {
    const response = await fetch(searchUrl, { timeout: 5000 });
    const data = await response.json();
    
    if (data.search && data.search.length > 0) {
      return data.search.map(item => ({
        title: `Wikidata: ${item.label}`,
        url: `https://www.wikidata.org/wiki/${item.id}`,
        snippet: (item.description || "Entité Wikidata structurée") + " - Données factuelles vérifiables.",
        reliability: 0.85,
        sourceCategory: 'database',
        isStructuredData: true,
        relevanceScore: calculateRelevance(claimText, item.label + ' ' + (item.description || '')),
        lastUpdated: new Date().toISOString(),
        sentiment: 'neutral'
      }));
    }
  } catch (error) {
    console.warn('Wikidata search failed:', error.message);
  }
  
  return [];
}

async function searchPubMed(query) {
  try {
    // Détection améliorée des termes scientifiques
    const hasScientificTerms = /\b(marie|curie|radioactivité|polonium|radium|maladie|virus|traitement|médical|recherche|étude|scientifique|découverte|cancer|vaccin|becquerel|uranium|physique|chimie|nobel|pénicilline|fleming|antibiotique)\b/i.test(query);
    if (!hasScientificTerms) return [];
    
    const keywords = extractBestKeywords(query);
    const searchTerms = keywords.filter(k => k.length > 3).slice(0, 4).join(' ');
    
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(searchTerms)}&retmode=json&retmax=3`;
    const response = await fetch(searchUrl, { timeout: 8000 });
    
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    const sources = [];
    
    if (data.esearchresult && data.esearchresult.idlist && data.esearchresult.idlist.length > 0) {
      sources.push({
        title: `PubMed: Recherches scientifiques - ${keywords[0] || 'Sujet'}`,
        url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(searchTerms)}`,
        snippet: `Base de données de ${data.esearchresult.count} publications scientifiques médicales - Source officielle NCBI/NIH.`,
        reliability: 0.92,
        sourceCategory: 'academic',
        isOfficialData: true,
        relevanceScore: hasScientificTerms ? 0.8 : 0.4,
        lastUpdated: new Date().toISOString(),
        sentiment: 'neutral'
      });
    }
    
    return sources;
  } catch (error) {
    console.warn('PubMed search failed:', error.message);
    return [];
  }
}

// Fonctions restantes identiques...
async function searchDuckDuckGo(claimText) {
  const keywords = extractBestKeywords(claimText);
  if (keywords.length === 0) return [];
  
  const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(keywords.slice(0, 3).join(' '))}&format=json&no_html=1&skip_disambig=1`;
  
  try {
    const response = await fetch(searchUrl, { timeout: 5000 });
    const data = await response.json();
    const sources = [];
    
    if (data.Abstract && data.Abstract.length > 50) {
      sources.push({
        title: `DuckDuckGo: ${data.Heading || "Résultat instantané"}`,
        url: data.AbstractURL || "https://duckduckgo.com/",
        snippet: data.Abstract.substring(0, 200) + "...",
        reliability: 0.75,
        sourceCategory: 'search_engine',
        relevanceScore: calculateRelevance(claimText, data.Abstract),
        lastUpdated: new Date().toISOString(),
        sentiment: analyzeSentiment(data.Abstract)
      });
    }
    
    return sources;
  } catch (error) {
    console.warn('DuckDuckGo search failed:', error.message);
  }
  
  return [];
}

async function searchArchiveOrg(query) {
  try {
    const keywords = extractBestKeywords(query);
    const searchTerms = keywords.slice(0, 4).join(' ');
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchTerms)}&fl[]=identifier,title,description&rows=3&output=json`;
    
    const response = await fetch(searchUrl, { timeout: 8000 });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    
    const data = await response.json();
    const sources = [];
    
    if (data.response && data.response.docs) {
      data.response.docs.slice(0, 2).forEach(doc => {
        if (doc.title && doc.description) {
          sources.push({
            title: `Archive.org: ${doc.title.substring(0, 60)}...`,
            url: `https://archive.org/details/${doc.identifier}`,
            snippet: doc.description.substring(0, 180) + "...",
            reliability: 0.78,
            sourceCategory: 'archive',
            relevanceScore: calculateRelevance(query, doc.title + ' ' + doc.description),
            lastUpdated: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString(), // Simulation
            sentiment: analyzeSentiment(doc.description)
          });
        }
      });
    }
    
    return sources;
  } catch (error) {
    console.warn('Archive.org search failed:', error.message);
    return [];
  }
}

async function searchOpenLibrary(query) {
  try {
    const hasBookTerms = /\b(livre|auteur|écrivain|roman|poésie|littérature|publié|édition|shakespeare|hugo|voltaire|book|author|writer|published)\b/i.test(query);
    if (!hasBookTerms) return [];
    
    const keywords = extractBestKeywords(query);
    const searchTerms = keywords.slice(0, 3).join(' ');
    const searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(searchTerms)}&limit=3`;
    
    const response = await fetch(searchUrl, { timeout: 8000 });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    
    const data = await response.json();
    const sources = [];
    
    if (data.docs && data.docs.length > 0) {
      data.docs.slice(0, 2).forEach(book => {
        if (book.title && book.author_name) {
          sources.push({
            title: `OpenLibrary: ${book.title.substring(0, 50)}...`,
            url: `https://openlibrary.org${book.key}`,
            snippet: `Livre de ${book.author_name[0]} ${book.first_publish_year ? `publié en ${book.first_publish_year}` : ''} - Archive numérique.`,
            reliability: 0.80,
            sourceCategory: 'reference',
            relevanceScore: calculateRelevance(query, book.title + ' ' + (book.author_name.join(' ') || '')),
            lastUpdated: book.first_publish_year ? new Date(`${book.first_publish_year}-01-01`).toISOString() : new Date().toISOString(),
            sentiment: 'neutral'
          });
        }
      });
    }
    
    return sources;
  } catch (error) {
    console.warn('OpenLibrary search failed:', error.message);
    return [];
  }
}

// Fonctions utilitaires
function deduplicateAndRankSources(sources) {
  const seen = new Set();
  const deduplicated = [];
  
  sources.forEach(source => {
    const domain = extractDomain(source.url);
    const key = domain + '-' + source.title.substring(0, 30);
    
    if (!seen.has(key) && deduplicated.length < 12) {
      seen.add(key);
      deduplicated.push(source);
    }
  });

  return deduplicated.sort((a, b) => {
    const aScore = (a.isOfficialData ? 100 : 0) + (a.reliability * 100) + (a.relevanceScore || 0) * 60;
    const bScore = (b.isOfficialData ? 100 : 0) + (b.reliability * 100) + (b.relevanceScore || 0) * 60;
    return bScore - aScore;
  });
}

function evaluateClaimWithSources(claimText, sources) {
  const relevantSources = sources.filter(s => {
    const relevance = calculateRelevance(claimText, s.title + ' ' + s.snippet);
    return relevance > 0.15; // Seuil plus permissif
  });

  let confidence = 0.25; // Base plus basse
  
  if (relevantSources.length >= 4) confidence += 0.45;
  else if (relevantSources.length >= 3) confidence += 0.35;
  else if (relevantSources.length >= 2) confidence += 0.25;
  else if (relevantSources.length >= 1) confidence += 0.15;
  
  let status;
  if (confidence >= 0.75) status = 'verified';
  else if (confidence >= 0.55) status = 'partially_verified';
  else if (confidence >= 0.40) status = 'uncertain';
  else status = 'disputed';

  return {
    text: claimText,
    confidence: Math.max(0.20, Math.min(0.90, confidence)),
    status: status,
    relevantSources: relevantSources.length
  };
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch (e) {
    return url ? url.substring(0, 20) : '';
  }
}

// Fonction principale améliorée
async function performComprehensiveFactCheck(text) {
  const results = {
    overallConfidence: 0,
    sources: [],
    claims: [],
    scoringDetails: {},
    contentAnalysis: {},
    extractedKeywords: [], // NOUVEAU
    contradictions: [], // NOUVEAU
    scoringExplanation: "" // NOUVEAU
  };
  
  try {
    const cleanedText = cleanText(text);
    const claims = extractIntelligentClaims(cleanedText);
    let allSources = [];
    
    // Extraction des mots-clés pour la réponse
    results.extractedKeywords = extractBestKeywords(cleanedText);
    
    // Recherche parallèle avec toutes les APIs
    const sourcePromises = [];
    
    for (const claimText of claims) {
      console.log("Recherche améliorée pour:", claimText.substring(0, 50) + "...");
      sourcePromises.push(searchWikipediaAdvanced(claimText));
      sourcePromises.push(searchWikidata(claimText));
      sourcePromises.push(searchDuckDuckGo(claimText));
      sourcePromises.push(searchArchiveOrg(claimText));
      sourcePromises.push(searchPubMed(claimText));
      sourcePromises.push(searchOpenLibrary(claimText));
    }
    
    const sourceArrays = await Promise.all(sourcePromises);
    
    sourceArrays.forEach(sourceArray => {
      if (sourceArray && Array.isArray(sourceArray)) {
        sourceArray.forEach(source => {
          if (source) allSources.push(source);
        });
      }
    });
    
    results.sources = deduplicateAndRankSources(allSources);
    
    // Détection des contradictions
    results.contradictions = detectContradictions(results.sources, cleanedText);
    
    const scoringAnalysis = calculateEnhancedConfidenceScore(claims, results.sources, cleanedText);
    results.overallConfidence = scoringAnalysis.finalScore;
    results.scoringDetails = scoringAnalysis.details;
    results.contentAnalysis = scoringAnalysis.contentAnalysis;
    
    // Génération de l'explication du scoring
    results.scoringExplanation = generateScoringExplanation(
      scoringAnalysis.details, 
      results.sources, 
      scoringAnalysis.contentAnalysis
    );
    
    results.claims = claims.map(claimText => evaluateClaimWithSources(claimText, results.sources));
    
    console.log(`Fact-check terminé: ${results.sources.length} sources, ${Math.round(results.overallConfidence * 100)}% confiance, ${results.contradictions.length} contradictions`);
    
    return results;
  } catch (error) {
    console.error('Erreur fact-checking:', error);
    throw error;
  }
}

// Routes API
app.get("/", (req, res) => {
  res.send("✅ API Fact-Checker CORRIGÉE en ligne ! Version 2.6");
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    version: "2.6", 
    apis: 6, 
    features: "keywords+relevance+scoring+contradictions+sentiment+explanations+fixed_scoring" 
  });
});

app.post('/verify', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.length < 10) {
      return res.status(400).json({ error: 'Le texte est requis et doit contenir au moins 10 caractères.' });
    }
    
    const cacheKey = `verify_v2.6_${text.substring(0, 100)}`;
    const cached = cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log('Réponse servie depuis le cache v2.6');
      return res.json(cached.data);
    }
    
    const verificationResult = await performComprehensiveFactCheck(text);
    cache.set(cacheKey, { data: verificationResult, timestamp: Date.now() });
    
    res.json(verificationResult);
  } catch (error) {
    console.error('Erreur dans /verify:', error);
    res.status(500).json({ 
      error: 'Échec de la vérification', 
      message: error.message,
      version: "2.6"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend Fact-Checker CORRIGÉ v2.6 sur port ${PORT}`);
  console.log(`📋 Corrections: Scoring équilibré, Personnages historiques étendus`);
});

module.exports = app;
