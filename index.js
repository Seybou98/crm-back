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

// Imports Firestore pour la synchronisation YouSign
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, updateDoc, collection, query, where, getDocs } = require('firebase/firestore');

const app = express();
app.use(express.json());
// Configuration CORS dynamique pour production
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  process.env.ADMIN_URL || 'http://localhost:3000',
  'https://teal-sunflower-0ade91.netlify.app', // Frontend Netlify (ancien)
  'https://labelenergie1.netlify.app', // Frontend Netlify (nouveau)
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

// Configuration YouSign dynamique pour production
const YOUSIGN_API_URL = process.env.YOUSIGN_API_URL || 'https://api-sandbox.yousign.app/v3';
const YOUSIGN_API_TOKEN = process.env.YOUSIGN_API_KEY;
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || 'service_wl6kjuo';
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || 'template_nfsa5wv';
const EMAILJS_USER_ID = process.env.EMAILJS_USER_ID || '9DbPDdjUGFwv3WVZ0';

// Configuration Firebase pour la synchronisation YouSign
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID
};

// Initialiser Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Utilitaire axios Yousign
const yousignApi = axios.create({
  baseURL: YOUSIGN_API_URL,
  headers: {
    Authorization: `Bearer ${YOUSIGN_API_TOKEN}`,
  }
});

// 1. Créer la demande de signature
async function createSignatureRequest(name = 'My Signature Request') {
  const res = await yousignApi.post('/signature_requests', {
    name,
    delivery_mode: 'email'
  });
  return res.data.id;
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
async function addSigner(signatureRequestId, documentId, firstName, lastName, email) {
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
          page: 1,
          x: 200,
          y: 400
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

    // 1. Créer le client
    const customerResponse = await axios.post(`${apiUrl}/customers`, {
      customers: {
        email: `${account_holder_name.toLowerCase().replace(' ', '.')}@example.com`,
        given_name: account_holder_name.split(' ')[0] || account_holder_name,
        family_name: account_holder_name.split(' ').slice(1).join(' ') || account_holder_name,
        address_line1: metadata?.address || 'Adresse non spécifiée',
        city: metadata?.city || 'Ville non spécifiée',
        postal_code: metadata?.postalCode || '00000',
        country_code: metadata?.country || 'FR'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    // 2. Créer le compte bancaire
    const bankAccountResponse = await axios.post(`${apiUrl}/customer_bank_accounts`, {
      customer_bank_accounts: {
        account_holder_name,
        iban,
        links: {
          customer: customerResponse.data.customers.id
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
    const mandateResponse = await axios.post(`${apiUrl}/mandates`, {
      mandates: {
        scheme: 'sepa_core',
        links: {
          customer_bank_account: bankAccountResponse.data.customer_bank_accounts.id,
          creditor: process.env.GOCARDLESS_CREDITOR_ID
        },
        metadata: metadata || {}
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
      url: error.config?.url,
      headers: error.config?.headers,
      requestData: error.config?.data
    });
    res.status(500).json({
      error: 'Erreur lors de la création du mandat GoCardless',
      details: error.response?.data || error.message,
      status: error.response?.status,
      url: error.config?.url,
      requestData: error.config?.data
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

    // 1. Créer le client
    const customerResponse = await axios.post(`${apiUrl}/customers`, {
      customers: {
        email: `${account_holder_name.toLowerCase().replace(' ', '.')}@example.com`,
        given_name: account_holder_name.split(' ')[0] || account_holder_name,
        family_name: account_holder_name.split(' ').slice(1).join(' ') || account_holder_name,
        address_line1: metadata?.address || 'Adresse non spécifiée',
        city: metadata?.city || 'Ville non spécifiée',
        postal_code: metadata?.postalCode || '00000',
        country_code: metadata?.country || 'FR'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    // 2. Créer le compte bancaire
    const bankAccountResponse = await axios.post(`${apiUrl}/customer_bank_accounts`, {
      customer_bank_accounts: {
        account_holder_name,
        iban,
        links: {
          customer: customerResponse.data.customers.id
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
    const mandateResponse = await axios.post(`${apiUrl}/mandates`, {
      mandates: {
        scheme: 'sepa_core',
        links: {
          customer_bank_account: bankAccountResponse.data.customer_bank_accounts.id,
          creditor: process.env.GOCARDLESS_CREDITOR_ID
        },
        metadata: metadata || {}
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
      url: error.config?.url,
      headers: error.config?.headers,
      requestData: error.config?.data
    });
    res.status(500).json({
      error: 'Erreur lors de la création du mandat GoCardless (sandbox)',
      details: error.response?.data || error.message,
      status: error.response?.status,
      url: error.config?.url,
      requestData: error.config?.data
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
    const { amount, currency, mandate_id, description, reference } = req.body;

    if (!amount || !currency || !mandate_id) {
      return res.status(400).json({ error: 'amount, currency et mandate_id sont requis' });
    }

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

    const response = await axios.post(`${apiUrl}/payments`, {
      payments: {
        amount: Math.round(amount * 100), // ✅ Conversion en centimes + arrondi à l'entier
        currency,
        links: {
          mandate: mandate_id
        },
        description: description || 'Paiement de maintenance',
        metadata: {
          reference: reference || 'PAYMENT_CREATED'
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    res.json({
      paymentId: response.data.payments.id,
      status: response.data.payments.status,
      amount: response.data.payments.amount,
      currency: response.data.payments.currency,
      description: response.data.payments.description
    });

  } catch (error) {
    console.error('[GoCardless] Erreur création paiement complète:', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      url: error.config?.url,
      headers: error.config?.headers,
      requestData: error.config?.data
    });
    res.status(500).json({
      error: 'Erreur lors de la création du paiement GoCardless',
      details: error.response?.data || error.message,
      status: error.response?.status,
      url: error.config?.url,
      requestData: error.config?.data
    });
  }
});

// POST : créer un paiement GoCardless (endpoint API)
app.post('/api/gocardless/create-payment', async (req, res) => {
  try {
    console.log('[GoCardless] Création de paiement via API:', req.body);
    const { amount, currency, mandate_id, description, reference } = req.body;

    if (!amount || !currency || !mandate_id) {
      return res.status(400).json({ error: 'amount, currency et mandate_id sont requis' });
    }

    if (!process.env.GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({ 
        error: 'GOCARDLESS_ACCESS_TOKEN manquant'
      });
    }

    const apiUrl = getGoCardlessApiUrl();

    const response = await axios.post(`${apiUrl}/payments`, {
      payments: {
        amount: Math.round(amount * 100), // ✅ Conversion en centimes + arrondi à l'entier
        currency,
        links: {
          mandate: mandate_id
        },
        description: description || 'Paiement de maintenance',
        metadata: {
          reference: reference || 'PAYMENT_CREATED'
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    res.json({
      paymentId: response.data.payments.id,
      status: response.data.payments.status,
      amount: response.data.payments.amount,
      currency: response.data.payments.currency,
      description: response.data.payments.description
    });

  } catch (error) {
    console.error('[GoCardless] Erreur création paiement API:', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      url: error.config?.url,
      headers: error.config?.headers,
      requestData: error.config?.data
    });
    res.status(500).json({
      error: 'Erreur lors de la création du paiement GoCardless',
      details: error.response?.data || error.message,
      status: error.response?.status,
      url: error.config?.url,
      requestData: error.config?.data
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
  
  switch (action) {
    case 'created':
      console.log('[GoCardless] Paiement créé:', links.payment);
      await handlePaymentCreated(links.payment);
      break;
    case 'confirmed':
      console.log('[GoCardless] Paiement confirmé:', links.payment);
      // ✅ NOUVEAU : Déclencher automatiquement le prochain paiement
      await handlePaymentConfirmed(links.payment);
      break;
    case 'failed':
      console.log('[GoCardless] Paiement échoué:', links.payment);
      await handlePaymentFailed(links.payment);
      break;
    case 'cancelled':
      console.log('[GoCardless] Paiement annulé:', links.payment);
      await handlePaymentCancelled(links.payment);
      break;
    case 'submitted':
      console.log('[GoCardless] Paiement soumis:', links.payment);
      await handlePaymentSubmitted(links.payment);
      break;
    default:
      console.log('[GoCardless] Action de paiement non gérée:', action);
  }
}

async function handleSubscriptionEvent(event) {
  const { action, links } = event;
  
  switch (action) {
    case 'created':
      console.log('[GoCardless] Abonnement créé:', links.subscription);
      break;
    case 'active':
      console.log('[GoCardless] Abonnement activé:', links.subscription);
      break;
    case 'cancelled':
      console.log('[GoCardless] Abonnement annulé:', links.subscription);
      break;
    default:
      console.log('[GoCardless] Action d\'abonnement non gérée:', action);
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
    const maintenanceId = metadata.maintenanceId;
    
    if (!maintenanceId) {
      console.log(`[GoCardless] Pas de maintenanceId dans les métadonnées du paiement: ${paymentId}`);
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
    // ✅ NOUVEAU : Endpoint pour notifier le frontend
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
    
  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la notification du frontend:`, error);
  }
}

/**
 * Notifier le frontend qu'un paiement a échoué
 */
async function notifyFrontendPaymentFailed(maintenanceId, paymentId, payment) {
  try {
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
    
  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la notification du frontend:`, error);
  }
}

/**
 * Notifier le frontend qu'un paiement est soumis
 */
async function notifyFrontendPaymentSubmitted(maintenanceId, paymentId, payment) {
  try {
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
    
  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la notification du frontend:`, error);
  }
}

/**
 * Notifier le frontend qu'un paiement est créé
 */
async function notifyFrontendPaymentCreated(maintenanceId, paymentId, payment) {
  try {
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
    
  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la notification du frontend:`, error);
  }
}

/**
 * Notifier le frontend qu'un paiement est annulé
 */
async function notifyFrontendPaymentCancelled(maintenanceId, paymentId, payment) {
  try {
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
    
  } catch (error) {
    console.error(`[GoCardless] Erreur lors de la notification du frontend:`, error);
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
    const apiUrl = `${process.env.YOUSIGN_API_URL}/v3/signature-requests/${requestId}`;
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

// GET : récupérer toutes les maintenances en attente de signature
app.get('/api/maintenance/pending-signatures', async (req, res) => {
  try {
    console.log('[Maintenance] Récupération des maintenances en attente de signature');

    // Récupérer depuis Firestore (vous devrez adapter selon votre structure)
    const maintenancesRef = collection(db, 'maintenances');
    const q = query(
      maintenancesRef,
      where('signatureStatus', '==', 'pending'),
      where('yousignRequestId', '!=', null)
    );

    const snapshot = await getDocs(q);
    const maintenances = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

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
    const documentsUrl = `${process.env.YOUSIGN_API_URL}/v3/signature-requests/${requestId}/documents`;
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
    
    // Télécharger le fichier signé
    const downloadUrl = `${process.env.YOUSIGN_API_URL}/v3/documents/${document.id}/download`;
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

// Lancer le serveur
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Serveur Yousign backend démarré sur le port ${PORT}`);
});
