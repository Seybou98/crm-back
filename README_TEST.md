# 🧪 Guide de Test - Script de Prélèvements Automatiques

## ⚠️ Problème : Backend ou Firebase non disponible

Si vous voyez l'erreur :
```
❌ Erreur: Firebase non disponible. Assurez-vous que le backend est démarré ou configurez Firebase.
```

## ✅ Solutions

### Solution 1 : Démarrer le Backend (Recommandé)

```bash
# Terminal 1 : Démarrer le backend
cd gocardless-backend
npm start

# Terminal 2 : Lancer le test
cd gocardless-backend
node test-automatic-payments-quick.js [MAINTENANCE_ID] 12
```

### Solution 2 : Configurer Firebase dans le Script

Si vous ne pouvez pas démarrer le backend, configurez Firebase :

1. **Créer/Modifier le fichier `.env` dans `gocardless-backend/`** :
```env
VITE_FIREBASE_API_KEY=votre_api_key
VITE_FIREBASE_AUTH_DOMAIN=votre_auth_domain
VITE_FIREBASE_PROJECT_ID=votre_project_id
VITE_FIREBASE_STORAGE_BUCKET=votre_storage_bucket
VITE_FIREBASE_MESSAGING_SENDER_ID=votre_messaging_sender_id
VITE_FIREBASE_APP_ID=votre_app_id
```

2. **Relancer le script** :
```bash
node test-automatic-payments-quick.js [MAINTENANCE_ID] 12
```

## 🔍 Comment Trouver l'ID de Maintenance

### Méthode 1 : Dans l'URL
1. Ouvrez la page de détail d'une maintenance
2. L'URL ressemble à : `/maintenance/00PSWHQPyqsvx7qAyom1`
3. L'ID est la partie après `/maintenance/`

### Méthode 2 : Firebase Console
1. Allez sur https://console.firebase.google.com
2. Ouvrez votre projet → Firestore Database
3. Collection `maintenances`
4. L'ID est le nom du document (pas `gocardlessMandateId`)

### Méthode 3 : Via le Backend (si démarré)
```bash
# Lister toutes les maintenances
curl http://localhost:3002/api/maintenance/pending-signatures

# Ou récupérer une maintenance spécifique
curl http://localhost:3002/api/maintenance/[MAINTENANCE_ID]
```

## 🚀 Utilisation Complète

### Étape 1 : Démarrer le Backend

```bash
cd gocardless-backend
npm start
```

Vous devriez voir :
```
✅ Fichier .env chargé avec succès
🚀 Serveur démarré sur le port 3002
```

### Étape 2 : Lancer le Test

Dans un **nouveau terminal** :

```bash
cd gocardless-backend
node test-automatic-payments-quick.js 00PSWHQPyqsvx7qAyom1 12
```

### Étape 3 : Observer les Résultats

Le script va :
1. ✅ Récupérer la maintenance
2. ✅ Créer un paiement toutes les 10 secondes
3. ✅ Simuler la confirmation
4. ✅ Vérifier le `paymentSchedule`
5. ✅ Répéter 12 fois

## 📊 Résultat Attendu

```
🚀 TEST RAPIDE - Prélèvements Automatiques
⏱️  Cycles: 12
⏰ Intervalle: 10 secondes
🔗 Backend: http://localhost:3002

🔍 Récupération de la maintenance: 00PSWHQPyqsvx7qAyom1
✅ Maintenance trouvée via API: CONTRACT-XXXXX
   Client: Nom du Client
   Montant: 50€
   Mandat: MD01...

🔄 CYCLE 1/12
💳 Création d'un paiement...
✅ Paiement créé: PM01...
🔄 Simulation confirmation...
✅ Webhook traité
📅 PaymentSchedule: 1 payé(s), 0 en cours, 11 en attente

...
```

## 🐛 Dépannage

### Erreur : "Backend non disponible"

**Solution :**
```bash
# Vérifier que le backend est démarré
curl http://localhost:3002/health

# Si pas de réponse, démarrer le backend
cd gocardless-backend
npm start
```

### Erreur : "Firebase non disponible"

**Solution :**
1. Vérifier le fichier `.env` dans `gocardless-backend/`
2. Vérifier que les variables Firebase sont présentes
3. OU démarrer le backend (qui utilise Firebase)

### Erreur : "ID de mandat au lieu de maintenance"

**Solution :**
- Utilisez l'ID de la **maintenance** (commence par des lettres aléatoires)
- PAS l'ID du **mandat** (commence par `MD01`)

## 📝 Notes

- Le script utilise l'API backend en priorité (plus fiable)
- Si le backend n'est pas disponible, il essaie Firebase directement
- Les paiements créés sont marqués avec `test: true` dans les métadonnées

