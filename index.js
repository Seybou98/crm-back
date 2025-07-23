require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const gocardless = require('gocardless-nodejs');
const cors = require('cors');
const axios = require('axios');
// Configuration de l'API Universign
const UNIVERSIGN_API_BASE_URL = 'https://api.universign.com/v1';
const UNIVERSIGN_API_KEY = 'apikey_oQeBvBrw0zKllcnZMWwvmX0ogm';

// Configuration Axios pour l'API Universign
const universignApi = require('axios').create({
  baseURL: UNIVERSIGN_API_BASE_URL,
  headers: {
    'Authorization': `Bearer ${UNIVERSIGN_API_KEY}`,
    'Content-Type': 'application/json'
  },
  // Désactiver la vérification SSL pour le développement
  httpsAgent: new (require('https').Agent)({  
    rejectUnauthorized: false
  })
});

// Fonction de test de connexion pour diagnostiquer les problèmes de réseau
async function testConnection() {
  try {
    // Tester la résolution DNS avec le résolveur personnalisé
    try {
      const addresses = await resolver.resolve4('api.universign.eu');
      console.log('Résolution DNS réussie pour api.universign.eu:', addresses);
      
      // Tester la connexion à l'API Universign avec l'IP résolue
      const config = {
        headers: {
          'Authorization': `Bearer ${UNIVERSIGN_API_KEY}`,
          'Host': 'api.universign.eu' // Important pour le SNI
        },
        // Désactiver la vérification SSL pour le test
        httpsAgent: new (require('https').Agent)({  
          rejectUnauthorized: false,
          servername: 'api.universign.eu' // SNI
        })
      };
      
      const response = await axios.get('https://' + addresses[0] + '/v1/health', config);
      console.log('Connexion à Universign réussie !', response.status, response.statusText);
      
    } catch (dnsError) {
      console.error('Erreur de résolution DNS:', dnsError);
      // Essayer avec l'IP directe en cas d'échec
      console.log('Tentative de connexion avec l\'IP directe...');
      
      const response = await axios.get('https://195.154.178.198/v1/health', {
        headers: {
          'Host': 'api.universign.eu',
          'Authorization': `Bearer ${UNIVERSIGN_API_KEY}`
        },
        httpsAgent: new (require('https').Agent)({  
          rejectUnauthorized: false,
          servername: 'api.universign.eu' // SNI
        })
      });
      console.log('Connexion à Universign via IP directe réussie !', response.status);
    }
    
  } catch (error) {
    console.error('Erreur lors du test de connexion:', error);
  }

  try {
    // Configuration du proxy depuis les variables d'environnement
    const proxyConfig = {
      host: process.env.HTTP_PROXY_HOST,
      port: process.env.HTTP_PROXY_PORT,
      auth: {
        username: process.env.HTTP_PROXY_USERNAME,
        password: process.env.HTTP_PROXY_PASSWORD
      }
    };

    // Configuration Axios avec le proxy si défini
    const config = {
      headers: {
        'Authorization': `Bearer ${UNIVERSIGN_API_KEY}`,
        'Content-Type': 'application/json'
      }
    };

    if (proxyConfig.host) {
      config.proxy = proxyConfig;
      console.log('Proxy configuré:', proxyConfig);
    }

    // Test de connexion à l'API Universign
    const response = await axios.get('https://api.universign.eu/v1/health', config);
    console.log('Test de connexion réussi vers Universign:', response.data);
  } catch (error) {
    console.error('Erreur lors du test de connexion vers Universign:', error);
    

  }
}

// Fonction pour démarrer une transaction de signature avec Universign
async function startUniversignSignature(documentBase64, signerEmail, signerName, signerPhone, fileName, callback) {
  try {
    // Préparation du document pour la signature
    const document = {
      content: documentBase64,
      name: fileName || 'document.pdf',
      title: fileName || 'Document à signer',
      signatureFields: [
        {
          page: 1,
          x: 50,  // Position X sur la page
          y: 700, // Position Y sur la page
          name: 'signature',
          signerIndex: 0
        }
      ]
    };

    // Préparation du signataire
    const signer = {
      email: signerEmail,
      firstname: signerName.split(' ')[0],
      lastname: signerName.split(' ').slice(1).join(' ') || '.', // Au moins un caractère requis
      phone: signerPhone,
      successURL: 'https://votresite.com/success', // À personnaliser
      cancelURL: 'https://votresite.com/cancel',   // À personnaliser
      failURL: 'https://votresite.com/error',      // À personnaliser
      certificateType: 'simple',
      signatureField: {
        name: 'signature',
        height: 30,
        width: 100
      }
    };

    // Création de la transaction
    const transaction = {
      documents: [document],
      signers: [signer],
      mustContactFirstSigner: false,
      finalDocRequesterSent: false,
      finalDocSent: false,
      finalDocRequesterMessage: 'Merci pour votre signature',
      finalDocSentMessage: 'Votre document signé est disponible en pièce jointe',
      description: 'Signature de document',
      customId: `sign_${Date.now()}`,
      successURL: 'https://votresite.com/success', // À personnaliser
      cancelURL: 'https://votresite.com/cancel',   // À personnaliser
      failURL: 'https://votresite.com/error',      // À personnaliser
      language: 'fr'
    };

    // Envoi de la requête à l'API Universign
    const response = await universignApi.post('/transactions', transaction);
    
    if (!response.data || !response.data.id) {
      throw new Error('Réponse invalide de l\'API Universign');
    }

    // Enregistrement de la transaction dans Firestore
    const signatureRequestRef = await admin.firestore().collection('signatureRequests').add({
      universignId: response.data.id,
      documentName: fileName,
      signerEmail: signerEmail,
      status: 'pending',
      customId: transaction.customId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Démarrage de la transaction
    await universignApi.post(`/transactions/${response.data.id}/start`);

    // Retour des informations de la transaction
    callback(null, {
      signatureRequestId: signatureRequestRef.id,
      universignId: response.data.id,
      customId: transaction.customId,
      status: 'pending',
      // L'URL de redirection sera disponible dans la réponse de l'API
      // ou via une requête GET sur /transactions/{id}
    });

  } catch (error) {
    console.error('Erreur lors de la création de la transaction Universign:', error.response?.data || error.message);
    callback({
      message: 'Erreur lors de la création de la transaction',
      details: error.response?.data || error.message
    }, null);
  }
}

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

// Configuration CORS
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://crm-label-pose-dev.web.app',
    'https://resonant-marshmallow-198dc0.netlify.app',
    'https://seybou-crm.netlify.app'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
  credentials: true
}));

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

// Gestion des requêtes OPTIONS
app.options('*', cors());

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
  console.log('Signature reçue:', signature);
  
  // En mode développement, autoriser les requêtes sans signature
  if (process.env.NODE_ENV === 'development') {
    console.log('Mode développement: signature ignorée');
    return next();
  }

  if (!signature) {
    console.error('Signature manquante');
    return res.status(401).json({
      error: 'Signature manquante',
      details: {
        headers: req.headers,
        environment: process.env.NODE_ENV
      }
    });
  }

  const rawBody = JSON.stringify(req.body);
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const calculatedSignature = hmac.update(rawBody).digest('hex');
  
  console.log('Signature calculée:', calculatedSignature);
  console.log('Body reçu:', rawBody);

  if (signature !== calculatedSignature) {
    console.error('Signature invalide');
    return res.status(401).json({
      error: 'Signature invalide',
      details: {
        received: signature,
        calculated: calculatedSignature,
        body: rawBody,
        environment: process.env.NODE_ENV
      }
    });
  }

  next();
}

// Fonction pour traiter les différents types d'événements
async function handleEvent(event) {
  const { action, resource_type, details } = event;
  console.log(`Traitement de l'événement: ${action} pour ${resource_type}`);
  console.log('Données complètes:', JSON.stringify(event, null, 2));

  // Créer une référence au document de paiement
  const paymentRef = admin.firestore().collection('payments').doc(event.id);
  console.log('Référence Firestore créée pour:', event.id);

  // Vérifier si le document existe
  const doc = await paymentRef.get();
  const exists = doc.exists;
  console.log('Document existe déjà:', exists);

  try {
    switch (action) {
      case 'created':
        await paymentRef.set({
          ...event,
          status: 'pending',
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Paiement créé dans Firestore: ${event.id}`);
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
        console.log(`Paiement confirmé dans Firestore: ${event.id}`);
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
        console.log(`Paiement échoué dans Firestore: ${event.id}`);
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
        console.log(`Paiement annulé dans Firestore: ${event.id}`);
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
        console.log(`Paiement versé dans Firestore: ${event.id}`);
        break;

      default:
        console.log(`Événement non géré: ${action}`);
        await paymentRef.set({
          ...event,
          status: 'unknown',
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    
    console.log('Opération Firestore réussie pour:', event.id);
  } catch (error) {
    console.error('Erreur lors de l\'enregistrement dans Firestore:', error);
    throw error;
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

// Endpoint pour créer un mandat GoCardless
app.post('/create-mandate', async (req, res) => {
  try {
    console.log('--- [GoCardless] Initialisation du prélèvement ---');
    console.log('Données reçues pour /create-mandate :', JSON.stringify(req.body, null, 2));
    const {
      clientId,
      clientName,
      clientEmail,
      clientAddress,
      redirectUrl,
      amount,
      currency,
      interval
    } = req.body;

    // Créer ou récupérer le client GoCardless
    let customer;
    try {
      console.log('Recherche du client GoCardless pour l’email :', clientEmail);
      const customers = await gocardless.customers.list({
        query: `email=${clientEmail}`
      });
      if (customers.customers.length > 0) {
        customer = customers.customers[0];
        console.log('Client GoCardless existant trouvé :', customer.id);
      } else {
        console.log('Aucun client existant, création d’un nouveau client GoCardless...');
        customer = await gocardless.customers.create({
          email: clientEmail,
          given_name: clientName,
          family_name: clientName,
          address_line1: clientAddress.street,
          city: clientAddress.city,
          postal_code: clientAddress.postalCode,
          country_code: clientAddress.country
        });
        console.log('Nouveau client GoCardless créé :', customer.id);
      }
    } catch (error) {
      console.error('Erreur lors de la création/récupération du client GoCardless:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create or retrieve GoCardless customer'
      });
    }

    // Créer la page de mandat
    console.log('Création de la page de mandat GoCardless pour le client :', customer.id);
    const mandatePages = await gocardless.mandate_pages.create({
      scheme: 'bacs',
      customer: customer.id,
      success_redirect_url: redirectUrl,
      prefilled_customer: {
        email: clientEmail,
        given_name: clientName,
        family_name: clientName,
        address_line1: clientAddress.street,
        city: clientAddress.city,
        postal_code: clientAddress.postalCode,
        country_code: clientAddress.country
      }
    });
    console.log('Page de mandat créée. ID du mandat :', mandatePages.mandate_id, 'URL de redirection :', mandatePages.url);

    // Créer le paiement récurrent
    console.log('Création de l’abonnement GoCardless (prélèvement récurrent)...');
    const subscription = await gocardless.subscriptions.create({
      amount: amount * 100, // Convertir en centimes
      currency: currency,
      interval_unit: interval === 'monthly' ? 'monthly' : interval === 'quarterly' ? 'quarterly' : 'yearly',
      links: {
        mandate: mandatePages.mandate_id
      },
      metadata: {
        clientId: clientId
      }
    });
    console.log('Abonnement GoCardless créé. ID de l’abonnement :', subscription.id);

    return res.json({
      success: true,
      redirectUrl: mandatePages.url,
      gocardlessCustomerId: customer.id,
      mandateId: mandatePages.mandate_id,
      subscriptionId: subscription.id
    });
  } catch (error) {
    console.error('Erreur lors de l’initialisation du prélèvement GoCardless:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Route pour créer un paiement
app.post('/create-payment', async (req, res) => {
  try {
    const { amount, currency, description, mandate_id, reference } = req.body;

    // Validation des données requises
    if (!amount || !currency || !mandate_id) {
      return res.status(400).json({
        error: 'Données manquantes',
        required: ['amount', 'currency', 'mandate_id']
      });
    }

    // Configuration du client GoCardless
    const client = gocardless({
      access_token: process.env.GOCARDLESS_ACCESS_TOKEN,
      environment: process.env.NODE_ENV === 'production' ? 'live' : 'sandbox'
    });

    // Création du paiement
    const payment = await client.payments.create({
      amount: amount * 100, // Conversion en centimes
      currency: currency,
      description: description || 'Paiement CRM',
      mandate: mandate_id,
      reference: reference || `PAY-${Date.now()}`,
      metadata: {
        source: 'crm',
        created_at: new Date().toISOString()
      }
    });

    // Enregistrement dans Firebase
    const db = admin.firestore();
    await db.collection('payments').doc(payment.id).set({
      ...payment,
      created_at: new Date().toISOString(),
      status: 'pending'
    });

    res.json({
      success: true,
      payment: payment,
      message: 'Paiement créé avec succès'
    });

  } catch (error) {
    console.error('Erreur lors de la création du paiement:', error);
    res.status(500).json({
      error: 'Erreur lors de la création du paiement',
      details: error.message
    });
  }
});

// Route pour lancer la signature d'un contrat avec Yousign
app.post('/api/yousign/send-contract', async (req, res) => {
  console.log('Body reçu pour signature Yousign:', req.body); // LOG DEBUG
  try {
    const { fileBase64, fileName, signerEmail, signerFirstname, signerLastname } = req.body;

    if (!fileBase64 || !fileName || !signerEmail || !signerFirstname || !signerLastname) {
      return res.status(400).json({ success: false, error: 'Champs manquants pour la signature' });
    }

    const headers = {
      'Authorization': `Bearer ${YOUSIGN_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // 1. Créer la procédure
    const procedureRes = await axios.post(
      `${YOUSIGN_API_URL}/procedures`,
      {
        name: `Signature ${fileName}`,
        description: 'Signature électronique du document',
        start: false
      },
      { headers }
    );
    const procedureId = procedureRes.data.id;
    console.log('[YOUSIGN] Procédure créée:', procedureId);

    // 2. Ajouter le document à la procédure
    const documentRes = await axios.post(
      `${YOUSIGN_API_URL}/procedures/${procedureId}/documents`,
      {
        name: fileName,
        content: fileBase64,
        contentType: 'application/pdf'
      },
      { headers }
    );
    const documentId = documentRes.data.id;
    console.log('[YOUSIGN] Document ajouté:', documentId);

    // 3. Ajouter le signataire
    await axios.post(
      `${YOUSIGN_API_URL}/procedures/${procedureId}/members`,
      {
        firstname: signerFirstname,
        lastname: signerLastname,
        email: signerEmail,
        fileObjects: [{
          document: documentId,
          page: 1,
          position: '230,499,464,589',
          mention: 'Lu et approuvé'
        }]
      },
      { headers }
    );
    console.log('[YOUSIGN] Membre ajouté');

    // 4. Démarrer la procédure
    await axios.post(
      `${YOUSIGN_API_URL}/procedures/${procedureId}/start`,
      {},
      { headers }
    );
    console.log('[YOUSIGN] Procédure démarrée');

    res.json({
      success: true,
      procedureId
    });
  } catch (error) {
    console.error('Erreur Yousign v3:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// Endpoint pour envoyer un contrat à signer via Universign
app.post('/api/universign/send-contract', async (req, res) => {
  try {
    const { pdfBase64, signerEmail, signerName, signerPhone, fileName } = req.body;

    if (!pdfBase64 || !signerEmail || !signerName) {
      return res.status(400).json({ error: 'Tous les champs sont obligatoires' });
    }

    startUniversignSignature(pdfBase64, signerEmail, signerName, signerPhone || '', fileName || 'document.pdf', (error, result) => {
      if (error) {
        console.error('Erreur lors de la création de la signature:', error);
        return res.status(500).json({ 
          error: 'Erreur lors de la création de la signature',
          details: error.details || error.message 
        });
      }
      
      res.json(result);
    });
  } catch (error) {
    console.error('Erreur inattendue:', error);
    res.status(500).json({ 
      error: 'Erreur lors du traitement de la demande',
      details: error.message 
    });
  }
});

// Webhook pour recevoir les mises à jour de statut d'Universign
app.post('/api/universign/webhook', async (req, res) => {
  try {
    const { event, data } = req.body;
    
    if (!event || !data || !data.transactionId) {
      console.warn('Requête de webhook invalide:', { event, data });
      return res.status(400).json({ error: 'Requête invalide' });
    }

    console.log(`Reçu un événement ${event} pour la transaction ${data.transactionId}`);

    // Mettre à jour le statut dans Firestore
    const snapshot = await admin.firestore()
      .collection('signatureRequests')
      .where('universignId', '==', data.transactionId)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      await doc.ref.update({
        status: event,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        [`events.${event}`]: admin.firestore.FieldValue.serverTimestamp(),
        ...(data.signatureUrl && { signedDocumentUrl: data.signatureUrl })
      });
      
      console.log(`Mise à jour du statut pour la transaction ${data.transactionId}: ${event}`);
    } else {
      console.warn(`Transaction non trouvée: ${data.transactionId}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Erreur lors du traitement du webhook:', error);
    res.status(500).json({ error: 'Erreur lors du traitement du webhook' });
  }
});

// Endpoint pour vérifier le statut d'une transaction
app.get('/api/universign/status/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    
    // Récupérer les informations de la transaction depuis Firestore
    const snapshot = await admin.firestore()
      .collection('signatureRequests')
      .where('universignId', '==', transactionId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'Transaction non trouvée' });
    }

    const doc = snapshot.docs[0].data();
    res.json({
      transactionId,
      status: doc.status,
      documentName: doc.documentName,
      signerEmail: doc.signerEmail,
      createdAt: doc.createdAt?.toDate()?.toISOString(),
      updatedAt: doc.updatedAt?.toDate()?.toISOString(),
      signedDocumentUrl: doc.signedDocumentUrl
    });
  } catch (error) {
    console.error('Erreur lors de la récupération du statut:', error);
    res.status(500).json({ 
      error: 'Erreur lors de la récupération du statut',
      details: error.message 
    });
  }
});

// Suppression du code en double qui causait des erreurs de syntaxe

// Fonction pour démarrer le serveur
async function startServer(port) {
  try {
    app.listen(port, () => {
      console.log(`Serveur démarré sur le port ${port}`);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      // Calculer le prochain port valide (entre 3000 et 65535)
      const nextPort = Math.min(port + 1, 65535);
      if (nextPort <= 65535) {
        console.log(`Le port ${port} est déjà utilisé, tentative avec le port ${nextPort}`);
        await startServer(nextPort);
      } else {
        throw new Error('Aucun port disponible dans la plage 3000-65535');
      }
    } else if (error.code === 'ERR_SOCKET_BAD_PORT') {
      // Si erreur de port invalide, essayer le port suivant
      const nextPort = Math.min(port + 1, 65535);
      console.log(`Port invalide (${port}), tentative avec le port ${nextPort}`);
      await startServer(nextPort);
    } else {
      throw error;
    }
  }
}

// Fonction pour vérifier si un port est disponible
async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = require('net').createServer().listen(port, () => {
      server.close(() => resolve(true));
    }).on('error', () => resolve(false));
  });
}

// Fonction pour trouver un port disponible
async function findAvailablePort(startPort = 10000) {
  for (let port = startPort; port <= 65535; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error('Aucun port disponible dans la plage 10000-65535');
}

// Démarrer le serveur
async function start() {
  try {
    // D'abord trouver un port disponible
    const port = await findAvailablePort(process.env.PORT || 10000);
    console.log(`Port disponible trouvé: ${port}`);

    // Effectuer le test de connexion
    console.log('Démarrage du test de connexion...');
    await testConnection().catch(err => {
      console.error('Erreur lors du test de connexion:', err);
    });

    // Démarrer le serveur sur le port trouvé
    await startServer(port);
    console.log(`Serveur démarré sur le port ${port}`);
  } catch (err) {
    console.error('Erreur lors du démarrage:', err);
    process.exit(1);
  }
}

// Lancer le démarrage
start();