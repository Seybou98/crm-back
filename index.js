// Chargement forcé du fichier .env
const path = require('path');
const result = require('dotenv').config({ path: path.join(__dirname, '.env') });

if (result.error) {
  console.error('❌ Erreur lors du chargement du fichier .env:', result.error);
} else {
  console.log('✅ Fichier .env chargé avec succès');
  console.log('🔑 Variables d\'environnement chargées:', {
    YOUSIGN_API_KEY: process.env.YOUSIGN_API_KEY ? 'PRÉSENTE' : 'MANQUANTE',
    YOUSIGN_API_URL: process.env.YOUSIGN_API_URL,
    SUMUP_CLIENT_ID: process.env.SUMUP_CLIENT_ID ? 'PRÉSENTE' : 'MANQUANTE',
    SUMUP_CLIENT_SECRET: process.env.SUMUP_CLIENT_SECRET ? 'PRÉSENTE' : 'MANQUANTE',
    SUMUP_MERCHANT_CODE: process.env.SUMUP_MERCHANT_CODE || 'MANQUANT',
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV
  });
}
const express = require('express');
const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');
const cors = require('cors');
const nodemailer = require('nodemailer');

// Importer les routes de test
const testRoutes = require('./test-endpoints');

// Importer le service SumUp
const sumupService = require('./sumup-service');

// Imports Firestore pour la synchronisation YouSign
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, updateDoc, collection, query, where, getDocs, getDoc } = require('firebase/firestore');

const app = express();
// Augmenter la limite de taille pour permettre l'envoi de PDF en base64 (jusqu'à 50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Configuration CORS dynamique pour production
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  process.env.ADMIN_URL || 'http://localhost:3000',
  'https://teal-sunflower-0ade91.netlify.app', // Frontend Netlify (ancien)
  'https://labelenergie1.netlify.app', // Frontend Netlify (nouveau)
  'https://labelenergie234.netlify.app', // Frontend Netlify test
  'http://localhost:5173', // Fallback pour développement
  'http://localhost:3000',  // Fallback pour développement
  'http://localhost:4173'   // Fallback pour développement
];

app.use(cors({
  origin: function (origin, callback) {
    // Log pour debug CORS
    console.log(`[CORS] Requête depuis origin: ${origin}`);
    console.log(`[CORS] Origins autorisés:`, allowedOrigins);

    // Permettre les requêtes sans origin (applications mobiles, etc.)
    if (!origin) {
      console.log(`[CORS] Pas d'origin - autorisé`);
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      console.log(`[CORS] Origin autorisé: ${origin}`);
      callback(null, true);
    } else {
      console.log(`[CORS] Origin bloqué: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin']
}));

// Routes de test pour YouSign et GoCardless
app.use('/', testRoutes);

// Fonction de validation IBAN (AJOUTÉE) - Version améliorée
function validateIBAN(iban) {
  // Supprimer les espaces et convertir en majuscules
  const cleanIban = iban.replace(/\s/g, '').toUpperCase();

  // Vérifier la longueur (FR = 27 caractères)
  if (cleanIban.length !== 27) {
    console.log('[GoCardless] IBAN invalide - longueur:', cleanIban.length, '(attendu: 27)');
    return false;
  }

  // Vérifier le format français (FR + 2 chiffres + 10 caractères + 11 caractères alphanumériques)
  // Format: FR + 2 chiffres + 10 caractères alphanumériques + 11 caractères alphanumériques
  const ibanRegex = /^FR\d{2}[A-Z0-9]{10}[A-Z0-9]{11}$/;
  const isValid = ibanRegex.test(cleanIban);

  // Log pour debug
  console.log('[GoCardless] Validation IBAN:', {
    iban: cleanIban,
    length: cleanIban.length,
    regexMatch: ibanRegex.test(cleanIban),
    isValid: isValid
  });

  if (!isValid) {
    console.log('[GoCardless] IBAN invalide - format:', cleanIban);
  }

  return isValid;
}

// Fonction utilitaire pour obtenir l'URL de l'API GoCardless (AJOUTÉE)
function getGoCardlessApiUrl() {
  const isProduction = process.env.GOCARDLESS_ACCESS_TOKEN?.startsWith('live_');
  const apiUrl = isProduction
    ? 'https://api.gocardless.com'
    : 'https://api-sandbox.gocardless.com';

  console.log('[GoCardless] Environnement détecté:', isProduction ? 'production' : 'sandbox');
  console.log('[GoCardless] URL API utilisée:', apiUrl);

  return apiUrl;
}

// Fonction pour convertir un nom de pays en code ISO (AJOUTÉE)
function getCountryCode(countryName) {
  if (!countryName) return 'FR';

  const countryMap = {
    'france': 'FR',
    'french': 'FR',
    'fr': 'FR',
    'belgium': 'BE',
    'belgique': 'BE',
    'be': 'BE',
    'switzerland': 'CH',
    'suisse': 'CH',
    'ch': 'CH',
    'germany': 'DE',
    'allemagne': 'DE',
    'de': 'DE',
    'spain': 'ES',
    'espagne': 'ES',
    'es': 'ES',
    'italy': 'IT',
    'italie': 'IT',
    'it': 'IT',
    'netherlands': 'NL',
    'pays-bas': 'NL',
    'nl': 'NL',
    'luxembourg': 'LU',
    'lu': 'LU',
    'portugal': 'PT',
    'pt': 'PT',
    'austria': 'AT',
    'autriche': 'AT',
    'at': 'AT'
  };

  const normalized = countryName.toLowerCase().trim();
  const code = countryMap[normalized];

  if (code) {
    console.log(`[GoCardless] Conversion pays: "${countryName}" -> "${code}"`);
    return code;
  }

  // Si c'est déjà un code à 2 lettres en majuscules, le retourner
  if (/^[A-Z]{2}$/.test(countryName.trim().toUpperCase())) {
    console.log(`[GoCardless] Code pays déjà valide: "${countryName}"`);
    return countryName.trim().toUpperCase();
  }

  // Par défaut, retourner FR
  console.log(`[GoCardless] Pays non reconnu "${countryName}", utilisation de "FR" par défaut`);
  return 'FR';
}

// Configuration YouSign dynamique pour production
// Normaliser l'URL pour s'assurer qu'elle se termine par /v3
let YOUSIGN_API_URL = process.env.YOUSIGN_API_URL || 'https://api-sandbox.yousign.app/v3';
if (!YOUSIGN_API_URL.endsWith('/v3')) {
  // Si l'URL ne se termine pas par /v3, l'ajouter
  YOUSIGN_API_URL = YOUSIGN_API_URL.replace(/\/+$/, '') + '/v3';
}
console.log('[YouSign] URL API normalisée:', YOUSIGN_API_URL);
const YOUSIGN_API_TOKEN = process.env.YOUSIGN_API_KEY;
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || 'service_wl6kjuo';
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || 'template_nfsa5wv';
const EMAILJS_USER_ID = process.env.EMAILJS_USER_ID || '9DbPDdjUGFwv3WVZ0';

// Configuration Firebase pour la synchronisation YouSign
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID || process.env.FIREBASE_APP_ID
};

// Initialiser Firebase seulement si les variables requises sont présentes
let db = null;
if (firebaseConfig.apiKey && firebaseConfig.projectId) {
  try {
    const firebaseApp = initializeApp(firebaseConfig);
    db = getFirestore(firebaseApp);
    console.log('✅ Firebase initialisé avec succès');
  } catch (error) {
    console.error('❌ Erreur initialisation Firebase:', error.message);
  }
} else {
  console.warn('⚠️  Firebase non configuré - Variables manquantes:', {
    apiKey: !!firebaseConfig.apiKey,
    projectId: !!firebaseConfig.projectId
  });
}

// Configuration des webhooks GoCardless
const GOCARDLESS_WEBHOOK_SECRET = process.env.GOCARDLESS_WEBHOOK_SECRET;

// Fonction pour valider la signature du webhook GoCardless
function validateGoCardlessWebhook(payload, signature) {
  if (!GOCARDLESS_WEBHOOK_SECRET) {
    console.warn('[Webhook] GOCARDLESS_WEBHOOK_SECRET non configuré, validation désactivée');
    return true;
  }

  try {
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', GOCARDLESS_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );

    console.log('[Webhook] Validation signature:', { isValid, expected: expectedSignature, received: signature });
    return isValid;
  } catch (error) {
    console.error('[Webhook] Erreur validation signature:', error);
    return false;
  }
}

// Fonction pour trouver une maintenance par ID de paiement GoCardless
async function findMaintenanceByPaymentId(paymentId) {
  try {
    console.log('[Webhook] Recherche maintenance pour paiement:', paymentId);

    if (!db) {
      console.error('[Webhook] Firebase non disponible');
      return null;
    }

    // ✅ Méthode 1 : Chercher dans goCardlessPaymentId (champ direct)
    const maintenancesRef = collection(db, 'maintenances');
    const q = query(maintenancesRef, where('goCardlessPaymentId', '==', paymentId));
    const snapshot = await getDocs(q);

    if (!snapshot.empty) {
      const maintenance = snapshot.docs[0];
      console.log('[Webhook] Maintenance trouvée via goCardlessPaymentId:', maintenance.id, maintenance.data().clientName);
      return { id: maintenance.id, ...maintenance.data() };
    }

    // ✅ Méthode 2 : Chercher dans paymentSchedule (plus fiable car c'est là qu'on stocke le paymentId)
    console.log('[Webhook] Recherche dans paymentSchedule...');
    const allMaintenancesSnapshot = await getDocs(maintenancesRef);
    console.log(`[Webhook] ${allMaintenancesSnapshot.docs.length} maintenances à vérifier`);

    for (const docSnapshot of allMaintenancesSnapshot.docs) {
      const maintenance = docSnapshot.data();
      const paymentSchedule = maintenance.paymentSchedule || [];

      // Chercher si le paymentId est dans le schedule
      const foundInSchedule = paymentSchedule.some(item => {
        const matches = item.gocardlessPaymentId === paymentId;
        if (matches) {
          console.log(`[Webhook] ✅ PaymentId trouvé dans schedule de ${maintenance.clientName || docSnapshot.id}`);
          console.log(`[Webhook]    Item: ${item.dueDate}, status: ${item.status}`);
        }
        return matches;
      });

      if (foundInSchedule) {
        console.log('[Webhook] Maintenance trouvée via paymentSchedule:', docSnapshot.id, maintenance.clientName);
        return { id: docSnapshot.id, ...maintenance };
      }
    }

    console.log(`[Webhook] ⚠️ PaymentId ${paymentId} non trouvé dans aucun paymentSchedule`);

    console.log('[Webhook] Aucune maintenance trouvée pour le paiement:', paymentId);
    return null;
  } catch (error) {
    console.error('[Webhook] Erreur recherche maintenance:', error);
    return null;
  }
}

// Fonction pour mettre à jour le statut de paiement d'une maintenance
async function updateMaintenancePaymentStatus(maintenanceId, newStatus, additionalData = {}) {
  try {
    console.log('[Webhook] 🔄 Mise à jour statut paiement:', { maintenanceId, newStatus, additionalData });

    if (!db) {
      console.error('[Webhook] ❌ Firebase non disponible (db est null)');
      return false;
    }

    const maintenanceRef = doc(db, 'maintenances', maintenanceId);
    const maintenanceDoc = await getDoc(maintenanceRef);

    if (!maintenanceDoc.exists()) {
      console.error('[Webhook] ❌ Maintenance non trouvée:', maintenanceId);
      return false;
    }

    const maintenance = maintenanceDoc.data();
    const paymentId = additionalData.goCardlessPaymentId || maintenance.goCardlessPaymentId;

    console.log('[Webhook] 🔍 PaymentId à chercher dans schedule:', paymentId);

    // ✅ NOUVEAU : Mapper le statut GoCardless vers le statut du paymentSchedule
    const scheduleStatusMapping = {
      'paid_out': 'paid',
      'confirmed': 'paid',
      'failed': 'failed',
      'cancelled': 'failed',
      'charged_back': 'failed',
      'submitted': 'processing',
      'pending_submission': 'pending'
    };

    const scheduleStatus = scheduleStatusMapping[newStatus] || 'pending';

    // ✅ NOUVEAU : Mettre à jour aussi le paymentSchedule
    const paymentSchedule = maintenance.paymentSchedule || [];
    console.log(`[Webhook] 📅 PaymentSchedule actuel: ${paymentSchedule.length} items`);
    console.log(`[Webhook] 🔍 Recherche paymentId "${paymentId}" dans schedule...`);

    let scheduleUpdated = false;
    let foundInSchedule = false;

    const updatedSchedule = paymentSchedule.map((item, index) => {
      if (item.gocardlessPaymentId === paymentId) {
        foundInSchedule = true;
        scheduleUpdated = true;
        console.log(`[Webhook] ✅ PaymentId trouvé dans schedule[${index}]: ${item.dueDate}, status: ${item.status} → ${scheduleStatus}`);
        return {
          ...item,
          status: scheduleStatus,
          updatedAt: new Date().toISOString(),
          ...(scheduleStatus === 'paid' && { paidAt: new Date().toISOString() }),
          ...(scheduleStatus === 'failed' && { failedAt: new Date().toISOString() })
        };
      }
      return item;
    });

    if (!foundInSchedule) {
      console.log(`[Webhook] ⚠️ PaymentId "${paymentId}" NON trouvé dans le schedule (${paymentSchedule.length} items)`);
      console.log(`[Webhook] 📋 PaymentIds présents dans schedule:`, paymentSchedule.map((item, idx) => ({
        index: idx,
        dueDate: item.dueDate,
        paymentId: item.gocardlessPaymentId,
        status: item.status
      })).filter(item => item.paymentId));
    }

    const updateData = {
      paymentStatus: newStatus,
      updatedAt: new Date(),
      lastPaymentUpdate: new Date(),
      ...additionalData,
      ...(scheduleUpdated && { paymentSchedule: updatedSchedule })
    };

    console.log(`[Webhook] 💾 Mise à jour Firebase:`, {
      maintenanceId,
      newStatus,
      scheduleUpdated,
      willUpdateSchedule: scheduleUpdated,
      scheduleLength: scheduleUpdated ? updatedSchedule.length : 'N/A'
    });

    await updateDoc(maintenanceRef, updateData);

    console.log('[Webhook] ✅ Statut paiement mis à jour avec succès:', { maintenanceId, newStatus, scheduleUpdated });
    return true;
  } catch (error) {
    console.error('[Webhook] Erreur mise à jour statut paiement:', error);
    return false;
  }
}

// Fonction pour traiter les événements de paiement GoCardless
async function processGoCardlessPaymentEvent(event) {
  try {
    console.log('[Webhook] Traitement événement paiement:', {
      id: event.id,
      resourceType: event.resource_type,
      action: event.action,
      paymentId: event.links?.payment
    });

    // ✅ CORRECTION : GoCardless peut envoyer 'payment' ou 'payments' comme resource_type
    const isPaymentEvent = event.resource_type === 'payment' || event.resource_type === 'payments';
    if (!isPaymentEvent || !event.links?.payment) {
      console.log('[Webhook] ❌ Événement ignoré (pas un paiement):', event.resource_type);
      return false;
    }

    console.log('[Webhook] ✅ Événement paiement détecté:', {
      resourceType: event.resource_type,
      action: event.action,
      paymentId: event.links.payment
    });

    const paymentId = event.links.payment;
    const action = event.action;

    // Mapping des actions GoCardless vers nos statuts
    const statusMapping = {
      'confirmed': 'confirmed',
      'paid_out': 'paid_out',
      'failed': 'failed',
      'cancelled': 'cancelled',
      'charged_back': 'charged_back',
      'submitted': 'submitted',
      'pending_submission': 'pending_submission'
    };

    const newStatus = statusMapping[action];
    if (!newStatus) {
      console.log('[Webhook] Action non mappée:', action);
      return false;
    }

    // Trouver la maintenance correspondante
    console.log(`[Webhook] 🔍 Recherche maintenance pour paymentId: ${paymentId}`);
    const maintenance = await findMaintenanceByPaymentId(paymentId);
    if (!maintenance) {
      console.log(`[Webhook] ⚠️ Maintenance non trouvée pour le paiement: ${paymentId}`);

      // Si l'événement contient un lien vers une subscription, essayer de retrouver
      // la maintenance via la subscriptionId (cas des paiements générés par subscriptions)
      const subscriptionId = event.links?.subscription;
      if (subscriptionId) {
        console.log(`[Webhook] Tentative de recherche via subscriptionId: ${subscriptionId}`);
        const maintenanceBySub = await findMaintenanceBySubscriptionId(subscriptionId);
        if (maintenanceBySub) {
          console.log('[Webhook] ✅ Maintenance trouvée via subscriptionId:', maintenanceBySub.id);
          maintenance = maintenanceBySub; // réassigner pour poursuivre la mise à jour
        }
      }

      if (!maintenance) {
        console.log(`[Webhook] ❌ Maintenance non trouvée pour le paiement: ${paymentId}`);
        return false;
      }
    }

    console.log(`[Webhook] ✅ Maintenance trouvée: ${maintenance.id} (${maintenance.clientName || 'N/A'})`);

    // Mettre à jour le statut
    const success = await updateMaintenancePaymentStatus(maintenance.id, newStatus, {
      goCardlessPaymentId: paymentId, // ✅ NOUVEAU : Passer le paymentId pour mettre à jour le schedule
      goCardlessEventId: event.id,
      goCardlessEventAction: action,
      goCardlessEventCreatedAt: event.created_at
    });

    console.log(`[Webhook] 📊 Résultat mise à jour: ${success ? '✅ Succès' : '❌ Échec'}`);

    if (success) {
      console.log('[Webhook] Événement traité avec succès:', {
        maintenanceId: maintenance.id,
        clientName: maintenance.clientName,
        oldStatus: maintenance.paymentStatus,
        newStatus: newStatus,
        action: action
      });
    }

    return success;
  } catch (error) {
    console.error('[Webhook] Erreur traitement événement paiement:', error);
    return false;
  }
}

// Utilitaire axios Yousign
const yousignApi = axios.create({
  baseURL: YOUSIGN_API_URL,
  headers: {
    Authorization: `Bearer ${YOUSIGN_API_TOKEN}`,
  }
});

// 1. Créer la demande de signature
async function createSignatureRequest(name = 'My Signature Request') {
  try {
    console.log('[YouSign] Appel API pour créer la demande de signature');
    console.log('[YouSign] URL complète:', `${YOUSIGN_API_URL}/signature_requests`);
    console.log('[YouSign] Données:', { name, delivery_mode: 'email' });
    const res = await yousignApi.post('/signature_requests', {
      name,
      delivery_mode: 'email'
    });
    console.log('[YouSign] Réponse reçue:', res.status, res.statusText);
    return res.data.id;
  } catch (error) {
    console.error('[YouSign] Erreur lors de la création de la demande:', error.response?.data || error.message);
    console.error('[YouSign] URL appelée:', error.config?.url);
    console.error('[YouSign] Méthode:', error.config?.method);
    throw error;
  }
}

// 2. Uploader le document
async function uploadDocument(signatureRequestId, pdfPath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(pdfPath));
  form.append('nature', 'signable_document');
  const res = await yousignApi.post(
    `/signature_requests/${signatureRequestId}/documents`,
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${YOUSIGN_API_TOKEN}` } }
  );
  return res.data.id;
}

// 3. Ajouter le signataire et le champ de signature
async function addSigner(signatureRequestId, documentId, firstName, lastName, email, signaturePosition = null) {
  // ✅ CORRECTION : Position par défaut pour la zone "Signature client" en bas de la page 2
  // Dans YouSign, l'origine (0,0) est en bas à gauche de la page
  // Pour un document A4 : largeur ~595 points, hauteur ~842 points
  // La zone de signature est en bas de la page 2, à gauche
  const defaultPosition = {
    page: 2,        // Page 2 où se trouve "Signature client"
    x: 100,         // Position horizontale (gauche)
    y: 80,          // Position verticale depuis le bas (zone "Signature client")
    width: 200,     // Largeur du champ de signature
    height: 60      // Hauteur du champ de signature
  };

  const position = signaturePosition || defaultPosition;

  const res = await yousignApi.post(
    `/signature_requests/${signatureRequestId}/signers`,
    {
      info: {
        first_name: firstName,
        last_name: lastName,
        email,
        locale: 'fr'
      },
      signature_level: 'electronic_signature',
      signature_authentication_mode: 'no_otp',
      delivery_mode: 'email', // <-- AJOUTÉ pour forcer la génération du lien et l'envoi de l'email
      fields: [
        {
          type: 'signature',
          document_id: documentId,
          page: position.page,
          x: position.x,
          y: position.y,
          ...(position.width && { width: position.width }),
          ...(position.height && { height: position.height })
        }
      ]
    }
  );
  return res.data;
}

// 4. Activer la demande de signature
async function activateSignatureRequest(signatureRequestId) {
  await yousignApi.post(`/signature_requests/${signatureRequestId}/activate`);
}

// 5. Récupérer le lien de signature
async function getSignatureRequest(signatureRequestId) {
  const res = await yousignApi.get(`/signature_requests/${signatureRequestId}`);
  return res.data;
}

// Utilitaire pour envoyer l'email via EmailJS
async function sendEmailWithSignatureLink(emailVars) {
  await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
    service_id: EMAILJS_SERVICE_ID,
    template_id: EMAILJS_TEMPLATE_ID,
    user_id: EMAILJS_USER_ID,
    template_params: emailVars
  });
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Utilitaire pour envoyer l'email avec le lien de signature
async function sendMailWithSignatureLink({ to, subject, html }) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    html
  });
}

// Fonction utilitaire pour attendre le lien de signature Yousign
async function waitForSignatureLink(signatureRequestId, signerId, maxTries = 10, delayMs = 1000) {
  for (let i = 0; i < maxTries; i++) {
    const signatureRequest = await getSignatureRequest(signatureRequestId);
    const signer = signatureRequest.signers.find(s => s.id === signerId);
    console.log(`[Yousign] Tentative ${i + 1}: signature_link=`, signer?.signature_link);
    if (signer && signer.signature_link) {
      return signer.signature_link;
    }
    await new Promise(res => setTimeout(res, delayMs));
  }
  return null;
}

// Endpoint principal

// POST : créer une subscription GoCardless (réccurence gérée par GoCardless)
app.post('/create-subscription', async (req, res) => {
  try {
    console.log('[GoCardless] Création de subscription:', req.body);
    const { mandate_id, amount, currency = 'EUR', interval_unit = 'monthly', interval = 1, start_date, metadata } = req.body;

    if (!mandate_id || !amount) {
      return res.status(400).json({ error: 'mandate_id et amount sont requis' });
    }

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'GOCARDLESS_ACCESS_TOKEN manquant' });
    }

    const apiUrl = getGoCardlessApiUrl();

    const body = {
      subscriptions: {
        amount: Math.round(amount * 100),
        currency,
        name: metadata?.contractNumber ? `Maintenance ${metadata.contractNumber}` : `Subscription ${mandate_id}`,
        interval_unit,
        interval,
        links: { mandate: mandate_id },
        ...(start_date && { start_date }),
        metadata: metadata || {}
      }
    };

    const response = await axios.post(`${apiUrl}/subscriptions`, body, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const subscription = response.data.subscriptions;

    // Si on a un maintenanceId dans metadata, sauvegarder le subscriptionId dans Firestore
    if (metadata?.maintenanceId && db) {
      try {
        const maintenanceRef = doc(db, 'maintenances', metadata.maintenanceId);
        await updateDoc(maintenanceRef, {
          subscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          billingIntervalUnit: interval_unit,
          billingInterval: interval,
          nextChargeDate: subscription.next_charge_date || null
        });
      } catch (e) {
        console.error('[GoCardless] Erreur sauvegarde subscription dans Firestore:', e);
      }
    }

    res.json({ success: true, subscription });
  } catch (error) {
    console.error('[GoCardless] Erreur création subscription:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erreur création subscription', details: error.response?.data || error.message });
  }
});

// POST : créer mandat + subscription, ou uniquement subscription si mandate_id fourni
app.post('/create-maintenance-subscription', async (req, res) => {
  try {
    const existingMandateId = req.body.mandate_id || req.body.mandateId;
    console.log('[GoCardless] ========================================');
    console.log(existingMandateId
      ? '[GoCardless] 🚀 CRÉATION ABONNEMENT UNIQUEMENT (mandat existant)'
      : '[GoCardless] 🚀 CRÉATION MANDAT + SUBSCRIPTION (HYBRID)');
    console.log('[GoCardless] ========================================');
    console.log('[GoCardless] Requête reçue:', req.body);

    const {
      account_holder_name,
      iban,
      amount,
      currency = 'EUR',
      interval_unit = 'monthly',
      interval = 1,
      start_date,
      metadata = {}
    } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'amount est requis' });
    }
    if (!process.env.GOCARDLESS_ACCESS_TOKEN || !process.env.GOCARDLESS_CREDITOR_ID) {
      return res.status(500).json({ error: 'Configuration GoCardless manquante (token ou creditor)' });
    }

    const apiUrl = getGoCardlessApiUrl();
    const limitedMetadata = {
      contractNumber: metadata?.contractNumber || '',
      maintenanceId: metadata?.maintenanceId || '',
      clientId: metadata?.clientId || ''
    };
    let mandateId;
    let customerId = null;
    let bankAccountId = null;
    let mandateStatus = null;

    if (existingMandateId) {
      mandateId = existingMandateId;
      console.log('[GoCardless] 🔸 Utilisation du mandat existant:', mandateId);
    } else {
      // Validation pour création complète
      if (!account_holder_name || !iban) {
        return res.status(400).json({ error: 'account_holder_name et iban sont requis (ou fournir mandate_id)' });
      }
      const countryCode = getCountryCode(metadata?.country);
      console.log('[GoCardless] 🔸 ÉTAPE 1/2: Création mandat...');

      // Email : utiliser l'email client réel (metadata.clientEmail) si valide, sinon générer à partir du nom
      const rawEmail = metadata?.clientEmail || metadata?.email;
      const isValidEmail = typeof rawEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail.trim());
      const customerEmail = isValidEmail ? rawEmail.trim() : `${account_holder_name.toLowerCase().replace(/\s+/g, '.')}@example.com`;

      const customerResponse = await axios.post(`${apiUrl}/customers`, {
      customers: {
        email: customerEmail,
        given_name: account_holder_name.split(' ')[0] || account_holder_name,
        family_name: account_holder_name.split(' ').slice(1).join(' ') || account_holder_name,
        address_line1: metadata?.address || 'Adresse non spécifiée',
        city: metadata?.city || 'Ville non spécifiée',
        postal_code: metadata?.postalCode || '00000',
        country_code: countryCode
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

      customerId = customerResponse.data.customers.id;
      console.log('[GoCardless] ✅ Client créé:', customerId);

      const cleanIban = iban.replace(/\s/g, '').toUpperCase();
      const cleanAccountHolderName = account_holder_name.trim();

      const bankAccountResponse = await axios.post(`${apiUrl}/customer_bank_accounts`, {
        customer_bank_accounts: {
          account_holder_name: cleanAccountHolderName,
          iban: cleanIban,
          links: { customer: customerId }
        }
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      });

      bankAccountId = bankAccountResponse.data.customer_bank_accounts.id;
      console.log('[GoCardless] ✅ Compte bancaire créé:', bankAccountId);

      const mandateResponse = await axios.post(`${apiUrl}/mandates`, {
        mandates: {
          scheme: 'sepa_core',
          links: {
            customer_bank_account: bankAccountId,
            creditor: process.env.GOCARDLESS_CREDITOR_ID
          },
          metadata: limitedMetadata
        }
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      });

      mandateId = mandateResponse.data.mandates.id;
      mandateStatus = mandateResponse.data.mandates.status;
      console.log('[GoCardless] ✅ Mandat créé:', mandateId);

      try {
        await axios.post(`${apiUrl}/mandates/${mandateId}/actions/activate`, {}, {
          headers: {
            'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
            'GoCardless-Version': '2015-07-06',
            'Content-Type': 'application/json'
          }
        });
        console.log('[GoCardless] ✅ Mandat activé');
      } catch (activationError) {
        console.log('[GoCardless] ℹ️ Mandat déjà actif ou activation non nécessaire');
      }
    }

    console.log('[GoCardless] 🔸 ÉTAPE 2/2: Création subscription...');

    // day_of_month : 1-28 ou -1 (dernier jour). Obligatoire pour monthly/yearly.
    // Sans start_date, GoCardless utilise next_possible_charge_date du mandat (doc GoCardless).
    const dayOfMonth = typeof req.body.day_of_month === 'number' && req.body.day_of_month >= 1 && req.body.day_of_month <= 28
      ? req.body.day_of_month
      : (req.body.day_of_month === -1 ? -1 : 1);

    // Doc GoCardless : amount et day_of_month en string dans les exemples
    const amountMinor = String(Math.round(amount * 100));
    const subscriptionBody = {
      subscriptions: {
        amount: amountMinor,
        currency,
        name: (metadata?.contractNumber ? `Maintenance ${metadata.contractNumber}` : `Subscription ${mandateId}`).slice(0, 255),
        interval_unit,
        interval,
        day_of_month: String(dayOfMonth),
        links: { mandate: mandateId },
        metadata: limitedMetadata
      }
    };
    console.log('[GoCardless] Body subscription envoyé:', JSON.stringify(subscriptionBody, null, 2));

    const subscriptionResponse = await axios.post(`${apiUrl}/subscriptions`, subscriptionBody, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const subscription = subscriptionResponse.data.subscriptions;
    console.log('[GoCardless] ✅ Subscription créée:', subscription.id);

    // Sauvegarder dans Firestore
    if (metadata?.maintenanceId && db) {
      try {
        const maintenanceRef = doc(db, 'maintenances', metadata.maintenanceId);
        const firestoreUpdate = {
          mandateId: mandateId,
          mandateStatus: mandateStatus || 'active',
          subscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          billingIntervalUnit: interval_unit,
          billingInterval: interval,
          nextChargeDate: subscription.next_charge_date || null,
          contractStartDate: start_date || new Date().toISOString().split('T')[0],
          billingMode: 'subscription',
          updatedAt: new Date().toISOString()
        };
        if (customerId) firestoreUpdate.customerId = customerId;
        if (bankAccountId) firestoreUpdate.bankAccountId = bankAccountId;
        firestoreUpdate.gocardlessSubscriptionPending = false;
        firestoreUpdate.gocardlessMandateId = mandateId;
        await updateDoc(maintenanceRef, firestoreUpdate);
        console.log('[GoCardless] ✅ Firestore mis à jour:', metadata.maintenanceId);
      } catch (firestoreError) {
        console.error('[GoCardless] ⚠️ Erreur Firestore:', firestoreError.message);
      }
    }

    console.log('[GoCardless] ========================================');
    console.log('[GoCardless] ✅ MANDAT + SUBSCRIPTION créés avec succès !');
    console.log('[GoCardless] ========================================\n');

    res.json({
      success: true,
      mandate: {
        id: mandateId,
        status: mandateStatus || 'active'
      },
      subscription: {
        id: subscription.id,
        status: subscription.status,
        nextChargeDate: subscription.next_charge_date
      },
      customer: customerId ? { id: customerId } : null,
      bankAccount: bankAccountId ? { id: bankAccountId } : null,
      message: existingMandateId
        ? 'Abonnement créé avec le mandat existant.'
        : 'Mandat et subscription créés. GoCardless gérera les prélèvements automatiques chaque mois.'
    });

  } catch (error) {
    const errData = error.response?.data;
    const validationErrors = errData?.error?.errors;
    console.error('[GoCardless] ❌ Erreur création mandat+subscription:', error.message, error.response?.status, error.config?.url);
    if (Array.isArray(validationErrors)) {
      console.error('[GoCardless] Détail validation_errors:', JSON.stringify(validationErrors, null, 2));
      validationErrors.forEach((e, i) => {
        console.error(`[GoCardless]   #${i + 1}`, e?.field, e?.message || e?.reason || e);
      });
    } else {
      console.error('[GoCardless] Réponse complète:', JSON.stringify(errData, null, 2));
    }

    res.status(error.response?.status || 500).json({
      error: 'Erreur lors de la création du mandat et de la subscription',
      details: errData || error.message,
      validationErrors: validationErrors || undefined
    });
  }
});

app.post('/api/yousign/signature-request', async (req, res) => {
  try {
    console.log('[Yousign] Requête reçue body:', req.body);
    const {
      pdfUrl, // <-- on attend maintenant un lien Firebase Storage
      signerFirstName,
      signerLastName,
      signerEmail,
      client_address,
      contract_number,
      equipment_name,
      contract_start_date,
      contract_end_date,
      monthly_amount
    } = req.body;
    if (!pdfUrl || !signerFirstName || !signerLastName || !signerEmail) {
      console.log('[Yousign] Champs manquants:', { pdfUrl, signerFirstName, signerLastName, signerEmail });
      return res.status(400).json({ error: 'pdfUrl, signerFirstName, signerLastName, signerEmail sont requis' });
    }

    // 1. Télécharger le PDF depuis Firebase Storage
    const path = require('path');
    const tempPath = path.join(__dirname, 'temp_contract.pdf');
    console.log('[Yousign] Téléchargement du PDF depuis:', pdfUrl);
    const response = await axios.get(pdfUrl, { responseType: 'stream' });
    const writer = require('fs').createWriteStream(tempPath);
    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    console.log('[Yousign] PDF téléchargé et sauvegardé temporairement:', tempPath);

    // 2. Créer la demande Yousign avec le fichier temporaire
    console.log('[Yousign] Création de la demande Yousign...');
    const signatureRequestId = await createSignatureRequest('Signature contrat');
    console.log('[Yousign] signatureRequestId:', signatureRequestId);
    const documentId = await uploadDocument(signatureRequestId, tempPath);
    console.log('[Yousign] documentId:', documentId);
    const signer = await addSigner(signatureRequestId, documentId, signerFirstName, signerLastName, signerEmail);
    console.log('[Yousign] signer:', signer);
    await activateSignatureRequest(signatureRequestId);
    console.log('[Yousign] Demande activée');

    // ---
    // Commenté temporairement : récupération et envoi du signature_link (non fiable en sandbox)
    // const signatureLink = await waitForSignatureLink(signatureRequestId, signer.id);
    // console.log('[Yousign] signatureLink (après polling):', signatureLink);
    // if (!signatureLink) {
    //   require('fs').unlinkSync(tempPath);
    //   console.log('[Yousign] Fichier temporaire supprimé');
    //   return res.status(500).json({ error: 'Lien de signature Yousign non généré après 10s. Réessayez dans quelques instants.' });
    // }
    // ---

    // 3. Nettoyer le fichier temporaire
    require('fs').unlinkSync(tempPath);
    console.log('[Yousign] Fichier temporaire supprimé');

    // 4. Envoi de l'email personnalisé désactivé (on laisse Yousign gérer l'invitation)
    // const html = `
    //   <h2>Contrat de maintenance à signer</h2>
    //   <p>Bonjour <strong>${signerFirstName} ${signerLastName}</strong>,</p>
    //   <p>
    //     Veuillez <a href="${signatureLink}" target="_blank">cliquer ici pour signer votre contrat de maintenance</a>.
    //   </p>
    //   <p>Numéro de contrat : ${contract_number}</p>
    //   <p>Adresse : ${client_address}</p>
    //   <p>Équipement : ${equipment_name}</p>
    //   <p>Date de début : ${contract_start_date}</p>
    //   <p>Date de fin : ${contract_end_date}</p>
    //   <p>Montant mensuel : ${monthly_amount}</p>
    //   <br>
    //   <p>L'équipe Label Energie</p>
    // `;
    // await sendMailWithSignatureLink({
    //   to: signerEmail,
    //   subject: 'Signature électronique de votre contrat de maintenance',
    //   html
    // });
    // console.log('[Yousign] Email envoyé à', signerEmail);

    // 5. Réponse au frontend (sans signatureLink)
    res.json({
      signatureRequestId,
      documentId,
      signerId: signer.id,
      // signatureLink, // <-- Commenté car non fiable en sandbox
      status: 'ongoing'
    });
    console.log('[Yousign] Réponse envoyée au frontend');
  } catch (error) {
    console.error('[Yousign] Erreur:', error.response?.data || error.message, error.stack);
    res.status(500).json({
      error: 'Erreur lors du process Yousign',
      details: error.response?.data || error.message
    });
  }
});

// GET : récupérer le statut et les infos d'une demande de signature
app.get('/api/yousign/signature-request/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const signatureRequest = await getSignatureRequest(id);

    // Extraire le statut de signature pour chaque signataire
    const signatureStatus = signatureRequest.signers?.map(signer => ({
      id: signer.id,
      firstName: signer.info?.first_name,
      lastName: signer.info?.last_name,
      email: signer.info?.email,
      status: signer.status, // 'initiated', 'signed', 'declined', etc.
      signedAt: signer.signed_at,
      signatureLink: signer.signature_link
    })) || [];

    res.json({
      id: signatureRequest.id,
      name: signatureRequest.name,
      status: signatureRequest.status, // 'draft', 'active', 'completed', 'expired'
      createdAt: signatureRequest.created_at,
      updatedAt: signatureRequest.updated_at,
      signers: signatureStatus,
      isCompleted: signatureRequest.status === 'completed' || signatureRequest.status === 'done',
      isExpired: signatureRequest.status === 'expired'
    });
  } catch (error) {
    console.error('[Yousign] Erreur GET:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la récupération de la demande Yousign',
      details: error.response?.data || error.message
    });
  }
});

// GET : télécharger le PDF signé (si disponible)
app.get('/api/yousign/signature-request/:id/document', async (req, res) => {
  try {
    const { id } = req.params;
    const signatureRequest = await getSignatureRequest(id);
    const documentId = signatureRequest.documents?.[0]?.id;
    if (!documentId) {
      return res.status(404).json({ error: 'Aucun document trouvé pour cette demande.' });
    }
    // Télécharger le PDF signé (ou original si pas encore signé)
    const docRes = await yousignApi.get(`/signature_requests/${id}/documents/${documentId}/download`, {
      responseType: 'arraybuffer'
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${documentId}.pdf"`);
    res.send(docRes.data);
  } catch (error) {
    console.error('[Yousign] Erreur download document:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors du téléchargement du document signé',
      details: error.response?.data || error.message
    });
  }
});

// POST : Endpoint pour les devis SAV (signature électronique)
app.post('/api/yousign-devis', async (req, res) => {
  console.log('\n🔷 ====== REQUÊTE YOUSIGN DEVIS SAV ======');

  try {
    const { action, ...data } = req.body;
    console.log('[Yousign-Devis] Action:', action);

    switch (action) {
      case 'create_signature_request': {
        const { pdfBase64, filename, signer, devisInfo } = data;
        console.log('[Yousign-Devis] Devis:', devisInfo?.number);
        console.log('[Yousign-Devis] Signataire:', signer?.email);

        // Validation des données
        if (!pdfBase64 || !signer || !devisInfo) {
          return res.status(400).json({
            success: false,
            error: 'Données manquantes: pdfBase64, signer, devisInfo requis'
          });
        }

        // 1. Créer la signature request
        console.log('[Yousign-Devis] Création de la demande de signature...');
        const signatureRequestRes = await yousignApi.post('/signature_requests', {
          name: `Devis SAV ${devisInfo.number}`,
          delivery_mode: 'email',
          timezone: 'Europe/Paris',
          reminder_settings: {
            interval_in_days: 7,
            max_occurrences: 3
          },
          expiration_date: devisInfo.validUntil || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          external_id: devisInfo.id
        });
        const signatureRequestId = signatureRequestRes.data.id;
        console.log('[Yousign-Devis] Signature request créée:', signatureRequestId);

        // 2. Upload du document PDF (depuis base64)
        console.log('[Yousign-Devis] Upload du document...');
        const pdfBuffer = Buffer.from(pdfBase64, 'base64');
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', pdfBuffer, {
          filename: filename || `devis-${devisInfo.number}.pdf`,
          contentType: 'application/pdf'
        });
        form.append('nature', 'signable_document');

        const uploadRes = await axios.post(
          `${YOUSIGN_API_URL}/signature_requests/${signatureRequestId}/documents`,
          form,
          { headers: { ...form.getHeaders(), Authorization: `Bearer ${YOUSIGN_API_TOKEN}` } }
        );
        const documentId = uploadRes.data.id;
        console.log('[Yousign-Devis] Document uploadé:', documentId);

        // 3. Ajouter le signataire
        console.log('[Yousign-Devis] Ajout du signataire...');

        // Préparer les infos du signataire (sans téléphone si invalide)
        const signerInfo = {
          first_name: signer.firstName || 'Client',
          last_name: signer.lastName || 'SAV',
          email: signer.email,
          locale: 'fr'
        };

        // Ajouter le téléphone seulement s'il est valide (format international +33...)
        if (signer.phone) {
          // Convertir en string si c'est un nombre
          let phone = String(signer.phone).replace(/\s/g, '').replace(/\./g, '').replace(/-/g, '');
          // Si le numéro commence par 0, le convertir en format international français
          if (phone.startsWith('0')) {
            phone = '+33' + phone.substring(1);
          }
          // Vérifier que le format est valide (commence par + et contient au moins 10 chiffres)
          if (phone.startsWith('+') && phone.replace(/\D/g, '').length >= 10) {
            signerInfo.phone_number = phone;
            console.log('[Yousign-Devis] Téléphone formaté:', phone);
          } else {
            console.log('[Yousign-Devis] Téléphone ignoré (format invalide):', signer.phone);
          }
        }

        // Calculer les coordonnées pour positionner la signature dans la zone "Le client"
        // Pour un PDF A4 standard : 595 points de largeur x 842 points de hauteur
        // IMPORTANT: Les coordonnées Yousign sont depuis le HAUT de la page (y=0 en haut)
        // La signature est maintenant positionnée EN BAS du document, juste avant le footer
        // (après les conditions générales, avant le footer)
        // La signature doit être SUR la ligne de signature du client, pas en dessous

        // Dimensions A4 en points (1 point = 1/72 inch)
        const A4_WIDTH = 595;
        const A4_HEIGHT = 842;

        // Calcul de la position de la ligne de signature
        // Le template a maintenant :
        // - Header avec logo: ~80-100 points
        // - Titre devis: ~100-180 points
        // - Section CLIENT: ~180-250 points
        // - Prestations: ~250-400 points
        // - Conditions générales: ~400-550 points
        // - Section signature: ~550-700 points (environ 65-83% de la hauteur) - À LA FIN
        // - Footer: ~700-842 points

        // Position de la zone de signature du client (section gauche)
        // x: zone gauche du document (environ 8% de la largeur pour la colonne gauche)
        // y: SUR la ligne de signature (border-top), positionnée en bas du document (après les conditions)
        //    
        // Calcul précis basé sur la structure CSS :
        //    - Section .signatures commence vers 75-80% de la hauteur (~630-674 points)
        //    - .signature-box : padding-top: 40px (≈ 30 points en PDF à 96 DPI)
        //    - .signature-line : margin-top: 30px (≈ 22 points en PDF) + border-top (la ligne elle-même)
        //    - La ligne border-top est donc à : début_signature_box + 30 + 22 = début + 52 points
        //    - Pour un PDF A4 (842 points), section signatures à ~75% = 631 points
        //    - Donc ligne border-top ≈ 631 + 52 = 683 points
        //
        // IMPORTANT: Yousign positionne Y depuis le HAUT de la zone de signature
        // Pour que la signature soit DIRECTEMENT SUR la ligne border-top :
        //    - Y doit être positionné à la hauteur de la ligne moins un petit offset
        //    - Le texte de la signature Yousign apparaîtra légèrement au-dessus de la ligne si Y = ligne
        //    - Pour que le texte soit SUR la ligne, réduire Y de 15-25 points
        // Calcul précis basé sur la structure CSS réelle du template
        // Section signatures commence vers 70% de la hauteur (réduit de 75% pour remonter le bloc)
        // Pour remonter : réduire le pourcentage (ex: 0.70 au lieu de 0.75)
        // Pour descendre : augmenter le pourcentage (ex: 0.80 au lieu de 0.75)
        const sectionStartY = Math.round(A4_HEIGHT * 0.60); // ~589 points - début de la section signatures (remonté)

        // Conversion CSS vers points PDF (1px CSS ≈ 0.75 points PDF à 96 DPI)
        // .signature-box : padding-top: 40px ≈ 30 points
        const signatureBoxPadding = Math.round(40 * 0.75); // 30 points

        // .signature-line : margin-top: 30px ≈ 22 points
        const signatureLineMargin = Math.round(30 * 0.75); // 22 points

        // Position exacte de la ligne border-top
        const linePosition = sectionStartY + signatureBoxPadding + signatureLineMargin; // ~684 points

        // IMPORTANT: Yousign positionne le coin supérieur gauche de la zone de signature
        // Pour que la signature soit SUR la ligne border-top, il faut :
        // - Positionner Y légèrement au-dessus de la ligne pour que le texte soit sur la ligne
        // - Le texte de la signature Yousign apparaît généralement 5-10 points sous le Y spécifié
        // - Donc Y = linePosition - 25 à 30 points pour que le texte soit sur la ligne
        // NOTE: Yousign exige une hauteur minimale de 37 points
        const signatureHeight = 37; // Hauteur minimale requise par Yousign
        const yOffset = 25; // Offset pour positionner le texte sur la ligne

        const signatureField = {
          type: 'signature',
          document_id: documentId,
          page: 1,
          x: Math.round(A4_WIDTH * 0.08),      // ~48 points - zone gauche (client)
          y: linePosition - yOffset,            // ~659 points - Position pour que le texte soit SUR la ligne
          width: Math.round(A4_WIDTH * 0.30),   // ~179 points - largeur pour la zone client
          height: signatureHeight,               // Hauteur de la zone
          label: 'Signature du client'           // Label descriptif
        };

        console.log('[Yousign-Devis] Zone de signature configurée pour la zone "Le client":', {
          ...signatureField,
          position: `(${signatureField.x}, ${signatureField.y})`,
          size: `${signatureField.width}x${signatureField.height}`,
          pageDimensions: `${A4_WIDTH}x${A4_HEIGHT}`,
          calculations: {
            sectionStartY,
            signatureBoxPadding,
            signatureLineMargin,
            linePosition,
            yOffset,
            finalY: signatureField.y,
            distanceFromLine: linePosition - signatureField.y
          },
          note: `Signature positionnée à Y=${signatureField.y} (ligne à ${linePosition}). Le texte Yousign apparaîtra ~5-10 points sous Y, donc sur la ligne. Si besoin, ajuster yOffset (actuellement ${yOffset}).`
        });

        const signerRes = await yousignApi.post(
          `/signature_requests/${signatureRequestId}/signers`,
          {
            info: signerInfo,
            signature_level: 'electronic_signature',
            signature_authentication_mode: 'no_otp',
            fields: [signatureField]
          }
        );
        const signerId = signerRes.data.id;
        const signingUrl = signerRes.data.signature_link;
        console.log('[Yousign-Devis] Signataire ajouté:', signerId);

        // 4. Activer la demande
        console.log('[Yousign-Devis] Activation de la demande...');
        await yousignApi.post(`/signature_requests/${signatureRequestId}/activate`);
        console.log('[Yousign-Devis] Demande activée');

        console.log('✅ [Yousign-Devis] Processus complet terminé !');
        console.log('🔗 [Yousign-Devis] Signature URL:', signingUrl);

        // NOUVEAU: Créer automatiquement un lien de paiement SumUp
        let sumupPaymentUrl = null;
        let sumupCheckoutId = null;
        let sumupError = null;

        try {
          console.log('[Yousign-Devis] Création automatique du lien de paiement SumUp...');

          // Vérifier si on a les informations nécessaires pour SumUp
          if (signerInfo.email && data.amount) {
            const sumupCheckoutData = {
              devisId: data.devisId || `DEVIS-${Date.now()}`,
              amount: parseFloat(data.amount),
              currency: data.currency || 'EUR',
              clientEmail: signerInfo.email,
              description: `Paiement ${data.devisNumber || 'devis'} - ${signerInfo.first_name} ${signerInfo.last_name}`,
              returnUrl: data.returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/sav/payment-success`
            };

            const sumupResult = await sumupService.createCheckout(sumupCheckoutData);

            if (sumupResult.success) {
              sumupPaymentUrl = sumupResult.payment_url;
              sumupCheckoutId = sumupResult.checkout_id;
              console.log('[Yousign-Devis] ✅ Lien de paiement SumUp créé:', sumupPaymentUrl);

              // Sauvegarder dans Firestore si disponible
              if (db && data.devisId) {
                try {
                  const maintenanceRef = doc(db, 'maintenances', data.devisId);
                  await updateDoc(maintenanceRef, {
                    sumup_checkout_id: sumupCheckoutId,
                    sumup_payment_url: sumupPaymentUrl,
                    sumup_created_at: new Date().toISOString(),
                    sumup_status: sumupResult.status,
                    yousign_signature_url: signingUrl,
                    yousign_signature_request_id: signatureRequestId
                  });
                  console.log('[Yousign-Devis] Liens YouSign et SumUp sauvegardés dans Firestore');
                } catch (firestoreError) {
                  console.warn('[Yousign-Devis] Erreur Firestore:', firestoreError.message);
                }
              }
            } else {
              sumupError = sumupResult.error;
              console.warn('[Yousign-Devis] ⚠️ Erreur création lien SumUp:', sumupResult.error);
            }
          } else {
            console.log('[Yousign-Devis] ℹ️ Informations insuffisantes pour créer le lien SumUp (email ou montant manquant)');
          }
        } catch (sumupErr) {
          sumupError = sumupErr.message;
          console.error('[Yousign-Devis] ❌ Erreur lors de la création du lien SumUp:', sumupErr);
        }

        return res.json({
          success: true,
          signatureRequestId,
          documentId,
          signerId,
          status: 'ongoing',
          signingUrl,
          // Ajouter les informations SumUp à la réponse
          sumup: {
            payment_url: sumupPaymentUrl,
            checkout_id: sumupCheckoutId,
            created: !!sumupPaymentUrl,
            error: sumupError
          }
        });
      }

      case 'get_status': {
        const { signatureRequestId } = data;
        console.log('[Yousign-Devis] Vérification statut:', signatureRequestId);

        const statusRes = await yousignApi.get(`/signature_requests/${signatureRequestId}`);
        const status = statusRes.data;

        return res.json({
          success: true,
          status: status.status,
          signers: status.signers?.map(s => ({
            email: s.info?.email,
            status: s.status,
            signedAt: s.signed_at
          })),
          signedAt: status.signed_at
        });
      }

      case 'download_signed': {
        const { signatureRequestId, documentId } = data;
        console.log('[Yousign-Devis] Téléchargement document signé:', signatureRequestId);

        const docRes = await yousignApi.get(
          `/signature_requests/${signatureRequestId}/documents/${documentId}/download`,
          { responseType: 'arraybuffer' }
        );

        const pdfBase64 = Buffer.from(docRes.data).toString('base64');

        return res.json({
          success: true,
          pdfBase64
        });
      }

      default:
        console.error('[Yousign-Devis] Action non reconnue:', action);
        return res.status(400).json({
          success: false,
          error: `Action non reconnue: ${action}`
        });
    }
  } catch (error) {
    console.error('[Yousign-Devis] Erreur:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// Route de test CORS
app.get('/cors-test', (req, res) => {
  console.log(`[CORS-TEST] Requête reçue depuis: ${req.headers.origin}`);
  res.json({
    message: 'CORS test successful',
    origin: req.headers.origin,
    timestamp: new Date().toISOString(),
    cors: {
      allowedOrigins: allowedOrigins,
      frontendUrl: process.env.FRONTEND_URL,
      adminUrl: process.env.ADMIN_URL
    }
  });
});

// Route de test pour vérifier la connectivité
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    cors: {
      allowedOrigins: allowedOrigins,
      frontendUrl: process.env.FRONTEND_URL,
      adminUrl: process.env.ADMIN_URL
    }
  });
});

// POST : créer un mandat GoCardless
app.post('/create-mandate', async (req, res) => {
  try {
    console.log('[GoCardless] Création de mandat:', req.body);
    const { account_holder_name, iban, reference, metadata } = req.body;

    if (!account_holder_name || !iban) {
      return res.status(400).json({ error: 'account_holder_name et iban sont requis' });
    }

    // Validation IBAN (AJOUTÉE) - Temporairement désactivée pour les tests
    // if (!validateIBAN(iban)) {
    //   return res.status(400).json({ 
    //     error: 'IBAN invalide', 
    //     message: 'L\'IBAN doit être au format français valide (FR + 27 caractères)' 
    //   });
    // }
    console.log('[GoCardless] Validation IBAN désactivée pour les tests');

    // Vérifier le token
    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant',
        message: 'Ajoutez votre token d\'accès dans le fichier .env'
      });
    }

    // Vérifier le Creditor ID (AJOUTÉ)
    if (!process.env.GOCARDLESS_CREDITOR_ID) {
      return res.status(500).json({
        error: 'GOCARDLESS_CREDITOR_ID manquant',
        message: 'Ajoutez votre Creditor ID dans le fichier .env'
      });
    }

    console.log('[GoCardless] Creditor ID utilisé:', process.env.GOCARDLESS_CREDITOR_ID);

    // Forcer l'utilisation de l'API sandbox pour les tests
    const apiUrl = 'https://api-sandbox.gocardless.com';
    console.log('[GoCardless] Utilisation forcée de l\'API sandbox pour les tests:', apiUrl);

    // Vérifier le statut du creditor (AJOUTÉ)
    try {
      const creditorResponse = await axios.get(`${apiUrl}/creditors/${process.env.GOCARDLESS_CREDITOR_ID}`, {
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      });

      const creditor = creditorResponse.data.creditors;

      if (!creditor.activated) {
        console.log('[GoCardless] Warning: Creditor non activé, mais continuation pour les tests');
        // Ne pas bloquer, juste logger un warning
      }

      if (!creditor.collections_permitted) {
        console.log('[GoCardless] Warning: Collections non permises, mais continuation pour les tests');
        // Ne pas bloquer, juste logger un warning
      }

      console.log('[GoCardless] Creditor vérifié:', creditor.name, '- Statut:', creditor.verification_status);

    } catch (creditorError) {
      console.error('[GoCardless] Erreur vérification creditor:', creditorError.response?.data || creditorError.message);
      return res.status(500).json({
        error: 'Erreur lors de la vérification du creditor',
        message: 'Impossible de vérifier le statut de votre creditor GoCardless.',
        details: creditorError.response?.data || creditorError.message
      });
    }

    // Convertir le nom du pays en code ISO
    const countryCode = getCountryCode(metadata?.country);
    console.log('[GoCardless] Code pays utilisé:', countryCode, '(depuis:', metadata?.country, ')');

    // 1. Créer le client (email réel si metadata.clientEmail/metadata.email, sinon généré)
    const rawEmail1 = metadata?.clientEmail || metadata?.email;
    const validEmail1 = typeof rawEmail1 === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail1.trim());
    const customerEmail1 = validEmail1 ? rawEmail1.trim() : `${account_holder_name.toLowerCase().replace(/\s+/g, '.')}@example.com`;
    const customerResponse = await axios.post(`${apiUrl}/customers`, {
      customers: {
        email: customerEmail1,
        given_name: account_holder_name.split(' ')[0] || account_holder_name,
        family_name: account_holder_name.split(' ').slice(1).join(' ') || account_holder_name,
        address_line1: metadata?.address || 'Adresse non spécifiée',
        city: metadata?.city || 'Ville non spécifiée',
        postal_code: metadata?.postalCode || '00000',
        country_code: countryCode
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    // 2. Créer le compte bancaire
    const cleanIban = iban.replace(/\s/g, '').toUpperCase();
    const cleanAccountHolderName = account_holder_name.trim();
    const customerId = customerResponse.data.customers.id;

    console.log('[GoCardless] Création du compte bancaire:', {
      account_holder_name: cleanAccountHolderName,
      iban: cleanIban,
      ibanLength: cleanIban.length,
      customerId: customerId
    });

    const bankAccountResponse = await axios.post(`${apiUrl}/customer_bank_accounts`, {
      customer_bank_accounts: {
        account_holder_name: cleanAccountHolderName,
        iban: cleanIban,
        links: {
          customer: customerId
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    // 3. Créer le mandat
    // GoCardless n'accepte que 3 propriétés maximum dans les métadonnées
    // On garde les plus importantes : contractNumber, maintenanceId, clientId
    const limitedMetadata = {
      contractNumber: metadata?.contractNumber || '',
      maintenanceId: metadata?.maintenanceId || '',
      clientId: metadata?.clientId || ''
    };

    console.log('[GoCardless] Métadonnées limitées à 3 propriétés:', limitedMetadata);

    const mandateResponse = await axios.post(`${apiUrl}/mandates`, {
      mandates: {
        scheme: 'sepa_core',
        links: {
          customer_bank_account: bankAccountResponse.data.customer_bank_accounts.id,
          creditor: process.env.GOCARDLESS_CREDITOR_ID
        },
        metadata: limitedMetadata
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    // 4. Activer le mandat (AJOUTÉ) - Version non-bloquante
    try {
      const mandateId = mandateResponse.data.mandates.id;
      await axios.post(`${apiUrl}/mandates/${mandateId}/actions/activate`, {}, {
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      });
      console.log('[GoCardless] Mandat activé avec succès:', mandateId);
    } catch (activationError) {
      console.log('[GoCardless] Mandat déjà actif ou activation non nécessaire:', mandateResponse.data.mandates.id);
    }

    res.json({
      mandateId: mandateResponse.data.mandates.id,
      bankAccountId: bankAccountResponse.data.customer_bank_accounts.id,
      customerId: customerResponse.data.customers.id,
      status: 'active', // Mise à jour du statut
      reference: reference || 'MANDATE_CREATED'
    });

  } catch (error) {
    console.error('[GoCardless] Erreur création mandat complète:', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      errors: error.response?.data?.error?.errors || error.response?.data?.errors || [],
      url: error.config?.url,
      headers: error.config?.headers,
      requestData: error.config?.data
    });

    // Afficher les erreurs de validation en détail
    if (error.response?.data?.error?.errors) {
      console.error('[GoCardless] Erreurs de validation détaillées:', JSON.stringify(error.response.data.error.errors, null, 2));
    }

    res.status(error.response?.status || 500).json({
      error: 'Erreur lors de la création du mandat GoCardless',
      details: error.response?.data || error.message,
      status: error.response?.status,
      url: error.config?.url,
      requestData: error.config?.data,
      validationErrors: error.response?.data?.error?.errors || error.response?.data?.errors || []
    });
  }
});

// POST : créer un mandat GoCardless avec sandbox forcé (AJOUTÉ)
app.post('/create-mandate-sandbox', async (req, res) => {
  try {
    console.log('[GoCardless] Création de mandat (sandbox forcé):', req.body);
    const { account_holder_name, iban, reference, metadata } = req.body;

    if (!account_holder_name || !iban) {
      return res.status(400).json({ error: 'account_holder_name et iban sont requis' });
    }

    // Validation IBAN (AJOUTÉE) - Temporairement désactivée pour les tests
    // if (!validateIBAN(iban)) {
    //   return res.status(400).json({ 
    //     error: 'IBAN invalide', 
    //     message: 'L\'IBAN doit être au format français valide (FR + 27 caractères)' 
    //   });
    // }
    console.log('[GoCardless] Validation IBAN désactivée pour les tests');

    // Vérifier le token
    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant',
        message: 'Ajoutez votre token d\'accès dans le fichier .env'
      });
    }

    // Vérifier le Creditor ID (AJOUTÉ)
    if (!process.env.GOCARDLESS_CREDITOR_ID) {
      return res.status(500).json({
        error: 'GOCARDLESS_CREDITOR_ID manquant',
        message: 'Ajoutez votre Creditor ID dans le fichier .env'
      });
    }

    console.log('[GoCardless] Creditor ID utilisé:', process.env.GOCARDLESS_CREDITOR_ID);

    // Forcer l'utilisation de l'API sandbox
    const apiUrl = 'https://api-sandbox.gocardless.com';
    console.log('[GoCardless] Utilisation forcée de l\'API sandbox:', apiUrl);

    // Convertir le nom du pays en code ISO
    const countryCode = getCountryCode(metadata?.country);
    console.log('[GoCardless] Code pays utilisé:', countryCode, '(depuis:', metadata?.country, ')');

    // 1. Créer le client (email réel si metadata.clientEmail/metadata.email, sinon généré)
    const rawEmail2 = metadata?.clientEmail || metadata?.email;
    const validEmail2 = typeof rawEmail2 === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail2.trim());
    const customerEmail2 = validEmail2 ? rawEmail2.trim() : `${account_holder_name.toLowerCase().replace(/\s+/g, '.')}@example.com`;
    const customerResponse = await axios.post(`${apiUrl}/customers`, {
      customers: {
        email: customerEmail2,
        given_name: account_holder_name.split(' ')[0] || account_holder_name,
        family_name: account_holder_name.split(' ').slice(1).join(' ') || account_holder_name,
        address_line1: metadata?.address || 'Adresse non spécifiée',
        city: metadata?.city || 'Ville non spécifiée',
        postal_code: metadata?.postalCode || '00000',
        country_code: countryCode
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    // 2. Créer le compte bancaire
    const cleanIban = iban.replace(/\s/g, '').toUpperCase();
    const cleanAccountHolderName = account_holder_name.trim();
    const customerId = customerResponse.data.customers.id;

    console.log('[GoCardless] Création du compte bancaire (sandbox):', {
      account_holder_name: cleanAccountHolderName,
      iban: cleanIban,
      ibanLength: cleanIban.length,
      customerId: customerId
    });

    const bankAccountResponse = await axios.post(`${apiUrl}/customer_bank_accounts`, {
      customer_bank_accounts: {
        account_holder_name: cleanAccountHolderName,
        iban: cleanIban,
        links: {
          customer: customerId
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    // 3. Créer le mandat
    // GoCardless n'accepte que 3 propriétés maximum dans les métadonnées
    // On garde les plus importantes : contractNumber, maintenanceId, clientId
    const limitedMetadata = {
      contractNumber: metadata?.contractNumber || '',
      maintenanceId: metadata?.maintenanceId || '',
      clientId: metadata?.clientId || ''
    };

    console.log('[GoCardless] Métadonnées limitées à 3 propriétés (sandbox):', limitedMetadata);

    const mandateResponse = await axios.post(`${apiUrl}/mandates`, {
      mandates: {
        scheme: 'sepa_core',
        links: {
          customer_bank_account: bankAccountResponse.data.customer_bank_accounts.id,
          creditor: process.env.GOCARDLESS_CREDITOR_ID
        },
        metadata: limitedMetadata
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    // 4. Activer le mandat (AJOUTÉ) - Version non-bloquante
    try {
      const mandateId = mandateResponse.data.mandates.id;
      await axios.post(`${apiUrl}/mandates/${mandateId}/actions/activate`, {}, {
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      });
      console.log('[GoCardless] Mandat activé avec succès:', mandateId);
    } catch (activationError) {
      console.log('[GoCardless] Mandat déjà actif ou activation non nécessaire:', mandateResponse.data.mandates.id);
    }

    res.json({
      mandateId: mandateResponse.data.mandates.id,
      bankAccountId: bankAccountResponse.data.customer_bank_accounts.id,
      customerId: customerResponse.data.customers.id,
      status: mandateResponse.data.mandates.status,
      reference: reference || 'MANDATE_CREATED',
      environment: 'sandbox'
    });

  } catch (error) {
    console.error('[GoCardless] Erreur création mandat sandbox complète:', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      errors: error.response?.data?.error?.errors || error.response?.data?.errors || [],
      url: error.config?.url,
      headers: error.config?.headers,
      requestData: error.config?.data
    });

    // Afficher les erreurs de validation en détail
    if (error.response?.data?.error?.errors) {
      console.error('[GoCardless] Erreurs de validation détaillées:', JSON.stringify(error.response.data.error.errors, null, 2));
    }

    res.status(error.response?.status || 500).json({
      error: 'Erreur lors de la création du mandat GoCardless (sandbox)',
      details: error.response?.data || error.message,
      status: error.response?.status,
      url: error.config?.url,
      requestData: error.config?.data,
      validationErrors: error.response?.data?.error?.errors || error.response?.data?.errors || []
    });
  }
});

// GET : diagnostic de la configuration GoCardless (AJOUTÉ)
app.get('/diagnose-gocardless', async (req, res) => {
  try {
    console.log('[GoCardless] Diagnostic de la configuration...');

    const config = {
      hasAccessToken: !!process.env.GOCARDLESS_ACCESS_TOKEN,
      hasCreditorId: !!process.env.GOCARDLESS_CREDITOR_ID,
      accessTokenType: process.env.GOCARDLESS_ACCESS_TOKEN ?
        (process.env.GOCARDLESS_ACCESS_TOKEN.startsWith('live_') ? 'production' : 'sandbox') : 'missing',
      creditorId: process.env.GOCARDLESS_CREDITOR_ID || 'missing'
    };

    console.log('[GoCardless] Configuration:', config);

    if (!config.hasAccessToken) {
      return res.json({
        success: false,
        message: 'GOCARDLESS_ACCESS_TOKEN manquant',
        config
      });
    }

    if (!config.hasCreditorId) {
      return res.json({
        success: false,
        message: 'GOCARDLESS_CREDITOR_ID manquant',
        config
      });
    }

    // Tester la connexion avec l'API
    const apiUrl = getGoCardlessApiUrl();
    const response = await axios.get(`${apiUrl}/creditors`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    res.json({
      success: true,
      message: 'Configuration GoCardless valide',
      config,
      apiResponse: {
        status: response.status,
        creditors: response.data.creditors?.length || 0
      }
    });

  } catch (error) {
    console.error('[GoCardless] Erreur diagnostic:', error.response?.data || error.message);
    res.json({
      success: false,
      message: 'Erreur de connexion à l\'API GoCardless',
      config: {
        hasAccessToken: !!process.env.GOCARDLESS_ACCESS_TOKEN,
        hasCreditorId: !!process.env.GOCARDLESS_CREDITOR_ID,
        accessTokenType: process.env.GOCARDLESS_ACCESS_TOKEN ?
          (process.env.GOCARDLESS_ACCESS_TOKEN.startsWith('live_') ? 'production' : 'sandbox') : 'missing'
      },
      error: error.response?.data || error.message,
      status: error.response?.status
    });
  }
});

// GET : tester la connexion GoCardless
app.get('/test-gocardless', async (req, res) => {
  try {
    console.log('[GoCardless] Test de connexion...');

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.json({
        success: false,
        environment: 'error',
        message: 'GOCARDLESS_ACCESS_TOKEN manquant',
        token_type: 'missing'
      });
    }

    // Utiliser l'API appropriée selon le token
    const apiUrl = getGoCardlessApiUrl();
    const response = await axios.get(`${apiUrl}/creditors`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const isProduction = process.env.GOCARDLESS_ACCESS_TOKEN?.startsWith('live_');
    res.json({
      success: true,
      environment: isProduction ? 'production' : 'sandbox',
      message: 'Connexion GoCardless réussie',
      token_type: isProduction ? 'production' : 'sandbox',
      creditors: response.data.creditors
    });

  } catch (error) {
    console.error('[GoCardless] Erreur test complète:', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      url: error.config?.url,
      headers: error.config?.headers
    });
    res.json({
      success: false,
      environment: 'error',
      message: 'Erreur de connexion GoCardless',
      token_type: 'invalid',
      details: error.response?.data || error.message,
      status: error.response?.status,
      url: error.config?.url
    });
  }
});

// GET : récupérer les créanciers (pour obtenir le Creditor ID)
app.get('/get-creditors', async (req, res) => {
  try {
    console.log('[GoCardless] Récupération des créanciers...');

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant',
        message: 'Ajoutez votre token d\'accès dans le fichier .env'
      });
    }

    const apiUrl = getGoCardlessApiUrl();
    const response = await axios.get(`${apiUrl}/creditors`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    console.log('[GoCardless] Créanciers récupérés:', response.data);
    res.json(response.data);

  } catch (error) {
    console.error('[GoCardless] Erreur récupération créanciers:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la récupération des créanciers',
      details: error.response?.data || error.message
    });
  }
});

// POST : créer un paiement GoCardless (endpoint principal)
app.post('/create-payment', async (req, res) => {
  try {
    console.log('[GoCardless] Création de paiement:', req.body);
    const { amount, currency, mandate_id, description, reference, charge_date, metadata } = req.body;

    if (!amount || !currency || !mandate_id) {
      return res.status(400).json({ error: 'amount, currency et mandate_id sont requis' });
    }

    // ✅ NOUVEAU : Calculer charge_date si non fourni
    let paymentChargeDate = charge_date;
    if (!paymentChargeDate && metadata?.dueDate) {
      paymentChargeDate = metadata.dueDate;
    }

    // ✅ CORRECTION : Valider et ajuster la date selon les règles GoCardless
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Réinitialiser l'heure pour la comparaison

    if (paymentChargeDate) {
      const chargeDateObj = new Date(paymentChargeDate);
      chargeDateObj.setHours(0, 0, 0, 0);

      // Minimum 3 jours dans le futur pour SEPA
      const minDate = new Date(today);
      minDate.setDate(minDate.getDate() + 3);

      // Maximum 1 an dans le futur
      const maxDate = new Date(today);
      maxDate.setFullYear(maxDate.getFullYear() + 1);

      if (chargeDateObj < minDate) {
        console.warn(`[GoCardless] Date de prélèvement trop proche (${paymentChargeDate}), minimum 3 jours requis. Ajustement à: ${minDate.toISOString().split('T')[0]}`);
        paymentChargeDate = minDate.toISOString().split('T')[0];
      } else if (chargeDateObj > maxDate) {
        console.warn(`[GoCardless] Date de prélèvement trop éloignée (${paymentChargeDate}), maximum 1 an. Ajustement à: ${maxDate.toISOString().split('T')[0]}`);
        paymentChargeDate = maxDate.toISOString().split('T')[0];
      }
    } else {
      // Si aucune date fournie, utiliser aujourd'hui + 3 jours (minimum pour SEPA)
      const minDate = new Date(today);
      minDate.setDate(minDate.getDate() + 3);
      paymentChargeDate = minDate.toISOString().split('T')[0];
    }

    console.log('[GoCardless] Date de prélèvement calculée:', paymentChargeDate);

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant'
      });
    }

    // Vérifier le statut du creditor avant de créer un paiement (AJOUTÉ) - Version non-bloquante
    try {
      const apiUrl = getGoCardlessApiUrl();
      const creditorResponse = await axios.get(`${apiUrl}/creditors/${process.env.GOCARDLESS_CREDITOR_ID}`, {
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      });

      const creditor = creditorResponse.data.creditors;

      if (!creditor.collections_permitted) {
        console.log('[GoCardless] Warning: Collections non permises sur le creditor');
        // Ne pas bloquer, juste logger un warning
      } else {
        console.log('[GoCardless] Creditor vérifié - collections permises');
      }

    } catch (creditorError) {
      console.error('[GoCardless] Erreur vérification creditor:', creditorError.response?.data || creditorError.message);
      console.log('[GoCardless] Poursuite sans vérification du creditor - tentative de création de paiement');
      // Ne pas bloquer, continuer avec la création de paiement
    }

    // Vérifier que le mandat existe et est actif (AJOUTÉ) - avec délai
    try {
      const apiUrl = getGoCardlessApiUrl();

      // Attendre un peu que le mandat soit disponible dans l'API
      await new Promise(resolve => setTimeout(resolve, 2000));

      const mandateResponse = await axios.get(`${apiUrl}/mandates/${mandate_id}`, {
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      });

      const mandate = mandateResponse.data.mandates;

      if (mandate.status !== 'active') {
        console.log('[GoCardless] Mandat trouvé mais non actif:', mandate.status);
        // Ne pas bloquer si le mandat existe mais n'est pas encore actif
        console.log('[GoCardless] Mandat en cours d\'activation:', mandate.id);
      } else {
        console.log('[GoCardless] Mandat vérifié et actif:', mandate.id);
      }

    } catch (mandateError) {
      console.error('[GoCardless] Erreur vérification mandat:', mandateError.response?.data || mandateError.message);
      // Ne pas bloquer la création de paiement si la vérification échoue
      console.log('[GoCardless] Poursuite sans vérification du mandat');
    }

    const apiUrl = getGoCardlessApiUrl();

    // ✅ NOUVEAU : Construire l'objet paiement avec charge_date
    const paymentData = {
      amount: Math.round(amount * 100), // ✅ Conversion en centimes + arrondi à l'entier
      currency,
      links: {
        mandate: mandate_id
      },
      description: description || 'Paiement de maintenance',
      metadata: {
        reference: reference || 'PAYMENT_CREATED',
        // ✅ CORRECTION : GoCardless limite les métadonnées à 3 propriétés maximum
        // On garde seulement les plus importantes : reference, maintenance_id, et type
        // Les autres informations (due_date, test, test_cycle) sont supprimées ou combinées
        ...(metadata ? (() => {
          const processed = {};
          let count = 1; // reference compte déjà comme 1

          // Priorité 1 : maintenance_id (important pour identifier la maintenance)
          if (metadata.maintenanceId && count < 3) {
            processed.maintenance_id = String(metadata.maintenanceId);
            count++;
          }

          // Priorité 2 : type (important pour le type de paiement)
          if (metadata.type && count < 3) {
            processed.type = String(metadata.type);
            count++;
          }

          // Si on a encore de la place, on peut combiner due_date et autres infos dans une seule clé
          if (count < 3 && (metadata.dueDate || metadata.test || metadata.testCycle)) {
            const extraInfo = [];
            if (metadata.dueDate) extraInfo.push(`due:${metadata.dueDate}`);
            if (metadata.test) extraInfo.push(`test:${metadata.test}`);
            if (metadata.testCycle) extraInfo.push(`cycle:${metadata.testCycle}`);
            if (extraInfo.length > 0) {
              processed.extra = extraInfo.join('|');
              count++;
            }
          }

          return processed;
        })() : {})
      }
    };

    // ✅ NOUVEAU : Ajouter charge_date si fourni (format YYYY-MM-DD requis par GoCardless)
    if (paymentChargeDate) {
      paymentData.charge_date = paymentChargeDate;
      console.log('[GoCardless] charge_date ajouté:', paymentChargeDate);
    }

    console.log('[GoCardless] 📤 Envoi requête GoCardless API...');
    const response = await axios.post(`${apiUrl}/payments`, {
      payments: paymentData
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    console.log('[GoCardless] ✅ Réponse GoCardless reçue');
    const paymentId = response.data.payments.id;
    const paymentStatus = response.data.payments.status;
    console.log(`[GoCardless] 💳 Paiement créé: ${paymentId}, status: ${paymentStatus}`);

    // ✅ DIAGNOSTIC : Logs pour comprendre pourquoi la sauvegarde ne se fait pas
    console.log('\n========================================');
    console.log(`[GoCardless] 🔍 DIAGNOSTIC SAUVEGARDE paymentId ${paymentId}`);
    console.log('========================================');
    console.log(`[GoCardless] hasMetadata: ${!!metadata}`);
    console.log(`[GoCardless] hasMaintenanceId: ${!!metadata?.maintenanceId}`);
    console.log(`[GoCardless] maintenanceId: ${metadata?.maintenanceId || 'N/A'}`);
    console.log(`[GoCardless] hasDb: ${!!db}`);
    console.log(`[GoCardless] chargeDate: ${paymentChargeDate}`);
    console.log(`[GoCardless] metadataKeys: ${metadata ? Object.keys(metadata).join(', ') : 'N/A'}`);
    if (metadata) {
      console.log(`[GoCardless] metadataFull:`, JSON.stringify(metadata, null, 2));
    }
    console.log('========================================\n');

    // ✅ NOUVEAU : Sauvegarder le paymentId dans le paymentSchedule si maintenanceId est fourni
    if (!metadata?.maintenanceId) {
      console.log(`[GoCardless] ⚠️ Pas de maintenanceId dans metadata, sauvegarde annulée`);
      console.log(`[GoCardless] 📋 Metadata reçue:`, JSON.stringify(metadata, null, 2));
    }
    if (!db) {
      console.log(`[GoCardless] ⚠️ Firebase non disponible (db est null), sauvegarde annulée`);
    }

    if (metadata?.maintenanceId && db) {
      console.log(`[GoCardless] ✅ Conditions remplies, début sauvegarde dans schedule...`);
      try {
        const maintenanceId = metadata.maintenanceId;
        const maintenanceRef = doc(db, 'maintenances', maintenanceId);
        const maintenanceDoc = await getDoc(maintenanceRef);

        if (maintenanceDoc.exists()) {
          const maintenance = maintenanceDoc.data();
          const paymentSchedule = maintenance.paymentSchedule || [];

          console.log(`[GoCardless] 📅 Tentative sauvegarde paymentId ${paymentId} dans schedule (${paymentSchedule.length} items)`);
          console.log(`[GoCardless] 📅 Date de charge: ${paymentChargeDate}`);

          let foundMatch = false;
          let scheduleUpdated = false;

          // Mettre à jour le schedule avec le paymentId
          console.log(`[GoCardless] 🔍 Recherche dans ${paymentSchedule.length} items du schedule...`);
          const updatedSchedule = paymentSchedule.map((item, index) => {
            // Chercher par dueDate (si fourni dans metadata) ou par charge_date
            const itemDueDate = item.dueDate ? item.dueDate.substring(0, 10) : null;
            const chargeDateStr = paymentChargeDate ? paymentChargeDate.substring(0, 10) : null;

            console.log(`[GoCardless]   Item[${index}]: dueDate=${itemDueDate}, chargeDate=${chargeDateStr}, status=${item.status}, paymentId=${item.gocardlessPaymentId || 'N/A'}`);

            // ✅ AMÉLIORATION : Chercher aussi les items "pending" ou "processing" sans paymentId
            if (chargeDateStr && itemDueDate === chargeDateStr) {
              foundMatch = true;
              scheduleUpdated = true;
              console.log(`[GoCardless] ✅ Item trouvé dans schedule[${index}]: ${itemDueDate} → paymentId: ${paymentId}`);
              return {
                ...item,
                status: 'processing',
                gocardlessPaymentId: paymentId,
                updatedAt: new Date().toISOString()
              };
            }

            // ✅ NOUVEAU : Si l'item est "pending" ou "processing" sans paymentId, et que la date est proche (même mois)
            if (!item.gocardlessPaymentId && (item.status === 'pending' || item.status === 'processing')) {
              const itemDueDate = item.dueDate ? item.dueDate.substring(0, 10) : null;
              const chargeDateStr = paymentChargeDate ? paymentChargeDate.substring(0, 10) : null;

              if (itemDueDate && chargeDateStr) {
                // Comparer année-mois (tolérance pour les dates proches)
                const itemYearMonth = itemDueDate.substring(0, 7);
                const chargeYearMonth = chargeDateStr.substring(0, 7);

                if (itemYearMonth === chargeYearMonth) {
                  const itemDay = parseInt(itemDueDate.substring(8, 10));
                  const chargeDay = parseInt(chargeDateStr.substring(8, 10));
                  const dayDiff = Math.abs(itemDay - chargeDay);

                  // Si la différence est de 7 jours ou moins, considérer comme match
                  if (dayDiff <= 7) {
                    foundMatch = true;
                    scheduleUpdated = true;
                    console.log(`[GoCardless] ✅ Item trouvé (date proche): ${itemDueDate} (diff: ${dayDiff}j) → paymentId: ${paymentId}`);
                    return {
                      ...item,
                      status: 'processing',
                      gocardlessPaymentId: paymentId,
                      updatedAt: new Date().toISOString()
                    };
                  }
                }
              }
            }

            return item;
          });

          // Si aucun item trouvé, ajouter un nouveau (seulement si dueDate est fourni)
          if (paymentChargeDate && !foundMatch) {
            console.log(`[GoCardless] ⚠️ Aucun item trouvé dans schedule, ajout d'un nouveau pour ${paymentChargeDate}`);
            const newPayment = {
              amount: amount,
              dueDate: paymentChargeDate,
              status: 'processing',
              month: new Date(paymentChargeDate).getMonth() + 1,
              year: new Date(paymentChargeDate).getFullYear(),
              gocardlessPaymentId: paymentId,
              updatedAt: new Date().toISOString()
            };
            updatedSchedule.push(newPayment);
            scheduleUpdated = true;
          }

          // Sauvegarder si on a trouvé ou ajouté un item
          if (scheduleUpdated) {
            await updateDoc(maintenanceRef, {
              paymentSchedule: updatedSchedule,
              updatedAt: new Date().toISOString()
            });
            console.log(`[GoCardless] ✅ PaymentSchedule mis à jour avec paymentId: ${paymentId}`);
          } else {
            console.log(`[GoCardless] ⚠️ Aucune mise à jour du schedule nécessaire pour paymentId: ${paymentId}`);
          }
        }
      } catch (scheduleError) {
        console.error('[GoCardless] Erreur mise à jour paymentSchedule:', scheduleError);
        // Ne pas bloquer la réponse si la mise à jour du schedule échoue
      }
    }

    res.json({
      paymentId: paymentId,
      status: paymentStatus,
      amount: response.data.payments.amount,
      currency: response.data.payments.currency,
      description: response.data.payments.description,
      charge_date: response.data.payments.charge_date // ✅ NOUVEAU : Retourner aussi la charge_date
    });

  } catch (error) {
    // ✅ AMÉLIORATION : Afficher les erreurs détaillées de GoCardless
    if (error.response?.data?.error?.errors) {
      console.error('\n========================================');
      console.error('[GoCardless] ❌ ERREURS DE VALIDATION DÉTAILLÉES');
      console.error('========================================');
      const errors = error.response.data.error.errors;
      if (Array.isArray(errors)) {
        errors.forEach((err, index) => {
          console.error(`\n${index + 1}. Champ: ${err.field || 'N/A'}`);
          console.error(`   Message: ${err.message || 'N/A'}`);
          console.error(`   Raison: ${err.reason || 'N/A'}`);
        });
      } else {
        console.error(JSON.stringify(errors, null, 2));
      }
      console.error('\n========================================\n');
    }

    console.error('[GoCardless] Erreur création paiement complète:', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      url: error.config?.url,
      requestData: error.config?.data
    });

    res.status(error.response?.status || 500).json({
      error: 'Erreur lors de la création du paiement GoCardless',
      details: error.response?.data || error.message,
      status: error.response?.status,
      url: error.config?.url,
      requestData: error.config?.data,
      validationErrors: error.response?.data?.error?.errors || []
    });
  }
});

// POST : créer un paiement GoCardless (endpoint API)
app.post('/api/gocardless/create-payment', async (req, res) => {
  try {
    console.log('[GoCardless] ========================================');
    console.log('[GoCardless] 🚀 CRÉATION PAIEMENT VIA API');
    console.log('[GoCardless] ========================================');
    console.log('[GoCardless] Création de paiement via API:', req.body);
    const { amount, currency, mandate_id, description, reference, charge_date, metadata } = req.body;
    console.log('[GoCardless] 📋 Metadata reçue:', JSON.stringify(metadata, null, 2));

    if (!amount || !currency || !mandate_id) {
      return res.status(400).json({ error: 'amount, currency et mandate_id sont requis' });
    }

    // ✅ NOUVEAU : Calculer charge_date si non fourni
    let paymentChargeDate = charge_date;
    if (!paymentChargeDate && metadata?.dueDate) {
      paymentChargeDate = metadata.dueDate;
    }

    // ✅ CORRECTION : Valider et ajuster la date selon les règles GoCardless
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Réinitialiser l'heure pour la comparaison

    if (paymentChargeDate) {
      const chargeDateObj = new Date(paymentChargeDate);
      chargeDateObj.setHours(0, 0, 0, 0);

      // Minimum 3 jours dans le futur pour SEPA
      const minDate = new Date(today);
      minDate.setDate(minDate.getDate() + 3);

      // Maximum 1 an dans le futur
      const maxDate = new Date(today);
      maxDate.setFullYear(maxDate.getFullYear() + 1);

      if (chargeDateObj < minDate) {
        console.warn(`[GoCardless] Date de prélèvement trop proche (${paymentChargeDate}), minimum 3 jours requis. Ajustement à: ${minDate.toISOString().split('T')[0]}`);
        paymentChargeDate = minDate.toISOString().split('T')[0];
      } else if (chargeDateObj > maxDate) {
        console.warn(`[GoCardless] Date de prélèvement trop éloignée (${paymentChargeDate}), maximum 1 an. Ajustement à: ${maxDate.toISOString().split('T')[0]}`);
        paymentChargeDate = maxDate.toISOString().split('T')[0];
      }
    } else {
      // Si aucune date fournie, utiliser aujourd'hui + 3 jours (minimum pour SEPA)
      const minDate = new Date(today);
      minDate.setDate(minDate.getDate() + 3);
      paymentChargeDate = minDate.toISOString().split('T')[0];
    }

    console.log('[GoCardless] Date de prélèvement calculée:', paymentChargeDate);

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant'
      });
    }

    const apiUrl = getGoCardlessApiUrl();

    // ✅ NOUVEAU : Construire l'objet paiement avec charge_date
    const paymentData = {
      amount: Math.round(amount * 100), // ✅ Conversion en centimes + arrondi à l'entier
      currency,
      links: {
        mandate: mandate_id
      },
      description: description || 'Paiement de maintenance',
      metadata: {
        reference: reference || 'PAYMENT_CREATED',
        // ✅ CORRECTION : GoCardless limite les métadonnées à 3 propriétés maximum
        // On garde seulement les plus importantes : reference, maintenance_id, et type
        // Les autres informations (due_date, test, test_cycle) sont supprimées ou combinées
        ...(metadata ? (() => {
          const processed = {};
          let count = 1; // reference compte déjà comme 1

          // Priorité 1 : maintenance_id (important pour identifier la maintenance)
          if (metadata.maintenanceId && count < 3) {
            processed.maintenance_id = String(metadata.maintenanceId);
            count++;
          }

          // Priorité 2 : type (important pour le type de paiement)
          if (metadata.type && count < 3) {
            processed.type = String(metadata.type);
            count++;
          }

          // Si on a encore de la place, on peut combiner due_date et autres infos dans une seule clé
          if (count < 3 && (metadata.dueDate || metadata.test || metadata.testCycle)) {
            const extraInfo = [];
            if (metadata.dueDate) extraInfo.push(`due:${metadata.dueDate}`);
            if (metadata.test) extraInfo.push(`test:${metadata.test}`);
            if (metadata.testCycle) extraInfo.push(`cycle:${metadata.testCycle}`);
            if (extraInfo.length > 0) {
              processed.extra = extraInfo.join('|');
              count++;
            }
          }

          return processed;
        })() : {})
      }
    };

    // ✅ NOUVEAU : Ajouter charge_date si fourni (format YYYY-MM-DD requis par GoCardless)
    if (paymentChargeDate) {
      paymentData.charge_date = paymentChargeDate;
      console.log('[GoCardless] charge_date ajouté:', paymentChargeDate);
    }

    console.log('[GoCardless] 📤 Envoi requête GoCardless API...');
    const response = await axios.post(`${apiUrl}/payments`, {
      payments: paymentData
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    console.log('[GoCardless] ✅ Réponse GoCardless reçue');
    const paymentId = response.data.payments.id;
    const paymentStatus = response.data.payments.status;
    console.log(`[GoCardless] 💳 Paiement créé: ${paymentId}, status: ${paymentStatus}`);

    // ✅ DIAGNOSTIC : Logs pour comprendre pourquoi la sauvegarde ne se fait pas
    console.log('\n========================================');
    console.log(`[GoCardless] 🔍 DIAGNOSTIC SAUVEGARDE paymentId ${paymentId}`);
    console.log('========================================');
    console.log(`[GoCardless] hasMetadata: ${!!metadata}`);
    console.log(`[GoCardless] hasMaintenanceId: ${!!metadata?.maintenanceId}`);
    console.log(`[GoCardless] maintenanceId: ${metadata?.maintenanceId || 'N/A'}`);
    console.log(`[GoCardless] hasDb: ${!!db}`);
    console.log(`[GoCardless] chargeDate: ${paymentChargeDate}`);
    console.log(`[GoCardless] metadataKeys: ${metadata ? Object.keys(metadata).join(', ') : 'N/A'}`);
    if (metadata) {
      console.log(`[GoCardless] metadataFull:`, JSON.stringify(metadata, null, 2));
    }
    console.log('========================================\n');

    // ✅ NOUVEAU : Sauvegarder le paymentId dans le paymentSchedule si maintenanceId est fourni
    if (!metadata?.maintenanceId) {
      console.log(`[GoCardless] ⚠️ Pas de maintenanceId dans metadata, sauvegarde annulée`);
      console.log(`[GoCardless] 📋 Metadata reçue:`, JSON.stringify(metadata, null, 2));
    }
    if (!db) {
      console.log(`[GoCardless] ⚠️ Firebase non disponible (db est null), sauvegarde annulée`);
    }

    if (metadata?.maintenanceId && db) {
      console.log(`[GoCardless] ✅ Conditions remplies, début sauvegarde dans schedule...`);
      try {
        const maintenanceId = metadata.maintenanceId;
        const maintenanceRef = doc(db, 'maintenances', maintenanceId);
        const maintenanceDoc = await getDoc(maintenanceRef);

        if (maintenanceDoc.exists()) {
          const maintenance = maintenanceDoc.data();
          const paymentSchedule = maintenance.paymentSchedule || [];

          console.log(`[GoCardless] 📅 Tentative sauvegarde paymentId ${paymentId} dans schedule (${paymentSchedule.length} items)`);
          console.log(`[GoCardless] 📅 Date de charge: ${paymentChargeDate}`);

          let foundMatch = false;
          let scheduleUpdated = false;

          // Mettre à jour le schedule avec le paymentId
          console.log(`[GoCardless] 🔍 Recherche dans ${paymentSchedule.length} items du schedule...`);
          const updatedSchedule = paymentSchedule.map((item, index) => {
            // Chercher par dueDate (si fourni dans metadata) ou par charge_date
            const itemDueDate = item.dueDate ? item.dueDate.substring(0, 10) : null;
            const chargeDateStr = paymentChargeDate ? paymentChargeDate.substring(0, 10) : null;

            console.log(`[GoCardless]   Item[${index}]: dueDate=${itemDueDate}, chargeDate=${chargeDateStr}, status=${item.status}, paymentId=${item.gocardlessPaymentId || 'N/A'}`);

            // ✅ AMÉLIORATION : Chercher aussi les items "pending" ou "processing" sans paymentId
            if (chargeDateStr && itemDueDate === chargeDateStr) {
              foundMatch = true;
              scheduleUpdated = true;
              console.log(`[GoCardless] ✅ Item trouvé dans schedule[${index}]: ${itemDueDate} → paymentId: ${paymentId}`);
              return {
                ...item,
                status: 'processing',
                gocardlessPaymentId: paymentId,
                updatedAt: new Date().toISOString()
              };
            }

            // ✅ NOUVEAU : Si l'item est "pending" ou "processing" sans paymentId, et que la date est proche (même mois)
            if (!item.gocardlessPaymentId && (item.status === 'pending' || item.status === 'processing')) {
              const itemDueDate = item.dueDate ? item.dueDate.substring(0, 10) : null;
              const chargeDateStr = paymentChargeDate ? paymentChargeDate.substring(0, 10) : null;

              if (itemDueDate && chargeDateStr) {
                // Comparer année-mois (tolérance pour les dates proches)
                const itemYearMonth = itemDueDate.substring(0, 7);
                const chargeYearMonth = chargeDateStr.substring(0, 7);

                if (itemYearMonth === chargeYearMonth) {
                  const itemDay = parseInt(itemDueDate.substring(8, 10));
                  const chargeDay = parseInt(chargeDateStr.substring(8, 10));
                  const dayDiff = Math.abs(itemDay - chargeDay);

                  // Si la différence est de 7 jours ou moins, considérer comme match
                  if (dayDiff <= 7) {
                    foundMatch = true;
                    scheduleUpdated = true;
                    console.log(`[GoCardless] ✅ Item trouvé (date proche): ${itemDueDate} (diff: ${dayDiff}j) → paymentId: ${paymentId}`);
                    return {
                      ...item,
                      status: 'processing',
                      gocardlessPaymentId: paymentId,
                      updatedAt: new Date().toISOString()
                    };
                  }
                }
              }
            }

            return item;
          });

          // Si aucun item trouvé, ajouter un nouveau (seulement si dueDate est fourni)
          if (paymentChargeDate && !foundMatch) {
            console.log(`[GoCardless] ⚠️ Aucun item trouvé dans schedule, ajout d'un nouveau pour ${paymentChargeDate}`);
            const newPayment = {
              amount: amount,
              dueDate: paymentChargeDate,
              status: 'processing',
              month: new Date(paymentChargeDate).getMonth() + 1,
              year: new Date(paymentChargeDate).getFullYear(),
              gocardlessPaymentId: paymentId,
              updatedAt: new Date().toISOString()
            };
            updatedSchedule.push(newPayment);
            scheduleUpdated = true;
          }

          // Sauvegarder si on a trouvé ou ajouté un item
          if (scheduleUpdated) {
            await updateDoc(maintenanceRef, {
              paymentSchedule: updatedSchedule,
              updatedAt: new Date().toISOString()
            });
            console.log(`[GoCardless] ✅ PaymentSchedule mis à jour avec paymentId: ${paymentId}`);
          } else {
            console.log(`[GoCardless] ⚠️ Aucune mise à jour du schedule nécessaire pour paymentId: ${paymentId}`);
          }
        }
      } catch (scheduleError) {
        console.error('[GoCardless] Erreur mise à jour paymentSchedule:', scheduleError);
        // Ne pas bloquer la réponse si la mise à jour du schedule échoue
      }
    }

    res.json({
      paymentId: paymentId,
      status: paymentStatus,
      amount: response.data.payments.amount,
      currency: response.data.payments.currency,
      description: response.data.payments.description,
      charge_date: response.data.payments.charge_date // ✅ NOUVEAU : Retourner aussi la charge_date
    });

  } catch (error) {
    // ✅ AMÉLIORATION : Afficher les erreurs détaillées de GoCardless
    if (error.response?.data?.error?.errors) {
      console.error('\n========================================');
      console.error('[GoCardless] ❌ ERREURS DE VALIDATION DÉTAILLÉES');
      console.error('========================================');
      const errors = error.response.data.error.errors;
      if (Array.isArray(errors)) {
        errors.forEach((err, index) => {
          console.error(`\n${index + 1}. Champ: ${err.field || 'N/A'}`);
          console.error(`   Message: ${err.message || 'N/A'}`);
          console.error(`   Raison: ${err.reason || 'N/A'}`);
        });
      } else {
        console.error(JSON.stringify(errors, null, 2));
      }
      console.error('\n========================================\n');
    }

    console.error('[GoCardless] Erreur création paiement API:', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      url: error.config?.url,
      requestData: error.config?.data
    });

    res.status(error.response?.status || 500).json({
      error: 'Erreur lors de la création du paiement GoCardless',
      details: error.response?.data || error.message,
      status: error.response?.status,
      url: error.config?.url,
      requestData: error.config?.data,
      validationErrors: error.response?.data?.error?.errors || []
    });
  }
});

// GET : vérifier le statut d'un paiement GoCardless (AJOUTÉ)
app.get('/api/gocardless/payment-status/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant'
      });
    }

    const apiUrl = getGoCardlessApiUrl();
    const response = await axios.get(`${apiUrl}/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const payment = response.data.payments;

    res.json({
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      description: payment.description,
      chargeDate: payment.charge_date,
      createdAt: payment.created_at,
      links: payment.links
    });

  } catch (error) {
    console.error('[GoCardless] Erreur vérification statut paiement:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la vérification du statut du paiement',
      details: error.response?.data || error.message
    });
  }
});

// GET : récupérer un mandat par ID (AJOUTÉ)
app.get('/mandates/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant'
      });
    }

    const apiUrl = getGoCardlessApiUrl();
    const response = await axios.get(`${apiUrl}/mandates/${id}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data);

  } catch (error) {
    console.error('[GoCardless] Erreur récupération mandat:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la récupération du mandat',
      details: error.response?.data || error.message
    });
  }
});

// GET : récupérer tous les paiements (AJOUTÉ)
app.get('/payments', async (req, res) => {
  try {
    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant'
      });
    }

    const apiUrl = getGoCardlessApiUrl();
    const response = await axios.get(`${apiUrl}/payments`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    console.log('[GoCardless] Paiements récupérés:', response.data);
    res.json(response.data);

  } catch (error) {
    console.error('[GoCardless] Erreur récupération paiements:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la récupération des paiements',
      details: error.response?.data || error.message
    });
  }
});

// POST : Synchroniser manuellement tous les paiements GoCardless avec Firebase (NOUVEAU)
app.post('/api/gocardless/sync-all-payments', async (req, res) => {
  try {
    console.log('[GoCardless] Début synchronisation manuelle de tous les paiements...');

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant'
      });
    }

    const apiUrl = getGoCardlessApiUrl();

    // Récupérer tous les paiements depuis GoCardless
    const response = await axios.get(`${apiUrl}/payments?limit=500`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const payments = response.data.payments || [];
    console.log(`[GoCardless] ${payments.length} paiements récupérés depuis GoCardless`);

    let updatedCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;

    // ✅ NOUVEAU : Récupérer toutes les maintenances une fois pour éviter les erreurs Firestore
    let allMaintenances = [];
    try {
      console.log('[GoCardless] Récupération de toutes les maintenances...');
      const maintenancesRef = collection(db, 'maintenances');
      const allMaintenancesSnapshot = await getDocs(maintenancesRef);
      allMaintenances = allMaintenancesSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      console.log(`[GoCardless] ${allMaintenances.length} maintenances récupérées`);
    } catch (error) {
      console.error('[GoCardless] Erreur récupération maintenances:', error);
      return res.status(500).json({
        error: 'Erreur lors de la récupération des maintenances',
        details: error.message
      });
    }

    // Pour chaque paiement, trouver la maintenance correspondante et mettre à jour
    for (const payment of payments) {
      try {
        // Extraire le numéro de contrat depuis la description
        const description = payment.description || '';
        const contractMatch = description.match(/CONTRACT-([A-Z0-9]+)/);

        if (!contractMatch) {
          console.log(`[GoCardless] Pas de numéro de contrat trouvé dans: ${description}`);
          notFoundCount++;
          continue;
        }

        const contractNumber = contractMatch[0]; // CONTRACT-XXXXX
        console.log(`[GoCardless] Recherche maintenance pour contrat: ${contractNumber}`);

        // ✅ NOUVEAU : Filtrer côté serveur au lieu d'utiliser une requête Firestore
        const matchingMaintenances = allMaintenances.filter(m => {
          const mContractNumber = m.contractNumber || '';
          return mContractNumber === contractNumber || mContractNumber.includes(contractNumber.replace('CONTRACT-', ''));
        });

        if (matchingMaintenances.length === 0) {
          console.log(`[GoCardless] Aucune maintenance trouvée pour le contrat: ${contractNumber}`);
          // ✅ NOUVEAU : Essayer aussi de chercher par goCardlessPaymentId
          const byPaymentId = allMaintenances.find(m => m.goCardlessPaymentId === payment.id);
          if (byPaymentId) {
            console.log(`[GoCardless] ✅ Maintenance trouvée par paymentId: ${byPaymentId.id}`);
            matchingMaintenances.push(byPaymentId);
          } else {
            notFoundCount++;
            continue;
          }
        }

        // Mapper le statut GoCardless vers notre statut
        const statusMapping = {
          'confirmed': 'confirmed',
          'paid_out': 'paid_out', // ✅ Statut "Versé" dans GoCardless
          'failed': 'failed',
          'cancelled': 'cancelled',
          'charged_back': 'charged_back',
          'submitted': 'submitted',
          'pending_submission': 'pending_submission',
          'pending_customer_approval': 'pending',
          'pending_submission': 'pending'
        };

        const mappedStatus = statusMapping[payment.status] || payment.status;

        // Mapper le statut GoCardless vers le statut du paymentSchedule
        const scheduleStatusMapping = {
          'paid_out': 'paid',           // Versé → Payé
          'confirmed': 'paid',          // Confirmé → Payé
          'failed': 'failed',           // Échoué → Échoué
          'cancelled': 'failed',        // Annulé → Échoué
          'charged_back': 'failed',     // Contesté → Échoué
          'submitted': 'processing',    // Soumis → En cours
          'pending_submission': 'pending' // En attente → En attente
        };

        const scheduleStatus = scheduleStatusMapping[mappedStatus] || 'pending';

        // Mettre à jour toutes les maintenances avec ce numéro de contrat
        for (const maintenance of matchingMaintenances) {
          const maintenanceId = maintenance.id;

          // Vérifier si le statut doit être mis à jour
          const currentStatus = maintenance.paymentStatus || 'pending';

          // ✅ NOUVEAU : Mettre à jour aussi le paymentSchedule
          const paymentSchedule = maintenance.paymentSchedule || [];
          let scheduleUpdated = false;

          const updatedSchedule = paymentSchedule.map(item => {
            // Chercher par paymentId (priorité)
            const matchesPaymentId = item.gocardlessPaymentId === payment.id;

            // Chercher par date de charge (format YYYY-MM-DD)
            let matchesChargeDate = false;
            if (payment.charge_date && item.dueDate) {
              // Comparer les dates (format YYYY-MM-DD)
              const chargeDateStr = payment.charge_date.substring(0, 10); // YYYY-MM-DD
              const dueDateStr = item.dueDate.substring(0, 10); // YYYY-MM-DD
              matchesChargeDate = chargeDateStr === dueDateStr;

              // Si pas de correspondance exacte, comparer année-mois (pour les cas où la date diffère de quelques jours)
              if (!matchesChargeDate) {
                const chargeYearMonth = payment.charge_date.substring(0, 7); // YYYY-MM
                const dueYearMonth = item.dueDate.substring(0, 7); // YYYY-MM
                matchesChargeDate = chargeYearMonth === dueYearMonth &&
                  Math.abs(new Date(payment.charge_date).getDate() - new Date(item.dueDate).getDate()) <= 7;
              }
            }

            if (matchesPaymentId || matchesChargeDate) {
              scheduleUpdated = true;
              return {
                ...item,
                status: scheduleStatus,
                gocardlessPaymentId: payment.id,
                updatedAt: new Date().toISOString(),
                ...(scheduleStatus === 'paid' && { paidAt: new Date().toISOString() }),
                ...(scheduleStatus === 'failed' && { failedAt: new Date().toISOString() })
              };
            }
            return item;
          });

          // Utiliser updatedSchedule (le nettoyage final sera fait après la boucle)
          const scheduleToUpdate = scheduleUpdated ? updatedSchedule : paymentSchedule;

          // Mettre à jour seulement si le statut a changé ou si le paymentId n'est pas enregistré
          if (currentStatus !== mappedStatus || maintenance.goCardlessPaymentId !== payment.id || scheduleUpdated) {
            const updateData = {
              goCardlessPaymentId: payment.id,
              paymentStatus: mappedStatus,
              paymentMethod: 'gocardless',
              updatedAt: new Date(),
              lastPaymentSync: new Date(),
              goCardlessPaymentAmount: payment.amount / 100, // Conversion centimes → euros
              goCardlessPaymentCurrency: payment.currency,
              goCardlessChargeDate: payment.charge_date,
              ...(scheduleUpdated && { paymentSchedule: scheduleToUpdate })
            };

            await updateDoc(doc(db, 'maintenances', maintenanceId), updateData);

            console.log(`[GoCardless] ✅ Maintenance ${maintenanceId} (${maintenance.clientName}) mise à jour: ${currentStatus} → ${mappedStatus}${scheduleUpdated ? ' (paymentSchedule mis à jour)' : ''}`);
            updatedCount++;
          } else {
            console.log(`[GoCardless] ⏭️ Maintenance ${maintenanceId} déjà à jour: ${mappedStatus}`);
          }
        }

      } catch (error) {
        console.error(`[GoCardless] Erreur traitement paiement ${payment.id}:`, error);
        errorCount++;
      }
    }

    // ✅ NOUVEAU : Nettoyer les statuts "processing" orphelins dans tous les paymentSchedules
    console.log('[GoCardless] Nettoyage des statuts "processing" orphelins...');
    let cleanedCount = 0;
    const allPaymentIds = new Set(payments.map(p => p.id));

    for (const maintenance of allMaintenances) {
      const paymentSchedule = maintenance.paymentSchedule || [];
      let needsUpdate = false;

      const cleanedSchedule = paymentSchedule.map(item => {
        // Si un item est "processing" mais n'a pas de paymentId valide dans GoCardless
        if (item.status === 'processing' && item.gocardlessPaymentId) {
          if (!allPaymentIds.has(item.gocardlessPaymentId)) {
            needsUpdate = true;
            const dueDate = new Date(item.dueDate);
            const now = new Date();
            return {
              ...item,
              status: 'pending', // Remettre en attente
              gocardlessPaymentId: undefined, // Retirer le paymentId invalide
              updatedAt: new Date().toISOString()
            };
          }
        }
        // Si un item est "processing" sans paymentId et que la date est future, le laisser
        // Si la date est passée, le marquer "pending" (sera affiché "En retard" par le frontend)
        if (item.status === 'processing' && !item.gocardlessPaymentId) {
          const dueDate = new Date(item.dueDate);
          const now = new Date();
          if (dueDate < now) {
            needsUpdate = true;
            return {
              ...item,
              status: 'pending', // En attente (sera affiché "En retard" par le frontend)
              updatedAt: new Date().toISOString()
            };
          }
        }
        return item;
      });

      if (needsUpdate) {
        try {
          await updateDoc(doc(db, 'maintenances', maintenance.id), {
            paymentSchedule: cleanedSchedule,
            updatedAt: new Date()
          });
          cleanedCount++;
          console.log(`[GoCardless] ✅ Schedule nettoyé pour maintenance: ${maintenance.id}`);
        } catch (error) {
          console.error(`[GoCardless] Erreur nettoyage schedule pour ${maintenance.id}:`, error);
        }
      }
    }

    console.log(`[GoCardless] ✅ Synchronisation terminée: ${updatedCount} mis à jour, ${notFoundCount} non trouvés, ${errorCount} erreurs, ${cleanedCount} schedules nettoyés`);

    res.json({
      success: true,
      message: 'Synchronisation terminée',
      stats: {
        total: payments.length,
        updated: updatedCount,
        notFound: notFoundCount,
        errors: errorCount,
        cleaned: cleanedCount
      }
    });

  } catch (error) {
    console.error('[GoCardless] Erreur synchronisation complète:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la synchronisation des paiements',
      details: error.response?.data || error.message
    });
  }
});

// GET : récupérer un paiement par ID (AJOUTÉ)
app.get('/payments/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant'
      });
    }

    const apiUrl = getGoCardlessApiUrl();
    const response = await axios.get(`${apiUrl}/payments/${id}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data);

  } catch (error) {
    console.error('[GoCardless] Erreur récupération paiement:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la récupération du paiement',
      details: error.response?.data || error.message
    });
  }
});

// POST : annuler un paiement (AJOUTÉ)
app.post('/payments/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant'
      });
    }

    const apiUrl = getGoCardlessApiUrl();
    const response = await axios.post(`${apiUrl}/payments/${id}/actions/cancel`, {}, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data);

  } catch (error) {
    console.error('[GoCardless] Erreur annulation paiement:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de l\'annulation du paiement',
      details: error.response?.data || error.message
    });
  }
});

// POST : créer un abonnement (AJOUTÉ)
app.post('/create-subscription', async (req, res) => {
  try {
    console.log('[GoCardless] Création d\'abonnement:', req.body);
    const { amount, currency, mandate_id, interval_unit, interval, description, metadata } = req.body;

    if (!amount || !currency || !mandate_id || !interval_unit || !interval) {
      return res.status(400).json({
        error: 'amount, currency, mandate_id, interval_unit et interval sont requis'
      });
    }

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant'
      });
    }

    const apiUrl = getGoCardlessApiUrl();
    const response = await axios.post(`${apiUrl}/subscriptions`, {
      subscriptions: {
        amount: amount * 100, // Conversion en centimes
        currency,
        interval_unit, // 'weekly', 'monthly', 'yearly'
        interval, // nombre d'intervalles
        links: {
          mandate: mandate_id
        },
        description: description || 'Abonnement maintenance',
        metadata: metadata || {}
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    res.json({
      subscriptionId: response.data.subscriptions.id,
      status: response.data.subscriptions.status,
      amount: response.data.subscriptions.amount,
      currency: response.data.subscriptions.currency,
      description: response.data.subscriptions.description
    });

  } catch (error) {
    console.error('[GoCardless] Erreur création abonnement:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la création de l\'abonnement',
      details: error.response?.data || error.message
    });
  }
});

// POST : endpoint webhook pour recevoir les notifications Yousign
app.post('/api/yousign/webhook', express.json(), async (req, res) => {
  try {
    console.log('[Yousign][Webhook] Notification reçue:', req.body);

    const { event, signature_request } = req.body;

    if (event === 'signature_request.completed' || event === 'signature_request.expired') {
      // Mettre à jour le statut dans Firestore
      // Note: Vous devrez implémenter la logique pour trouver la maintenance correspondante
      console.log('[Yousign][Webhook] Demande de signature mise à jour:', signature_request.id);

      // Exemple de mise à jour (à adapter selon votre structure)
      // const maintenanceRef = doc(db, 'maintenances', maintenanceId);
      // await updateDoc(maintenanceRef, {
      //   signatureStatus: event === 'signature_request.completed' ? 'signed' : 'expired',
      //   updatedAt: new Date()
      // });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Yousign][Webhook] Erreur:', error);
    res.status(500).json({ error: 'Erreur webhook' });
  }
});

// POST : endpoint webhook pour recevoir les notifications GoCardless (AJOUTÉ)
app.post('/api/gocardless/webhook', express.json(), async (req, res) => {
  try {
    console.log('[GoCardless][Webhook] Notification reçue:', req.body);

    const { events } = req.body;

    if (events && Array.isArray(events)) {
      for (const event of events) {
        console.log('[GoCardless][Webhook] Traitement événement:', event.resource_type, event.action);

        switch (event.resource_type) {
          case 'mandates':
            await handleMandateEvent(event);
            break;
          case 'payments':
            await handlePaymentEvent(event);
            break;
          case 'subscriptions':
            await handleSubscriptionEvent(event);
            break;
          default:
            console.log('[GoCardless][Webhook] Type d\'événement non géré:', event.resource_type);
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[GoCardless][Webhook] Erreur:', error);
    res.status(500).json({ error: 'Erreur webhook GoCardless' });
  }
});

// Fonctions de gestion des événements GoCardless (AMÉLIORÉES)
async function handleMandateEvent(event) {
  const { action, links } = event;

  switch (action) {
    case 'created':
      console.log('[GoCardless] Mandat créé:', links.mandate);
      break;
    case 'active':
      console.log('[GoCardless] Mandat activé:', links.mandate);
      // ✅ NOUVEAU : Déclencher automatiquement le premier paiement
      await triggerFirstPayment(links.mandate);
      break;
    case 'cancelled':
      console.log('[GoCardless] Mandat annulé:', links.mandate);
      await handleMandateCancellation(links.mandate);
      break;
    case 'expired':
      console.log('[GoCardless] Mandat expiré:', links.mandate);
      await handleMandateExpiration(links.mandate);
      break;
    default:
      console.log('[GoCardless] Action de mandat non gérée:', action);
  }
}

async function handlePaymentEvent(event) {
  const { action, links } = event;

  // ✅ CORRECTION : Utiliser processGoCardlessPaymentEvent qui met à jour le paymentSchedule
  // Cette fonction cherche dans le paymentSchedule et met à jour correctement
  const success = await processGoCardlessPaymentEvent(event);

  if (success) {
    console.log('[GoCardless] Événement paiement traité avec succès:', action, links.payment);

    // Pour les actions spécifiques, appeler aussi les handlers additionnels
    switch (action) {
      case 'confirmed':
        // ✅ NOUVEAU : Déclencher automatiquement le prochain paiement après mise à jour du schedule
        await handlePaymentConfirmed(links.payment);
        break;
      case 'created':
        await handlePaymentCreated(links.payment);
        break;
      case 'failed':
        await handlePaymentFailed(links.payment);
        break;
      case 'cancelled':
        await handlePaymentCancelled(links.payment);
        break;
      case 'submitted':
        await handlePaymentSubmitted(links.payment);
        break;
    }
  } else {
    console.log('[GoCardless] Événement paiement non traité:', action, links.payment);
  }
}

async function handleSubscriptionEvent(event) {
  const { action, links } = event;
  try {
    const subscriptionId = links.subscription;
    console.log('[GoCardless] Subscription event:', { action, subscriptionId });

    if (!subscriptionId) {
      console.log('[GoCardless] Pas de subscription id dans l\'événement');
      return;
    }

    // Récupérer la subscription pour obtenir le statut et next_charge_date
    let subscription = null;
    try {
      const resp = await axios.get(`${getGoCardlessApiUrl()}/subscriptions/${subscriptionId}`, {
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      });
      subscription = resp.data.subscriptions;
    } catch (e) {
      console.warn('[GoCardless] Impossible de récupérer la subscription via API:', e.response?.data || e.message);
    }

    // Trouver la maintenance associée
    let maintenance = null;
    if (db) {
      try {
        maintenance = await findMaintenanceBySubscriptionId(subscriptionId);
      } catch (e) {
        console.error('[GoCardless] Erreur recherche maintenance par subscriptionId:', e);
      }
    }

    // Si trouvé, mettre à jour Firestore avec le statut de la subscription
    if (maintenance && db) {
      try {
        const maintenanceRef = doc(db, 'maintenances', maintenance.id);
        const updateData = {
          subscriptionStatus: subscription?.status || action,
          updatedAt: new Date(),
          ...(subscription?.next_charge_date && { nextChargeDate: subscription.next_charge_date }),
          ...(subscription && { subscriptionMetadata: subscription })
        };

        console.log('[GoCardless] Mise à jour Firestore subscription:', { maintenanceId: maintenance.id, updateData });
        await updateDoc(maintenanceRef, updateData);
      } catch (e) {
        console.error('[GoCardless] Erreur mise à jour Firestore pour subscription:', e);
      }
    } else {
      console.log('[GoCardless] Aucune maintenance trouvée pour subscriptionId:', subscriptionId);
    }

    // Actions spécifiques
    switch (action) {
      case 'created':
        console.log('[GoCardless] Abonnement créé:', subscriptionId);
        break;
      case 'active':
      case 'activated':
        console.log('[GoCardless] Abonnement activé:', subscriptionId);
        break;
      case 'cancelled':
      case 'cancelled_by_merchant':
        console.log('[GoCardless] Abonnement annulé:', subscriptionId);
        break;
      case 'updated':
        console.log('[GoCardless] Abonnement mis à jour:', subscriptionId);
        break;
      default:
        console.log('[GoCardless] Action d\'abonnement non gérée:', action);
    }
  } catch (err) {
    console.error('[GoCardless] Erreur handleSubscriptionEvent:', err);
  }
}

// Trouver une maintenance par subscriptionId
async function findMaintenanceBySubscriptionId(subscriptionId) {
  try {
    if (!db) return null;
    const maintenancesRef = collection(db, 'maintenances');
    const q = query(maintenancesRef, where('subscriptionId', '==', subscriptionId));
    const snapshot = await getDocs(q);
    if (!snapshot.empty) {
      const docSnap = snapshot.docs[0];
      console.log('[Webhook] Maintenance trouvée via subscriptionId:', docSnap.id);
      return { id: docSnap.id, ...docSnap.data() };
    }

    // Sinon, parcourir pour trouver dans les metadata ou subscriptionMetadata
    const allSnap = await getDocs(maintenancesRef);
    for (const d of allSnap.docs) {
      const data = d.data();
      if ((data.subscriptionId && data.subscriptionId === subscriptionId) || (data.subscription && data.subscription.id === subscriptionId)) {
        console.log('[Webhook] Maintenance trouvée via scan:', d.id);
        return { id: d.id, ...data };
      }
    }

    return null;
  } catch (e) {
    console.error('[Webhook] Erreur findMaintenanceBySubscriptionId:', e);
    return null;
  }
}

// ✅ NOUVEAU : Fonctions de gestion avancée des événements

/**
 * Déclencher automatiquement le premier paiement après activation du mandat
 */
async function triggerFirstPayment(mandateId) {
  try {
    console.log(`[GoCardless] Déclenchement du premier paiement pour le mandat: ${mandateId}`);

    // Récupérer les informations du mandat
    const mandateResponse = await axios.get(`${getGoCardlessApiUrl()}/mandates/${mandateId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const mandate = mandateResponse.data.mandates;
    const metadata = mandate.metadata || {};
    const maintenanceId = metadata.maintenanceId;

    if (!maintenanceId) {
      console.log(`[GoCardless] Pas de maintenanceId dans les métadonnées du mandat: ${mandateId}`);
      return;
    }

    // Récupérer les informations de maintenance depuis Firebase
    // (Cette partie sera gérée par le frontend via le scheduler)
    console.log(`[GoCardless] Premier paiement déclenché pour la maintenance: ${maintenanceId}`);

  } catch (error) {
    console.error(`[GoCardless] Erreur lors du déclenchement du premier paiement:`, error);
  }
}

/**
 * Gérer la confirmation d'un paiement et déclencher le suivant
 */
async function handlePaymentConfirmed(paymentId) {
  try {
    console.log(`[GoCardless] Gestion de la confirmation du paiement: ${paymentId}`);

    // Récupérer les informations du paiement
    const paymentResponse = await axios.get(`${getGoCardlessApiUrl()}/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const payment = paymentResponse.data.payments;
    const metadata = payment.metadata || {};

    // ✅ CORRECTION : Chercher maintenance_id (snake_case) au lieu de maintenanceId (camelCase)
    // GoCardless normalise les métadonnées en snake_case
    let maintenanceId = metadata.maintenance_id || metadata.maintenanceId;

    // Si pas trouvé, chercher dans la clé "extra" (format: "due:2025-11-20|test:true|cycle:123")
    if (!maintenanceId && metadata.extra) {
      const extraMatch = metadata.extra.match(/maintenance[_:]([^|]+)/i);
      if (extraMatch) {
        maintenanceId = extraMatch[1];
      }
    }

    // Si toujours pas trouvé, essayer de trouver via le paymentId dans Firebase
    if (!maintenanceId) {
      console.log(`[GoCardless] Pas de maintenance_id dans les métadonnées, recherche via paymentId: ${paymentId}`);
      const maintenance = await findMaintenanceByPaymentId(paymentId);
      if (maintenance) {
        maintenanceId = maintenance.id;
        console.log(`[GoCardless] Maintenance trouvée via paymentId: ${maintenanceId}`);
      }
    }

    if (!maintenanceId) {
      console.log(`[GoCardless] Pas de maintenanceId trouvé pour le paiement: ${paymentId}`);
      console.log(`[GoCardless] Métadonnées disponibles:`, JSON.stringify(metadata, null, 2));
      return;
    }

    // ✅ NOUVEAU : Notifier le frontend pour créer automatiquement le prochain paiement
    await notifyFrontendPaymentConfirmed(maintenanceId, paymentId, payment);

  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la gestion de la confirmation:`, error);
  }
}

/**
 * Gérer l'échec d'un paiement
 */
async function handlePaymentFailed(paymentId) {
  try {
    console.log(`[GoCardless] Gestion de l'échec du paiement: ${paymentId}`);

    const paymentResponse = await axios.get(`${getGoCardlessApiUrl()}/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const payment = paymentResponse.data.payments;
    const metadata = payment.metadata || {};
    const maintenanceId = metadata.maintenanceId;

    if (maintenanceId) {
      // ✅ NOUVEAU : Notifier le frontend de l'échec
      await notifyFrontendPaymentFailed(maintenanceId, paymentId, payment);
    }

  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la gestion de l'échec:`, error);
  }
}

/**
 * Gérer la soumission d'un paiement
 */
async function handlePaymentSubmitted(paymentId) {
  try {
    console.log(`[GoCardless] Gestion de la soumission du paiement: ${paymentId}`);

    const paymentResponse = await axios.get(`${getGoCardlessApiUrl()}/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const payment = paymentResponse.data.payments;
    const metadata = payment.metadata || {};
    const maintenanceId = metadata.maintenanceId;

    if (maintenanceId) {
      // ✅ NOUVEAU : Notifier le frontend de la soumission
      await notifyFrontendPaymentSubmitted(maintenanceId, paymentId, payment);
    }

  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la gestion de la soumission:`, error);
  }
}

/**
 * Gérer la création d'un paiement
 */
async function handlePaymentCreated(paymentId) {
  try {
    console.log(`[GoCardless] Gestion de la création du paiement: ${paymentId}`);

    const paymentResponse = await axios.get(`${getGoCardlessApiUrl()}/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const payment = paymentResponse.data.payments;
    const metadata = payment.metadata || {};
    const maintenanceId = metadata.maintenanceId;

    if (maintenanceId) {
      // ✅ NOUVEAU : Notifier le frontend de la création
      await notifyFrontendPaymentCreated(maintenanceId, paymentId, payment);
    }

  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la gestion de la création:`, error);
  }
}

/**
 * Gérer l'annulation d'un paiement
 */
async function handlePaymentCancelled(paymentId) {
  try {
    console.log(`[GoCardless] Gestion de l'annulation du paiement: ${paymentId}`);

    const paymentResponse = await axios.get(`${getGoCardlessApiUrl()}/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const payment = paymentResponse.data.payments;
    const metadata = payment.metadata || {};
    const maintenanceId = metadata.maintenanceId;

    if (maintenanceId) {
      // ✅ NOUVEAU : Notifier le frontend de l'annulation
      await notifyFrontendPaymentCancelled(maintenanceId, paymentId, payment);
    }

  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la gestion de l'annulation:`, error);
  }
}

/**
 * Gérer l'annulation d'un mandat
 */
async function handleMandateCancellation(mandateId) {
  try {
    console.log(`[GoCardless] Gestion de l'annulation du mandat: ${mandateId}`);

    // ✅ NOUVEAU : Notifier le frontend de l'annulation du mandat
    await notifyFrontendMandateCancelled(mandateId);

  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la gestion de l'annulation du mandat:`, error);
  }
}

/**
 * Gérer l'expiration d'un mandat
 */
async function handleMandateExpiration(mandateId) {
  try {
    console.log(`[GoCardless] Gestion de l'expiration du mandat: ${mandateId}`);

    // ✅ NOUVEAU : Notifier le frontend de l'expiration du mandat
    await notifyFrontendMandateExpired(mandateId);

  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la gestion de l'expiration du mandat:`, error);
  }
}

// ✅ NOUVEAU : Fonctions de notification du frontend

/**
 * Notifier le frontend qu'un paiement est confirmé
 */
async function notifyFrontendPaymentConfirmed(maintenanceId, paymentId, payment) {
  try {
    // ✅ NOTE : Cette notification est optionnelle - les webhooks mettent déjà à jour Firebase directement
    // L'endpoint frontend n'existe pas encore, donc on désactive cette notification pour éviter les erreurs 404
    // Si besoin, créer l'endpoint dans le frontend plus tard
    console.log(`[GoCardless] 💡 Notification frontend désactivée (endpoint non implémenté) - Firebase déjà mis à jour via webhook`);
    return;

    /* DÉSACTIVÉ TEMPORAIREMENT - Endpoint frontend non implémenté
    const response = await axios.post(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/api/gocardless/payment-update`, {
      maintenanceId,
      paymentId,
      status: 'confirmed',
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        created_at: payment.created_at,
        charge_date: payment.charge_date
      }
    });
    
    console.log(`[GoCardless] Frontend notifié de la confirmation du paiement: ${paymentId}`);
    */

  } catch (error) {
    // Erreur silencieuse - notification optionnelle
  }
}

/**
 * Notifier le frontend qu'un paiement a échoué
 */
async function notifyFrontendPaymentFailed(maintenanceId, paymentId, payment) {
  try {
    // ✅ NOTE : Notification désactivée - Firebase déjà mis à jour via webhook
    console.log(`[GoCardless] 💡 Notification frontend désactivée (endpoint non implémenté)`);
    return;
    /* DÉSACTIVÉ
    const response = await axios.post(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/api/gocardless/payment-update`, {
      maintenanceId,
      paymentId,
      status: 'failed',
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        created_at: payment.created_at,
        charge_date: payment.charge_date
      }
    });
    
    console.log(`[GoCardless] Frontend notifié de l'échec du paiement: ${paymentId}`);
    */

  } catch (error) {
    // Erreur silencieuse - notification optionnelle
  }
}

/**
 * Notifier le frontend qu'un paiement est soumis
 */
async function notifyFrontendPaymentSubmitted(maintenanceId, paymentId, payment) {
  try {
    // ✅ NOTE : Notification désactivée - Firebase déjà mis à jour via webhook
    console.log(`[GoCardless] 💡 Notification frontend désactivée (endpoint non implémenté)`);
    return;
    /* DÉSACTIVÉ
    const response = await axios.post(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/api/gocardless/payment-update`, {
      maintenanceId,
      paymentId,
      status: 'submitted',
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        created_at: payment.created_at,
        charge_date: payment.charge_date
      }
    });
    
    console.log(`[GoCardless] Frontend notifié de la soumission du paiement: ${paymentId}`);
    */

  } catch (error) {
    // Erreur silencieuse - notification optionnelle
  }
}

/**
 * Notifier le frontend qu'un paiement est créé
 */
async function notifyFrontendPaymentCreated(maintenanceId, paymentId, payment) {
  try {
    // ✅ NOTE : Notification désactivée - Firebase déjà mis à jour via webhook
    console.log(`[GoCardless] 💡 Notification frontend désactivée (endpoint non implémenté)`);
    return;
    /* DÉSACTIVÉ
    const response = await axios.post(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/api/gocardless/payment-update`, {
      maintenanceId,
      paymentId,
      status: 'created',
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        created_at: payment.created_at,
        charge_date: payment.charge_date
      }
    });
    
    console.log(`[GoCardless] Frontend notifié de la création du paiement: ${paymentId}`);
    */

  } catch (error) {
    // Erreur silencieuse - notification optionnelle
  }
}

/**
 * Notifier le frontend qu'un paiement est annulé
 */
async function notifyFrontendPaymentCancelled(maintenanceId, paymentId, payment) {
  try {
    // ✅ NOTE : Notification désactivée - Firebase déjà mis à jour via webhook
    console.log(`[GoCardless] 💡 Notification frontend désactivée (endpoint non implémenté)`);
    return;
    /* DÉSACTIVÉ
    const response = await axios.post(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/api/gocardless/payment-update`, {
      maintenanceId,
      paymentId,
      status: 'cancelled',
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        created_at: payment.created_at,
        charge_date: payment.charge_date
      }
    });
    
    console.log(`[GoCardless] Frontend notifié de l'annulation du paiement: ${paymentId}`);
    */

  } catch (error) {
    // Erreur silencieuse - notification optionnelle
  }
}

/**
 * Notifier le frontend qu'un mandat est annulé
 */
async function notifyFrontendMandateCancelled(mandateId) {
  try {
    const response = await axios.post(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/api/gocardless/mandate-update`, {
      mandateId,
      status: 'cancelled'
    });

    console.log(`[GoCardless] Frontend notifié de l'annulation du mandat: ${mandateId}`);

  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la notification du frontend:`, error);
  }
}

/**
 * Notifier le frontend qu'un mandat est expiré
 */
async function notifyFrontendMandateExpired(mandateId) {
  try {
    const response = await axios.post(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/api/gocardless/mandate-update`, {
      mandateId,
      status: 'expired'
    });

    console.log(`[GoCardless] Frontend notifié de l'expiration du mandat: ${mandateId}`);

  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la notification du frontend:`, error);
  }
}

// GET : récupérer le statut d'une signature YouSign
app.get('/api/yousign/status/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    console.log('[Yousign] Vérification du statut de la signature:', requestId);
    console.log('[Yousign] Variables d\'environnement:', {
      YOUSIGN_API_KEY: process.env.YOUSIGN_API_KEY ? 'PRÉSENTE' : 'MANQUANTE',
      YOUSIGN_API_URL: process.env.YOUSIGN_API_URL,
      NODE_ENV: process.env.NODE_ENV
    });

    if (!process.env.YOUSIGN_API_KEY) {
      console.log('[Yousign] ERREUR: YOUSIGN_API_KEY manquante');
      return res.status(500).json({
        error: 'YOUSIGN_API_KEY manquant'
      });
    }

    // Appel à l'API YouSign officielle
    console.log('[Yousign] Appel API YouSign avec clé:', process.env.YOUSIGN_API_KEY ? 'PRÉSENTE' : 'MANQUANTE');
    // Utiliser YOUSIGN_API_URL normalisé (déjà avec /v3) et signature_requests avec underscore
    const apiUrl = `${YOUSIGN_API_URL}/signature_requests/${requestId}`;
    console.log('[Yousign] URL appelée:', apiUrl);

    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.YOUSIGN_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const signatureRequest = response.data;
    console.log('[Yousign] Statut récupéré:', signatureRequest.status);

    // Formater la réponse pour le frontend
    const formattedResponse = {
      data: {
        id: signatureRequest.id,
        status: signatureRequest.status,
        signed_at: signatureRequest.signed_at,
        declined_at: signatureRequest.declined_at,
        expired_at: signatureRequest.expired_at,
        created_at: signatureRequest.created_at,
        updated_at: signatureRequest.updated_at
      },
      signers: signatureRequest.signers?.map(signer => ({
        id: signer.id,
        email: signer.email,
        status: signer.status,
        signed_at: signer.signed_at,
        declined_at: signer.declined_at
      })) || []
    };

    res.json(formattedResponse);

  } catch (error) {
    console.error('[Yousign] Erreur lors de la récupération du statut:', error.response?.data || error.message);

    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'Demande de signature non trouvée' });
    }

    res.status(500).json({
      error: 'Erreur lors de la récupération du statut de signature',
      details: error.response?.data || error.message
    });
  }
});

// GET : récupérer une maintenance par ID (pour les tests)
app.get('/api/maintenance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('[Maintenance] Récupération de la maintenance:', id);

    // ✅ Vérifier que Firebase est initialisé
    if (!db) {
      return res.status(503).json({
        error: 'Firebase non configuré',
        message: 'Les variables d\'environnement Firebase ne sont pas définies',
        details: 'Vérifiez votre fichier .env dans gocardless-backend/'
      });
    }

    try {
      const maintenanceRef = doc(db, 'maintenances', id);
      const maintenanceDoc = await getDoc(maintenanceRef);

      if (!maintenanceDoc.exists()) {
        return res.status(404).json({
          error: 'Maintenance non trouvée',
          id
        });
      }

      const maintenance = {
        id: maintenanceDoc.id,
        ...maintenanceDoc.data()
      };

      console.log(`[Maintenance] Maintenance trouvée: ${maintenance.contractNumber || id}`);
      res.json(maintenance);
    } catch (firebaseError) {
      // ✅ Gérer spécifiquement les erreurs Firebase
      if (firebaseError.code === 'unavailable' || firebaseError.code === 'invalid-argument') {
        console.error('[Maintenance] Erreur Firebase:', firebaseError.code, firebaseError.message);
        return res.status(503).json({
          error: 'Firebase non disponible',
          message: 'Impossible de se connecter à Firebase',
          details: firebaseError.message,
          code: firebaseError.code
        });
      }
      throw firebaseError; // Relancer les autres erreurs
    }

  } catch (error) {
    console.error('[Maintenance] Erreur récupération maintenance:', error);
    res.status(500).json({
      error: 'Erreur lors de la récupération de la maintenance',
      details: error.message,
      code: error.code
    });
  }
});

// GET : récupérer toutes les maintenances en attente de signature
app.get('/api/maintenance/pending-signatures', async (req, res) => {
  try {
    console.log('[Maintenance] Récupération des maintenances en attente de signature');

    // ✅ NOUVEAU : Récupérer toutes les maintenances et filtrer côté serveur
    // pour éviter les erreurs Firestore avec les requêtes complexes
    const maintenancesRef = collection(db, 'maintenances');
    const snapshot = await getDocs(maintenancesRef);

    const allMaintenances = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Filtrer côté serveur
    const maintenances = allMaintenances.filter(m => {
      const hasPendingSignature = m.signatureStatus === 'pending' || !m.signatureStatus;
      const hasYousignRequestId = m.yousignRequestId && m.yousignRequestId !== null;
      return hasPendingSignature && hasYousignRequestId;
    });

    console.log(`[Maintenance] ${maintenances.length} maintenances en attente trouvées sur ${allMaintenances.length} totales`);

    res.json({ maintenances });

  } catch (error) {
    console.error('[Maintenance] Erreur lors de la récupération des maintenances:', error);
    res.status(500).json({
      error: 'Erreur lors de la récupération des maintenances',
      details: error.message
    });
  }
});

// ✅ NOUVEAU : Endpoint alternatif avec le chemin correct
app.get('/maintenance/pending-signatures', async (req, res) => {
  try {
    console.log('[Maintenance] Récupération des maintenances en attente de signature (endpoint alternatif)');

    const maintenancesRef = collection(db, 'maintenances');
    const snapshot = await getDocs(maintenancesRef);

    const allMaintenances = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    const maintenances = allMaintenances.filter(m => {
      const hasPendingSignature = m.signatureStatus === 'pending' || !m.signatureStatus;
      const hasYousignRequestId = m.yousignRequestId && m.yousignRequestId !== null;
      return hasPendingSignature && hasYousignRequestId;
    });

    console.log(`[Maintenance] ${maintenances.length} maintenances en attente trouvées`);

    res.json({ maintenances });

  } catch (error) {
    console.error('[Maintenance] Erreur lors de la récupération des maintenances:', error);
    res.status(500).json({
      error: 'Erreur lors de la récupération des maintenances',
      details: error.message
    });
  }
});

// PATCH : mettre à jour le statut de signature d'une maintenance
app.patch('/api/maintenance/:id/signature', async (req, res) => {
  try {
    const { id } = req.params;
    const { signatureStatus, signatureDate } = req.body;

    console.log(`[Maintenance] Mise à jour de la signature pour ${id}:`, { signatureStatus, signatureDate });

    if (!signatureStatus) {
      return res.status(400).json({ error: 'signatureStatus est requis' });
    }

    // Mettre à jour dans Firestore
    const maintenanceRef = doc(db, 'maintenances', id);
    const updateData = {
      signatureStatus,
      updatedAt: new Date()
    };

    if (signatureDate) {
      updateData.signatureDate = signatureDate;
    }

    await updateDoc(maintenanceRef, updateData);

    console.log(`[Maintenance] Maintenance ${id} mise à jour avec succès`);

    res.json({
      success: true,
      message: 'Statut de signature mis à jour',
      data: updateData
    });

  } catch (error) {
    console.error('[Maintenance] Erreur lors de la mise à jour de la signature:', error);
    res.status(500).json({
      error: 'Erreur lors de la mise à jour de la signature',
      details: error.message
    });
  }
});

// GET : télécharger un contrat signé depuis YouSign
app.get('/api/yousign/download/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    console.log('[Yousign] Téléchargement du contrat signé:', requestId);
    console.log('[Yousign] Variables d\'environnement (download):', {
      YOUSIGN_API_KEY: process.env.YOUSIGN_API_KEY ? 'PRÉSENTE' : 'MANQUANTE',
      YOUSIGN_API_URL: process.env.YOUSIGN_API_URL,
      NODE_ENV: process.env.NODE_ENV
    });

    if (!process.env.YOUSIGN_API_KEY) {
      console.log('[Yousign] ERREUR: YOUSIGN_API_KEY manquante (download)');
      return res.status(500).json({
        error: 'YOUSIGN_API_KEY manquant'
      });
    }

    // Récupérer le document signé depuis YouSign
    console.log('[Yousign] Appel API YouSign documents avec clé:', process.env.YOUSIGN_API_KEY ? 'PRÉSENTE' : 'MANQUANTE');
    // Utiliser YOUSIGN_API_URL normalisé (déjà avec /v3) et signature_requests avec underscore
    const documentsUrl = `${YOUSIGN_API_URL}/signature_requests/${requestId}/documents`;
    console.log('[Yousign] URL documents appelée:', documentsUrl);

    const response = await axios.get(documentsUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.YOUSIGN_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.data || !response.data.length) {
      return res.status(404).json({ error: 'Aucun document trouvé pour cette signature' });
    }

    // Récupérer le premier document (normalement il n'y en a qu'un)
    const document = response.data[0];

    // Télécharger le fichier signé - utiliser la structure correcte de l'API YouSign
    const downloadUrl = `${YOUSIGN_API_URL}/signature_requests/${requestId}/documents/${document.id}/download`;
    console.log('[Yousign] URL download appelée:', downloadUrl);
    const fileResponse = await axios.get(downloadUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.YOUSIGN_API_KEY}`
      },
      responseType: 'stream'
    });

    // Configurer les headers pour le téléchargement
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Contrat_Signe_${requestId}.pdf"`);

    // Streamer le fichier vers la réponse
    fileResponse.data.pipe(res);

  } catch (error) {
    console.error('[Yousign] Erreur lors du téléchargement:', error.response?.data || error.message);

    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'Document signé non trouvé' });
    }

    res.status(500).json({
      error: 'Erreur lors du téléchargement du contrat signé',
      details: error.response?.data || error.message
    });
  }
});

// ============================================================================
// ROUTES SUMUP - GESTION DES PAIEMENTS
// ============================================================================

/**
 * POST /api/sumup/create-checkout
 * Créer un lien de paiement SumUp
 * Body: {
 *   devisId: string,
 *   devisNumber: string,
 *   amount: number,
 *   currency: string (optionnel, défaut: EUR),
 *   clientName: string,
 *   clientEmail: string,
 *   clientPhone: string (optionnel),
 *   description: string (optionnel),
 *   returnUrl: string (optionnel)
 * }
 */
app.post('/api/sumup/create-checkout', async (req, res) => {
  try {
    console.log('[SumUp] Requête de création de checkout reçue');
    console.log('[SumUp] Body:', JSON.stringify(req.body, null, 2));

    const {
      devisId,
      devisNumber,
      amount,
      currency = 'EUR',
      clientName,
      clientEmail,
      clientPhone,
      description,
      returnUrl
    } = req.body;

    // Validation des champs requis
    if (!devisId || !amount || !clientEmail) {
      console.error('[SumUp] Champs manquants:', { devisId, amount, clientEmail });
      return res.status(400).json({
        success: false,
        error: 'Champs requis manquants',
        details: 'devisId, amount et clientEmail sont requis'
      });
    }

    // Validation du montant
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Montant invalide',
        details: 'Le montant doit être un nombre positif'
      });
    }

    // Préparer les données du checkout
    const checkoutData = {
      devisId: devisId,
      amount: parsedAmount,
      currency: currency,
      clientEmail: clientEmail,
      description: description || `Paiement devis ${devisNumber || devisId} - ${clientName}`,
      returnUrl: returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/sav/payment-success`
    };

    console.log('[SumUp] Données du checkout préparées:', checkoutData);

    // Créer le checkout via le service SumUp
    const result = await sumupService.createCheckout(checkoutData);

    // Si on a Firebase, sauvegarder le lien de paiement dans Firestore
    if (db && result.success) {
      try {
        const maintenanceRef = doc(db, 'maintenances', devisId);
        await updateDoc(maintenanceRef, {
          sumup_checkout_id: result.checkout_id,
          sumup_payment_url: result.payment_url,
          sumup_created_at: new Date().toISOString(),
          sumup_status: result.status
        });
        console.log('[SumUp] Lien de paiement sauvegardé dans Firestore pour:', devisId);
      } catch (firestoreError) {
        console.warn('[SumUp] Impossible de sauvegarder dans Firestore:', firestoreError.message);
      }
    }

    res.json(result);

  } catch (error) {
    console.error('[SumUp] Erreur lors de la création du checkout:', error);
    res.status(error.status || 500).json(
      error.success === false ? error : {
        success: false,
        error: 'Erreur lors de la création du lien de paiement',
        details: error.message
      }
    );
  }
});

/**
 * GET /api/sumup/checkout/:checkoutId
 * Récupérer les informations d'un checkout
 */
app.get('/api/sumup/checkout/:checkoutId', async (req, res) => {
  try {
    const { checkoutId } = req.params;
    console.log('[SumUp] Récupération des informations du checkout:', checkoutId);

    const result = await sumupService.getCheckout(checkoutId);
    res.json(result);

  } catch (error) {
    console.error('[SumUp] Erreur lors de la récupération du checkout:', error);
    res.status(error.status || 500).json(
      error.success === false ? error : {
        success: false,
        error: 'Erreur lors de la récupération du checkout',
        details: error.message
      }
    );
  }
});

/**
 * GET /api/sumup/config
 * Vérifier la configuration SumUp
 */
app.get('/api/sumup/config', (req, res) => {
  const config = sumupService.checkSumUpConfig();
  res.json(config);
});

/**
 * POST /api/sumup/test-token
 * Tester l'obtention du token OAuth2
 */
app.post('/api/sumup/test-token', async (req, res) => {
  try {
    console.log('[SumUp] Test d\'obtention du token OAuth2');
    const token = await sumupService.getAccessToken();

    res.json({
      success: true,
      message: 'Token obtenu avec succès',
      token_preview: token ? `${token.substring(0, 20)}...` : null,
      token_length: token ? token.length : 0
    });
  } catch (error) {
    console.error('[SumUp] Erreur test token:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'obtention du token',
      details: error.message
    });
  }
});

// Lancer le serveur
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Serveur Yousign backend démarré sur le port ${PORT}`);
});

// POST : Webhook GoCardless pour les mises à jour de statut de paiement
app.post('/webhooks/gocardless', async (req, res) => {
  try {
    console.log('[Webhook] Réception webhook GoCardless');

    // Validation de la signature du webhook
    const signature = req.headers['webhook-signature'];
    const payload = JSON.stringify(req.body);

    if (!validateGoCardlessWebhook(payload, signature)) {
      console.error('[Webhook] Signature invalide, webhook rejeté');
      return res.status(401).json({ error: 'Signature invalide' });
    }

    const { events } = req.body;
    console.log('[Webhook] Événements reçus:', events?.length || 0);

    if (!events || !Array.isArray(events)) {
      console.log('[Webhook] Aucun événement reçu');
      return res.status(200).json({ message: 'Aucun événement à traiter' });
    }

    let processedCount = 0;
    let errorCount = 0;

    // Traiter chaque événement
    for (const event of events) {
      try {
        const success = await processGoCardlessPaymentEvent(event);
        if (success) {
          processedCount++;
        } else {
          errorCount++;
        }
      } catch (error) {
        console.error('[Webhook] Erreur traitement événement:', event.id, error);
        errorCount++;
      }
    }

    console.log('[Webhook] Traitement terminé:', { processed: processedCount, errors: errorCount });

    res.status(200).json({
      message: 'Webhook traité avec succès',
      processed: processedCount,
      errors: errorCount
    });

  } catch (error) {
    console.error('[Webhook] Erreur générale webhook:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur',
      details: error.message
    });
  }
});

// GET : Test du webhook GoCardless (pour développement)
app.get('/webhooks/gocardless/test', async (req, res) => {
  try {
    console.log('[Webhook] Test du webhook GoCardless');

    // Simuler un événement de test
    const testEvent = {
      id: 'test_event_' + Date.now(),
      resource_type: 'payment',
      action: 'confirmed',
      links: {
        payment: 'test_payment_id'
      },
      created_at: new Date().toISOString()
    };

    const success = await processGoCardlessPaymentEvent(testEvent);

    res.json({
      message: 'Test webhook terminé',
      success: success,
      testEvent: testEvent,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('[Webhook] Erreur test webhook:', error);
    res.status(500).json({
      error: 'Erreur lors du test du webhook',
      details: error.message
    });
  }
});

// POST : Configuration des webhooks GoCardless
app.post('/api/gocardless/webhooks/setup', async (req, res) => {
  try {
    console.log('[Webhook] Configuration des webhooks GoCardless');

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(400).json({ error: 'GOCARDLESS_ACCESS_TOKEN manquant' });
    }

    const webhookUrl = `${req.protocol}://${req.get('host')}/webhooks/gocardless`;
    console.log('[Webhook] URL webhook:', webhookUrl);

    // Créer le webhook via l'API GoCardless
    const response = await axios.post(
      `${getGoCardlessApiUrl()}/webhooks`,
      {
        url: webhookUrl,
        events: [
          'payment.created',
          'payment.confirmed',
          'payment.paid_out',
          'payment.failed',
          'payment.cancelled',
          'payment.charged_back',
          'payment.submitted'
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('[Webhook] Webhook créé avec succès:', response.data);

    res.json({
      success: true,
      message: 'Webhook GoCardless configuré avec succès',
      webhook: response.data,
      webhookUrl: webhookUrl
    });

  } catch (error) {
    console.error('[Webhook] Erreur configuration webhook:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la configuration du webhook',
      details: error.response?.data || error.message
    });
  }
});

// GET : Statut des webhooks GoCardless
app.get('/api/gocardless/webhooks/status', async (req, res) => {
  try {
    console.log('[Webhook] Vérification statut des webhooks GoCardless');

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(400).json({ error: 'GOCARDLESS_ACCESS_TOKEN manquant' });
    }

    const response = await axios.get(
      `${getGoCardlessApiUrl()}/webhooks`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06'
        }
      }
    );

    const webhooks = response.data.webhooks || [];
    const activeWebhooks = webhooks.filter(w => w.status === 'active');

    res.json({
      success: true,
      total: webhooks.length,
      active: activeWebhooks.length,
      webhooks: webhooks.map(w => ({
        id: w.id,
        url: w.url,
        status: w.status,
        events: w.events,
        created_at: w.created_at
      }))
    });

  } catch (error) {
    console.error('[Webhook] Erreur vérification statut webhooks:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la vérification du statut des webhooks',
      details: error.response?.data || error.message
    });
  }
});
