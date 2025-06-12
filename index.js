require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');

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

// Initialiser Firebase Admin avec les variables d'environnement
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  }),
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`)); 