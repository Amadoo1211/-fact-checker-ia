# 🧠 VerifyAI – Serveur de Vérification de Faits (v2.3)

**VerifyAI** est une API Node.js/Express conçue pour évaluer automatiquement la **fiabilité d’un texte**.  
Elle alimente l’extension Chrome VerifyAI et compare les informations fournies avec des **sources web fiables** grâce à un moteur de fact-checking complet, sans recours à d’agents IA externes.

---

## ⚙️ Fonctionnement général

Le fichier principal `server.js` agit comme le **backend central** de VerifyAI.  
Il :

- Reçoit les requêtes de l’extension Chrome ou d’applications clientes via `/verify` ou `/verify/ai`  
- Analyse le texte transmis : extraction des faits, mots-clés, données chiffrées, etc.  
- Interroge le Web (via l’API Google Custom Search) pour trouver des **sources pertinentes et fiables**  
- Évalue la **cohérence, le consensus, la crédibilité et la fraîcheur** des sources trouvées  
- Calcule un **score global de fiabilité** et une étiquette (“Highly Reliable”, “Uncertain”, etc.)  
- Met en cache les résultats pour accélérer les vérifications suivantes  
- Enregistre le feedback utilisateur dans PostgreSQL (si disponible)

---

## 🧩 Rôle de `server.js`

`server.js` est le **noyau serveur** de VerifyAI.  
Il gère :

| Composant | Description |
|------------|-------------|
| **API Express** | Fournit les endpoints `/verify`, `/verify/ai`, `/compare/ai`, `/feedback`, et `/health`. |
| **Analyse de texte** | Extraction d’affirmations vérifiables, de mots-clés et de contextes (géographiques, temporels, etc.). |
| **Vérification Web** | Recherche automatique de sources crédibles via Google Custom Search. |
| **Évaluation contextuelle** | Détection de contradictions, calcul de consensus et de diversité des sources. |
| **Système de cache** | Limite les appels redondants et accélère les analyses. |
| **Base de données (PostgreSQL)** | Stocke les feedbacks utilisateurs et sondages VerifyAI Pro. |
| **Sécurité et limitations** | Filtrage CORS, limiteur de requêtes et nettoyage d’entrée pour éviter les abus. |

---

## 🚀 Principaux endpoints API

### `POST /verify`

Analyse un texte libre et renvoie un score de fiabilité.

**Exemple d’appel :**
```json
{
  "text": "La population de Tokyo dépasse 14 millions d’habitants."
}
```
**Exemple de réponse :**
```json
{
  "overallConfidence": 0.87,
  "reliabilityLabel": "Highly Reliable",
  "sources": [
    { "url": "https://en.wikipedia.org/wiki/Tokyo", "credibilityTier": "tier1", "actuallySupports": true }
  ],
  "keywords": ["Tokyo", "population", "14 millions"],
  "scoringExplanation": "Fait géographique avec sources officielles récentes (+87%)"
}
```

### `POST /verify/ai`

Spécifique à l’extension VerifyAI.  
Permet d’analyser la réponse d’un modèle d’IA (ChatGPT, Claude, Gemini, etc.) pour en évaluer la fiabilité.

**Exemple :**
```json
{
  "model": "ChatGPT",
  "prompt": "Quel est le PIB de la France ?",
  "response": "Le PIB de la France est d’environ 2,9 billions de dollars."
}
```
**Retour :**
```json
{
  "modelAnalyzed": "ChatGPT",
  "reliabilityLabel": "Mostly Reliable",
  "reliabilityScore": 0.74,
  "sources": [...],
  "reasoningSummary": "Données économiques cohérentes avec sources officielles."
}
```

### `POST /compare/ai`

Compare plusieurs réponses de modèles d’IA sur un même prompt.

**Exemple :**
```json
{
  "prompt": "Quelle est la capitale du Canada ?",
  "responses": {
    "ChatGPT": "Ottawa",
    "Gemini": "Toronto"
  }
}
```
**Retour :**
```json
{
  "success": true,
  "bestModel": "ChatGPT",
  "comparison": [
    { "model": "ChatGPT", "score": 0.92 },
    { "model": "Gemini", "score": 0.45 }
  ]
}
```

### `POST /feedback`

Permet à l’extension ou à l’utilisateur de transmettre un retour sur les analyses.  
Stocke les retours dans PostgreSQL (table `feedback`).  
Peut aussi collecter les réponses au sondage VerifyAI Pro (table `pro_survey`).

### `GET /health`

Renvoie l’état du serveur et les fonctionnalités actives.

```json
{
  "status": "ok",
  "version": "VERIFYAI-SERVER-2.3",
  "features": ["balanced_scoring", "contextual_analysis", "intelligent_contradictions"],
  "api_configured": true
}
```

---

## 🔑 Configuration (`.env`)

```
# Clés API Google Custom Search
GOOGLE_API_KEY=your_google_api_key
SEARCH_ENGINE_ID=your_cse_id

# Base de données (optionnelle)
DATABASE_URL=postgres://user:password@host:port/dbname

# Environnement
NODE_ENV=production
PORT=3000
```

---

## ⚙️ Lancer le serveur

```
npm install
npm start
```

- Le serveur écoute sur `http://localhost:3000`
- Logs colorés en mode développement
- Reconnexion automatique à la base PostgreSQL si disponible

---

## 🧠 Méthodologie d’analyse

VerifyAI applique un système équilibré combinant plusieurs étapes :

1. Extraction des faits → détection des données chiffrées, noms, dates, lieux
2. Analyse du contenu → différenciation entre faits, opinions et questions
3. Recherche web intelligente → Google Custom Search filtrée par crédibilité des domaines
4. Évaluation de cohérence → comparaison sémantique, contradictions et contexte
5. Scoring final → calcul pondéré de fiabilité, entre 0 et 1

---

## 🧰 Outils internes

- **ImprovedFactChecker** : cœur du moteur de scoring
- **NodeCache** : cache mémoire avec TTL
- **express-rate-limit** : anti-abus
- **string-similarity** : mesure de similarité lexicale
- **pg** : gestion PostgreSQL

---

## 📊 Endpoints de diagnostic

| Endpoint | Description |
|----------|-------------|
| `/metrics` | Donne le nombre total de requêtes, les hits cache, et l’uptime |
| `/health` | Vérifie la configuration et la disponibilité du serveur |

---

## 🧩 Intégration Chrome Extension

L’extension VerifyAI envoie directement les textes ou réponses d’IA au serveur via `/verify` ou `/verify/ai`.  
Les résultats (score, fiabilité, sources, etc.) sont ensuite affichés sous forme de badges et d’alertes de confiance dans le navigateur.
