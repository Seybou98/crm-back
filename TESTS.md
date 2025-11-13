# Guide de test pour YouSign et GoCardless

Ce document explique comment utiliser les endpoints de test pour vérifier les intégrations YouSign et GoCardless.

## Prérequis

1. Assurez-vous que le serveur backend est démarré :
```bash
cd gocardless-backend
npm run dev
```

2. Vérifiez que votre fichier `.env` contient les clés nécessaires :
```env
YOUSIGN_API_KEY=your_yousign_api_key_here
YOUSIGN_API_URL=https://api-sandbox.yousign.app
GOCARDLESS_ACCESS_TOKEN=your_gocardless_access_token_here
GOCARDLESS_CREDITOR_ID=your_gocardless_creditor_id_here
NODE_ENV=development
```

## Tests YouSign

### 1. Test de connexion YouSign

Teste la connexion à l'API YouSign et vérifie que les clés sont correctes.

**Endpoint:** `GET http://localhost:3002/test/yousign/connection`

**Exemple de requête:**
```bash
curl http://localhost:3002/test/yousign/connection
```

**Réponse attendue:**
```json
{
  "success": true,
  "message": "Connexion YouSign réussie",
  "url": "https://api-sandbox.yousign.app/v3",
  "status": 200,
  "data": {...}
}
```

### 2. Test de création de demande de signature

Crée une demande de signature de test pour vérifier que l'API fonctionne correctement.

**Endpoint:** `POST http://localhost:3002/test/yousign/create-request`

**Exemple de requête:**
```bash
curl -X POST http://localhost:3002/test/yousign/create-request
```

**Réponse attendue:**
```json
{
  "success": true,
  "message": "Demande de signature créée avec succès",
  "signatureRequestId": "xxx",
  "data": {...}
}
```

## Tests GoCardless

### 1. Test de connexion GoCardless

Teste la connexion à l'API GoCardless et vérifie que les clés sont correctes.

**Endpoint:** `GET http://localhost:3002/test/gocardless/connection`

**Exemple de requête:**
```bash
curl http://localhost:3002/test/gocardless/connection
```

**Réponse attendue:**
```json
{
  "success": true,
  "message": "Connexion GoCardless réussie",
  "url": "https://api-sandbox.gocardless.com",
  "status": 200,
  "creditor": {...}
}
```

### 2. Test de création de customer

Crée un customer de test pour vérifier que l'API fonctionne correctement.

**Endpoint:** `POST http://localhost:3002/test/gocardless/create-customer`

**Exemple de requête:**
```bash
curl -X POST http://localhost:3002/test/gocardless/create-customer
```

**Réponse attendue:**
```json
{
  "success": true,
  "message": "Customer créé avec succès",
  "customerId": "CU01K9VRJCC73P9N19MG7YTPY9TN",
  "customer": {...}
}
```

### 3. Test de création de compte bancaire

Crée un compte bancaire de test pour vérifier que l'API fonctionne correctement.

**Endpoint:** `POST http://localhost:3002/test/gocardless/create-bank-account`

**Body:**
```json
{
  "customerId": "CU01K9VRJCC73P9N19MG7YTPY9TN",
  "accountHolderName": "Test User",
  "iban": "FR1420010101150500013M02606"
}
```

**Exemple de requête:**
```bash
curl -X POST http://localhost:3002/test/gocardless/create-bank-account \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CU01K9VRJCC73P9N19MG7YTPY9TN",
    "accountHolderName": "Test User",
    "iban": "FR1420010101150500013M02606"
  }'
```

**Réponse attendue:**
```json
{
  "success": true,
  "message": "Compte bancaire créé avec succès",
  "bankAccountId": "BA01K9VRJCC73P9N19MG7YTPY9TN",
  "bankAccount": {...}
}
```

### 4. Test de création de mandat complet

Crée un mandat complet de test (customer + compte bancaire + mandat) pour vérifier que l'API fonctionne correctement.

**Endpoint:** `POST http://localhost:3002/test/gocardless/create-mandate`

**Body:**
```json
{
  "accountHolderName": "Test User",
  "iban": "FR1420010101150500013M02606"
}
```

**Exemple de requête:**
```bash
curl -X POST http://localhost:3002/test/gocardless/create-mandate \
  -H "Content-Type: application/json" \
  -d '{
    "accountHolderName": "Test User",
    "iban": "FR1420010101150500013M02606"
  }'
```

**Réponse attendue:**
```json
{
  "success": true,
  "message": "Mandat créé avec succès",
  "customerId": "CU01K9VRJCC73P9N19MG7YTPY9TN",
  "bankAccountId": "BA01K9VRJCC73P9N19MG7YTPY9TN",
  "mandateId": "MD01K9VRJCC73P9N19MG7YTPY9TN",
  "mandate": {...}
}
```

## Utilisation avec Postman ou Thunder Client

1. Importez les endpoints dans Postman ou Thunder Client
2. Testez chaque endpoint dans l'ordre
3. Vérifiez les réponses et les logs du serveur

## Utilisation dans le navigateur

Vous pouvez aussi tester les endpoints GET dans le navigateur :

- `http://localhost:3002/test/yousign/connection`
- `http://localhost:3002/test/gocardless/connection`

## Notes importantes

1. **IBAN de test** : L'IBAN `FR1420010101150500013M02606` est un IBAN de test valide pour GoCardless sandbox. Il a 26 caractères, ce qui peut causer des erreurs de validation.

2. **Compte YouSign** : Assurez-vous que votre compte YouSign sandbox est actif et que la clé API est correcte.

3. **Compte GoCardless** : Assurez-vous que votre compte GoCardless sandbox est actif et que les clés sont correctes.

4. **Logs** : Tous les tests affichent des logs détaillés dans la console du serveur pour faciliter le débogage.

## Dépannage

### Erreur 404 YouSign
- Vérifiez que l'URL de l'API est correcte
- Vérifiez que la clé API est valide
- Vérifiez que le compte sandbox est actif

### Erreur 422 GoCardless
- Vérifiez que l'IBAN est valide (27 caractères pour la France)
- Vérifiez que le nom du titulaire n'est pas trop court
- Vérifiez les logs pour voir les erreurs de validation détaillées

### Erreur de connexion
- Vérifiez que le serveur backend est démarré
- Vérifiez que le port 3002 est disponible
- Vérifiez que les variables d'environnement sont correctement chargées

