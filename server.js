// server.js - VERSION FINALE OPTIMISÉE - Scoring aligné sur 75%
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

const API_HEADERS = {
    'User-Agent': 'FactCheckerIA/3.3 (boud3285@gmail.com)'
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ... (Les fonctions extractPreciseKeywords, searchWikipediaFixed, getContextualOfficialSources restent les mêmes) ...
function extractPreciseKeywords(text) {
    const cleaned = text
    .replace(/^(Oui|Non|Bien sûr|Voici|En effet|Selon|D’accord|Effectivement)[,.\s:]*/gi, '')
    .replace(/\b(je|tu|il|elle|nous|vous|ils|elles|le|la|les|un|une|des|ce|cette|ces)\b/gi, '')
    .substring(0, 600);
    
    const keywords = [];
    
    const entities = cleaned.match(/\b[A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ]+){0,3}\b/g) || [];
    entities.forEach(entity => {
        if (entity.length > 2 && !['Oui', 'Non', 'Voici', 'Cette', 'Dans', 'Pour', 'Avec'].includes(entity)) {
            keywords.push(entity.trim());
        }
    });
    
    const dates = cleaned.match(/\b(19|20)\d{2}\b|\b\d{1,2}\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+\d{4}\b/gi) || [];
    keywords.push(...dates);
    
    const technical = cleaned.match(/\b(climat|température|Nobel|population|France|physique|GIEC|INSEE|coronavirus|covid|vaccin|économie|politique|élection|président|ministre|gouvernement|parlement|assemblée|sénat|union européenne|brexit|ukraine|russie|chine|états-unis|afghanistan|réchauffement|biodiversité|énergie|nucléaire|renouvelable|inflation|croissance|chômage|retraite)\b/gi) || [];
    keywords.push(...technical);
    
    const numbers = cleaned.match(/\b\d+(?:\.\d+)?\s*(?:%|millions?|milliards?|degrés?|euros?|dollars?|habitants?|km|mètres?|tonnes?)\b/gi) || [];
    keywords.push(...numbers);
    
    const unique = [...new Set(keywords)].slice(0, 6);
    console.log('Mots-clés extraits:', unique);
    return unique;
}

async function searchWikipediaFixed(keywords) {
    if (!keywords || keywords.length === 0) return [];
    
    const sources = [];
    const searchQueries = [
        keywords.join(' '),
        keywords[0],
        ...(keywords.length > 1 ? [keywords.slice(0, 2).join(' ')] : [])
    ];

    for (const lang of ['fr', 'en']) {
        for (const query of searchQueries.slice(0, 2)) {
            try {
                const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch="${encodeURIComponent(query)}"&format=json&origin=*&srlimit=3`;
                const res = await fetch(url, { headers: API_HEADERS, timeout: 6000 });
                const data = await res.json();
                
                if (data.query?.search?.length > 0) {
                    for (const article of data.query.search.slice(0, 2)) {
                        const titleLower = article.title.toLowerCase();
                        const snippetLower = article.snippet.toLowerCase();
                        const keywordsLower = keywords.map(k => k.toLowerCase());
                        
                        let relevanceScore = 0;
                        keywordsLower.forEach(kw => {
                            if (titleLower.includes(kw)) relevanceScore += 0.4;
                            if (snippetLower.includes(kw)) relevanceScore += 0.2;
                        });
                        
                        if (relevanceScore >= 0.3) {
                            let reliabilityBonus = 0;
                            const snippet = article.snippet.toLowerCase();
                            
                            if (snippet.includes('selon') || snippet.includes('d\'après') || snippet.includes('étude')) {
                                reliabilityBonus += 0.05;
                            }
                            if (snippet.includes('références') || snippet.includes('source')) {
                                reliabilityBonus += 0.05;
                            }
                            if (article.title.toLowerCase().includes(keywords[0].toLowerCase())) {
                                reliabilityBonus += 0.10;
                            }
                            
                            const finalReliability = (lang === 'fr' ? 0.82 : 0.85) + reliabilityBonus;
                            const finalRelevance = Math.min(relevanceScore + reliabilityBonus, 0.95);
                            
                            sources.push({
                                title: `Wikipedia (${lang.toUpperCase()}): ${article.title}`,
                                url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(article.title.replace(/ /g, '_'))}`,
                                snippet: article.snippet.replace(/<[^>]*>/g, '').substring(0, 200) + '...',
                                reliability: Math.min(finalReliability, 0.95),
                                relevance: finalRelevance,
                                sourceCategory: 'encyclopedia',
                                qualityIndicators: {
                                    titleMatch: article.title.toLowerCase().includes(keywords[0].toLowerCase()),
                                    hasReferences: snippet.includes('références') || snippet.includes('source'),
                                    hasCitations: snippet.includes('selon') || snippet.includes('d\'après')
                                }
                            });
                        }
                    }
                }
            } catch (e) {
                console.warn(`Wiki ${lang} erreur:`, e.message);
            }
        }
    }

    const uniqueSources = Array.from(
        new Map(sources.map(s => [s.title, s])).values()
    ).sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

    return uniqueSources.slice(0, 6);
}

function getContextualOfficialSources(text, keywords) {
    const sources = [];
    const textLower = text.toLowerCase();
    const allText = keywords.join(' ').toLowerCase() + ' ' + textLower;
    
    if (allText.includes('marie') && allText.includes('curie')) {
        sources.push({
            title: "Nobel Prize: Marie Curie - Prix Nobel de Physique 1903",
            url: "https://www.nobelprize.org/prizes/physics/1903/marie-curie/facts/",
            snippet: "Marie Curie (1867-1934) fut la première femme à recevoir un Prix Nobel en 1903 pour ses travaux pionniers sur la radioactivité avec Pierre Curie et Henri Becquerel.",
            reliability: 0.98,
            relevance: 0.95,
            sourceCategory: 'primary',
            isOfficialData: true
        });
    }

    if ((allText.includes('population') || allText.includes('habitants') || allText.includes('démographie')) && 
        (allText.includes('france') || allText.includes('français'))) {
        sources.push({
            title: "INSEE - Population française officielle 2024",
            url: "https://www.insee.fr/fr/statistiques/1893198",
            snippet: "La France compte 68,1 millions d'habitants au 1er janvier 2024 selon l'INSEE. Population métropolitaine: 65,6 millions, DOM: 2,2 millions, COM: 0,3 millions.",
            reliability: 0.99,
            relevance: 0.92,
            sourceCategory: 'primary',
            isOfficialData: true
        });
    }

    if (allText.includes('giec') || allText.includes('climat') || allText.includes('réchauffement') || allText.includes('température')) {
        sources.push({
            title: "GIEC - 6e Rapport d'évaluation sur le climat (2023)",
            url: "https://www.ipcc.ch/report/ar6/syr/",
            snippet: "Le réchauffement planétaire atteint +1.1°C par rapport à 1850-1900. Les activités humaines sont responsables du réchauffement observé (confiance très élevée).",
            reliability: 0.97,
            relevance: 0.90,
            sourceCategory: 'scientific',
            isOfficialData: true
        });
    }

    if (allText.includes('covid') || allText.includes('coronavirus') || allText.includes('vaccin') || allText.includes('pandémie')) {
        sources.push({
            title: "OMS - COVID-19 Données officielles",
            url: "https://covid19.who.int/",
            snippet: "Plus de 770 millions de cas confirmés et 6,9 millions de décès dans le monde selon l'OMS. Les vaccins ont évité des millions de décès.",
            reliability: 0.96,
            relevance: 0.88,
            sourceCategory: 'health',
            isOfficialData: true
        });
    }

    if ((allText.includes('pib') || allText.includes('croissance') || allText.includes('économie') || allText.includes('inflation')) && 
        allText.includes('france')) {
        sources.push({
            title: "INSEE - Comptes nationaux France",
            url: "https://www.insee.fr/fr/statistiques/",
            snippet: "PIB français: 2 794 milliards d'euros en 2023. Croissance: +0.9% en 2023. Inflation moyenne: 4.9% en 2023 selon l'INSEE.",
            reliability: 0.98,
            relevance: 0.85,
            sourceCategory: 'economic',
            isOfficialData: true
        });
    }
    
    return sources;
}


// ===================================================================================
// FONCTION DE SCORING MISE À JOUR
// ===================================================================================
function calculateRealScore(originalText, sources) {
    let finalScore = 0.15; // Score de base si aucune source majeure
    const totalSources = sources.length;
    const officialSources = sources.filter(s => s.isOfficialData);
    const wikiSources = sources.filter(s => s.sourceCategory === 'encyclopedia');

    console.log(`[SCORING] Début - ${totalSources} sources (${officialSources.length} off., ${wikiSources.length} wiki)`);

    if (officialSources.length > 0) {
        if (officialSources[0].relevance >= 0.75) {
            finalScore = 0.80; // Base pour source officielle très pertinente
            console.log('[SCORING] Source officielle pertinente -> 80%');
            if (officialSources.length >= 2) {
                finalScore += 0.10; // Bonus pour multiples sources officielles
            }
            if (new Set(sources.map(s => s.sourceCategory)).size >= 2) {
                finalScore += 0.08; // Bonus pour diversité
            }
        } else {
            finalScore = 0.65; // Source officielle mais moins pertinente
        }
    } else if (wikiSources.length > 0) {
        if (wikiSources.length >= 2) {
            finalScore = 0.65; // Plusieurs Wikipedia
            console.log('[SCORING] Plusieurs Wikipedia -> 65%');
        } else { // Un seul Wikipedia
            const wiki = wikiSources[0];
            const relevance = wiki.relevance || 0.5;
            const reliability = wiki.reliability || 0.8;

            // ***** MODIFICATION PRINCIPALE ICI *****
            if (relevance >= 0.8 && reliability >= 0.85) {
                finalScore = 0.75; // 75% pour une Wikipedia excellente et très fiable
                console.log('[SCORING] Wikipedia unique EXCELLENTE -> 75%');
            } else if (relevance >= 0.65) {
                finalScore = 0.65; // Wikipedia pertinente
                console.log('[SCORING] Wikipedia unique PERTINENTE -> 65%');
            } else {
                finalScore = 0.50; // Wikipedia standard
                console.log('[SCORING] Wikipedia unique STANDARD -> 50%');
            }
        }
    } else {
        finalScore = 0.25; // Sources alternatives
    }

    // Ajustements finaux
    if (totalSources <= 1 && officialSources.length === 0) {
        finalScore -= 0.10;
    }
    if (totalSources >= 5) {
        finalScore += 0.05;
    }

    finalScore = Math.max(0.15, Math.min(0.95, finalScore));
    console.log(`[SCORING] Score final: ${Math.round(finalScore * 100)}%`);

    let explanation = `Score: ${Math.round(finalScore * 100)}%. `;
    if (finalScore >= 0.75) {
        explanation += "**Très bonne fiabilité** basée sur des sources officielles ou encyclopédiques de haute qualité.";
    } else if (finalScore >= 0.60) {
        explanation += "**Fiabilité correcte** soutenue par plusieurs sources pertinentes.";
    } else {
        explanation += "**Fiabilité limitée** due au manque de sources concordantes ou de haute qualité.";
    }

    return { score: finalScore, explanation };
}

// ... (Le reste du fichier : performFactCheck, routes API, etc. reste identique) ...
async function performFactCheck(text) {
    console.log('[FACT-CHECK] Début analyse:', text.substring(0, 100));
    
    const keywords = extractPreciseKeywords(text);
    
    if (keywords.length === 0) {
        return {
            overallConfidence: 0.18,
            sources: [],
            extractedKeywords: [],
            scoringExplanation: "Aucun élément factuel identifiable dans ce texte."
        };
    }
    
    console.log('[FACT-CHECK] Mots-clés:', keywords);
    
    const [wikiSources, officialSources] = await Promise.all([
        searchWikipediaFixed(keywords).catch(e => { console.error('Wiki error:', e); return []; }),
        Promise.resolve(getContextualOfficialSources(text, keywords))
    ]);
    
    console.log('[FACT-CHECK] Sources trouvées - Wiki:', wikiSources.length, 'Officielles:', officialSources.length);
    
    const allSources = [...officialSources, ...wikiSources];
    const uniqueSources = Array.from(
        new Map(allSources.map(s => [s.url, s])).values()
    ).slice(0, 10);
    
    const { score, explanation } = calculateRealScore(text, uniqueSources);
    
    return {
        overallConfidence: score,
        sources: uniqueSources,
        extractedKeywords: keywords,
        scoringExplanation: explanation
    };
}

app.get("/", (req, res) => res.send("✅ Fact-Checker API v3.3 - Scoring 75% OK"));

app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.length < 8) {
            return res.status(400).json({ error: 'Texte trop court ou invalide' });
        }
        
        console.log('[API] Nouvelle vérification:', text.length, 'caractères');
        const result = await performFactCheck(text);
        console.log('[API] Résultat:', result.overallConfidence, result.sources.length, 'sources');
        
        res.json(result);
    } catch (error) {
        console.error("Erreur vérification:", error);
        res.json({
            overallConfidence: 0.20,
            sources: [],
            extractedKeywords: [],
            scoringExplanation: "Erreur lors de l'analyse. Réessayez dans quelques instants."
        });
    }
});

app.post('/feedback', async (req, res) => {
    const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
    try {
        const client = await pool.connect();
        await client.query(
            `INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found) VALUES($1,$2,$3,$4,$5)`,
            [originalText?.substring(0,5000), scoreGiven, isUseful, comment, JSON.stringify(sourcesFound)]
        );
        client.release();
        console.log('[FEEDBACK] Reçu:', isUseful ? 'Utile' : 'Pas utile', comment ? '+ commentaire' : '');
        res.json({ success: true });
    } catch (err) {
        console.error('Erreur feedback:', err);
        res.status(500).json({ error: 'Erreur sauvegarde feedback' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fact-Checker v3.3 port ${PORT} - Prêt`);
});
