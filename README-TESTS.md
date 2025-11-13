# Tests YouSign et GoCardless

## 📋 Résumé

J'ai créé des endpoints de test pour vérifier les intégrations YouSign et GoCardless. Ces tests permettent de diagnostiquer les problèmes de connexion et de validation.

## 🚀 Utilisation rapide

### 1. Démarrer le serveur
```bash
cd gocardless-backend
npm run dev
```

### 2. Tester YouSign

**Test de connexion :**
```bash
# Dans le navigateur ou avec curl
http://localhost:3002/test/yousign/connection
```

**Test de création de demande :**
```bash
# Avec curl
curl -X POST http://localhost:3002/test/yousign/create-request
```

### 3. Tester GoCardless

**Test de connexion :**
```bash
# Dans le navigateur ou avec curl
http://localhost:3002/test/gocardless/connection
```

**Test de création de customer :**
```bash
curl -X POST http://localhost:3002/test/gocardless/create-customer
```

**Test de création de compte bancaire :**
```bash
curl -X POST http://localhost:3002/test/gocardless/create-bank-account \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CU01K9VRJCC73P9N19MG7YTPY9TN",
    "accountHolderName": "Test User",
    "iban": "FR1420010101150500013M02606"
  }'
```

**Test de création de mandat complet :**
```bash
curl -X POST http://localhost:3002/test/gocardless/create-mandate \
  -H "Content-Type: application/json" \
  -d '{
    "accountHolderName": "Test User",
    "iban": "FR1420010101150500013M02606"
  }'
```

## 🔍 Endpoints disponibles

### YouSign

1. `GET /test/yousign/connection` - Test de connexion à l'API YouSign
2. `POST /test/yousign/create-request` - Créer une demande de signature de test

### GoCardless

1. `GET /test/gocardless/connection` - Test de connexion à l'API GoCardless
2. `POST /test/gocardless/create-customer` - Créer un customer de test
3. `POST /test/gocardless/create-bank-account` - Créer un compte bancaire de test
4. `POST /test/gocardless/create-mandate` - Créer un mandat complet de test

## 📝 Configuration requise

Assurez-vous que votre fichier `.env` contient :

```env
YOUSIGN_API_KEY=your_yousign_api_key_here
YOUSIGN_API_URL=https://api-sandbox.yousign.app
GOCARDLESS_ACCESS_TOKEN=your_gocardless_access_token_here
GOCARDLESS_CREDITOR_ID=your_gocardless_creditor_id_here
NODE_ENV=development
```

## 🐛 Dépannage

### Erreur 404 YouSign
- Vérifiez que l'URL de l'API est correcte
- Vérifiez que la clé API est valide
- Vérifiez que le compte sandbox est actif

### Erreur 422 GoCardless
- Vérifiez que l'IBAN est valide (27 caractères pour la France)
- Vérifiez que le nom du titulaire n'est pas trop court
- Consultez les logs pour voir les erreurs de validation détaillées

## 📊 Logs

Tous les tests affichent des logs détaillés dans la console du serveur :
- URL appelée
- Données envoyées
- Réponse reçue
- Erreurs de validation (si présentes)

## ✅ Réponse à votre question sur NODE_ENV

**`NODE_ENV: undefined` n'est pas un problème critique**, mais il est recommandé de le définir dans le fichier `.env` :

```env
NODE_ENV=development
```

Cela permet :
- De mieux gérer les environnements (développement, production, test)
- D'optimiser les performances en production
- De faciliter le débogage

Le code utilise déjà une valeur par défaut (`process.env.NODE_ENV || 'development'`), donc même si `NODE_ENV` n'est pas défini, l'application fonctionnera correctement.

