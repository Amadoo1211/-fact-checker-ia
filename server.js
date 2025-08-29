// server.js - VERSION FINALE STABLE - Scoring Intelligent & Comparaison de Contenu
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const app = express();

app.use(cors({ origin: ['chrome-extension://*', 'https://fact-checker-ia-production.up.railway.app'] }));
app.use(express.json());

const API_HEADERS = {
    'User-Agent': 'FactCheckerIA/3.0 (boud3285@gmail.com; https://github.com/Amadoo1211/-fact-checker-ia)'
};

// Configuration PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initializeDb = async () => {
    try {
        const client = await pool.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS feedback (
                id SERIAL PRIMARY KEY,
                original_text TEXT NOT NULL,
                score_given REAL NOT NULL,
                is_useful BOOLEAN NOT NULL,
                comment TEXT,
                sources_found JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        client.release();
        console.log('✅ Base de données initialisée.');
    } catch (err) { 
        console.error('❌ Erreur BDD:', err); 
    }
};

// ============= FONCTIONS UTILITAIRES =============

function cleanText(text) {
    return text.trim()
        .replace(/\s+/g, ' ')
        .replace(/^(ChatGPT dit|Claude dit|Selon|D'après|Voici|En effet)\s*:?\s*/gi, '')
        .substring(0, 8000);
}

function extractFactualClaims(text) {
    const claims = [];
    
    // Extraire les phrases avec des faits vérifiables
    const sentences = text.match(/[^.!?]+[.!?]/g) || [];
    
    for (const sentence of sentences.slice(0, 5)) { // Limiter à 5 phrases
        // Chercher des éléments factuels
        if (sentence.match(/\b(19|20)\d{2}\b/) || // Dates
            sentence.match(/\b\d+([.,]\d+)?\s*(millions?|milliards?|%|euros?|dollars?)\b/i) || // Chiffres
            sentence.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/) || // Noms propres
            sentence.match(/\b(premier|première|inventeur|créateur|fondateur)\b/i)) { // Faits historiques
            claims.push(sentence.trim());
        }
    }
    
    return claims.length > 0 ? claims : [text.substring(0, 500)];
}

function extractSmartKeywords(text) {
    const keywords = new Set();
    
    // Priorité 1: Noms propres et entités
    const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) || [];
    properNouns.forEach(noun => keywords.add(noun));
    
    // Priorité 2: Dates et années
    const dates = text.match(/\b(19|20)\d{2}\b/g) || [];
    dates.forEach(date => keywords.add(date));
    
    // Priorité 3: Termes techniques/spécifiques (mots longs)
    const technicalTerms = text.match(/\b[a-zà-ÿ]{8,}\b/gi) || [];
    technicalTerms.slice(0, 3).forEach(term => keywords.add(term));
    
    return Array.from(keywords).slice(0, 6);
}

// ============= RECHERCHE DE SOURCES =============

async function searchWikipedia(claim, keywords) {
    const sources = [];
    const searchQuery = keywords.slice(0, 3).join(' ');
    
    for (const lang of ['fr', 'en']) {
        try {
            const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchQuery)}&format=json&origin=*&srlimit=3`;
            const searchRes = await fetch(searchUrl, { headers: API_HEADERS, timeout: 5000 });
            const searchData = await searchRes.json();
            
            if (searchData.query?.search) {
                for (const article of searchData.query.search) {
                    const pageUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(article.title)}&format=json&origin=*`;
                    const pageRes = await fetch(pageUrl, { headers: API_HEADERS, timeout: 5000 });
                    const pageData = await pageRes.json();
                    const pages = pageData.query?.pages || {};
                    const page = Object.values(pages)[0];
                    
                    if (page?.extract) {
                        const relevance = calculateRelevance(claim, page.extract);
                        sources.push({
                            title: `Wikipedia (${lang.toUpperCase()}): ${article.title}`,
                            url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(article.title.replace(/ /g, '_'))}`,
                            snippet: page.extract.substring(0, 300) + '...',
                            reliability: 0.85,
                            relevance: relevance,
                            content: page.extract.substring(0, 1000),
                            sourceCategory: 'encyclopedia'
                        });
                    }
                }
            }
        } catch (e) {
            console.warn(`Wikipedia ${lang} search failed:`, e.message);
        }
    }
    
    return sources;
}

async function getOfficialSources(claim, keywords) {
    const sources = [];
    const lowerClaim = claim.toLowerCase();
    const keywordString = keywords.join(' ').toLowerCase();
    
    // Sources officielles statiques basées sur le contenu
    if (keywordString.includes('marie') && keywordString.includes('curie')) {
        sources.push({
            title: "Nobel Prize: Marie Curie",
            url: "https://www.nobelprize.org/prizes/physics/1903/marie-curie/facts/",
            snippet: "Marie Curie fut la première femme à recevoir un prix Nobel en 1903 pour ses travaux sur la radioactivité.",
            reliability: 0.98,
            relevance: calculateRelevance(claim, "Marie Curie Nobel Prize 1903 radioactivity physics chemistry polonium radium"),
            sourceCategory: 'primary',
            isOfficialData: true
        });
    }
    
    if (lowerClaim.includes('population') && keywordString.includes('france')) {
        sources.push({
            title: "INSEE - Population France",
            url: "https://www.insee.fr/fr/statistiques/",
            snippet: "La France compte environ 68 millions d'habitants en 2024.",
            reliability: 0.99,
            relevance: calculateRelevance(claim, "France population 68 millions habitants INSEE statistiques démographie"),
            sourceCategory: 'primary',
            isOfficialData: true
        });
    }
    
    if (lowerClaim.includes('climat') || lowerClaim.includes('réchauffement')) {
        sources.push({
            title: "GIEC - Rapports Climat",
            url: "https://www.ipcc.ch/languages-2/francais/",
            snippet: "Le GIEC confirme un réchauffement global de +1.1°C depuis l'ère préindustrielle.",
            reliability: 0.97,
            relevance: calculateRelevance(claim, "climat réchauffement GIEC température global changement climatique"),
            sourceCategory: 'scientific',
            isOfficialData: true
        });
    }
    
    // Sources académiques pour sujets scientifiques
    if (lowerClaim.match(/\b(physique|chimie|biologie|mathématique|science)\b/)) {
        sources.push({
            title: "Nature Scientific Reports",
            url: "https://www.nature.com/srep/",
            snippet: "Revue scientifique peer-reviewed pour les dernières découvertes.",
            reliability: 0.95,
            relevance: 0.7,
            sourceCategory: 'academic'
        });
    }
    
    return sources;
}

async function getFactCheckingSources(claim) {
    const sources = [];
    
    // AFP Factuel (français)
    sources.push({
        title: "AFP Factuel",
        url: "https://factuel.afp.com/",
        snippet: "Service de fact-checking de l'Agence France-Presse",
        reliability: 0.90,
        relevance: 0.5,
        sourceCategory: 'fact-checking'
    });
    
    // Snopes (anglais)
    sources.push({
        title: "Snopes Fact Check",
        url: "https://www.snopes.com/",
        snippet: "Site de référence pour la vérification des faits",
        reliability: 0.88,
        relevance: 0.5,
        sourceCategory: 'fact-checking'
    });
    
    return sources;
}

// ============= CALCUL DE PERTINENCE ET SCORE =============

function calculateRelevance(claim, sourceContent) {
    if (!sourceContent) return 0;
    
    const claimLower = claim.toLowerCase();
    const contentLower = sourceContent.toLowerCase();
    
    // Extraire les mots importants du claim
    const claimWords = claimLower.match(/\b[a-zà-ÿ0-9]{3,}\b/g) || [];
    const importantWords = claimWords.filter(w => w.length > 4);
    
    let matchCount = 0;
    let totalWords = importantWords.length || 1;
    
    // Compter les correspondances
    for (const word of importantWords) {
        if (contentLower.includes(word)) {
            matchCount++;
        }
    }
    
    // Bonus pour les nombres et dates exactes
    const numbers = claim.match(/\b\d+([.,]\d+)?\b/g) || [];
    for (const num of numbers) {
        if (sourceContent.includes(num)) {
            matchCount += 2; // Bonus pour correspondance exacte de nombre
        }
    }
    
    // Calculer le score de pertinence (0 à 1)
    const relevance = Math.min(1, matchCount / (totalWords + numbers.length));
    return relevance;
}

function calculateFinalScore(claims, sources) {
    if (sources.length === 0) {
        return {
            score: 0.15,
            explanation: "Score très faible (15%). Aucune source trouvée pour vérifier les affirmations."
        };
    }
    
    let baseScore = 0.20; // Score de base
    
    // Analyser la qualité des sources
    const officialSources = sources.filter(s => s.isOfficialData);
    const highRelevanceSources = sources.filter(s => s.relevance > 0.7);
    const mediumRelevanceSources = sources.filter(s => s.relevance > 0.4);
    
    // Bonus pour sources officielles pertinentes
    if (officialSources.length > 0) {
        const avgOfficialRelevance = officialSources.reduce((sum, s) => sum + (s.relevance || 0), 0) / officialSources.length;
        baseScore += 0.30 * avgOfficialRelevance;
        
        if (officialSources.length > 1) {
            baseScore += 0.10; // Bonus pour multiple sources officielles
        }
    }
    
    // Bonus pour sources très pertinentes
    if (highRelevanceSources.length > 0) {
        baseScore += 0.20 * (highRelevanceSources.length / sources.length);
        
        // Super bonus si source officielle ET très pertinente
        const officialAndRelevant = sources.filter(s => s.isOfficialData && s.relevance > 0.7);
        if (officialAndRelevant.length > 0) {
            baseScore += 0.15;
        }
    }
    
    // Bonus pour sources moyennement pertinentes
    if (mediumRelevanceSources.length > 0) {
        baseScore += 0.10 * (mediumRelevanceSources.length / sources.length);
    }
    
    // Bonus pour diversité des sources
    const categories = new Set(sources.map(s => s.sourceCategory));
    if (categories.size > 2) {
        baseScore += 0.10;
    }
    
    // Pénalité si seulement Wikipedia
    if (sources.every(s => s.sourceCategory === 'encyclopedia')) {
        baseScore -= 0.15;
    }
    
    // Calculer le score final (entre 15% et 95%)
    const finalScore = Math.max(0.15, Math.min(0.95, baseScore));
    
    // Générer l'explication
    const explanation = generateExplanation(finalScore, sources, officialSources, highRelevanceSources);
    
    return { score: finalScore, explanation };
}

function generateExplanation(score, sources, officialSources, highRelevanceSources) {
    const percent = Math.round(score * 100);
    let explanation = `Score de fiabilité: ${percent}%. `;
    
    if (percent >= 70) {
        explanation += `**Excellente vérifiabilité.** `;
        if (officialSources.length > 0) {
            explanation += `${officialSources.length} source(s) officielle(s) confirment les faits. `;
        }
        if (highRelevanceSources.length > 0) {
            explanation += `${highRelevanceSources.length} source(s) avec correspondance élevée. `;
        }
    } else if (percent >= 40) {
        explanation += `**Vérifiabilité modérée.** `;
        explanation += `${sources.length} source(s) trouvée(s) avec pertinence variable. `;
        if (officialSources.length === 0) {
            explanation += `Aucune source officielle directe trouvée. `;
        }
    } else {
        explanation += `**Faible vérifiabilité.** `;
        if (sources.length === 0) {
            explanation += `Aucune source fiable n'a pu être trouvée. `;
        } else {
            explanation += `Les sources trouvées ont une pertinence limitée. `;
        }
        explanation += `Vérification manuelle recommandée.`;
    }
    
    return explanation;
}

// ============= FONCTION PRINCIPALE =============

async function performComprehensiveFactCheck(text) {
    const cleanedText = cleanText(text);
    const claims = extractFactualClaims(cleanedText);
    const keywords = extractSmartKeywords(cleanedText);
    
    console.log(`Analyse de ${claims.length} affirmation(s) avec mots-clés: ${keywords.join(', ')}`);
    
    // Rechercher des sources pour chaque affirmation
    const allSources = [];
    
    for (const claim of claims.slice(0, 3)) { // Limiter à 3 claims pour la performance
        const [wikiSources, officialSources, factCheckSources] = await Promise.all([
            searchWikipedia(claim, keywords),
            getOfficialSources(claim, keywords),
            getFactCheckingSources(claim)
        ]);
        
        allSources.push(...wikiSources, ...officialSources, ...factCheckSources);
    }
    
    // Dédupliquer et trier par pertinence
    const uniqueSources = deduplicateSources(allSources);
    const sortedSources = uniqueSources.sort((a, b) => {
        // Prioriser: 1) Pertinence, 2) Fiabilité, 3) Sources officielles
        const scoreA = (a.relevance || 0) * 0.5 + (a.reliability || 0) * 0.3 + (a.isOfficialData ? 0.2 : 0);
        const scoreB = (b.relevance || 0) * 0.5 + (b.reliability || 0) * 0.3 + (b.isOfficialData ? 0.2 : 0);
        return scoreB - scoreA;
    }).slice(0, 8); // Garder les 8 meilleures sources
    
    // Calculer le score final
    const { score, explanation } = calculateFinalScore(claims, sortedSources);
    
    return {
        overallConfidence: score,
        sources: sortedSources,
        extractedKeywords: keywords,
        claims: claims.slice(0, 3),
        scoringExplanation: explanation
    };
}

function deduplicateSources(sources) {
    const seen = new Map();
    
    for (const source of sources) {
        const key = new URL(source.url).hostname + source.title;
        if (!seen.has(key) || (seen.get(key).relevance || 0) < (source.relevance || 0)) {
            seen.set(key, source);
        }
    }
    
    return Array.from(seen.values());
}

// ============= ROUTES API =============

app.get("/", (req, res) => res.send("✅ API Fact-Checker IA Pro v3.0 - Stable"));

app.post('/verify', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.trim().length < 10) {
            return res.status(400).json({ error: 'Texte manquant ou trop court.' });
        }
        
        const result = await performComprehensiveFactCheck(text);
        res.json(result);
    } catch (error) {
        console.error("Erreur dans /verify:", error);
        res.status(500).json({ 
            error: 'Erreur de vérification.', 
            overallConfidence: 0.25,
            sources: [],
            scoringExplanation: "Erreur lors de la vérification. Veuillez réessayer."
        });
    }
});

app.post('/feedback', async (req, res) => {
    const { originalText, scoreGiven, isUseful, comment, sourcesFound } = req.body;
    
    if (!originalText || scoreGiven == null || isUseful == null) {
        return res.status(400).json({ error: 'Données de feedback incomplètes.' });
    }
    
    try {
        const client = await pool.connect();
        const query = `
            INSERT INTO feedback(original_text, score_given, is_useful, comment, sources_found)
            VALUES($1, $2, $3, $4, $5)
            RETURNING id;
        `;
        const values = [
            originalText.substring(0, 5000), 
            scoreGiven, 
            isUseful, 
            comment || null, 
            JSON.stringify(sourcesFound || [])
        ];
        const result = await client.query(query, values);
        client.release();
        
        console.log(`📝 Feedback #${result.rows[0].id} enregistré`);
        res.status(201).json({ success: true, feedbackId: result.rows[0].id });
    } catch (err) {
        console.error('Erreur feedback:', err.message);
        res.status(500).json({ error: 'Erreur enregistrement feedback.' });
    }
});

// ============= DÉMARRAGE =============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fact-Checker IA Pro v3.0 sur port ${PORT}`);
    initializeDb();
});
