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

// --- Fonctions de Fact-Checking (le cerveau) ---

function cleanText(text) {
  return text.trim().replace(/\s+/g, ' ').substring(0, 8000);
}

function extractIntelligentClaims(text) {
  return text.split(/[.!?]+/).filter(s => s.trim().length > 25).map(s => s.trim()).slice(0, 3);
}

function extractBestKeywords(text) {
  const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'dans', 'sur', 'avec', 'par', 'pour', 'sans', 'qui', 'que', 'est', 'sont', 'été', 'avoir', 'être', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'that', 'this', 'was', 'were', 'has', 'have', 'had']);
  const properNouns = text.match(/\b[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+(?:\s+[A-ZÀÂÄÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+)*\b/g) || [];
  const dates = text.match(/\b(?:19|20)\d{2}\b/g) || [];
  const numbers = text.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
  const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(word => word.length > 3 && !stopWords.has(word)).slice(0, 4);
  return properNouns.concat(dates, numbers, words).slice(0, 6);
}

function calculateRelevance(claim, sourceContent) {
  const claimKeywords = extractBestKeywords(claim);
  const sourceText = sourceContent.toLowerCase();
  let matches = claimKeywords.filter(keyword => sourceText.includes(keyword.toLowerCase()));
  let relevance = matches.length / Math.max(claimKeywords.length, 1);
  const exactMatches = claimKeywords.filter(keyword => keyword.length > 4 && sourceText.includes(keyword.toLowerCase()));
  if (exactMatches.length > 0) relevance += 0.2;
  return Math.min(relevance, 1.0);
}

function deduplicateAndRankSources(sources) {
  const seen = new Set();
  const deduplicated = [];
  sources.forEach(source => {
    const domain = extractDomain(source.url);
    const key = domain + '-' + source.title.substring(0, 30);
    if (!seen.has(key) && deduplicated.length < 10) {
      seen.add(key);
      deduplicated.push(source);
    }
  });
  return deduplicated.sort((a, b) => {
    const aScore = (a.isOfficialData ? 100 : 0) + (a.reliability * 100) + (a.relevanceScore || 0) * 50;
    const bScore = (b.isOfficialData ? 100 : 0) + (b.reliability * 100) + (b.relevanceScore || 0) * 50;
    return bScore - aScore;
  });
}

function evaluateClaimWithSources(claimText, sources) {
  const relevantSources = sources.filter(s => calculateRelevance(claimText, s.title + ' ' + s.snippet) > 0.2);
  let confidence = 0.30;
  if (relevantSources.length >= 4) confidence += 0.40;
  else if (relevantSources.length >= 3) confidence += 0.30;
  else if (relevantSources.length >= 2) confidence += 0.20;
  else if (relevantSources.length >= 1) confidence += 0.10;
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

function isStrongOpinionContent(text) {
  const opinionPatterns = [
    /\b(meilleur|meilleure|pire|plus beau|plus belle|plus grand|plus petit)\b.*\b(monde|univers|planète|terre)\b/i,
    /\b(plus.*ville|plus.*pays|plus.*endroit)\b.*\b(monde|univers|planète)\b/i,
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

function calculateEnhancedConfidenceScore(claims, sources, originalText) {
  let baseScore = 30;
  let sourceScore = 0;
  let qualityBonus = 0;
  let penalties = 0;
  const isOpinion = isStrongOpinionContent(originalText);
  const isSpeculative = hasSpeculativeLanguage(originalText);
  const isComparative = hasComparativeLanguage(originalText);
  const isSubjective = hasSubjectiveLanguage(originalText);
  const encyclopediaSources = sources.filter(s => s.sourceCategory === 'encyclopedia');
  const databaseSources = sources.filter(s => s.sourceCategory === 'database');
  const searchEngineSources = sources.filter(s => s.sourceCategory === 'search_engine');
  const archiveSources = sources.filter(s => s.sourceCategory === 'archive');
  const academicSources = sources.filter(s => s.sourceCategory === 'academic');
  const referenceSources = sources.filter(s => s.sourceCategory === 'reference');
  sourceScore += encyclopediaSources.length * 12;
  sourceScore += databaseSources.length * 15;
  sourceScore += searchEngineSources.length * 8;
  sourceScore += archiveSources.length * 10;
  sourceScore += academicSources.length * 18;
  sourceScore += referenceSources.length * 8;
  const totalSources = sources.length;
  if (totalSources >= 6) qualityBonus = 25;
  else if (totalSources >= 4) qualityBonus = 20;
  else if (totalSources >= 3) qualityBonus = 15;
  else if (totalSources >= 2) qualityBonus = 10;
  else if (totalSources >= 1) qualityBonus = 5;
  const sourceTypes = [encyclopediaSources, databaseSources, academicSources, archiveSources].filter(arr => arr.length > 0);
  if (sourceTypes.length >= 3) qualityBonus += 10;
  if (isOpinion) penalties += 30;
  if (isSubjective) penalties += 20;
  if (isComparative) penalties += 15;
  if (isSpeculative) penalties += 10;
  if (totalSources === 0) penalties += 25;
  const rawScore = baseScore + sourceScore + qualityBonus - penalties;
  const finalScore = Math.max(20, Math.min(90, rawScore)) / 100;
  const details = {
    baseScore: baseScore,
    sourceScore: sourceScore,
    qualityBonus: qualityBonus,
    penalties: penalties,
    rawScore: rawScore,
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
  };
  const contentAnalysis = {
    isOpinion: isOpinion,
    isSubjective: isSubjective,
    isComparative: isComparative,
    isSpeculative: isSpeculative,
    contentType: isOpinion ? 'OPINION' : isSubjective ? 'SUBJECTIF' : 'FACTUEL'
  };
  console.log('Scoring 6 sources:', { details: details, content: contentAnalysis });
  return { finalScore: finalScore, details: details, contentAnalysis: contentAnalysis };
}

async function searchWikipediaAdvanced(claimText) {
  const sources = [];
  const languages = ['fr', 'en'];
  for (const lang of languages) {
    const keywords = extractBestKeywords(claimText);
    if (keywords.length === 0) continue;
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(keywords.join(' '))}&format=json&origin=*&srlimit=3`;
    try {
      const response = await fetch(searchUrl, { timeout: 5000 });
      const data = await response.json();
      if (data.query && data.query.search) {
        const articlePromises = data.query.search.slice(0, 2).map(article => fetchWikipediaContent(lang, article.title, claimText));
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
    const response = await fetch(summaryUrl, { timeout: 5000 });
    if (!response.ok) throw new Error('Not found or API error');
    const data = await response.json();
    if (data.extract && data.extract.length > 50) {
      const relevanceScore = calculateRelevance(originalClaim, data.title + ' ' + data.extract);
      if (relevanceScore > 0.3) {
        return {
          title: `Wikipedia (${lang.toUpperCase()}): ${data.title}`,
          url: data.content_urls.desktop.page,
          snippet: data.extract.substring(0, 200) + "...",
          reliability: 0.82,
          sourceCategory: 'encyclopedia',
          relevanceScore: relevanceScore
        };
      }
    }
  } catch (error) {
    console.warn(`Fetch Wikipedia content failed for "${title}":`, error.message);
  }
  return null;
}

async function searchWikidata(claimText) {
  const keywords = extractBestKeywords(claimText);
  if (keywords.length === 0) return [];
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(keywords.join(' '))}&language=fr&format=json&origin=*&limit=3`;
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
        isStructuredData: true
      }));
    }
  } catch (error) {
    console.warn('Wikidata search failed:', error.message);
  }
  return [];
}

async function searchDuckDuckGo(claimText) {
  const keywords = extractBestKeywords(claimText);
  if (keywords.length === 0) return [];
  const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(keywords.join(' '))}&format=json&no_html=1&skip_disambig=1`;
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
        sourceCategory: 'search_engine'
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
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier,title,description&rows=3&output=json`;
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
            sourceCategory: 'archive'
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

async function searchPubMed(query) {
  try {
    const hasScientificTerms = /\b(maladie|virus|traitement|médical|recherche|étude|scientifique|découverte|cancer|vaccin|radioactivité|curie|becquerel)\b/i.test(query);
    if (!hasScientificTerms) return [];
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmode=json&retmax=3`;
    const response = await fetch(searchUrl, { timeout: 8000 });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    const sources = [];
    if (data.esearchresult && data.esearchresult.idlist && data.esearchresult.idlist.length > 0) {
      sources.push({
        title: `PubMed: Recherches scientifiques sur ${query.split(' ')[0]}`,
        url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(query)}`,
        snippet: `Base de données de ${data.esearchresult.count} publications scientifiques médicales - Source officielle NCBI/NIH.`,
        reliability: 0.92,
        sourceCategory: 'academic',
        isOfficialData: true
      });
    }
    return sources;
  } catch (error) {
    console.warn('PubMed search failed:', error.message);
    return [];
  }
}

async function searchOpenLibrary(query) {
  try {
    const hasBookTerms = /\b(livre|auteur|écrivain|roman|poésie|littérature|publié|édition|shakespeare|hugo|voltaire)\b/i.test(query);
    if (!hasBookTerms) return [];
    const searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=3`;
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
            sourceCategory: 'reference'
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

async function performComprehensiveFactCheck(text) {
  const results = {
    overallConfidence: 0,
    sources: [],
    claims: [],
    scoringDetails: {},
    contentAnalysis: {}
  };
  try {
    const cleanedText = cleanText(text);
    const claims = extractIntelligentClaims(cleanedText);
    let allSources = [];
    const sourcePromises = [];
    for (const claimText of claims) {
      console.log("Recherche 6 sources pour: " + claimText.substring(0, 50) + "...");
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
    const scoringAnalysis = calculateEnhancedConfidenceScore(claims, results.sources, cleanedText);
    results.overallConfidence = scoringAnalysis.finalScore;
    results.scoringDetails = scoringAnalysis.details;
    results.contentAnalysis = scoringAnalysis.contentAnalysis;
    results.claims = claims.map(claimText => evaluateClaimWithSources(claimText, results.sources));
    return results;
  } catch (error) {
    console.error('Erreur fact-checking côté backend:', error);
    throw error;
  }
}

// --- Routes de l'API ---
app.get("/", (req, res) => {
  res.send("✅ API Fact-Checker en ligne ! Consulter /verify");
});

app.post('/verify', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.length < 10) {
      return res.status(400).json({ error: 'Le texte est requis et doit contenir au moins 10 caractères.' });
    }
    const cacheKey = `full_verify_${text.substring(0, 100)}`;
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log('Réponse de vérification servie depuis le cache.');
      return res.json(cached.data);
    }
    const verificationResult = await performComprehensiveFactCheck(text);
    cache.set(cacheKey, { data: verificationResult, timestamp: Date.now() });
    res.json(verificationResult);
  } catch (error) {
    console.error('Erreur dans la route /verify:', error);
    res.status(500).json({ error: 'Échec de la vérification de faits', message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend fact-checker démarré sur port ${PORT}`);
});

module.exports = app;
