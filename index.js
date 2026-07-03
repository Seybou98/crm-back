// Chargement optionnel du fichier .env (local) — sur Render / CI il n’y a pas de .env : tout vient de process.env
const path = require('path');
const fs = require('fs');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const result = require('dotenv').config({ path: envPath });
  if (result.error) {
    console.error('❌ Erreur lors du chargement du fichier .env:', result.error);
  } else {
    console.log('✅ Fichier .env chargé:', envPath);
  }
} else {
  console.log('ℹ️ Fichier .env absent — variables depuis process.env uniquement (normal sur Render).');
}
console.log('🔑 Synthèse variables:', {
  DOCUSIGN_INTEGRATION_KEY: process.env.DOCUSIGN_INTEGRATION_KEY ? 'PRÉSENTE' : 'MANQUANTE',
  DOCUSIGN_USER_ID: process.env.DOCUSIGN_USER_ID ? 'PRÉSENTE' : 'MANQUANTE',
  DOCUSIGN_ACCOUNT_ID: process.env.DOCUSIGN_ACCOUNT_ID ? 'PRÉSENTE' : 'MANQUANTE',
  DOCUSIGN_PRIVATE_KEY: process.env.DOCUSIGN_PRIVATE_KEY ? 'PRÉSENTE' : 'MANQUANTE',
  SUMUP_CLIENT_ID: process.env.SUMUP_CLIENT_ID ? 'PRÉSENTE' : 'MANQUANTE',
  SUMUP_CLIENT_SECRET: process.env.SUMUP_CLIENT_SECRET ? 'PRÉSENTE' : 'MANQUANTE',
  SUMUP_MERCHANT_CODE: process.env.SUMUP_MERCHANT_CODE || 'MANQUANT',
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ? 'PRÉSENT' : 'MANQUANT',
  PORT: process.env.PORT,
  NODE_ENV: process.env.NODE_ENV
});
const express = require('express');
const FormData = require('form-data');
const axios = require('axios');
const cors = require('cors');
const nodemailer = require('nodemailer');

// Importer les routes de test
const testRoutes = require('./test-endpoints');

// Importer le service SumUp
const sumupService = require('./sumup-service');

// Service DocuSign (signature électronique - remplace YouSign)
const docusignService = require('./docusign-service');

// Firestore Admin (service account) — bypass Security Rules
const admin = require('firebase-admin');

// Mini-adapter pour conserver les appels style "firebase/firestore"
// (doc, collection, query, where, getDoc, getDocs, setDoc, updateDoc)
function collection(db, name) {
  return db.collection(name);
}

function doc(refOrDb, colName, id) {
  // doc(db,'collection','id')
  if (refOrDb && typeof refOrDb.collection === 'function' && typeof colName === 'string' && typeof id === 'string') {
    return refOrDb.collection(colName).doc(id);
  }
  // doc(collection(db,'x')) -> auto id
  if (refOrDb && typeof refOrDb.doc === 'function' && colName === undefined && id === undefined) {
    return refOrDb.doc();
  }
  throw new Error('doc(): arguments invalides');
}

function where(field, op, value) {
  return { field, op, value };
}

function query(colRef, ...clauses) {
  let q = colRef;
  for (const c of clauses) {
    if (!c) continue;
    if (typeof c === 'object' && 'field' in c && 'op' in c) {
      q = q.where(c.field, c.op, c.value);
    }
  }
  return q;
}

function wrapDocSnapshot(snap) {
  if (!snap) return snap;
  return {
    id: snap.id,
    ref: snap.ref,
    exists: () => !!snap.exists,
    data: () => snap.data(),
    get: (fieldPath) => snap.get(fieldPath),
  };
}

function wrapQuerySnapshot(snap) {
  if (!snap) return snap;
  return {
    empty: snap.empty,
    size: snap.size,
    docs: Array.isArray(snap.docs) ? snap.docs.map(wrapDocSnapshot) : [],
    forEach: (cb) => snap.forEach((d) => cb(wrapDocSnapshot(d))),
  };
}

async function getDocs(q) {
  const snap = await q.get();
  return wrapQuerySnapshot(snap);
}

async function getDoc(docRef) {
  const snap = await docRef.get();
  return wrapDocSnapshot(snap);
}

async function setDoc(docRef, data) {
  await docRef.set(data);
}

async function updateDoc(docRef, data) {
  await docRef.update(data);
}

const app = express();
// Augmenter la limite de taille pour permettre l'envoi de PDF en base64 (jusqu'à 50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Configuration CORS dynamique pour production
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  process.env.ADMIN_URL || 'http://localhost:3000',
  'https://labelenergie2.netlify.app', // Frontend Netlify (ancien)
  'https://labelenergie1.netlify.app', // Frontend Netlify (nouveau)
  'https://labelenergie234.netlify.app', // Frontend Netlify test
  'http://localhost:5173', // Fallback pour développement
  'http://localhost:3000',  // Fallback pour développement
  'http://localhost:4173'   // Fallback pour développement
];

function isAllowedLanDevOrigin(origin) {
  if (!origin) return false;
  // Autoriser les origins LAN sur port Vite en dev (ex: http://192.168.8.157:5173)
  // Activable via ALLOW_LAN_ORIGINS=true (par défaut true en dev).
  const allowLan =
    String(process.env.ALLOW_LAN_ORIGINS ?? (process.env.NODE_ENV ? 'false' : 'true')).toLowerCase() === 'true';
  if (!allowLan) return false;
  return /^http:\/\/(192\.168|10|172\.(1[6-9]|2\d|3[0-1]))\.\d{1,3}\.\d{1,3}:(5173|4173)$/.test(origin);
}

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

    if (allowedOrigins.includes(origin) || isAllowedLanDevOrigin(origin)) {
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

// Signature électronique : DocuSign (exclusif, remplace YouSign)
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || 'service_wl6kjuo';
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || 'template_nfsa5wv';
const EMAILJS_USER_ID = process.env.EMAILJS_USER_ID || '9DbPDdjUGFwv3WVZ0';

// Email de bienvenue après signature (peut réutiliser les IDs par défaut)
const EMAILJS_WELCOME_SERVICE_ID = process.env.EMAILJS_WELCOME_SERVICE_ID || EMAILJS_SERVICE_ID;
const EMAILJS_WELCOME_TEMPLATE_ID = process.env.EMAILJS_WELCOME_TEMPLATE_ID || EMAILJS_TEMPLATE_ID;
const EMAILJS_WELCOME_USER_ID = process.env.EMAILJS_WELCOME_USER_ID || EMAILJS_USER_ID;
// Private key / access token (EmailJS "Use Private Key" mode)
const EMAILJS_WELCOME_PRIVATE_KEY =
  process.env.EMAILJS_WELCOME_PRIVATE_KEY || process.env.EMAILJS_PRIVATE_KEY || '';

async function sendWelcomeEmailViaEmailJs(args) {
  const {
    toEmail,
    clientName,
    contractNumber,
    maintenanceId,
    contractId,
    // Pour template welcome : date d'activation (souvent date de signature)
    activationDate,
    signatureDate,
    paymentMethod,
    formulaName,
    equipments,
    monthlyAmount,
    hotlinePhone,
    supportEmail,
  } = args || {};

  if (!toEmail || typeof toEmail !== 'string' || !toEmail.includes('@')) {
    throw new Error('EmailJS welcome: toEmail manquant ou invalide');
  }

  if (!EMAILJS_WELCOME_SERVICE_ID || !EMAILJS_WELCOME_TEMPLATE_ID || !EMAILJS_WELCOME_USER_ID) {
    throw new Error('EmailJS welcome: variables d’environnement manquantes (service/template/user)');
  }

  const frontendUrl = process.env.FRONTEND_URL || process.env.PUBLIC_URL || process.env.ADMIN_URL || '';
  const portalUrl = frontendUrl ? `${frontendUrl.replace(/\/$/, '')}/client-portal` : '';

  const resolvedActivationDate = (activationDate || signatureDate || '').toString();
  const resolvedHotline = (hotlinePhone || '01 81 72 39 59').toString();
  const resolvedSupport = (supportEmail || 'sav@labelenergie.fr').toString();
  const resolvedEquipments = Array.isArray(equipments) ? equipments.join(', ') : (equipments || '').toString();
  const resolvedMonthly =
    typeof monthlyAmount === 'number'
      ? `${monthlyAmount.toFixed(2).replace('.', ',')} €`
      : (monthlyAmount || '').toString();

  const templateParams = {
    to_email: toEmail.trim(),
    client_name: (clientName || '').toString(),
    // Champs attendus par l'email BIENVENUE — ACTIVATION DE VOS SERVICES
    formula_name: (formulaName || '').toString(),
    activation_date: resolvedActivationDate,
    equipments: resolvedEquipments,
    monthly_amount: resolvedMonthly,
    hotline_phone: resolvedHotline,
    support_email: resolvedSupport,

    contract_number: (contractNumber || '').toString(),
    maintenance_id: (maintenanceId || '').toString(),
    contract_id: (contractId || '').toString(),
    signature_date: (signatureDate || '').toString(),
    payment_method: (paymentMethod || '').toString(),
    portal_url: portalUrl,
    // Variantes fréquentes selon templates EmailJS
    email: toEmail.trim(),
    recipient_email: toEmail.trim(),
  };

  // EmailJS REST API (côté serveur)
  const startedAt = Date.now();
  console.log('[EmailJS][Welcome] → send', {
    serviceId: EMAILJS_WELCOME_SERVICE_ID,
    templateId: EMAILJS_WELCOME_TEMPLATE_ID,
    to: toEmail,
    contractNumber,
    maintenanceId,
    usingPrivateKey: !!EMAILJS_WELCOME_PRIVATE_KEY,
  });

  const payload = {
    service_id: EMAILJS_WELCOME_SERVICE_ID,
    template_id: EMAILJS_WELCOME_TEMPLATE_ID,
    // Le user_id (public key) fonctionne en mode navigateur.
    // En mode serveur + "Use Private Key", on ajoute accessToken.
    user_id: EMAILJS_WELCOME_USER_ID,
    ...(EMAILJS_WELCOME_PRIVATE_KEY ? { accessToken: EMAILJS_WELCOME_PRIVATE_KEY } : {}),
    template_params: templateParams,
  };

  const response = await axios.post(
    'https://api.emailjs.com/api/v1.0/email/send',
    payload,
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    }
  );

  console.log('[EmailJS][Welcome] ✅ sent', { ms: Date.now() - startedAt, status: response.status });
}

// Configuration Firebase pour la synchronisation YouSign
let db = null;
try {
  // Mode sélectionné par env
  // - FIREBASE_USE_SERVICE_ACCOUNT=true|false (default: true)
  // - FIREBASE_SERVICE_ACCOUNT_PATH=... (optional)
  // - FIREBASE_SERVICE_ACCOUNT_JSON=... (optional, JSON string)
  // - Ou variables « déployeur » (Render, etc.) : FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
  // - GOOGLE_APPLICATION_CREDENTIALS=... (ADC)
  const useServiceAccount = String(process.env.FIREBASE_USE_SERVICE_ACCOUNT ?? 'true').toLowerCase() !== 'false';
  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, 'serviceAccountKey.json');

  /** Construit l’objet compte de service à partir des variables séparées (souvent sur Render sans fichier JSON). */
  function serviceAccountFromSplitEnv() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const rawKey = process.env.FIREBASE_PRIVATE_KEY;
    if (!projectId || !clientEmail || !rawKey) return null;
    const privateKey = String(rawKey).includes('\\n')
      ? String(rawKey).replace(/\\n/g, '\n')
      : String(rawKey);
    const sa = {
      type: 'service_account',
      project_id: projectId,
      private_key: privateKey,
      client_email: clientEmail,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(clientEmail)}`,
    };
    if (process.env.FIREBASE_PRIVATE_KEY_ID) sa.private_key_id = process.env.FIREBASE_PRIVATE_KEY_ID;
    if (process.env.FIREBASE_CLIENT_ID) sa.client_id = process.env.FIREBASE_CLIENT_ID;
    return sa;
  }

  if (useServiceAccount) {
    let serviceAccount = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      } catch (e) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON invalide (JSON parse error)');
      }
    } else if (fs.existsSync(serviceAccountPath)) {
      serviceAccount = require(serviceAccountPath);
    } else {
      serviceAccount = serviceAccountFromSplitEnv();
    }

    if (serviceAccount) {
      if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      }
      db = admin.firestore();
      const src = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
        ? 'FIREBASE_SERVICE_ACCOUNT_JSON'
        : fs.existsSync(serviceAccountPath)
          ? serviceAccountPath
          : 'FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY';
      console.log('✅ Firebase Admin initialisé (service account)', { source: src });
      console.log('[Firebase Admin] projectId:', serviceAccount.project_id || serviceAccount.projectId || '(unknown)');
    } else {
      // Pas de fichier/JSON → fallback ADC
      if (!admin.apps.length) admin.initializeApp();
      db = admin.firestore();
      console.log('✅ Firebase Admin initialisé (ADC / variables d’environnement)');
    }
  } else {
    // Mode "env only": on n'utilise PAS le fichier serviceAccountKey.json local.
    // On initialise explicitement avec le JSON pointé par GOOGLE_APPLICATION_CREDENTIALS si présent,
    // sinon on tente ADC classique.
    const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (adcPath && fs.existsSync(adcPath)) {
      const sa = require(adcPath);
      if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(sa) });
      }
      db = admin.firestore();
      console.log('✅ Firebase Admin initialisé (GOOGLE_APPLICATION_CREDENTIALS)');
      console.log('[Firebase Admin] projectId:', sa.project_id || sa.projectId || '(unknown)');
    } else {
      if (!admin.apps.length) admin.initializeApp();
      db = admin.firestore();
      console.log('✅ Firebase Admin initialisé (ADC forcé par FIREBASE_USE_SERVICE_ACCOUNT=false)');
      if (!adcPath) {
        console.warn('[Firebase Admin] GOOGLE_APPLICATION_CREDENTIALS manquant (ADC peut échouer en local)');
      } else {
        console.warn('[Firebase Admin] GOOGLE_APPLICATION_CREDENTIALS pointe vers un fichier introuvable:', adcPath);
      }
    }
  }
} catch (error) {
  console.error('❌ Erreur initialisation Firebase Admin:', error.message || error);
  db = null;
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
    // ⚠️ Robustesse: certaines sources (Firestore/JSON) envoient "14" (string) → on normalise.
    const rawDayOfMonth = req.body.day_of_month;
    const parsedDayOfMonth =
      typeof rawDayOfMonth === 'number'
        ? rawDayOfMonth
        : (typeof rawDayOfMonth === 'string' && rawDayOfMonth.trim()
          ? Number(rawDayOfMonth.trim())
          : NaN);

    const dayOfMonth =
      Number.isFinite(parsedDayOfMonth) && parsedDayOfMonth >= 1 && parsedDayOfMonth <= 28
        ? parsedDayOfMonth
        : (parsedDayOfMonth === -1 ? -1 : 1);

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

// POST /api/yousign/signature-request — DocuSign (même contrat API pour le frontend)
app.post('/api/yousign/signature-request', async (req, res) => {
  try {
    if (!docusignService.isConfigured()) {
      return res.status(503).json({ error: 'DocuSign non configuré (variables d\'environnement manquantes)' });
    }
    console.log('[DocuSign] Requête signature reçue:', { pdfUrl: !!req.body.pdfUrl, signerEmail: req.body.signerEmail });
    const { pdfUrl, signerFirstName, signerLastName, signerEmail } = req.body;
    if (!pdfUrl || !signerEmail) {
      return res.status(400).json({ error: 'pdfUrl et signerEmail sont requis' });
    }
    const { envelopeId } = await docusignService.createEnvelopeFromPdfUrl(
      pdfUrl,
      signerEmail,
      signerFirstName || '',
      signerLastName || '',
      {
        emailSubject: 'Contrat à signer',
        emailBody: 'Veuillez signer le document ci-joint.',
      }
    );
    res.json({
      signatureRequestId: envelopeId,
      documentId: '1',
      signerId: '1',
      status: 'ongoing'
    });
    console.log('[DocuSign] Enveloppe créée:', envelopeId);
  } catch (error) {
    console.error('[DocuSign] Erreur:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de la création de la demande de signature',
      details: error.response?.data?.message || error.message
    });
  }
});

// GET : statut d'une demande de signature (DocuSign — même contrat API)
app.get('/api/yousign/signature-request/:id', async (req, res) => {
  try {
    if (!docusignService.isConfigured()) {
      return res.status(503).json({ error: 'DocuSign non configuré' });
    }
    const { id } = req.params;
    const envelope = await docusignService.getEnvelopeStatus(id);
    const statusMap = { sent: 'active', delivered: 'active', signed: 'active', completed: 'completed', declined: 'declined', voided: 'expired' };
    const frontStatus = statusMap[envelope.status] || envelope.status;
    res.json({
      id: envelope.envelopeId,
      status: frontStatus,
      signers: (envelope.signers || []).map(s => ({
        id: s.id,
        email: s.email,
        status: s.status === 'completed' ? 'signed' : s.status,
        signedAt: s.signedDateTime
      })),
      isCompleted: envelope.status === 'completed',
      isExpired: envelope.status === 'voided'
    });
  } catch (error) {
    console.error('[DocuSign] Erreur GET statut:', error.response?.data || error.message);
    
    // ✅ Gestion erreur DocuSign : limite de polling horaire dépassée
    if (error.errorCode === 'HOURLY_ENVELOPE_POLLING_LIMIT_EXCEEDED' || 
        error.response?.data?.errorCode === 'HOURLY_ENVELOPE_POLLING_LIMIT_EXCEEDED') {
      return res.status(429).json({
        errorCode: 'HOURLY_ENVELOPE_POLLING_LIMIT_EXCEEDED',
        message: error.message || error.response?.data?.message || 'Limite de polling horaire dépassée (250 appels/heure)',
        data: { status: 'pending' } // Retourner un statut par défaut
      });
    }
    
    if (error.response?.status === 404) return res.status(404).json({ error: 'Enveloppe non trouvée' });
    res.status(500).json({ error: 'Erreur récupération statut', details: error.response?.data?.message || error.message });
  }
});

// GET : télécharger le PDF signé (DocuSign)
app.get('/api/yousign/signature-request/:id/document', async (req, res) => {
  try {
    if (!docusignService.isConfigured()) {
      return res.status(503).json({ error: 'DocuSign non configuré' });
    }
    const { id } = req.params;
    const pdfBuffer = await docusignService.getEnvelopeDocumentCombined(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Contrat_Signe_${id}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('[DocuSign] Erreur download:', error.response?.data || error.message);
    if (error.response?.status === 404) return res.status(404).json({ error: 'Document non trouvé' });
    res.status(500).json({ error: 'Erreur téléchargement document', details: error.response?.data?.message || error.message });
  }
});

// GET : image de signature du signataire (pour affichage sur PDF contrat généré)
app.get('/api/yousign/signature-request/:id/signature-image', async (req, res) => {
  try {
    if (!docusignService.isConfigured()) {
      return res.status(503).json({ error: 'DocuSign non configuré' });
    }
    const { id: envelopeId } = req.params;
    const result = await docusignService.getRecipientSignatureImage(envelopeId, '1');
    if (!result) {
      return res.status(404).json({ error: 'Image de signature non disponible' });
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(result.buffer);
  } catch (error) {
    console.error('[DocuSign] Erreur signature image:', error.response?.data || error.message);
    if (error.response?.status === 404) return res.status(404).json({ error: 'Image non trouvée' });
    res.status(500).json({ error: 'Erreur récupération image signature', details: error.response?.data?.message || error.message });
  }
});

// POST : Endpoint devis SAV — DocuSign (même contrat API que YouSign)
app.post('/api/yousign-devis', async (req, res) => {
  console.log('\n🔷 ====== REQUÊTE DOCUSIGN DEVIS SAV ======');
  try {
    if (!docusignService.isConfigured()) {
      return res.status(503).json({ success: false, error: 'DocuSign non configuré' });
    }
    const { action, ...data } = req.body;
    console.log('[DocuSign-Devis] Action:', action);

    switch (action) {
      case 'create_signature_request': {
        const { pdfBase64, filename, signer, devisInfo } = data;
        if (!pdfBase64 || !signer || !devisInfo) {
          return res.status(400).json({ success: false, error: 'Données manquantes: pdfBase64, signer, devisInfo requis' });
        }
        const pdfBuffer = Buffer.from(pdfBase64, 'base64');
        const { envelopeId } = await docusignService.createEnvelopeFromPdfBuffer(
          pdfBuffer,
          filename || `devis-${devisInfo.number}.pdf`,
          signer.email,
          signer.firstName || '',
          signer.lastName || '',
          {
            emailSubject: `Devis SAV ${devisInfo.number} à signer`,
            // Un devis SAV n'inclut pas le mandat SEPA (contrairement au contrat maintenance).
            includeSepaTabs: false,
          }
        );
        let sumupPaymentUrl = null;
        let sumupCheckoutId = null;
        let sumupError = null;
        if (signer.email && data.amount && sumupService.createCheckout) {
          try {
            const sumupResult = await sumupService.createCheckout({
              devisId: data.devisId || `DEVIS-${Date.now()}`,
              amount: parseFloat(data.amount),
              currency: data.currency || 'EUR',
              clientEmail: signer.email,
              description: `Paiement ${data.devisNumber || 'devis'}`,
              returnUrl: data.returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/sav/payment-success`
            });
            if (sumupResult.success) {
              sumupPaymentUrl = sumupResult.payment_url;
              sumupCheckoutId = sumupResult.checkout_id;
              if (db && data.devisId) {
                try {
                  const maintenanceRef = doc(db, 'maintenances', data.devisId);
                  await updateDoc(maintenanceRef, {
                    sumup_checkout_id: sumupCheckoutId,
                    sumup_payment_url: sumupPaymentUrl,
                    sumup_created_at: new Date().toISOString(),
                    sumup_status: sumupResult.status,
                    yousign_signature_request_id: envelopeId
                  });
                } catch (e) { console.warn('[DocuSign-Devis] Firestore:', e.message); }
              }
            } else sumupError = sumupResult.error;
          } catch (e) { sumupError = e.message; }
        }
        return res.json({
          success: true,
          signatureRequestId: envelopeId,
          documentId: '1',
          signerId: '1',
          status: 'ongoing',
          signingUrl: null,
          sumup: { payment_url: sumupPaymentUrl, checkout_id: sumupCheckoutId, created: !!sumupPaymentUrl, error: sumupError }
        });
      }

      case 'get_status': {
        const { signatureRequestId } = data;
        const envelope = await docusignService.getEnvelopeStatus(signatureRequestId);
        const statusMap = { sent: 'ongoing', delivered: 'ongoing', signed: 'ongoing', completed: 'done', declined: 'declined', voided: 'expired' };
        const signedAt = envelope.signers?.find(s => s.signedDateTime)?.signedDateTime || (envelope.status === 'completed' ? envelope.statusDateTime : null);
        return res.json({
          success: true,
          status: statusMap[envelope.status] || envelope.status,
          signers: (envelope.signers || []).map(s => ({ email: s.email, status: s.status, signedAt: s.signedDateTime })),
          signedAt
        });
      }

      case 'download_signed': {
        const { signatureRequestId } = data;
        const pdfBuffer = await docusignService.getEnvelopeDocumentCombined(signatureRequestId);
        return res.json({ success: true, pdfBase64: pdfBuffer.toString('base64') });
      }

      default:
        return res.status(400).json({ success: false, error: `Action non reconnue: ${action}` });
    }
  } catch (error) {
    console.error('[DocuSign-Devis] Erreur:', error.response?.data || error.message);
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

    const apiUrl = getGoCardlessApiUrl();

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

// GET : statut d'un abonnement GoCardless (pour la fiche maintenance - bouton "Rafraîchir le statut")
app.get('/api/gocardless/subscription-status', async (req, res) => {
  try {
    const subscriptionId = req.query.subscriptionId;

    if (!subscriptionId || typeof subscriptionId !== 'string') {
      return res.status(400).json({ error: 'Paramètre subscriptionId requis (query)' });
    }

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'GOCARDLESS_ACCESS_TOKEN manquant' });
    }

    const apiUrl = getGoCardlessApiUrl();
    const response = await axios.get(`${apiUrl}/subscriptions/${subscriptionId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    const sub = response.data.subscriptions || response.data.subscription;
    if (!sub) {
      return res.status(404).json({ error: 'Abonnement non trouvé', subscriptionId });
    }

    res.json({
      status: sub.status,
      next_charge_date: sub.next_charge_date || null,
      subscription: sub
    });
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    console.error('[GoCardless] Erreur statut abonnement:', data || error.message);
    res.status(status || 500).json({
      error: 'Erreur lors de la récupération du statut de l\'abonnement',
      message: data?.error?.message || error.message,
      details: data
    });
  }
});

// GET : liste des paiements GoCardless pour un abonnement (portail / CRM)
app.get('/api/gocardless/payments-by-subscription', async (req, res) => {
  try {
    const subscriptionId = req.query.subscriptionId;
    const limitRaw = req.query.limit;
    const limit = Math.max(1, Math.min(200, Number(limitRaw ?? 50) || 50));

    if (!subscriptionId || typeof subscriptionId !== 'string') {
      return res.status(400).json({ error: 'Paramètre subscriptionId requis (query)' });
    }
    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'GOCARDLESS_ACCESS_TOKEN manquant' });
    }

    const apiUrl = getGoCardlessApiUrl();
    const headers = {
      'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
      'GoCardless-Version': '2015-07-06',
      'Content-Type': 'application/json'
    };

    // Tentative 1: filtre API si supporté
    try {
      const response = await axios.get(`${apiUrl}/payments`, {
        headers,
        params: { subscription: subscriptionId, limit }
      });
      const payments = response.data.payments || [];
      return res.json({ payments });
    } catch (e) {
      // fallback: liste + filtre côté serveur (plus robuste selon versions GoCardless)
      const listRes = await axios.get(`${apiUrl}/payments`, {
        headers,
        params: { limit: Math.max(limit, 100) }
      });
      const allPayments = listRes.data.payments || [];
      const filtered = allPayments.filter((p) => p?.links?.subscription === subscriptionId).slice(0, limit);
      return res.json({ payments: filtered });
    }
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    console.error('[GoCardless] Erreur récupération paiements (subscription):', data || error.message);
    return res.status(status || 500).json({
      error: 'Erreur lors de la récupération des paiements',
      message: data?.error?.message || error.message,
      details: data
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

// POST : Synchroniser les statuts de paiement d'une seule maintenance depuis l'API GoCardless
app.post('/api/gocardless/sync-maintenance-payments', async (req, res) => {
  try {
    const { maintenanceId } = req.body || {};
    if (!maintenanceId) {
      return res.status(400).json({ error: 'maintenanceId requis dans le body' });
    }

    if (!db) {
      console.error('[GoCardless] sync-maintenance-payments: Firebase (db) non initialisé');
      return res.status(503).json({ error: 'Base de données non disponible', details: 'Firebase non initialisé' });
    }

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'GOCARDLESS_ACCESS_TOKEN manquant' });
    }

    const apiUrl = getGoCardlessApiUrl();
    const headers = {
      'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
      'GoCardless-Version': '2015-07-06',
      'Content-Type': 'application/json'
    };

    const maintenanceRef = doc(db, 'maintenances', maintenanceId);
    const maintenanceSnap = await getDoc(maintenanceRef);
    if (!maintenanceSnap.exists()) {
      return res.status(404).json({ error: 'Maintenance non trouvée' });
    }

    const maintenance = { id: maintenanceSnap.id, ...maintenanceSnap.data() };
    const paymentSchedule = maintenance.paymentSchedule || [];
    const contractNumber = (maintenance.contractNumber || '').trim();

    const statusMapping = {
      confirmed: 'confirmed',
      paid_out: 'paid_out',
      failed: 'failed',
      cancelled: 'cancelled',
      charged_back: 'charged_back',
      submitted: 'submitted',
      pending_submission: 'pending_submission',
      pending_customer_approval: 'pending'
    };
    const scheduleStatusMapping = {
      paid_out: 'paid',
      confirmed: 'paid',
      failed: 'failed',
      cancelled: 'failed',
      charged_back: 'failed',
      submitted: 'processing',
      pending_submission: 'pending'
    };

    // 1) Collecter les payment IDs déjà connus sur la maintenance
    const paymentIds = new Set();
    if (maintenance.goCardlessPaymentId) paymentIds.add(maintenance.goCardlessPaymentId);
    paymentSchedule.forEach(item => {
      if (item.gocardlessPaymentId) paymentIds.add(item.gocardlessPaymentId);
    });

    // 2) Si aucun ID enregistré mais on a un numéro de contrat, récupérer les paiements GoCardless par description
    if (paymentIds.size === 0 && contractNumber) {
      try {
        const listRes = await axios.get(`${apiUrl}/payments?limit=300`, { headers });
        const allPayments = listRes.data.payments || [];
        const contractMatch = contractNumber.includes('CONTRACT-') ? contractNumber : `CONTRACT-${contractNumber}`;
        const matching = allPayments.filter(p => (p.description || '').includes(contractMatch));
        matching.forEach(p => paymentIds.add(p.id));
        if (matching.length > 0) {
          console.log(`[GoCardless] ${matching.length} paiement(s) trouvé(s) par contrat "${contractMatch}" pour maintenance ${maintenanceId}`);
        }
      } catch (err) {
        console.error('[GoCardless] Erreur liste paiements:', err.response?.data || err.message);
      }
    }

    if (paymentIds.size === 0) {
      return res.json({
        success: true,
        message: 'Aucun paiement GoCardless trouvé pour cette maintenance (vérifiez le numéro de contrat)',
        stats: { paymentsChecked: 0, scheduleUpdated: false }
      });
    }

    // 3) Récupérer le détail de chaque paiement
    const paymentStatusById = {};
    for (const paymentId of paymentIds) {
      try {
        const response = await axios.get(`${apiUrl}/payments/${paymentId}`, { headers });
        const p = response.data.payments;
        const mapped = statusMapping[p.status] || p.status;
        const scheduleStatus = scheduleStatusMapping[mapped] || 'pending';
        const chargeDate = (p.charge_date || '').substring(0, 10);
        paymentStatusById[paymentId] = { paymentStatus: mapped, scheduleStatus, chargeDate };
      } catch (err) {
        console.error(`[GoCardless] Erreur récupération paiement ${paymentId}:`, err.response?.data || err.message);
      }
    }

    // 4) Statut principal affiché dans la liste : "meilleur" statut parmi tous les paiements (si un est Versé → afficher Versé)
    const statusPriority = { paid_out: 4, confirmed: 3, submitted: 2, pending_submission: 1, pending: 0, failed: -1, cancelled: -2, charged_back: -3 };
    let mainPaymentStatus = maintenance.paymentStatus || 'pending';
    let mainPaymentId = maintenance.goCardlessPaymentId;
    if (Object.keys(paymentStatusById).length > 0) {
      let bestPriority = statusPriority[mainPaymentStatus] ?? -10;
      let bestId = mainPaymentId && paymentStatusById[mainPaymentId] ? mainPaymentId : null;
      for (const [payId, info] of Object.entries(paymentStatusById)) {
        const p = statusPriority[info.paymentStatus] ?? -10;
        if (p > bestPriority) {
          bestPriority = p;
          bestId = payId;
          mainPaymentStatus = info.paymentStatus;
        }
      }
      if (bestId) mainPaymentId = bestId;
      // Si aucun "meilleur" trouvé, garder le plus récent par date pour mainPaymentId
      if (!mainPaymentId) {
        const sortedIds = Object.entries(paymentStatusById)
          .sort((a, b) => (b[1].chargeDate || '').localeCompare(a[1].chargeDate || ''));
        if (sortedIds.length > 0) mainPaymentId = sortedIds[0][0];
      }
    }

    // 5) Mettre à jour l'échéancier : par paymentId connu, ou par date de charge (charge_date <-> dueDate)
    const updatedSchedule = paymentSchedule.map(item => {
      const pid = item.gocardlessPaymentId;
      if (pid && paymentStatusById[pid]) {
        const { scheduleStatus } = paymentStatusById[pid];
        return {
          ...item,
          status: scheduleStatus,
          gocardlessPaymentId: pid,
          updatedAt: new Date().toISOString(),
          ...(scheduleStatus === 'paid' && { paidAt: new Date().toISOString() }),
          ...(scheduleStatus === 'failed' && { failedAt: new Date().toISOString() })
        };
      }
      const dueStr = (item.dueDate || '').substring(0, 10);
      for (const [payId, info] of Object.entries(paymentStatusById)) {
        if (info.chargeDate === dueStr) {
          return {
            ...item,
            status: info.scheduleStatus,
            gocardlessPaymentId: payId,
            updatedAt: new Date().toISOString(),
            ...(info.scheduleStatus === 'paid' && { paidAt: new Date().toISOString() }),
            ...(info.scheduleStatus === 'failed' && { failedAt: new Date().toISOString() })
          };
        }
        const itemYearMonth = dueStr.substring(0, 7);
        const chargeYearMonth = (info.chargeDate || '').substring(0, 7);
        if (itemYearMonth === chargeYearMonth && Math.abs(new Date(dueStr).getDate() - new Date(info.chargeDate).getDate()) <= 7) {
          return {
            ...item,
            status: info.scheduleStatus,
            gocardlessPaymentId: payId,
            updatedAt: new Date().toISOString(),
            ...(info.scheduleStatus === 'paid' && { paidAt: new Date().toISOString() }),
            ...(info.scheduleStatus === 'failed' && { failedAt: new Date().toISOString() })
          };
        }
      }
      return item;
    });

    const scheduleChanged = JSON.stringify(updatedSchedule) !== JSON.stringify(paymentSchedule) ||
      mainPaymentStatus !== (maintenance.paymentStatus || 'pending');

    if (scheduleChanged) {
      const updateData = {
        paymentStatus: mainPaymentStatus,
        paymentSchedule: updatedSchedule,
        paymentMethod: maintenance.paymentMethod || 'gocardless',
        updatedAt: new Date(),
        lastPaymentSync: new Date()
      };
      if (mainPaymentId) updateData.goCardlessPaymentId = mainPaymentId;
      await updateDoc(maintenanceRef, updateData);
      console.log(`[GoCardless] ✅ Maintenance ${maintenanceId} synchronisée: ${Object.keys(paymentStatusById).length} paiement(s), statut principal → ${mainPaymentStatus}`);
    }

    res.json({
      success: true,
      message: scheduleChanged ? 'Échéancier mis à jour depuis GoCardless' : 'Déjà à jour',
      stats: {
        paymentsChecked: paymentIds.size,
        scheduleUpdated: scheduleChanged
      }
    });
  } catch (error) {
    const details = error.response?.data || error.message;
    const stack = error.stack;
    console.error('[GoCardless] Erreur sync-maintenance-payments:', details);
    if (stack) console.error('[GoCardless] Stack:', stack);
    res.status(500).json({
      error: 'Erreur lors de la synchronisation des paiements de la maintenance',
      details: typeof details === 'string' ? details : JSON.stringify(details)
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

// POST : webhook YouSign (désactivé — signature gérée par DocuSign)
app.post('/api/yousign/webhook', express.json(), async (req, res) => {
  res.status(200).json({ received: true });
});

// POST /api/portal/create-maintenance-for-contract — portail client: créer une maintenance si aucune n'existe
app.post('/api/portal/create-maintenance-for-contract', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Firebase non initialisé' });
    }

    const body = req.body || {};
    const {
      clientId,
      clientName,
      signerEmail,
      contractNumber,
      contractStartDate,
      contractEndDate,
      monthlyAmount,
      paymentDate,
      paymentMethod,
      equipmentName,
      gocardlessIban,
      gocardlessAccountHolder,
      gocardlessAddress,
      gocardlessPostalCode,
      gocardlessCity,
      gocardlessCountry
    } = body;

    const missing = [];
    if (!clientId) missing.push('clientId');
    if (!signerEmail) missing.push('signerEmail');
    if (!contractNumber) missing.push('contractNumber');
    if (!contractStartDate) missing.push('contractStartDate');
    if (!contractEndDate) missing.push('contractEndDate');
    if (typeof monthlyAmount !== 'number') missing.push('monthlyAmount');
    if (typeof paymentDate !== 'number') missing.push('paymentDate');
    if (paymentMethod !== 'gocardless' && paymentMethod !== 'manual') missing.push('paymentMethod');

    if (missing.length) {
      return res.status(400).json({ error: 'Champs requis manquants', missing });
    }

    const maintenanceRef = doc(collection(db, 'maintenances'));
    const maintenanceId = maintenanceRef.id;

    // Important : ces champs sont utilisés par les rules Storage/Firestore côté portail.
    const maintenanceData = {
      clientId: String(clientId),
      clientName: String(clientName || ''),
      clientContact: { email: String(signerEmail) },
      signerEmail: String(signerEmail),

      contractNumber: String(contractNumber),
      equipmentName: equipmentName ? String(equipmentName) : undefined,

      lastMaintenance: String(contractStartDate), // YYYY-MM-DD
      nextMaintenance: String(contractEndDate), // YYYY-MM-DD

      monthlyAmount: monthlyAmount,
      paymentDate: paymentDate,
      paymentMethod: paymentMethod,
      paymentStatus: 'pending',

      status: 'aprogrammer',
      signatureStatus: 'pending',
      gocardlessSubscriptionPending: paymentMethod === 'gocardless' && monthlyAmount > 0,

      ...(paymentMethod === 'gocardless' && {
        gocardlessIban: String(gocardlessIban || ''),
        gocardlessAccountHolder: String(gocardlessAccountHolder || ''),
        gocardlessAddress: String(gocardlessAddress || ''),
        gocardlessPostalCode: String(gocardlessPostalCode || ''),
        gocardlessCity: String(gocardlessCity || ''),
        gocardlessCountry: String(gocardlessCountry || 'FR')
      }),

      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await setDoc(maintenanceRef, maintenanceData);

    console.log('[Portal][Contract] maintenance créée', { maintenanceId, clientId, signerEmail });
    return res.json({ success: true, maintenanceId });
  } catch (error) {
    console.error('[Portal][Contract] Erreur create-maintenance-for-contract:', error.response?.data || error.message || error);
    return res.status(500).json({
      error: 'Erreur lors de la création de maintenance portail',
      details: error.response?.data || error.message || error
    });
  }
});

// POST /api/portal/create-contract — portail client: créer contrat + lancer DocuSign
app.post('/api/portal/create-contract', async (req, res) => {
  try {
    if (!docusignService.isConfigured()) {
      return res.status(503).json({ error: 'DocuSign non configuré (variables d’environnement manquantes)' });
    }
    if (!db) {
      return res.status(500).json({ error: 'Firebase non initialisé' });
    }

    const body = req.body || {};
    const {
      maintenanceId,
      contractNumber,
      pdfUrl,
      signerEmail,
      signerFirstName,
      signerLastName,
      equipmentName,
      contractStartDate,
      contractEndDate,
      monthlyAmount,
      paymentDate,
      paymentMethod,
      gocardlessIban,
      gocardlessAccountHolder,
      gocardlessAddress,
      gocardlessPostalCode,
      gocardlessCity,
      gocardlessCountry
    } = body;

    const missing = [];
    if (!maintenanceId) missing.push('maintenanceId');
    if (!contractNumber) missing.push('contractNumber');
    if (!pdfUrl) missing.push('pdfUrl');
    if (!signerEmail) missing.push('signerEmail');
    if (!contractStartDate) missing.push('contractStartDate');
    if (!contractEndDate) missing.push('contractEndDate');
    if (typeof monthlyAmount !== 'number') missing.push('monthlyAmount');
    if (typeof paymentDate !== 'number') missing.push('paymentDate');
    if (paymentMethod !== 'gocardless' && paymentMethod !== 'manual') missing.push('paymentMethod');

    if (paymentMethod === 'gocardless') {
      if (!gocardlessIban) missing.push('gocardlessIban');
      if (!gocardlessAccountHolder) missing.push('gocardlessAccountHolder');
      if (!gocardlessAddress) missing.push('gocardlessAddress');
      if (!gocardlessPostalCode) missing.push('gocardlessPostalCode');
      if (!gocardlessCity) missing.push('gocardlessCity');
      if (!gocardlessCountry) missing.push('gocardlessCountry');
    }

    if (missing.length) {
      return res.status(400).json({ error: 'Champs requis manquants', missing });
    }

    const maintenanceRef = doc(db, 'maintenances', maintenanceId);
    console.log('[Portal][Contract] create-contract', {
      maintenanceId,
      contractNumber,
      paymentMethod,
      paymentDate,
      monthlyAmount: typeof monthlyAmount === 'number' ? monthlyAmount : null
    });
    const maintenanceSnap = await getDoc(maintenanceRef);
    if (!maintenanceSnap.exists()) {
      return res.status(404).json({ error: 'Maintenance introuvable' });
    }

    const maintenanceData = maintenanceSnap.data() || {};
    const clientId = maintenanceData.clientId || '';
    const clientEmail = signerEmail;
    const clientName = maintenanceData.clientName || '';

    const contractRef = doc(collection(db, 'contracts'));
    const contractId = contractRef.id;

    // Créer l’enveloppe DocuSign à partir du PDF (le PDF contient déjà les données contractuelles)
    const { envelopeId } = await docusignService.createEnvelopeFromPdfUrl(
      pdfUrl,
      signerEmail,
      signerFirstName || '',
      signerLastName || '',
      {
        emailSubject: 'Contrat à signer',
        emailBody: 'Veuillez signer le document ci-joint.'
      }
    );
    console.log('[Portal][Contract] DocuSign envelope created', { envelopeId });

    // 1) Créer le document `contracts` pour que le portail puisse afficher le contrat + télécharger le PDF signé
    await setDoc(contractRef, {
      id: contractId,
      maintenanceId,
      clientId,
      clientEmail,
      clientName,
      contractNumber,
      equipmentName: equipmentName || 'Équipement',
      pdfUrl,
      contractStartDate: new Date(`${contractStartDate}T00:00:00`),
      contractEndDate: new Date(`${contractEndDate}T00:00:00`),
      paymentStatus: 'pending',
      signatureStatus: 'pending',
      yousignRequestId: envelopeId,
      createdAt: new Date().toISOString()
    });
    try {
      const contractSnap = await getDoc(contractRef);
      console.log('[Portal][Contract] contract doc exists after write?', contractSnap.exists());
    } catch (e) {
      console.warn('[Portal][Contract] unable to read back contract doc after write:', e.message || e);
    }

    // 2) Mettre à jour la `maintenance` (webhook DocuSign mettra signatureStatus à 'signed')
    const ibanNormalized = paymentMethod === 'gocardless' ? String(gocardlessIban).replace(/\s/g, '').toUpperCase() : '';
    const maintenanceUpdate = {
      contractNumber,
      contractId,
      paymentMethod,
      paymentStatus: 'pending',
      monthlyAmount,
      paymentDate,
      lastMaintenance: contractStartDate,
      nextMaintenance: contractEndDate,

      // Pour éviter des erreurs GoCardless quand le montant est à 0 (ex: formule VIP “sur devis”)
      gocardlessSubscriptionPending: paymentMethod === 'gocardless' && monthlyAmount > 0,
      ...(paymentMethod === 'gocardless' && {
        gocardlessIban: ibanNormalized,
        gocardlessAccountHolder: String(gocardlessAccountHolder),
        gocardlessAddress: String(gocardlessAddress),
        gocardlessPostalCode: String(gocardlessPostalCode),
        gocardlessCity: String(gocardlessCity),
        gocardlessCountry: String(gocardlessCountry)
      }),

      signerEmail,
      yousignRequestId: envelopeId,
      signatureStatus: 'pending',
      updatedAt: new Date().toISOString()
    };

    await updateDoc(maintenanceRef, maintenanceUpdate);

    return res.json({ success: true, contractId, yousignRequestId: envelopeId });
  } catch (error) {
    console.error('[Portal][Contract] Erreur:', error.response?.data || error.message || error);
    return res.status(500).json({
      error: 'Erreur lors de la création du contrat portail',
      details: error.response?.data || error.message || error
    });
  }
});

// POST : webhook DocuSign Connect — mise à jour Firestore quand une enveloppe est complétée
// signatureDate = date réelle de signature DocuSign (signedDateTime), pas la date d'envoi du webhook
app.post('/api/docusign/webhook', express.json(), async (req, res) => {
  try {
    console.log('[DocuSign][Webhook] Notification reçue');
    const envelopeId = req.body.envelopeId || req.body.data?.envelopeId;
    const status = req.body.status || req.body.data?.status;
    if (!envelopeId) {
      return res.status(400).json({ error: 'envelopeId manquant' });
    }
    if (status === 'completed' && db) {
      console.log('[DocuSign][Webhook] Envelope completed → start sync', { envelopeId });
      let signatureDateIso = null;
      try {
        const envelope = await docusignService.getEnvelopeStatus(envelopeId);
        const signedAt = envelope.signers?.find(s => s.signedDateTime)?.signedDateTime;
        if (signedAt) {
          signatureDateIso = signedAt; // ISO string fournie par DocuSign (date réelle de signature)
        }
      } catch (e) {
        console.warn('[DocuSign][Webhook] Impossible de récupérer signedDateTime, utilisation date courante:', e.message);
      }
      const maintenancesRef = collection(db, 'maintenances');
      const q = query(maintenancesRef, where('yousignRequestId', '==', envelopeId));
      const snapshot = await getDocs(q);
      let maintenanceDoc = !snapshot.empty ? snapshot.docs[0] : null;

      // Fallback: si la maintenance n'a pas (encore) le yousignRequestId, tenter via `contracts`
      if (!maintenanceDoc) {
        try {
          const contractsRef = collection(db, 'contracts');
          const cq = query(contractsRef, where('yousignRequestId', '==', envelopeId));
          const csnap = await getDocs(cq);
          if (!csnap.empty) {
            const c0 = csnap.docs[0];
            const cData = c0.data() || {};
            const mId = cData.maintenanceId;
            const cNumber = cData.contractNumber;
            console.log('[DocuSign][Webhook] Maintenance fallback via contract', { envelopeId, maintenanceId: mId || null, contractNumber: cNumber || null });

            if (mId) {
              const mRef = doc(db, 'maintenances', String(mId));
              const mSnap = await getDoc(mRef);
              if (mSnap.exists()) maintenanceDoc = mSnap;
            }

            if (!maintenanceDoc && cNumber) {
              const mq = query(maintenancesRef, where('contractNumber', '==', String(cNumber)));
              const msnap = await getDocs(mq);
              if (!msnap.empty) maintenanceDoc = msnap.docs[0];
            }
          }
        } catch (e) {
          console.warn('[DocuSign][Webhook] Maintenance fallback via contract failed:', e.message || e);
        }
      }

      if (maintenanceDoc) {
        const maintenanceId = maintenanceDoc.id;
        const previousMaintenanceData = maintenanceDoc.data() || {};
        console.log('[DocuSign][Webhook] Maintenance found for envelope', {
          maintenanceId,
          contractNumber: previousMaintenanceData?.contractNumber,
          signerEmail: previousMaintenanceData?.signerEmail || previousMaintenanceData?.clientContact?.email,
          welcomeEmailSentAt: previousMaintenanceData?.welcomeEmailSentAt || null,
        });
        const maintenanceRef = doc(db, 'maintenances', maintenanceId);
        const updatePayload = {
          signatureStatus: 'signed',
          updatedAt: new Date().toISOString()
        };
        if (signatureDateIso) {
          updatePayload.signatureDate = signatureDateIso;
        } else {
          updatePayload.signatureDate = new Date().toISOString().split('T')[0];
        }
        await updateDoc(maintenanceRef, updatePayload);
        console.log('[DocuSign][Webhook] Maintenance mise à jour:', maintenanceId, 'signatureDate:', updatePayload.signatureDate);

        // 1) Mettre à jour les contrats côté portail (documents `contracts`)
        let updatedContractIds = [];
        try {
          const contractsRef = collection(db, 'contracts');
          const contractQuery = query(contractsRef, where('yousignRequestId', '==', envelopeId));
          const contractSnap = await getDocs(contractQuery);
          for (const c of contractSnap.docs) {
            await updateDoc(doc(db, 'contracts', c.id), {
              signatureStatus: 'signed',
              signatureDate: updatePayload.signatureDate,
              updatedAt: new Date().toISOString()
            });
            updatedContractIds.push(c.id);
          }
        } catch (e) {
          console.warn('[DocuSign][Webhook] Mise à jour contracts impossible:', e.message || e);
        }

        // 1bis) Envoyer l'email de bienvenue (une seule fois, uniquement après signature)
        try {
          const alreadySent = !!previousMaintenanceData?.welcomeEmailSentAt;
          const toEmail = previousMaintenanceData?.signerEmail || previousMaintenanceData?.clientContact?.email || '';
          const clientName = previousMaintenanceData?.clientName || '';
          const contractNumber = previousMaintenanceData?.contractNumber || '';
          const paymentMethod = previousMaintenanceData?.paymentMethod || '';

          if (!alreadySent && toEmail) {
            console.log('[DocuSign][Webhook] Welcome email eligible → sending', { maintenanceId, toEmail, contractNumber });
            await sendWelcomeEmailViaEmailJs({
              toEmail,
              clientName,
              contractNumber,
              maintenanceId,
              contractId: previousMaintenanceData?.contractId || (updatedContractIds[0] || ''),
              activationDate: updatePayload.signatureDate,
              signatureDate: updatePayload.signatureDate,
              paymentMethod,
              formulaName: previousMaintenanceData?.formulaName || previousMaintenanceData?.formula?.name || '',
              equipments: previousMaintenanceData?.equipmentNames || previousMaintenanceData?.equipmentName || '',
              monthlyAmount: typeof previousMaintenanceData?.monthlyAmount === 'number' ? previousMaintenanceData.monthlyAmount : null,
              hotlinePhone: '01 81 72 39 59',
              supportEmail: 'sav@labelenergie.fr',
            });

            // Marquer comme envoyé (idempotence anti double webhook)
            await updateDoc(maintenanceRef, {
              welcomeEmailSentAt: new Date().toISOString(),
              welcomeEmailStatus: 'success',
              welcomeEmailTo: String(toEmail),
              updatedAt: new Date().toISOString(),
            });

            // Marquer aussi côté contracts (si présents)
            for (const cid of updatedContractIds) {
              try {
                await updateDoc(doc(db, 'contracts', cid), {
                  welcomeEmailSentAt: new Date().toISOString(),
                  welcomeEmailStatus: 'success',
                  welcomeEmailTo: String(toEmail),
                  updatedAt: new Date().toISOString(),
                });
              } catch (e2) {
                // non bloquant
              }
            }

            console.log('[DocuSign][Webhook] ✅ Email de bienvenue envoyé:', toEmail, 'maintenance:', maintenanceId);
          } else {
            console.log('[DocuSign][Webhook] Email bienvenue ignoré (déjà envoyé ou email manquant)', {
              alreadySent,
              hasEmail: !!toEmail,
              maintenanceId,
            });
          }
        } catch (e) {
          console.warn('[DocuSign][Webhook] ❌ Envoi email bienvenue échoué:', e.message || e);
          // Log non bloquant + marquage erreur (sans bloquer GoCardless)
          try {
            await updateDoc(maintenanceRef, {
              welcomeEmailStatus: 'error',
              welcomeEmailError: String(e.message || e),
              updatedAt: new Date().toISOString(),
            });
          } catch (_ignored) {}
        }

        // 2) Créer automatiquement l’abonnement GoCardless après signature (si requis)
        try {
          const shouldCreateSubscription =
            previousMaintenanceData?.gocardlessSubscriptionPending === true &&
            previousMaintenanceData?.paymentMethod === 'gocardless' &&
            previousMaintenanceData?.gocardlessIban &&
            previousMaintenanceData?.gocardlessAccountHolder &&
            typeof previousMaintenanceData?.monthlyAmount === 'number' &&
            previousMaintenanceData?.monthlyAmount > 0;

          if (shouldCreateSubscription) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            await axios.post(`${baseUrl}/create-maintenance-subscription`, {
              account_holder_name: previousMaintenanceData.gocardlessAccountHolder,
              iban: previousMaintenanceData.gocardlessIban,
              amount: previousMaintenanceData.monthlyAmount,
              currency: 'EUR',
              interval_unit: 'monthly',
              interval: 1,
              start_date: previousMaintenanceData.lastMaintenance,
              // Certaines maintenances stockent paymentDate en string ("14") → on cast pour éviter fallback à 1.
              day_of_month: Number(previousMaintenanceData.paymentDate) || 1,
              metadata: {
                contractNumber: previousMaintenanceData.contractNumber || '',
                maintenanceId: maintenanceId,
                clientId: previousMaintenanceData.clientId || '',
                address: previousMaintenanceData.gocardlessAddress || '',
                city: previousMaintenanceData.gocardlessCity || '',
                postalCode: previousMaintenanceData.gocardlessPostalCode || '',
                country: previousMaintenanceData.gocardlessCountry || 'FR',
                clientEmail: previousMaintenanceData.signerEmail || previousMaintenanceData.clientContact?.email || ''
              }
            }, {
              headers: { 'Content-Type': 'application/json' }
            });
          }
        } catch (e) {
          console.warn('[DocuSign][Webhook] Création abonnement GoCardless échouée:', e.message || e);
        }
      } else {
        console.log('[DocuSign][Webhook] No maintenance found for envelope', { envelopeId });
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('[DocuSign][Webhook] Erreur:', error);
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

// GET : statut d'une signature (DocuSign — même URL pour compatibilité frontend)
app.get('/api/yousign/status/:requestId', async (req, res) => {
  try {
    if (!docusignService.isConfigured()) {
      return res.status(503).json({ error: 'DocuSign non configuré' });
    }
    const { requestId } = req.params;
    const envelope = await docusignService.getEnvelopeStatus(requestId);
    const statusMap = { completed: 'signed', declined: 'declined', voided: 'expired', sent: 'pending', delivered: 'pending', signed: 'pending' };
    const frontStatus = statusMap[envelope.status] || envelope.status;
    const signedAt = envelope.signers?.find(s => s.signedDateTime)?.signedDateTime || (envelope.status === 'completed' ? envelope.statusDateTime : null);
    console.log('[DocuSign][Status] envelope', { requestId, envelopeStatus: envelope.status, frontStatus, signedAt: signedAt || null });

    // Fallback local: si DocuSign Connect (webhook) n'est pas configuré,
    // le front ne fera que "poller" ce endpoint. On en profite pour synchroniser Firestore
    // et envoyer l'email de bienvenue UNE seule fois.
    if (frontStatus === 'signed' && db) {
      try {
        const maintenancesRef = collection(db, 'maintenances');
        const q = query(maintenancesRef, where('yousignRequestId', '==', requestId));
        const snap = await getDocs(q);
        let mDoc = !snap.empty ? snap.docs[0] : null;

        // Fallback: si la maintenance n'a pas (encore) le yousignRequestId, tenter via `contracts`
        if (!mDoc) {
          try {
            const contractsRef = collection(db, 'contracts');
            const cq = query(contractsRef, where('yousignRequestId', '==', requestId));
            const csnap = await getDocs(cq);
            if (!csnap.empty) {
              const c0 = csnap.docs[0];
              const cData = c0.data() || {};
              const mId = cData.maintenanceId;
              const cNumber = cData.contractNumber;
              console.log('[DocuSign][Status] Maintenance fallback via contract', { requestId, maintenanceId: mId || null, contractNumber: cNumber || null });

              if (mId) {
                const mRef = doc(db, 'maintenances', String(mId));
                const mSnap = await getDoc(mRef);
                if (mSnap.exists()) mDoc = mSnap;
              }

              if (!mDoc && cNumber) {
                const mq = query(maintenancesRef, where('contractNumber', '==', String(cNumber)));
                const msnap = await getDocs(mq);
                if (!msnap.empty) mDoc = msnap.docs[0];
              }
            }
          } catch (e) {
            console.warn('[DocuSign][Status] Maintenance fallback via contract failed:', e.message || e);
          }
        }

        if (mDoc) {
          const maintenanceId = mDoc.id;
          const mData = mDoc.data() || {};
          const mRef = doc(db, 'maintenances', maintenanceId);
          console.log('[DocuSign][Status] Maintenance found for signed envelope', {
            maintenanceId,
            contractNumber: mData?.contractNumber,
            signerEmail: mData?.signerEmail || mData?.clientContact?.email,
            welcomeEmailSentAt: mData?.welcomeEmailSentAt || null,
          });

          // Assurer la cohérence des champs de signature
          const nextSigDate = signedAt || new Date().toISOString();
          const shouldUpdateSig = mData.signatureStatus !== 'signed' || !mData.signatureDate;
          if (shouldUpdateSig) {
            await updateDoc(mRef, {
              signatureStatus: 'signed',
              signatureDate: nextSigDate,
              updatedAt: new Date().toISOString(),
            });
          }

          // Email bienvenue idempotent
          if (!mData.welcomeEmailSentAt) {
            const toEmail = mData.signerEmail || mData.clientContact?.email || '';
            if (toEmail) {
              console.log('[DocuSign][Status] Welcome email eligible → sending', { maintenanceId, toEmail, contractNumber: mData.contractNumber });
              const equipments =
                Array.isArray(mData.equipmentNames) && mData.equipmentNames.length
                  ? mData.equipmentNames.join(', ')
                  : (mData.equipmentName || '');
              const monthly = typeof mData.monthlyAmount === 'number' ? mData.monthlyAmount : null;
              const activationDate = (() => {
                try {
                  return new Date(nextSigDate).toLocaleDateString('fr-FR');
                } catch {
                  return '';
                }
              })();

              await sendWelcomeEmailViaEmailJs({
                toEmail,
                clientName: mData.clientName || '',
                contractNumber: mData.contractNumber || '',
                maintenanceId,
                contractId: mData.contractId || '',
                activationDate,
                signatureDate: activationDate,
                paymentMethod: mData.paymentMethod || '',
                formulaName: mData.formulaName || mData.formula?.name || '',
                equipments,
                monthlyAmount: monthly,
                hotlinePhone: '01 81 72 39 59',
                supportEmail: 'sav@labelenergie.fr',
              });

              await updateDoc(mRef, {
                welcomeEmailSentAt: new Date().toISOString(),
                welcomeEmailStatus: 'success',
                welcomeEmailTo: String(toEmail),
                updatedAt: new Date().toISOString(),
              });
              console.log('[DocuSign][Status] ✅ Email de bienvenue envoyé (fallback polling):', toEmail, 'maintenance:', maintenanceId);
            } else {
              console.log('[DocuSign][Status] Welcome email skipped (missing email)', { maintenanceId });
            }
          } else {
            console.log('[DocuSign][Status] Welcome email skipped (already sent)', { maintenanceId });
          }
        } else {
          console.log('[DocuSign][Status] No maintenance found for signed envelope', { requestId });
        }
      } catch (e) {
        console.warn('[DocuSign][Status] Fallback sync/welcome email failed:', e.message || e);
      }
    }

    res.json({
      data: {
        id: envelope.envelopeId,
        status: frontStatus,
        signed_at: signedAt,
        declined_at: envelope.status === 'declined' ? envelope.statusDateTime : null,
        expired_at: envelope.status === 'voided' ? envelope.statusDateTime : null,
        created_at: envelope.statusDateTime,
        updated_at: envelope.statusDateTime
      },
      signers: (envelope.signers || []).map(s => ({
        id: s.id,
        email: s.email,
        status: s.status === 'completed' ? 'signed' : s.status,
        signed_at: s.signedDateTime,
        declined_at: null
      }))
    });
  } catch (error) {
    console.error('[DocuSign] Erreur statut:', error.response?.data || error.message);
    
    // ✅ Gestion erreur DocuSign : limite de polling horaire dépassée
    if (error.errorCode === 'HOURLY_ENVELOPE_POLLING_LIMIT_EXCEEDED' || 
        error.response?.data?.errorCode === 'HOURLY_ENVELOPE_POLLING_LIMIT_EXCEEDED') {
      return res.status(429).json({
        errorCode: 'HOURLY_ENVELOPE_POLLING_LIMIT_EXCEEDED',
        message: error.message || error.response?.data?.message || 'Limite de polling horaire dépassée (250 appels/heure)',
        data: { status: 'pending' } // Retourner un statut par défaut
      });
    }
    
    if (error.response?.status === 404) return res.status(404).json({ error: 'Demande de signature non trouvée' });
    res.status(500).json({ error: 'Erreur récupération statut', details: error.response?.data?.message || error.message });
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

// DEBUG (DEV) — Forcer l'envoi de l'email de bienvenue depuis une maintenanceId
// Usage: POST /api/debug/send-welcome-email { maintenanceId: "..." }
app.post('/api/debug/send-welcome-email', express.json(), async (req, res) => {
  try {
    const { maintenanceId } = req.body || {};
    if (!maintenanceId) return res.status(400).json({ error: 'maintenanceId requis' });
    if (!db) return res.status(503).json({ error: 'Firebase non disponible' });

    const mRef = doc(db, 'maintenances', String(maintenanceId));
    const mSnap = await getDoc(mRef);
    if (!mSnap.exists()) return res.status(404).json({ error: 'Maintenance non trouvée', maintenanceId });

    const m = { id: mSnap.id, ...(mSnap.data() || {}) };
    const toEmail = m.signerEmail || m.clientContact?.email || '';
    if (!toEmail) return res.status(400).json({ error: 'Email manquant sur la maintenance', maintenanceId });

    const equipments = Array.isArray(m.equipmentNames) && m.equipmentNames.length ? m.equipmentNames : (m.equipmentName || '');
    const activationDate = (() => {
      try {
        const d = m.signatureDate || new Date().toISOString();
        return new Date(d).toLocaleDateString('fr-FR');
      } catch {
        return '';
      }
    })();

    console.log('[DEBUG][WelcomeEmail] force send', { maintenanceId, toEmail, contractNumber: m.contractNumber || '' });
    await sendWelcomeEmailViaEmailJs({
      toEmail,
      clientName: m.clientName || '',
      contractNumber: m.contractNumber || '',
      maintenanceId: mSnap.id,
      contractId: m.contractId || '',
      activationDate,
      signatureDate: m.signatureDate || '',
      paymentMethod: m.paymentMethod || '',
      formulaName: m.formulaName || m.formula?.name || '',
      equipments,
      monthlyAmount: typeof m.monthlyAmount === 'number' ? m.monthlyAmount : null,
      hotlinePhone: '01 81 72 39 59',
      supportEmail: 'sav@labelenergie.fr',
    });

    res.json({ success: true, maintenanceId: mSnap.id, toEmail });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    console.error('[DEBUG][WelcomeEmail] failed', details);
    res.status(500).json({ error: 'Envoi welcome email échoué', details });
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

// GET : télécharger un contrat signé (DocuSign)
app.get('/api/yousign/download/:requestId', async (req, res) => {
  try {
    if (!docusignService.isConfigured()) {
      return res.status(503).json({ error: 'DocuSign non configuré' });
    }
    const { requestId } = req.params;
    const pdfBuffer = await docusignService.getEnvelopeDocumentCombined(requestId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Contrat_Signe_${requestId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('[DocuSign] Erreur download:', error.response?.data || error.message);
    if (error.response?.status === 404) return res.status(404).json({ error: 'Document signé non trouvé' });
    res.status(500).json({ error: 'Erreur téléchargement contrat', details: error.response?.data?.message || error.message });
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

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING RÉGIE — Workflow d'inscription partenaire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envoie un email via EmailJS (générique, pour les emails d'onboarding régie).
 */
async function sendRegieOnboardingEmail({ toEmail, toName, subject, body }) {
  const serviceId  = process.env.EMAILJS_WELCOME_SERVICE_ID  || process.env.EMAILJS_SERVICE_ID  || '';
  const templateId = process.env.EMAILJS_REGIE_TEMPLATE_ID   || process.env.EMAILJS_WELCOME_TEMPLATE_ID || '';
  const userId     = process.env.EMAILJS_WELCOME_USER_ID     || process.env.EMAILJS_USER_ID     || '';
  const privateKey = process.env.EMAILJS_WELCOME_PRIVATE_KEY || process.env.EMAILJS_PRIVATE_KEY || '';

  if (!serviceId || !templateId || !userId) {
    console.warn('[Regie Onboarding] Variables EmailJS manquantes — email non envoyé');
    return;
  }

  await axios.post(
    'https://api.emailjs.com/api/v1.0/email/send',
    {
      service_id: serviceId,
      template_id: templateId,
      user_id: userId,
      ...(privateKey ? { accessToken: privateKey } : {}),
      template_params: {
        to_email: toEmail,
        to_name: toName || 'Partenaire',
        subject,
        message: body,
        // Compatibilité templates génériques
        email: toEmail,
        recipient_email: toEmail,
        client_name: toName || 'Partenaire',
      },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
}

/**
 * POST /api/regie-onboarding/submit
 * Reçoit le formulaire public, crée la fiche régie et uploade les documents.
 */
app.post('/api/regie-onboarding/submit', async (req, res) => {
  console.log('[Regie Onboarding] Nouvelle demande reçue');
  try {
    if (!db) return res.status(503).json({ success: false, error: 'Firebase non initialisé' });

    const { formData, documents } = req.body;
    if (!formData?.raisonSociale) {
      return res.status(400).json({ success: false, error: 'raisonSociale requis' });
    }

    // 1. Créer la fiche régie
    const regieData = {
      nom: formData.raisonSociale,
      status: "Demande d'ouverture",
      onboarding: {
        societe: {
          raisonSociale:     formData.raisonSociale     || '',
          nomCommercial:     formData.nomCommercial     || '',
          formeJuridique:    formData.formeJuridique    || '',
          siren:             formData.siren             || '',
          siret:             formData.siret             || '',
          tvaIntracom:       formData.tvaIntracom       || '',
          dateCreation:      formData.dateCreation      || '',
          adresse:           formData.adresse           || '',
          complementAdresse: formData.complementAdresse || '',
          codePostal:        formData.codePostal        || '',
          ville:             formData.ville             || '',
          pays:              formData.pays              || 'France',
        },
        responsableLegal: {
          nom:       formData.nom       || '',
          prenom:    formData.prenom    || '',
          fonction:  formData.fonction  || '',
          telephone: formData.telephone || '',
          email:     formData.email     || '',
        },
        activite: {
          nombreCommerciaux:    formData.nombreCommerciaux    || '',
          dossiersMensuels:     formData.dossiersMensuels     || '',
          zonesIntervention:    formData.zonesIntervention    || '',
          produitsCommercialises: formData.produitsCommercialises || '',
        },
        documents: {},
      },
      historique: [{
        date: new Date().toISOString(),
        action: 'Demande déposée',
        details: `Demande déposée par ${formData.prenom || ''} ${formData.nom || ''} (${formData.email || ''})`,
      }],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await collection(db, 'regies').add(regieData);
    const regieId = docRef.id;
    await updateDoc(doc(db, 'regies', regieId), { id: regieId });

    // 2. Uploader les documents vers Firebase Storage
    const documentPaths = {};
    if (documents && typeof documents === 'object') {
      const storageBucketName = process.env.FIREBASE_STORAGE_BUCKET ||
        `${(admin.app().options.credential?.projectId || process.env.FIREBASE_PROJECT_ID || 'crm-pose')}.appspot.com`;

      let bucket;
      try {
        bucket = admin.storage().bucket(storageBucketName);
      } catch (e) {
        console.warn('[Regie Onboarding] Storage non disponible:', e.message);
      }

      if (bucket) {
        for (const [key, fileData] of Object.entries(documents)) {
          try {
            const { base64, filename, contentType } = fileData;
            if (!base64) continue;
            const buffer = Buffer.from(base64, 'base64');
            const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
            const storagePath = `regies/${regieId}/onboarding/${key}/${safeName}`;
            const fileRef = bucket.file(storagePath);
            await fileRef.save(buffer, {
              metadata: { contentType: contentType || 'application/octet-stream' },
            });
            documentPaths[key] = storagePath;
            console.log(`[Regie Onboarding] Document uploadé: ${storagePath}`);
          } catch (uploadErr) {
            console.warn(`[Regie Onboarding] Erreur upload ${key}:`, uploadErr.message);
          }
        }
        if (Object.keys(documentPaths).length > 0) {
          await updateDoc(doc(db, 'regies', regieId), { 'onboarding.documents': documentPaths });
        }
      }
    }

    // 3. Notification aux admins (Firestore + email)
    try {
      const usersSnap = await getDocs(collection(db, 'users'));
      const adminDocs = usersSnap.docs.filter(d => {
        const role = String(d.data()?.role || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        return role === 'administrateur' || role === 'rh';
      });
      const adminIds = adminDocs.map(d => d.id);

      if (adminIds.length > 0) {
        await collection(db, 'notifications').add({
          category: 'new_dossier',
          type: 'lead',
          source: 'onboarding',
          title: `Nouvelle demande partenariat — ${formData.raisonSociale}`,
          description: `${formData.prenom || ''} ${formData.nom || ''} (${formData.email || ''}) a déposé une demande d'ouverture de compte régie.`,
          recipientIds: adminIds,
          regieId,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Envoi email à chaque admin
      const frontendUrl = process.env.FRONTEND_URL || 'https://labelenergie1.netlify.app';
      for (const adminDoc of adminDocs) {
        const adminEmail = adminDoc.data()?.email;
        const adminName  = adminDoc.data()?.displayName || adminDoc.data()?.prenom || 'Administrateur';
        if (!adminEmail) continue;
        try {
          await sendRegieOnboardingEmail({
            toEmail: adminEmail,
            toName: adminName,
            subject: `Nouvelle demande partenariat — ${formData.raisonSociale || ''}`,
            body: `Bonjour ${adminName},\n\nUne nouvelle demande d'ouverture de compte partenaire régie vient d'être reçue.\n\nSociété : ${formData.raisonSociale || '—'}\nContact : ${formData.prenom || ''} ${formData.nom || ''}\nEmail : ${formData.email || '—'}\nTéléphone : ${formData.telephone || '—'}\n\nConsultez la demande dans le CRM :\n${frontendUrl}/regie/${regieId}\n\nCordialement,\nLabel Énergie CRM`,
          });
          console.log(`[Regie Onboarding] Email admin envoyé à ${adminEmail}`);
        } catch (mailErr) {
          console.warn(`[Regie Onboarding] Email admin impossible pour ${adminEmail}:`, mailErr.message);
        }
      }
    } catch (notifErr) {
      console.warn('[Regie Onboarding] Notification impossible:', notifErr.message);
    }

    console.log(`[Regie Onboarding] ✅ Demande créée: ${regieId}`);
    return res.json({ success: true, regieId });
  } catch (err) {
    console.error('[Regie Onboarding] Erreur submit:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/regie-onboarding/refuse
 * Envoie un email de refus au candidat.
 */
app.post('/api/regie-onboarding/refuse', async (req, res) => {
  try {
    const { regieId, email, nom, motif } = req.body;
    if (!email || !motif) return res.status(400).json({ success: false, error: 'email et motif requis' });

    await sendRegieOnboardingEmail({
      toEmail: email,
      toName: nom,
      subject: 'Label Énergie — Votre demande de partenariat',
      body: `Bonjour ${nom},\n\nNous avons bien étudié votre demande d'ouverture de compte partenaire et nous regrettons de ne pas pouvoir y donner suite dans l'immédiat.\n\nMotif : ${motif}\n\nN'hésitez pas à nous recontacter pour toute question.\n\nCordialement,\nL'équipe Label Énergie`,
    });

    console.log(`[Regie Onboarding] Refus envoyé à ${email}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Regie Onboarding] Erreur refuse:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/regie-onboarding/request-complement
 * Envoie un email de demande de compléments.
 */
app.post('/api/regie-onboarding/request-complement', async (req, res) => {
  try {
    const { regieId, email, nom, message } = req.body;
    if (!email || !message) return res.status(400).json({ success: false, error: 'email et message requis' });

    const frontendUrl = process.env.FRONTEND_URL || 'https://labelenergie1.netlify.app';

    await sendRegieOnboardingEmail({
      toEmail: email,
      toName: nom,
      subject: 'Label Énergie — Compléments requis pour votre dossier',
      body: `Bonjour ${nom},\n\nNous avons bien reçu votre demande de partenariat et nous vous remercions de l'intérêt que vous portez à Label Énergie.\n\nAfin de traiter votre dossier, nous avons besoin des éléments complémentaires suivants :\n\n${message}\n\nMerci de nous faire parvenir ces éléments dès que possible.\n\nCordialement,\nL'équipe Label Énergie`,
    });

    console.log(`[Regie Onboarding] Complément demandé à ${email}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Regie Onboarding] Erreur request-complement:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/regie-onboarding/send-contract
 * Envoie le contrat de partenariat via DocuSign.
 */
app.post('/api/regie-onboarding/send-contract', async (req, res) => {
  try {
    if (!docusignService.isConfigured()) {
      return res.status(503).json({ success: false, error: 'DocuSign non configuré' });
    }
    if (!db) return res.status(503).json({ success: false, error: 'Firebase non initialisé' });

    const { regieId, pdfBase64, signerEmail, signerFirstName, signerLastName, raisonSociale } = req.body;
    if (!pdfBase64 || !signerEmail || !regieId) {
      return res.status(400).json({ success: false, error: 'pdfBase64, signerEmail et regieId requis' });
    }

    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const { envelopeId } = await docusignService.createEnvelopeFromPdfBuffer(
      pdfBuffer,
      `contrat-partenariat-${raisonSociale || regieId}.pdf`,
      signerEmail,
      signerFirstName || '',
      signerLastName || '',
      {
        emailSubject: `Contrat de partenariat Label Énergie — Signature requise`,
        emailBody: `Bonjour,\n\nVeuillez trouver ci-joint votre contrat de partenariat Label Énergie à signer électroniquement.\n\nCordialement,\nL'équipe Label Énergie`,
        includeSepaTabs: false,
      }
    );

    // Mettre à jour la fiche régie
    await updateDoc(doc(db, 'regies', regieId), {
      status: 'Contrat envoyé',
      'onboarding.docusignEnvelopeId': envelopeId,
      'onboarding.docusignStatus': 'sent',
      'onboarding.docusignSentAt': new Date().toISOString(),
    });

    console.log(`[Regie Onboarding] Contrat envoyé via DocuSign: ${envelopeId}`);
    return res.json({ success: true, envelopeId });
  } catch (err) {
    console.error('[Regie Onboarding] Erreur send-contract:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/regie-onboarding/create-account
 * Crée le compte Firebase Auth + utilisateur Firestore + email de bienvenue.
 */
app.post('/api/regie-onboarding/create-account', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ success: false, error: 'Firebase non initialisé' });

    const { regieId, email, firstName, lastName, raisonSociale } = req.body;
    if (!email || !regieId) return res.status(400).json({ success: false, error: 'email et regieId requis' });

    // Créer l'utilisateur Firebase Auth
    let uid;
    try {
      const userRecord = await admin.auth().createUser({
        email,
        displayName: `${firstName || ''} ${lastName || ''}`.trim() || raisonSociale,
        emailVerified: false,
      });
      uid = userRecord.uid;
    } catch (authErr) {
      if (authErr.code === 'auth/email-already-exists') {
        const existing = await admin.auth().getUserByEmail(email);
        uid = existing.uid;
      } else throw authErr;
    }

    // Générer un lien de définition du mot de passe (à usage unique)
    const passwordLink = await admin.auth().generatePasswordResetLink(email, {
      url: process.env.FRONTEND_URL || 'https://labelenergie1.netlify.app',
    });

    // Créer le document utilisateur dans Firestore
    await setDoc(doc(db, 'users', uid), {
      uid,
      email,
      firstName: firstName || '',
      lastName: lastName || '',
      role: 'regie',
      regie: { id: regieId, name: raisonSociale || '' },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'active',
    });

    // Mettre à jour la fiche régie
    await updateDoc(doc(db, 'regies', regieId), {
      status: 'Régie active',
      'onboarding.accountCreatedAt': new Date().toISOString(),
      'onboarding.accountUid': uid,
    });

    // Envoyer l'email de bienvenue avec le lien de création de mot de passe
    await sendRegieOnboardingEmail({
      toEmail: email,
      toName: `${firstName || ''} ${lastName || ''}`.trim(),
      subject: 'Bienvenue chez Label Énergie — Votre compte partenaire est activé',
      body: `Bonjour ${firstName || ''},\n\nNous avons le plaisir de vous informer que votre compte partenaire Label Énergie est maintenant activé.\n\nPour accéder à votre espace, vous devez d'abord créer votre mot de passe en cliquant sur le lien ci-dessous :\n\n${passwordLink}\n\nCe lien est personnel, à usage unique et expire dans 24 heures.\n\nUne fois connecté, vous aurez accès à :\n• Votre tableau de bord régie\n• Le suivi de vos dossiers\n• Vos factures et commissions\n\nPour toute question, notre équipe est à votre disposition.\n\nCordialement,\nL'équipe Label Énergie`,
    });

    console.log(`[Regie Onboarding] Compte créé pour ${email} (uid: ${uid})`);
    return res.json({ success: true, uid });
  } catch (err) {
    console.error('[Regie Onboarding] Erreur create-account:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Extension du webhook DocuSign existant — gestion des contrats de partenariat régie
// (Le webhook principal à /api/docusign/webhook gère déjà maintenances,
//  ce handler complémentaire détecte les régie onboarding via onboarding.docusignEnvelopeId)
app.post('/api/docusign/webhook/regie', express.json(), async (req, res) => {
  try {
    const envelopeId = req.body.envelopeId || req.body.data?.envelopeId;
    const status     = req.body.status     || req.body.data?.status;
    if (!envelopeId) return res.status(400).json({ error: 'envelopeId manquant' });

    console.log('[DocuSign][Webhook Régie]', { envelopeId, status });
    res.json({ received: true });

    if (!db) return;

    // Chercher la régie liée à cet envelopeId
    const snap = await getDocs(query(collection(db, 'regies'), where('onboarding.docusignEnvelopeId', '==', envelopeId)));
    if (snap.empty) return;

    const regieDoc = snap.docs[0];
    const regieId  = regieDoc.id;
    const updateData = { 'onboarding.docusignStatus': status };

    if (status === 'completed') {
      let signedAt = new Date().toISOString();
      try {
        const envelope = await docusignService.getEnvelopeStatus(envelopeId);
        signedAt = envelope.signers?.find(s => s.signedDateTime)?.signedDateTime || signedAt;
      } catch (e) { /* ignore */ }

      Object.assign(updateData, {
        status: 'Contrat signé',
        'onboarding.docusignSignedAt': signedAt,
        historique: admin.firestore.FieldValue.arrayUnion({
          date: new Date().toISOString(),
          action: 'Contrat signé',
          details: `Signature confirmée par DocuSign (envelope: ${envelopeId})`,
        }),
      });
    }

    await updateDoc(doc(db, 'regies', regieId), updateData);
    console.log(`[DocuSign][Webhook Régie] Régie ${regieId} mise à jour → ${status}`);
  } catch (err) {
    console.error('[DocuSign][Webhook Régie] Erreur:', err.message);
  }
});
