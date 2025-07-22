require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const gocardless = require('gocardless-nodejs');
const cors = require('cors');
const axios = require('axios');
const UNIVERSIGN_API_URL = 'https://195.154.178.198/v1'; // IP directe de l'API Universign // IP temporaire pour tester l'accessibilité
const UNIVERSIGN_API_KEY = 'apikey_oQeBvBrw0zKllcnZMWwvmX0ogm';

// Fonction de test de connexion pour diagnostiquer les problèmes de réseau
async function testConnection() {
  try {
    // Test de connexion à un serveur public (Google)
    const googleResponse = await axios.get('https://www.google.com');
    console.log('Test de connexion réussi vers Google');
  } catch (error) {
    console.error('Erreur lors du test de connexion vers Google:', error);
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

// Fonction pour créer un contrat via Universign
async function startUniversignSignature(pdfBase64, signerEmail, signerFirstname, signerLastname) {
  try {
    // Configuration du proxy depuis les variables d'environnement
    const proxyConfig = process.env.HTTP_PROXY_HOST ? {
      host: process.env.HTTP_PROXY_HOST,
      port: process.env.HTTP_PROXY_PORT,
      auth: {
        username: process.env.HTTP_PROXY_USERNAME,
        password: process.env.HTTP_PROXY_PASSWORD
      }
    } : null;

    // Configuration Axios avec le proxy si défini
    const config = {
      headers: {
        'Authorization': `Bearer ${UNIVERSIGN_API_KEY}`,
        'Content-Type': 'application/json'
      }
    };
    
    // Ajouter la configuration proxy si nécessaire
    if (proxyConfig) {
      config.proxy = proxyConfig;
    }
    const createContractResponse = await axios.post(`${UNIVERSIGN_API_URL}/contracts`, {
      document: {
        name: 'Contrat de signature',
        content: pdfBase64
      },
      signers: [
        {
          email: signerEmail,
          firstName: signerFirstname,
          lastName: signerLastname,
          role: 'signer'
        }
      ]
    }, config);
    return createContractResponse.data;
  } catch (error) {
    console.error('Erreur lors de la création du contrat Universign:', error);
    throw error;
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
app.post('/api/universign/send-contract', async (req, res) => {
  try {
    const { fileBase64, signerEmail, signerFirstname, signerLastname } = req.body;
    
    // Validation des données
    if (!fileBase64 || !signerEmail || !signerFirstname || !signerLastname) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: {
          required: ['fileBase64', 'signerEmail', 'signerFirstname', 'signerLastname']
        }
      });
    }

    // Vérifier que le fichier est bien en base64
    if (!Buffer.from(fileBase64, 'base64').toString('base64') === fileBase64) {
      return res.status(400).json({
        error: 'Invalid base64 file'
      });
    }

    // Vérifier l'adresse email
    if (!signerEmail.includes('@')) {
      return res.status(400).json({
        error: 'Invalid email address'
      });
    }

    // Créer le contrat avec Universign
    const result = await startUniversignSignature(fileBase64, signerEmail, signerFirstname, signerLastname);
    
    // Stocker les informations dans Firebase
    const db = admin.firestore();
    await db.collection('contracts').add({
      signerEmail,
      signerFirstname,
      signerLastname,
      contractId: result.contractId,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      data: result,
      message: 'Contract sent successfully'
    });
  } catch (error) {
    console.error('Error sending contract:', error);
    res.status(500).json({
      error: 'Error sending contract',
      details: error.message
    });
  }
});

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