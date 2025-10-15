# Otto Fact Checker – Explications en français

Cette application Node.js/Express expose une API dédiée au fact-checking qui s'appuie sur quatre agents IA "Otto" ainsi qu'un moteur de vérification plus classique. Elle permet d'auditer un texte, de noter sa fiabilité et de qualifier les sources utilisées.

## Aperçu des agents Otto

| Agent | Rôle | Sortie principale |
|-------|------|-------------------|
| Fact Checker | Distingue les affirmations vérifiées des affirmations fausses ou invérifiables. Il signale aussi toute référence inventée (hallucination). | Score global de fiabilité, listes `verified_claims`, `unverified_claims`, `hallucinated_references` |
| Source Analyst | Vérifie que chaque source existe, est crédible et soutient bien l'affirmation citée. | `real_sources`, `fake_sources`, score de qualité |
| Context Guardian | Repère les informations ou contextes manquants afin de signaler les biais ou omissions potentielles. | `context_score`, `omissions`, détection de manipulation |
| Freshness Detector | Indique si les données mentionnées sont récentes ou obsolètes. | `freshness_score`, `recent_data`, `outdated_data` |

Les quatre agents sont exécutés en parallèle depuis `AIAgentsService.runAllAgents`. La réponse agrégée réunit leurs analyses pour être restituée au frontend.

## Calcul du score et logique de vérification

1. **Extraction des affirmations vérifiables** : l'algorithme identifie chiffres, dates, références géographiques et scientifiques (`ImprovedFactChecker.extractVerifiableClaims`).
2. **Analyse du type de contenu** : on distingue opinion, question, article factuel, etc. pour fixer un score de base.
3. **Évaluation des sources** : les sources sont classées par niveau de crédibilité et leur soutien/contradiction vis-à-vis du texte ajuste le score (`evaluateSourceQuality`).
4. **Consensus et cohérence contextuelle** : on ajoute ou retire des points selon le consensus entre sources et la diversité des domaines (`evaluateConsensus`, `evaluateContextualCoherence`).
5. **Score équilibré** : l'ensemble produit un score final pondéré accompagné d'une justification détaillée.

Chaque agent retourne exclusivement du JSON. En cas d'échec d'appel à l'API OpenAI ou de réponse mal formatée, une valeur de secours est renvoyée afin d'éviter les erreurs côté client.

## Configuration

- **Clé OpenAI** : `OPENAI_API_KEY`
- **Base de données PostgreSQL** : `DATABASE_URL`
- **Stripe** (optionnel) : `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET`

Les clés d'environnement peuvent être définies dans un fichier `.env` (ignoré par Git) ou dans votre système d'hébergement.

## Lancer le serveur

```bash
npm install
npm start
```

Le serveur écoute par défaut sur le port défini dans `process.env.PORT` ou sur `3000` et expose les routes Express décrites dans `server.js`.

## Réinitialisation des mots de passe

- Endpoint temporaire : `POST /admin/reset-password` requiert `adminEmail`, `adminSecret`, `targetEmail` et `newPassword`. Par sécurité, supprimez ou désactivez cette route après utilisation.
- Script CLI : `node scripts/reset-passwords.js email1=nouveauMotDePasse1 email2=nouveauMotDePasse2` met à jour en base les comptes indiqués (ou utilisez `--file resets.json` avec un tableau d'objets `{ "email": "...", "password": "..." }`).

