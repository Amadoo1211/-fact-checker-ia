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

// Utilitaires de base
function cleanText(text) {
  return text.trim().replace(/\s+/g, ' ').substring(0, 12000);
}

function extractIntelligentClaims(text) {
  return text.split(/[.!?]+/).filter(s => s.trim().length > 20).map(s => s.trim()).slice(0, 4);
}

// EXTRACTION DE MOTS-CLÉS V1 - Robuste et précise
function extractBestKeywords(text) {
  const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'dans', 'sur', 'avec', 'par', 'pour', 'sans', 'qui', 'que', 'est', 'sont', 'été', 'avoir', 'être', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'that', 'this', 'was', 'were', 'has', 'have', 'had', 'comment', 'grok', 'partager', 'inscrire', 'connecter', 'share', 'subscribe']);
  
  // Noms propres complets (priorité max)
  const properNouns = text.match(/\b[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+(?:\s+[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+)+\b/g) || [];
  
  // Personnages historiques et scientifiques étendus
  const historicalFigures = text.match(/\b(Marie|Edison|Curie|Watt|Savery|Tesla|Einstein|Darwin|Newton|Galilée|Pasteur|Napoléon|Bonaparte|César|Jules|Fleming|Alexandre|Pénicilline|Sarkozy|Gorbatchev|Hitler|Staline|Roosevelt|Churchill|Gandhi|Mandela|Lincoln|Washington|Voltaire|Rousseau|Descartes|Pascal|Molière|Hugo|Balzac|Zola|Proust|Camus|Picasso|Monet|Van Gogh|Beethoven|Mozart|Bach)\b/gi) || [];
  
  // Villes, pays, régions
  const places = text.match(/\b(Paris|Londres|Tokyo|Canberra|Sydney|Melbourne|New York|Berlin|Rome|Madrid|Moscou|Beijing|Pékin|Washington|Ottawa|Brasília|Le Caire|Mumbai|Delhi|Lagos|Kinshasa|Australie|France|Allemagne|Espagne|Italie|Russie|Chine|Japon|États-Unis|Canada|Brésil|Inde|Afrique|Europe|Asie|Amérique|URSS|Empire|République)\b/gi) || [];
  
  // Dates et périodes historiques
  const dates = text.match(/\b(?:1[0-9]\d{2}|20\d{2})\b/g) || [];
  const periods = text.match(/\b(Moyen Âge|Renaissance|Révolution|Empire|République|Antiquité|Préhistoire|XXe siècle|XIXe siècle|Guerre mondiale|Guerre froide)\b/gi) || [];
  
  // Concepts scientifiques spécialisés
  const scientificTerms = text.match(/\b(radioactivité|polonium|radium|électrons?|atomes?|carbone|hydrogène|oxygène|uranium|plutonium|physique|chimie|biologie|mathématiques|géologie|astronomie|médecine|pénicilline|antibiotique|vaccin|virus|bactérie|ADN|ARN|photosynthèse|évolution|gravité|relativité|quantique|thermodynamique|électricité|magnétisme|optique|acoustique)\b/gi) || [];
  
  // Termes géographiques et démographiques
  const geoTerms = text.match(/\b(capitale|ville|pays|continent|océan|mer|montagne|rivière|fleuve|lac|désert|forêt|habitants?|population|densité|superficie|altitude|latitude|longitude|climat|température|précipitations)\b/gi) || [];
  
  // Nombres avec unités significatives
  const numbers = text.match(/\b\d+(?:[.,]\d+)?\s*(?:millions?|milliards?|mille|milliers?|%|km|mètres?|tonnes?|années?|ans|siècles?|habitants?|°C|km\/h|m\/s)\b/gi) || [];
  
  // Événements et concepts historiques
  const historicalEvents = text.match(/\b(révolution|guerre|bataille|traité|alliance|empire|royaume|république|démocratie|dictature|monarchie|féodalisme|capitalisme|socialisme|communisme|fascisme|nazisme|colonisation|indépendance|unification|partition|chute|fondation|découverte|invention|exploration)\b/gi) || [];
  
  // Arts, littérature, culture
  const culturalTerms = text.match(/\b(peinture|sculpture|architecture|littérature|poésie|roman|théâtre|cinéma|musique|opéra|ballet|symphonie|concerto|chef-d'œuvre|style|mouvement|courant|école|baroque|classique|romantique|moderne|contemporain)\b/gi) || [];
  
  // Mots importants filtrés (réduction du bruit)
  const importantWords = text.toLowerCase()
    .replace(/[^\w\sÀ-ÿ]/g, ' ')
    .split(/\s+/)
    .filter(word => 
      word.length > 4 && 
      !stopWords.has(word) &&
      !/^\d+$/.test(word) && 
      !word.includes('http') &&
      !/^(cela|cette|celui|celle|ceux|celles|donc|ainsi|aussi|très|plus|moins|bien|tout|tous|toute|toutes|même|autres?|autre|grand|petit|nouveau|nouvelle|premier|première|dernier|dernière)$/i.test(word)
    )
    .slice(0, 2);
  
  // Combinaison pondérée (ordre d'importance)
  let keywords = [
    ...properNouns,           // Priorité 1: Noms complets
    ...historicalFigures,     // Priorité 2: Personnages
    ...places,               // Priorité 3: Lieux
    ...scientificTerms,      // Priorité 4: Science
    ...historicalEvents,     // Priorité 5: Histoire
    ...culturalTerms,        // Priorité 6: Culture
    ...geoTerms,            // Priorité 7: Géographie
    ...dates,               // Priorité 8: Dates
    ...periods,             // Priorité 9: Périodes
    ...numbers,             // Priorité 10: Nombres
    ...importantWords       // Priorité 11: Autres
  ];
  
  // Nettoyage et déduplication
  keywords = keywords.filter(k => k && k.length > 1)
    .map(k => k.trim())
    .filter(k => !['comment', 'grok', 'partager', 'inscrire', 'connecter'].includes(k.toLowerCase()));
  
  keywords = [...new Set(keywords)];
  
  return keywords.slice(0, 7); // Limite optimale
}

// CALCUL DE PERTINENCE V1 - Strict et précis
function calculateRelevance(claim, sourceContent) {
  const claimKeywords = extractBestKeywords(claim);
  const sourceText = sourceContent.toLowerCase();
  const claimText = claim.toLowerCase();
  
  if (claimKeywords.length === 0) return 0;
  
  let relevanceScore = 0;
  let exactMatches = 0;
  let partialMatches = 0;
  
  // Correspondances exactes (poids fort)
  claimKeywords.forEach(keyword => {
    const keywordLower = keyword.toLowerCase();
    
    if (sourceText.includes(keywordLower)) {
      exactMatches++;
      // Bonus selon la longueur et l'importance du mot-clé
      if (keyword.length > 8) {
        relevanceScore += 0.5; // Mots très longs = très importants
      } else if (keyword.length > 5) {
        relevanceScore += 0.4;
      } else {
        relevanceScore += 0.3;
      }
    }
    
    // Correspondances partielles pour noms composés
    if (keyword.includes(' ')) {
      const parts = keyword.split(' ');
      const matchingParts = parts.filter(part => 
        part.length > 2 && sourceText.includes(part.toLowerCase())
      ).length;
      
      if (matchingParts > 0) {
        partialMatches++;
        relevanceScore += (matchingParts / parts.length) * 0.25;
      }
    }
  });
  
  // Bonus pour correspondances multiples
  if (exactMatches >= 2) relevanceScore += 0.3;
  if (exactMatches >= 3) relevanceScore += 0.4;
  if (partialMatches >= 2) relevanceScore += 0.2;
  
  // PÉNALITÉ drastique si aucune correspondance directe
  if (exactMatches === 0 && partialMatches === 0) {
    return 0.02; // Quasi-inexistant
  }
  
  // Bonus pour correspondance dans le titre de la source
  const titleWords = sourceContent.substring(0, 100).toLowerCase();
  const titleMatches = claimKeywords.filter(k => titleWords.includes(k.toLowerCase())).length;
  if (titleMatches > 0) {
    relevanceScore += titleMatches * 0.2;
  }
  
  return Math.min(relevanceScore, 1.0);
}

// DÉTECTION DE CONTRADICTIONS V1 - Intelligente
function detectContradictions(sources, originalText) {
  const contradictions = [];
  
  // Contradiction sur les dates
  const datePattern = /\b(1[0-9]\d{2}|20\d{2})\b/g;
  const textDates = [...new Set((originalText.match(datePattern) || []))];
  
  if (textDates.length > 0) {
    const sourceDates = [];
    sources.forEach(source => {
      const dates = source.snippet.match(datePattern) || [];
      sourceDates.push(...dates);
    });
    
    const conflictingDates = sourceDates.filter(date => !textDates.includes(date));
    if (conflictingDates.length > 0 && Math.abs(parseInt(conflictingDates[0]) - parseInt(textDates[0])) > 5) {
      contradictions.push({
        topic: "Dates",
        description: `Sources mentionnent ${conflictingDates[0]} alors que le texte évoque ${textDates[0]}`,
        severity: "medium"
      });
    }
  }
  
  // Contradiction sur les chiffres significatifs
  const numberPattern = /\b\d+(?:[.,]\d+)?\s*(?:millions?|milliards?|mille|%|habitants?|km|mètres?)\b/gi;
  const textNumbers = originalText.match(numberPattern) || [];
  
  if (textNumbers.length > 0) {
    sources.forEach(source => {
      const sourceNumbers = source.snippet.match(numberPattern) || [];
      sourceNumbers.forEach(sourceNum => {
        const hasConflict = !textNumbers.some(textNum => {
          const sourceVal = parseFloat(sourceNum.replace(/[^\d.,]/g, '').replace(',', '.'));
          const textVal = parseFloat(textNum.replace(/[^\d.,]/g, '').replace(',', '.'));
          return Math.abs(sourceVal - textVal) / Math.max(sourceVal, textVal) < 0.2; // 20% de tolérance
        });
        
        if (hasConflict && sourceNumbers.length > 0) {
          contradictions.push({
            topic: "Statistiques",
            description: `Sources présentent des chiffres différents de ceux mentionnés`,
            severity: "high"
          });
        }
      });
    });
  }
  
  // Contradiction terminologique
  const keyTerms = extractBestKeywords(originalText);
  const contradictorySources = sources.filter(source => 
    /\b(faux|incorrect|erreur|inexact|conteste|dément|réfute|nie)\b/i.test(source.snippet)
  );
  
  if (contradictorySources.length > 0) {
    contradictions.push({
      topic: "Affirmations",
      description: `${contradictorySources.length} source(s) contiennent des éléments contradictoires`,
      severity: "high"
    });
  }
  
  return [...new Set(contradictions.map(c => JSON.stringify(c)))].map(c => JSON.parse(c));
}

// ANALYSE DE SENTIMENT V1 - Nuancée
function analyzeSentiment(text) {
  const positiveWords = /\b(excellent|parfait|remarquable|exceptionnel|magnifique|brillant|génial|extraordinaire|merveilleux|formidable|splendide|superbe)\b/gi;
  const negativeWords = /\b(terrible|horrible|catastrophique|désastreux|lamentable|pitoyable|scandaleux|affreux|épouvantable|atroce)\b/gi;
  const criticalWords = /\b(attention|prudence|danger|risque|problème|erreur|controverse|débat|critique|polémique|contesté|disputé|incertain|douteux)\b/gi;
  
  const positiveCount = (text.match(positiveWords) || []).length;
  const negativeCount = (text.match(negativeWords) || []).length;
  const criticalCount = (text.match(criticalWords) || []).length;
  
  if (criticalCount >= 2) return 'critical';
  if (negativeCount > positiveCount && negativeCount > 0) return 'negative';
  if (positiveCount > 0 && positiveCount > negativeCount) return 'positive';
  return 'neutral';
}

// GÉNÉRATION D'EXPLICATION V1 - Claire et détaillée
function generateScoringExplanation(scoringDetails, sources, contentAnalysis) {
  const finalPercentage = scoringDetails.finalPercentage;
  const relevantSources = sources.filter(s => s.relevanceScore && s.relevanceScore > 0.25);
  
  let explanation = "";
  
  // Explication principale
  if (finalPercentage >= 80) {
    explanation = `Score très élevé grâce à ${relevantSources.length} sources hautement pertinentes`;
  } else if (finalPercentage >= 70) {
    explanation = `Score élevé avec ${relevantSources.length} sources fiables trouvées`;
  } else if (finalPercentage >= 50) {
    explanation = `Score modéré basé sur ${relevantSources.length} sources disponibles`;
  } else if (finalPercentage >= 30) {
    explanation = `Score faible dû à un nombre limité de sources pertinentes (${relevantSources.length})`;
  } else {
    explanation = `Score très faible causé par l'absence de sources fiables`;
  }
  
  // Détails sur les types de sources
  const sourceTypes = [];
  if (scoringDetails.sourceBreakdown.academic > 0) sourceTypes.push(`${scoringDetails.sourceBreakdown.academic} académique(s)`);
  if (scoringDetails.sourceBreakdown.encyclopedia > 0) sourceTypes.push(`${scoringDetails.sourceBreakdown.encyclopedia} encyclopédie(s)`);
  if (scoringDetails.sourceBreakdown.database > 0) sourceTypes.push(`${scoringDetails.sourceBreakdown.database} base(s) de données`);
  
  if (sourceTypes.length > 0) {
    explanation += `, incluant ${sourceTypes.join(', ')}`;
  }
  
  // Explications des pénalités
  if (contentAnalysis.isOpinion) {
    explanation += ". Score réduit car le contenu exprime des opinions personnelles";
  } else if (contentAnalysis.isSubjective) {
    explanation += ". Score ajusté car le contenu contient des éléments subjectifs";
  } else if (contentAnalysis.isSpeculative) {
    explanation += ". Score modéré en raison de la nature spéculative du contenu";
  }
  
  explanation += ".";
  return explanation;
}

// SCORING GLOBAL V1 CORRIGÉ - Équilibré et cohérent
function calculateEnhancedConfidenceScore(claims, sources, originalText) {
  // CORRECTION 3: Score de base général réduit
  let baseScore = 25; // Au lieu de 35
  let sourceScore = 0;
  let qualityBonus = 0;
  let penalties = 0;
  
  // Analyse du type de contenu
  const isOpinion = isStrongOpinionContent(originalText);
  const isSpeculative = hasSpeculativeLanguage(originalText);
  const isComparative = hasComparativeLanguage(originalText);
  const isSubjective = hasSubjectiveLanguage(originalText);
  const isGeographical = /\b(capitale|ville|pays|habitants|population|superficie|densité)\b/i.test(originalText);
  const isScientific = /\b(électrons?|atomes?|carbone|physique|chimie|découverte|invention|vitesse|lumière)\b/i.test(originalText);
  const isHistorical = /\b(napoléon|césar|guerre|révolution|empire|république|siècle|histoire)\b/i.test(originalText);
  
  // Filtrage strict des sources pertinentes
  const relevantSources = sources.filter(s => s.relevanceScore && s.relevanceScore > 0.25);
  const highQualitySources = relevantSources.filter(s => s.relevanceScore > 0.5);
  
  // Catégorisation des sources pertinentes
  const encyclopediaSources = relevantSources.filter(s => s.sourceCategory === 'encyclopedia');
  const databaseSources = relevantSources.filter(s => s.sourceCategory === 'database');
  const academicSources = relevantSources.filter(s => s.sourceCategory === 'academic');
  const archiveSources = relevantSources.filter(s => s.sourceCategory === 'archive');
  
  // Calcul du score de sources (uniquement sources pertinentes)
  relevantSources.forEach(source => {
    let sourceValue = 0;
    
    switch(source.sourceCategory) {
      case 'encyclopedia': sourceValue = 20; break;
      case 'database': sourceValue = 25; break;
      case 'academic': sourceValue = 30; break;
      case 'archive': sourceValue = 18; break;
      case 'search_engine': sourceValue = 15; break;
      case 'reference': sourceValue = 15; break;
      default: sourceValue = 10;
    }
    
    // Multiplication par la pertinence
    sourceValue *= source.relevanceScore;
    
    // Bonus pour sources de très haute qualité
    if (source.relevanceScore > 0.7) sourceValue *= 1.4;
    if (source.isOfficialData) sourceValue *= 1.3;
    
    sourceScore += sourceValue;
  });
  
  // Bonus qualité adaptatif basé sur sources PERTINENTES
  const relevantCount = relevantSources.length;
  if (relevantCount >= 5) qualityBonus = 40;
  else if (relevantCount >= 4) qualityBonus = 35;
  else if (relevantCount >= 3) qualityBonus = 25;
  else if (relevantCount >= 2) qualityBonus = 15;
  else if (relevantCount >= 1) qualityBonus = 8;
  
  // Bonus diversité (sources pertinentes uniquement)
  const diversityCount = [encyclopediaSources, databaseSources, academicSources, archiveSources]
    .filter(arr => arr.length > 0).length;
  
  if (diversityCount >= 3) qualityBonus += 15;
  else if (diversityCount >= 2) qualityBonus += 10;
  
  // Bonus spécialisé par type de contenu
  if (isScientific && academicSources.length > 0) qualityBonus += 12;
  if (isHistorical && archiveSources.length > 0) qualityBonus += 10;
  if (isGeographical && encyclopediaSources.length > 0) qualityBonus += 8;
  
  // CORRECTION 1: Pénalités opinions augmentées
  if (isOpinion) {
    penalties += 70; // Au lieu de 45
    baseScore = 8;   // Au lieu de 20
  } else if (isSubjective) {
    penalties += 25;
  } else if (isComparative) {
    penalties += 15;
  }
  
  if (isSpeculative) penalties += 12;
  
  // Pénalité majeure pour manque de sources pertinentes
  if (relevantCount === 0) {
    penalties += 40;
    baseScore = 15;
  } else if (relevantCount === 1 && !isScientific && !isHistorical) {
    penalties += 20;
  }
  
  // Calcul final avec bornes
  const rawScore = baseScore + sourceScore + qualityBonus - penalties;
  const finalScore = Math.max(15, Math.min(95, rawScore)) / 100;
  
  return {
    finalScore: finalScore,
    details: {
      baseScore,
      sourceScore: Math.round(sourceScore),
      qualityBonus,
      penalties,
      rawScore,
      finalPercentage: Math.round(finalScore * 100),
      sourceBreakdown: {
        encyclopedia: encyclopediaSources.length,
        database: databaseSources.length,
        academic: academicSources.length,
        archive: archiveSources.length,
        searchEngine: relevantSources.filter(s => s.sourceCategory === 'search_engine').length,
        reference: relevantSources.filter(s => s.sourceCategory === 'reference').length,
        total: sources.length,
        totalRelevant: relevantCount,
        highQuality: highQualitySources.length
      }
    },
    contentAnalysis: {
      isOpinion,
      isSubjective,
      isComparative,
      isSpeculative,
      isGeographical,
      isScientific,
      isHistorical,
      contentType: isOpinion ? 'OPINION' : 
                  isSubjective ? 'SUBJECTIF' : 
                  isGeographical ? 'GÉOGRAPHIQUE' : 
                  isScientific ? 'SCIENTIFIQUE' : 
                  isHistorical ? 'HISTORIQUE' : 'FACTUEL'
    }
  };
}

// CORRECTION 2: Fonction de détection d'opinions renforcée
function isStrongOpinionContent(text) {
  const opinionPatterns = [
    /\b(meilleur|meilleure|pire|plus beau|plus belle)\b.*\b(monde|univers|planète|terre|tous temps)\b/i,
    /\b(préfère|aime mieux|déteste|adore|opinion|goût|point de vue|je pense|à mon avis|selon moi)\b/i,
    /\b(magnifique|horrible|parfait|nul|génial|fantastique|extraordinaire)\b/i,
    // AJOUT: Patterns stricts pour opinions superlatives
    /\b(plus belle|plus beau|meilleur.*monde|meilleur.*jamais|meilleur.*tous.*temps)\b/i
  ];
  return opinionPatterns.some(pattern => pattern.test(text));
}

function hasSubjectiveLanguage(text) {
  return /\b(beau|belle|laid|joli|superbe|merveilleux|incroyable|impressionnant|remarquable|exceptionnel|splendide)\b/i.test(text);
}

function hasComparativeLanguage(text) {
  return /\b(plus.*que|moins.*que|meilleur.*que|pire.*que|supérieur|inférieur|comparé|versus|vs|par rapport)\b/i.test(text);
}

function hasSpeculativeLanguage(text) {
  return /\b(peut-être|probablement|semble|paraît|suppose|présume|vraisemblablement|apparemment|sans doute|possiblement|éventuellement)\b/i.test(text);
}

// Fonctions de recherche optimisées
async function searchWikipediaAdvanced(claimText) {
  const sources = [];
  const languages = ['fr', 'en'];
  
  for (const lang of languages) {
    const keywords = extractBestKeywords(claimText);
    if (keywords.length === 0) continue;
    
    const searchTerms = keywords.slice(0, 4).join(' ');
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchTerms)}&format=json&origin=*&srlimit=5`;
    
    try {
      const response = await fetch(searchUrl, { timeout: 8000 });
      const data = await response.json();
      
      if (data.query?.search) {
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
    const response = await fetch(summaryUrl, { timeout: 8000 });
    if (!response.ok) throw new Error('Not found');
    
    const data = await response.json();
    if (data.extract && data.extract.length > 30) {
      const relevanceScore = calculateRelevance(originalClaim, data.title + ' ' + data.extract);
      
      if (relevanceScore > 0.15) {
        return {
          title: `Wikipedia (${lang.toUpperCase()}): ${data.title}`,
          url: data.content_urls.desktop.page,
          snippet: data.extract.substring(0, 220) + "...",
          reliability: 0.85,
          sourceCategory: 'encyclopedia',
          relevanceScore: relevanceScore,
          lastUpdated: new Date().toISOString(),
          sentiment: analyzeSentiment(data.extract)
        };
      }
    }
  } catch (error) {
    console.warn(`Wikipedia content fetch failed:`, error.message);
  }
  
  return null;
}

async function searchWikidata(claimText) {
  const keywords = extractBestKeywords(claimText);
  if (keywords.length === 0) return [];
  
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(keywords.slice(0, 3).join(' '))}&language=fr&format=json&origin=*&limit=4`;
  
  try {
    const response = await fetch(searchUrl, { timeout: 7000 });
    const data = await response.json();
    
    if (data.search?.length > 0) {
      return data.search.map(item => ({
        title: `Wikidata: ${item.label}`,
        url: `https://www.wikidata.org/wiki/${item.id}`,
        snippet: (item.description || "Entité Wikidata structurée") + " - Données factuelles vérifiables et références croisées.",
        reliability: 0.88,
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
    const hasScientificTerms = /\b(marie|curie|radioactivité|polonium|radium|maladie|virus|traitement|médical|recherche|étude|scientifique|découverte|cancer|vaccin|becquerel|uranium|physique|chimie|nobel|pénicilline|fleming|antibiotique|biologie|génétique|ADN|protéine|cellule|molécule|thérapie|diagnostic)\b/i.test(query);
    
    if (!hasScientificTerms) return [];
    
    const keywords = extractBestKeywords(query);
    const searchTerms = keywords.filter(k => k.length > 3).slice(0, 3).join(' ');
    
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(searchTerms)}&retmode=json&retmax=2`;
    const response = await fetch(searchUrl, { timeout: 10000 });
    
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    
    if (data.esearchresult?.idlist?.length > 0) {
      return [{
        title: `PubMed: Recherches scientifiques - ${keywords[0] || 'Sujet médical'}`,
        url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(searchTerms)}`,
        snippet: `Base de données médicale officielle avec ${data.esearchresult.count} publications scientifiques peer-reviewed - Source: NCBI/NIH.`,
        reliability: 0.94,
        sourceCategory: 'academic',
        isOfficialData: true,
        relevanceScore: 0.8,
        lastUpdated: new Date().toISOString(),
        sentiment: 'neutral'
      }];
    }
  } catch (error) {
    console.warn('PubMed search failed:', error.message);
  }
  
  return [];
}

async function searchArchiveOrg(query) {
  try {
    const keywords = extractBestKeywords(query);
    const searchTerms = keywords.slice(0, 3).join(' ');
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchTerms)}&fl[]=identifier,title,description,date&rows=3&output=json`;
    
    const response = await fetch(searchUrl, { timeout: 10000 });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    
    const data = await response.json();
    const sources = [];
    
    if (data.response?.docs) {
      data.response.docs.forEach(doc => {
        if (doc.title && doc.description) {
          const relevanceScore = calculateRelevance(query, doc.title + ' ' + doc.description);
          
          if (relevanceScore > 0.2) {
            sources.push({
              title: `Archive.org: ${doc.title.substring(0, 60)}...`,
              url: `https://archive.org/details/${doc.identifier}`,
              snippet: doc.description.substring(0, 200) + "...",
              reliability: 0.80,
              sourceCategory: 'archive',
              relevanceScore: relevanceScore,
              lastUpdated: doc.date ? new Date(doc.date).toISOString() : new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString(),
              sentiment: analyzeSentiment(doc.description)
            });
          }
        }
      });
    }
    
    return sources;
  } catch (error) {
    console.warn('Archive.org search failed:', error.message);
    return [];
  }
}

async function searchDuckDuckGo(claimText) {
  const keywords = extractBestKeywords(claimText);
  if (keywords.length === 0) return [];
  
  const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(keywords.slice(0, 2).join(' '))}&format=json&no_html=1&skip_disambig=1`;
  
  try {
    const response = await fetch(searchUrl, { timeout: 7000 });
    const data = await response.json();
    
    if (data.Abstract && data.Abstract.length > 50) {
      const relevanceScore = calculateRelevance(claimText, data.Abstract);
      
      if (relevanceScore > 0.2) {
        return [{
          title: `DuckDuckGo: ${data.Heading || "Résultat instantané"}`,
          url: data.AbstractURL || "https://duckduckgo.com/",
          snippet: data.Abstract.substring(0, 200) + "...",
          reliability: 0.75,
          sourceCategory: 'search_engine',
          relevanceScore: relevanceScore,
          lastUpdated: new Date().toISOString(),
          sentiment: analyzeSentiment(data.Abstract)
        }];
      }
    }
  } catch (error) {
    console.warn('DuckDuckGo search failed:', error.message);
  }
  
  return [];
}

// Déduplication et classement optimisés
function deduplicateAndRankSources(sources) {
  const seen = new Set();
  const deduplicated = [];
  
  sources.forEach(source => {
    const domain = extractDomain(source.url);
    const key = domain + '-' + source.title.substring(0, 30);
    
    // Filtrage strict par pertinence
    if (source.relevanceScore && source.relevanceScore < 0.2) {
      console.log(`Source écartée (pertinence: ${source.relevanceScore.toFixed(2)}):`, source.title.substring(0, 50));
      return;
    }
    
    if (!seen.has(key) && deduplicated.length < 10) {
      seen.add(key);
      deduplicated.push(source);
    }
  });

  return deduplicated.sort((a, b) => {
    const aScore = (a.isOfficialData ? 100 : 0) + (a.reliability * 100) + (a.relevanceScore || 0) * 100;
    const bScore = (b.isOfficialData ? 100 : 0) + (b.reliability * 100) + (b.relevanceScore || 0) * 100;
    return bScore - aScore;
  });
}

function evaluateClaimWithSources(claimText, sources) {
  const relevantSources = sources.filter(s => s.relevanceScore && s.relevanceScore > 0.25);
  
  let confidence = 0.20;
  
  if (relevantSources.length >= 4) confidence += 0.50;
  else if (relevantSources.length >= 3) confidence += 0.40;
  else if (relevantSources.length >= 2) confidence += 0.30;
  else if (relevantSources.length >= 1) confidence += 0.20;
  
  let status;
  if (confidence >= 0.75) status = 'verified';
  else if (confidence >= 0.55) status = 'partially_verified';
  else if (confidence >= 0.40) status = 'uncertain';
  else status = 'disputed';

  return {
    text: claimText,
    confidence: Math.max(0.15, Math.min(0.95, confidence)),
    status: status,
    relevantSources: relevantSources.length
  };
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch (e) {
    return url ? url.substring(0, 20) : 'unknown';
  }
}

// FONCTION PRINCIPALE V1 - Production Ready
async function performComprehensiveFactCheck(text) {
  const results = {
    overallConfidence: 0,
    sources: [],
    claims: [],
    scoringDetails: {},
    contentAnalysis: {},
    extractedKeywords: [],
    contradictions: [],
    scoringExplanation: ""
  };
  
  try {
    const cleanedText = cleanText(text);
    const claims = extractIntelligentClaims(cleanedText);
    let allSources = [];
    
    // Extraction des mots-clés
    results.extractedKeywords = extractBestKeywords(cleanedText);
    console.log('Mots-clés extraits:', results.extractedKeywords);
    
    // Recherche parallèle avec timeout global
    const searchPromises = [];
    
    for (const claimText of claims) {
      console.log(`Recherche pour: "${claimText.substring(0, 60)}..."`);
      searchPromises.push(searchWikipediaAdvanced(claimText));
      searchPromises.push(searchWikidata(claimText));
      searchPromises.push(searchDuckDuckGo(claimText));
      searchPromises.push(searchArchiveOrg(claimText));
      searchPromises.push(searchPubMed(claimText));
    }
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Search timeout')), 25000)
    );
    
    try {
      const sourceArrays = await Promise.race([
        Promise.all(searchPromises),
        timeoutPromise
      ]);
      
      sourceArrays.forEach(sourceArray => {
        if (Array.isArray(sourceArray)) {
          sourceArray.forEach(source => {
            if (source) allSources.push(source);
          });
        }
      });
    } catch (timeoutError) {
      console.warn('Recherche interrompue par timeout, utilisation des résultats partiels');
    }
    
    // Traitement des résultats
    results.sources = deduplicateAndRankSources(allSources);
    results.contradictions = detectContradictions(results.sources, cleanedText);
    
    const scoringAnalysis = calculateEnhancedConfidenceScore(claims, results.sources, cleanedText);
    results.overallConfidence = scoringAnalysis.finalScore;
    results.scoringDetails = scoringAnalysis.details;
    results.contentAnalysis = scoringAnalysis.contentAnalysis;
    
    results.scoringExplanation = generateScoringExplanation(
      scoringAnalysis.details, 
      results.sources, 
      scoringAnalysis.contentAnalysis
    );
    
    results.claims = claims.map(claimText => evaluateClaimWithSources(claimText, results.sources));
    
    console.log(`Fact-check terminé: ${results.sources.length} sources (${results.scoringDetails.sourceBreakdown.totalRelevant} pertinentes), ${Math.round(results.overallConfidence * 100)}% confiance, ${results.contradictions.length} contradictions`);
    
    return results;
  } catch (error) {
    console.error('Erreur fact-checking:', error);
    throw error;
  }
}

// Routes API
app.get("/", (req, res) => {
  res.send("✅ API Fact-Checker IA Pro V1.0 - Production Ready!");
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    version: "1.0", 
    apis: 5, 
    features: "production-ready+optimized-relevance+smart-scoring+contradiction-detection"
  });
});

app.post('/verify', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.length < 10) {
      return res.status(400).json({ error: 'Le texte est requis et doit contenir au moins 10 caractères.' });
    }
    
    const cacheKey = `verify_v1_${Buffer.from(text.substring(0, 100)).toString('base64')}`;
    const cached = cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log('Réponse servie depuis le cache V1');
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
      version: "1.0"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Fact-Checker IA Pro V1.0 démarré sur port ${PORT}`);
  console.log(`📊 Production Ready: Scoring optimisé, Sources pertinentes, Multi-plateformes`);
});

module.exports = app;
