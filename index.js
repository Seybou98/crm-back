require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Forcer le mode développement
process.env.NODE_ENV = 'development';

// Configuration
const WEBHOOK_SECRET = process.env.GOCARDLESS_WEBHOOK_SECRET || 'your_webhook_secret_here';
const ALLOWED_IPS = process.env.ALLOWED_IPS ? process.env.ALLOWED_IPS.split(',') : ['127.0.0.1'];

// Configuration Firebase
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

// Initialiser Firebase Admin
let serviceAccount;
try {
  // Lire le fichier serviceAccountKey.json
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  console.log('Tentative de lecture du fichier:', serviceAccountPath);
  
  if (fs.existsSync(serviceAccountPath)) {
    const rawData = fs.readFileSync(serviceAccountPath, 'utf8');
    serviceAccount = JSON.parse(rawData);
    console.log('Fichier serviceAccountKey.json chargé avec succès');
  } else {
    throw new Error('Fichier serviceAccountKey.json non trouvé');
  }
} catch (error) {
  console.error('Erreur lors de la lecture du fichier serviceAccountKey.json:', error.message);
  // Si le fichier n'existe pas, utiliser les variables d'environnement
  console.log('Utilisation des variables d\'environnement pour Firebase');
  serviceAccount = {
    type: 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
  };
}

// Initialiser l'application Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  ...firebaseConfig
});

const app = express();

// Middleware pour gérer les erreurs JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Erreur de parsing JSON:', err.message);
    return res.status(400).json({
      error: 'Invalid JSON',
      message: err.message
    });
  }
  next();
});

app.use(express.json());

// Route de base pour vérifier que le serveur fonctionne
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'GoCardless webhook server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// Route de santé pour le monitoring
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    firebase: {
      connected: admin.apps.length > 0,
      projectId: process.env.FIREBASE_PROJECT_ID
    }
  });
});

// Middleware pour vérifier l'IP
function checkIP(req, res, next) {
  const clientIP = req.ip || req.connection.remoteAddress;
  const forwardedFor = req.headers['x-forwarded-for'];
  const realIP = req.headers['x-real-ip'];
  
  console.log('Informations de connexion:');
  console.log('- IP du client:', clientIP);
  console.log('- X-Forwarded-For:', forwardedFor);
  console.log('- X-Real-IP:', realIP);
  console.log('- Mode:', process.env.NODE_ENV);
  
  // En mode développement, autoriser toutes les IPs
  if (process.env.NODE_ENV === 'development') {
    console.log('Mode développement: toutes les IPs sont autorisées');
    return next();
  }
  
  // En production, vérifier l'IP
  const ipToCheck = realIP || (forwardedFor ? forwardedFor.split(',')[0].trim() : clientIP);
  if (!ALLOWED_IPS.includes(ipToCheck)) {
    console.error('IP non autorisée:', ipToCheck);
    return res.status(403).json({
      error: 'IP non autorisée',
      details: {
        clientIP,
        forwardedFor,
        realIP,
        ipChecked: ipToCheck,
        environment: process.env.NODE_ENV
      }
    });
  }
  
  console.log('IP autorisée:', ipToCheck);
  next();
}

// Middleware pour vérifier la signature GoCardless
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['webhook-signature'];
  if (!signature) {
    console.error('Signature manquante');
    return res.status(401).send('Signature manquante');
  }

  const rawBody = JSON.stringify(req.body);
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const calculatedSignature = hmac.update(rawBody).digest('hex');

  if (signature !== calculatedSignature) {
    console.error('Signature invalide');
    return res.status(401).send('Signature invalide');
  }

  next();
}

// Fonction pour traiter les différents types d'événements
async function handleEvent(event) {
  const { action, resource_type, details } = event;
  console.log(`Traitement de l'événement: ${action} pour ${resource_type}`);

  // Créer une référence au document de paiement
  const paymentRef = admin.firestore().collection('payments').doc(event.id);

  // Vérifier si le document existe
  const doc = await paymentRef.get();
  const exists = doc.exists;

  switch (action) {
    case 'created':
      await paymentRef.set({
        ...event,
        status: 'pending',
        receivedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`Paiement créé: ${event.id}`);
      break;

    case 'confirmed':
      if (!exists) {
        await paymentRef.set({
          ...event,
          status: 'confirmed',
          confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        await paymentRef.update({
          status: 'confirmed',
          confirmedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      console.log(`Paiement confirmé: ${event.id}`);
      break;

    case 'failed':
      if (!exists) {
        await paymentRef.set({
          ...event,
          status: 'failed',
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: details?.cause || 'unknown',
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        await paymentRef.update({
          status: 'failed',
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: details?.cause || 'unknown'
        });
      }
      console.log(`Paiement échoué: ${event.id}`);
      break;

    case 'cancelled':
      if (!exists) {
        await paymentRef.set({
          ...event,
          status: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        await paymentRef.update({
          status: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      console.log(`Paiement annulé: ${event.id}`);
      break;

    case 'paid_out':
      if (!exists) {
        await paymentRef.set({
          ...event,
          status: 'paid_out',
          paidOutAt: admin.firestore.FieldValue.serverTimestamp(),
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        await paymentRef.update({
          status: 'paid_out',
          paidOutAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      console.log(`Paiement versé: ${event.id}`);
      break;

    default:
      console.log(`Événement non géré: ${action}`);
      await paymentRef.set({
        ...event,
        status: 'unknown',
        receivedAt: admin.firestore.FieldValue.serverTimestamp()
      });
  }
}

// Route webhook avec vérifications
app.post('/webhook', checkIP, verifyWebhookSignature, async (req, res) => {
  console.log('Webhook reçu:', JSON.stringify(req.body, null, 2));
  
  if (!req.body || Object.keys(req.body).length === 0) {
    console.error('Body vide reçu');
    return res.status(400).send('Body vide');
  }

  try {
    // Traiter chaque événement dans le webhook
    const events = req.body.events || [req.body];
    for (const event of events) {
      await handleEvent(event);
    }
    
    res.status(200).send('Webhook processed');
  } catch (error) {
    console.error('Erreur lors du traitement:', error);
    res.status(500).send(error.message);
  }
});

// Fonction pour démarrer le serveur
function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`Serveur démarré sur le port ${port}`);
      resolve(server);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Le port ${port} est déjà utilisé, tentative avec le port ${port + 1}`);
        startServer(port + 1).then(resolve).catch(reject);
      } else {
        console.error('Erreur lors du démarrage du serveur:', err);
        reject(err);
      }
    });
  });
}

// Démarrer le serveur
const PORT = process.env.PORT || 3001;
startServer(PORT).catch(err => {
  console.error('Impossible de démarrer le serveur:', err);
  process.exit(1);
}); 