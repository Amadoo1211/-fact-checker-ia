// server.js - VERSION 1.1 FINALE ET COMPLÈTE (PRODUCTION)
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const cache = new Map();
// Cache remis à 12 heures pour la production
const CACHE_TTL = 12 * 60 * 60 * 1000;

app.use(cors({
  origin: ['chrome-extension://*', 'https://*.netlify.app', 'http://localhost:3000', 'https://fact-checker-ia-production.up.railway.app']
}));
app.use(express.json());

// --- Fonctions Utilitaires ---
function cleanText(text) {
 return text.trim().replace(/\s+/g, ' ').substring(0, 12000);
}

function extractIntelligentClaims(text) {
 return text.split(/[.!?]+/).filter(s => s.trim().length > 20).map(s => s.trim()).slice(0, 4);
}

function extractBestKeywords(text) {
    const stopWords = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'dans', 'sur', 'avec', 'par', 'pour', 'sans', 'qui', 'que', 'est', 'sont', 'été', 'avoir', 'être', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'that', 'this', 'was', 'were', 'has', 'have', 'had', 'comment', 'grok', 'partager', 'inscrire', 'connecter', 'share', 'subscribe']);
    const properNouns = text.match(/\b[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+(?:\s+[A-ZÀÂÄÉÈÊËÏÎÔÖÙÛÜŸÇ][a-zàâäéèêëïîôöùûüÿç]+)+\b/g) || [];
    const historicalFigures = text.match(/\b(Marie|Edison|Curie|Watt|Savery|Tesla|Einstein|Darwin|Newton|Galilée|Pasteur|Napoléon|Bonaparte|César|Jules|Fleming|Alexandre|Pénicilline|Sarkozy|Gorbatchev|Hitler|Staline|Roosevelt|Churchill|Gandhi|Mandela|Lincoln|Washington|Voltaire|Rousseau|Descartes|Pascal|Molière|Hugo|Balzac|Zola|Proust|Camus|Picasso|Monet|Van Gogh|Beethoven|Mozart|Bach)\b/gi) || [];
    const places = text.match(/\b(Paris|Londres|Tokyo|Canberra|Sydney|Melbourne|New York|Berlin|Rome|Madrid|Moscou|Beijing|Pékin|Washington|Ottawa|Brasília|Le Caire|Mumbai|Delhi|Lagos|Kinshasa|Australie|France|Allemagne|Espagne|Italie|Russie|Chine|Japon|États-Unis|Canada|Brésil|Inde|Afrique|Europe|Asie|Amérique|URSS|Empire|République)\b/gi) || [];
    const dates = text.match(/\b(?:1[0-9]\d{2}|20\d{2})\b/g) || [];
    const scientificTerms = text.match(/\b(radioactivité|polonium|radium|électrons?|atomes?|physique|chimie|biologie|pénicilline|antibiotique|vaccin|évolution|gravité|relativité|quantique)\b/gi) || [];
    const importantWords = text.toLowerCase().replace(/[^\w\sÀ-ÿ]/g, ' ').split(/\s+/).filter(word => word.length > 4 && !stopWords.has(word) && !/^\d+$/.test(word)).slice(0, 2);
    let keywords = [...new Set([...properNouns, ...historicalFigures, ...places, ...scientificTerms, ...dates, ...importantWords].map(k => k.trim()).filter(k => k && k.length > 1))];
    return keywords.slice(0, 7);
}


function calculateRelevance(claim, sourceContent) {
    const claimKeywords = extractBestKeywords(claim);
    const sourceText = (sourceContent || '').toLowerCase();
    if (claimKeywords.length === 0) return 0;
    let relevanceScore = 0;
    let exactMatches = 0;
    claimKeywords.forEach(keyword => {
        if (sourceText.includes(keyword.toLowerCase())) {
            exactMatches++;
            relevanceScore += (keyword.length > 5) ? 0.4 : 0.3;
        }
    });
    if (exactMatches === 0) return 0.02;
    if (exactMatches >= 2) relevanceScore += 0.3;
    if (exactMatches >= 3) relevanceScore += 0.4;
    return Math.min(relevanceScore, 1.0);
}

function extractDomain(url) {
    try {
        return new URL(url).hostname.replace('www.', '');
    } catch (e) {
        return url ? url.substring(0, 20) : 'unknown';
    }
}

// --- Fonctions de détection de type de contenu ---
function isStrongOpinionContent(text) {
    const opinionPatterns = [
        /\b(meilleur|meilleure|pire|plus beau|plus belle)\b.*\b(monde|univers|planète|terre|tous temps)\b/i,
        /\b(préfère|aime mieux|déteste|adore|opinion|goût|point de vue|je pense|à mon avis|selon moi)\b/i,
        /\b(magnifique|horrible|parfait|nul|génial|fantastique|extraordinaire)\b/i,
        /\b(plus belle|plus beau|meilleur.*monde|meilleur.*jamais|meilleur.*tous.*temps)\b/i
    ];
    return opinionPatterns.some(pattern => pattern.test(text));
}

function hasSubjectiveLanguage(text) {
    return /\b(beau|belle|laid|joli|superbe|merveilleux|incroyable|impressionnant|remarquable)\b/i.test(text);
}

function hasComparativeLanguage(text) {
    return /\b(plus.*que|moins.*que|meilleur.*que|pire.*que|supérieur|inférieur|comparé)\b/i.test(text);
}

function hasSpeculativeLanguage(text) {
    return /\b(peut-être|probablement|semble|paraît|suppose|vraisemblablement|apparemment)\b/i.test(text);
}

// --- NOUVELLE FONCTION DE SCORING CORRIGÉE ---
function calculateEnhancedConfidenceScore(claims, sources, originalText) {
    const isOpinion = isStrongOpinionContent(originalText);

    if (isOpinion) {
        const opinionScore = 22;
        return {
            finalScore: opinionScore / 100,
            details: {
                baseScore: 5, sourceScore: 0, qualityBonus: 0, penalties: 80, rawScore: opinionScore, finalPercentage: opinionScore,
                sourceBreakdown: { total: 0, totalRelevant: 0 }
            },
            contentAnalysis: { isOpinion: true, contentType: 'OPINION' }
        };
    }

    let baseScore = 25, sourceScore = 0, qualityBonus = 0, penalties = 0;
    const isSpeculative = hasSpeculativeLanguage(originalText);
    const isComparative = hasComparativeLanguage(originalText);
    const isSubjective = hasSubjectiveLanguage(originalText);
    const relevantSources = sources.filter(s => s.relevanceScore && s.relevanceScore > 0.25);
    const encyclopediaSources = relevantSources.filter(s => s.sourceCategory === 'encyclopedia');
    const databaseSources = relevantSources.filter(s => s.sourceCategory === 'database');
    const academicSources = relevantSources.filter(s => s.sourceCategory === 'academic');
    const archiveSources = relevantSources.filter(s => s.sourceCategory === 'archive');

    relevantSources.forEach(source => {
        let sourceValue = 0;
        switch(source.sourceCategory) {
            case 'encyclopedia': sourceValue = 20; break;
            case 'database': sourceValue = 25; break;
            case 'academic': sourceValue = 30; break;
            case 'archive': sourceValue = 18; break;
            default: sourceValue = 12;
        }
        sourceValue *= source.relevanceScore;
        if (source.relevanceScore > 0.7) sourceValue *= 1.4;
        sourceScore += sourceValue;
    });

    const relevantCount = relevantSources.length;
    if (relevantCount >= 4) qualityBonus = 35;
    else if (relevantCount >= 3) qualityBonus = 25;
    else if (relevantCount >= 2) qualityBonus = 15;
    else if (relevantCount >= 1) qualityBonus = 8;
    
    const diversityCount = [encyclopediaSources, databaseSources, academicSources, archiveSources].filter(arr => arr.length > 0).length;
    if (diversityCount >= 3) qualityBonus += 15;
    else if (diversityCount >= 2) qualityBonus += 10;
    
    if (isSubjective) penalties += 25;
    if (isComparative) penalties += 15;
    if (isSpeculative) penalties += 12;
    
    if (relevantCount === 0) {
        penalties += 50;
        baseScore = 10;
    } else if (relevantCount === 1) {
        penalties += 20;
    }
    
    const rawScore = baseScore + sourceScore + qualityBonus - penalties;
    const finalScore = Math.max(15, Math.min(95, rawScore)) / 100;

    return {
        finalScore: finalScore,
        details: {
            baseScore, sourceScore: Math.round(sourceScore), qualityBonus, penalties, rawScore: Math.round(rawScore),
            finalPercentage: Math.round(finalScore * 100),
            sourceBreakdown: {
                encyclopedia: encyclopediaSources.length, database: databaseSources.length, academic: academicSources.length, archive: archiveSources.length,
                total: sources.length, totalRelevant: relevantCount
            }
        },
        contentAnalysis: { isOpinion: false, isSubjective, isComparative, isSpeculative, contentType: 'FACTUAL_ANALYSIS' }
    };
}


// --- Fonctions de recherche ---
async function searchWikipediaAdvanced(claimText) {
    const sources = [];
    const languages = ['fr', 'en'];
    for (const lang of languages) {
        const keywords = extractBestKeywords(claimText);
        if (keywords.length === 0) continue;
        const searchTerms = keywords.slice(0, 4).join(' ');
        const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchTerms)}&format=json&origin=*&srlimit=3`;
        try {
            const response = await fetch(searchUrl, { timeout: 8000 });
            const data = await response.json();
            if (data.query?.search) {
                const articlePromises = data.query.search.map(article => fetchWikipediaContent(lang, article.title, claimText));
                const articles = (await Promise.all(articlePromises)).filter(a => a !== null);
                sources.push(...articles);
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
        if (!response.ok) return null;
        const data = await response.json();
        if (data.extract && data.extract.length > 30) {
            const relevanceScore = calculateRelevance(originalClaim, data.title + ' ' + data.extract);
            if (relevanceScore > 0.15) {
                return {
                    title: `Wikipedia (${lang.toUpperCase()}): ${data.title}`, url: data.content_urls.desktop.page,
                    snippet: data.extract.substring(0, 220) + "...", reliability: 0.85, sourceCategory: 'encyclopedia',
                    relevanceScore: relevanceScore, lastUpdated: new Date().toISOString(),
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
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(keywords.slice(0, 3).join(' '))}&language=fr&format=json&origin=*&limit=2`;
    try {
        const response = await fetch(searchUrl, { timeout: 7000 });
        const data = await response.json();
        if (data.search?.length > 0) {
            return data.search.map(item => ({
                title: `Wikidata: ${item.label}`, url: `https://www.wikidata.org/wiki/${item.id}`,
                snippet: (item.description || "Entité Wikidata structurée."), reliability: 0.88, sourceCategory: 'database',
                relevanceScore: calculateRelevance(claimText, item.label + ' ' + (item.description || '')),
            }));
        }
    } catch (error) {
        console.warn('Wikidata search failed:', error.message);
    }
    return [];
}

async function searchPubMed(query) {
    try {
        const hasScientificTerms = /\b(marie|curie|radioactivité|maladie|virus|traitement|médical|recherche|étude|scientifique|découverte|cancer|vaccin|pénicilline|fleming|antibiotique)\b/i.test(query);
        if (!hasScientificTerms) return [];
        const keywords = extractBestKeywords(query);
        const searchTerms = keywords.filter(k => k.length > 3).slice(0, 3).join(' ');
        const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(searchTerms)}&retmode=json&retmax=1`;
        const response = await fetch(searchUrl, { timeout: 10000 });
        if (!response.ok) return [];
        const data = await response.json();
        if (data.esearchresult?.idlist?.length > 0) {
            return [{
                title: `PubMed: Recherches scientifiques - ${keywords[0] || 'Sujet médical'}`,
                url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(searchTerms)}`,
                snippet: `Base de données médicale officielle avec ${data.esearchresult.count} publications scientifiques.`,
                reliability: 0.94, sourceCategory: 'academic', relevanceScore: 0.8,
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
        const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchTerms)}&fl[]=identifier,title,description,date&rows=2&output=json`;
        const response = await fetch(searchUrl, { timeout: 10000 });
        if (!response.ok) return [];
        const data = await response.json();
        const sources = [];
        if (data.response?.docs) {
            data.response.docs.forEach(doc => {
                if (doc.title && doc.description) {
                    const relevanceScore = calculateRelevance(query, doc.title + ' ' + doc.description);
                    if (relevanceScore > 0.2) {
                        sources.push({
                            title: `Archive.org: ${doc.title.substring(0, 60)}...`, url: `https://archive.org/details/${doc.identifier}`,
                            snippet: doc.description.substring(0, 200) + "...", reliability: 0.80, sourceCategory: 'archive',
                            relevanceScore: relevanceScore,
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

function deduplicateAndRankSources(sources) {
    const seen = new Set();
    const deduplicated = [];
    sources.forEach(source => {
        if (!source || !source.relevanceScore || source.relevanceScore < 0.2) return;
        const key = extractDomain(source.url) + '-' + source.title.substring(0, 30);
        if (!seen.has(key) && deduplicated.length < 10) {
            seen.add(key);
            deduplicated.push(source);
        }
    });
    return deduplicated.sort((a, b) => (b.reliability * b.relevanceScore) - (a.reliability * a.relevanceScore));
}

// --- Fonction principale ---
async function performComprehensiveFactCheck(text) {
    const cleanedText = cleanText(text);
    const claims = extractIntelligentClaims(cleanedText);
    if (claims.length === 0) claims.push(cleanedText);
    
    let allSources = [];
    const searchPromises = claims.flatMap(claim => [
        searchWikipediaAdvanced(claim),
        searchWikidata(claim),
        searchArchiveOrg(claim),
        searchPubMed(claim)
    ]);

    try {
        const sourceArrays = await Promise.all(searchPromises);
        allSources = sourceArrays.flat();
    } catch (error) {
        console.warn('Search failed:', error.message);
    }

    const rankedSources = deduplicateAndRankSources(allSources);
    const scoringAnalysis = calculateEnhancedConfidenceScore(claims, rankedSources, cleanedText);
    
    return {
        overallConfidence: scoringAnalysis.finalScore,
        sources: rankedSources,
        claims: [],
        scoringDetails: scoringAnalysis.details,
        contentAnalysis: scoringAnalysis.contentAnalysis,
        extractedKeywords: extractBestKeywords(cleanedText),
        contradictions: [],
        scoringExplanation: "" 
    };
}


// --- Routes API ---
app.get("/", (req, res) => {
  res.send("✅ API Fact-Checker IA Pro V1.1 - Production Ready!");
});

app.post('/verify', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.length < 10) {
      return res.status(400).json({ error: 'Le texte est requis et doit contenir au moins 10 caractères.' });
    }
    const cacheKey = `verify_v1.1_${Buffer.from(text.substring(0, 100)).toString('base64')}`;
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log('Réponse servie depuis le cache V1.1');
      return res.json(cached.data);
    }
    const verificationResult = await performComprehensiveFactCheck(text);
    cache.set(cacheKey, { data: verificationResult, timestamp: Date.now() });
    res.json(verificationResult);
  } catch (error) {
    console.error('Erreur dans /verify:', error);
    res.status(500).json({ error: 'Échec de la vérification' });
  }
});

/*
// Route de débogage, commentée pour la production
app.get("/clear-cache", (req, res) => {
  if (cache) {
    cache.clear();
    res.status(200).json({ message: "Cache has been cleared successfully." });
  } else {
    res.status(500).json({ message: "Cache object not found." });
  }
});
*/

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Fact-Checker IA Pro V1.1 démarré sur port ${PORT}`);
});

module.exports = app;
