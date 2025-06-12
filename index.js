require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const serviceAccount = require('./serviceAccountKey.json');

// Configuration
const WEBHOOK_SECRET = process.env.GOCARDLESS_WEBHOOK_SECRET || 'your_webhook_secret_here';
const ALLOWED_IPS = process.env.ALLOWED_IPS ? process.env.ALLOWED_IPS.split(',') : ['127.0.0.1'];

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
app.use(express.json());

// Middleware pour vérifier l'IP
function checkIP(req, res, next) {
  const clientIP = req.ip || req.connection.remoteAddress;
  console.log('IP du client:', clientIP);
  
  if (!ALLOWED_IPS.includes(clientIP)) {
    console.error('IP non autorisée:', clientIP);
    return res.status(403).send('IP non autorisée');
  }
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