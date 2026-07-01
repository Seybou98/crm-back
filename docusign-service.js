/**
 * Service DocuSign eSignature
 * - Authentification JWT (OAuth 2.0)
 * - Création d'enveloppes (document + signataire)
 * - Récupération statut et téléchargement document signé
 * Remplace YouSign pour la signature électronique (maintenance + SAV).
 */

const axios = require('axios');
const jwt = require('jsonwebtoken');
const path = require('path');

// Configuration depuis .env
const DOCUSIGN_INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY;
const DOCUSIGN_USER_ID = process.env.DOCUSIGN_USER_ID; // GUID de l'utilisateur API
const DOCUSIGN_ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID;
const DOCUSIGN_PRIVATE_KEY = process.env.DOCUSIGN_PRIVATE_KEY; // PEM, \n pour les retours à la ligne
const DOCUSIGN_BASE_URL = process.env.DOCUSIGN_BASE_URL || 'https://demo.docusign.net'; // demo ou https://www.docusign.net
const DOCUSIGN_OAUTH_HOST = process.env.DOCUSIGN_OAUTH_HOST || 'account-d.docusign.com'; // account-d = demo, account = prod

let cachedAccessToken = null;
let tokenExpiresAt = 0;
const TOKEN_BUFFER_MS = 5 * 60 * 1000; // Renouveler 5 min avant expiration

function getPrivateKey() {
  if (!DOCUSIGN_PRIVATE_KEY) return null;
  const key = DOCUSIGN_PRIVATE_KEY.replace(/\\n/g, '\n');
  return key;
}

/**
 * Obtient un access token via JWT Grant (OAuth 2.0).
 * Le token est mis en cache jusqu'à expiration.
 */
async function getAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - TOKEN_BUFFER_MS) {
    return cachedAccessToken;
  }

  if (!DOCUSIGN_INTEGRATION_KEY || !DOCUSIGN_USER_ID || !DOCUSIGN_ACCOUNT_ID) {
    throw new Error('DocuSign: DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID et DOCUSIGN_ACCOUNT_ID sont requis');
  }

  const privateKey = getPrivateKey();
  // DEBUG TEMPORAIRE POUR DIAGNOSTIC CLE / JWT
  if (privateKey) {
    const start = privateKey.substring(0, 80);
    const end = privateKey.substring(privateKey.length - 80);
    console.log('[DocuSign][DEBUG] Clé privée - début:', JSON.stringify(start));
    console.log('[DocuSign][DEBUG] Clé privée - fin:', JSON.stringify(end));
    console.log('[DocuSign][DEBUG] Contient vrais newlines:', privateKey.includes('\n'));
    console.log('[DocuSign][DEBUG] Nombre de lignes:', privateKey.split('\n').length);
  } else {
    console.log('[DocuSign][DEBUG] Aucune clé privée chargée depuis DOCUSIGN_PRIVATE_KEY');
  }
  // FIN DEBUG TEMPORAIRE

  if (!privateKey) {
    throw new Error('DocuSign: DOCUSIGN_PRIVATE_KEY (clé privée RSA PEM) est requise');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: DOCUSIGN_INTEGRATION_KEY,
    sub: DOCUSIGN_USER_ID,
    aud: DOCUSIGN_OAUTH_HOST,
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation'
  };

  const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' });
  const url = `https://${DOCUSIGN_OAUTH_HOST}/oauth/token`;
  
  try {
    const response = await axios.post(
      url,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: token
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    cachedAccessToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in || 3600) * 1000;
    console.log('[DocuSign] Access token obtenu avec succès');
    return cachedAccessToken;
  } catch (error) {
    if (error.response?.data?.error === 'consent_required') {
      const consentUrl = `https://${DOCUSIGN_OAUTH_HOST}/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=${DOCUSIGN_INTEGRATION_KEY}&redirect_uri=https://developers.docusign.com/platform/auth/consent`;
      console.error('[DocuSign] ❌ CONSENT REQUIRED');
      console.error('[DocuSign] L\'utilisateur doit donner son consentement une fois.');
      console.error('[DocuSign] URL de consentement:', consentUrl);
      console.error('[DocuSign] Instructions:');
      console.error('[DocuSign] 1. Connecte-toi à DocuSign Demo avec le compte User ID:', DOCUSIGN_USER_ID);
      console.error('[DocuSign] 2. Ouvre cette URL dans le même navigateur:', consentUrl);
      console.error('[DocuSign] 3. Clique sur "Allow" / "Autoriser"');
      throw new Error(`Consent required. Open this URL to grant consent: ${consentUrl}`);
    }
    throw error;
  }
}

function getBasePath() {
  return `${DOCUSIGN_BASE_URL}/restapi/v2.1`;
}

async function apiRequest(method, path, options = {}) {
  try {
    const token = await getAccessToken();
    const url = path.startsWith('http') ? path : `${getBasePath()}/accounts/${DOCUSIGN_ACCOUNT_ID}${path}`;
    const config = {
      method,
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': options.headers?.['Content-Type'] || 'application/json',
        ...options.headers
      },
      ...options
    };
    const response = await axios(config);
    return response.data;
  } catch (error) {
    // Propager les erreurs DocuSign avec leur structure complète
    if (error.response?.data) {
      error.response.data = error.response.data;
    }
    throw error;
  }
}

/**
 * Crée une enveloppe à partir d'un buffer PDF et envoie au signataire.
 * @param {Buffer} pdfBuffer - Contenu du PDF
 * @param {string} fileName - Nom du fichier (ex: contract.pdf)
 * @param {string} signerEmail - Email du signataire
 * @param {string} signerFirstName - Prénom
 * @param {string} signerLastName - Nom
 * @param {object} options - { emailSubject, emailBody, signatureBlockPage }
 *   signatureBlockPage: 1 = bloc signature sur page 1 (1–2 produits), 2 = sur page 2 (3+ produits, page « Page 1 (suite) »)
 * @returns {Promise<{ envelopeId: string }>}
 */
async function createEnvelopeFromPdfBuffer(pdfBuffer, fileName, signerEmail, signerFirstName, signerLastName, options = {}) {
  const documentBase64 = pdfBuffer.toString('base64');
  const signerName = [signerFirstName, signerLastName].filter(Boolean).join(' ') || 'Signataire';
  // On utilise des ancres DocuSign (anchorString) : plus besoin de calculer la page.
  // signatureBlockPage est conservé pour compatibilité mais ignoré.

  const includeSepaTabs = options.includeSepaTabs !== false;

  const signHereTabs = [
    // Document — zone "Signature client"
    {
      documentId: '1',
      tabLabel: 'Signature',
      anchorString: 'DS_SIGNATURE_CLIENT',
      anchorUnits: 'pixels',
      anchorXOffset: '0',
      anchorYOffset: '0',
      anchorMatchWholeWord: 'true',
      anchorCaseSensitive: 'true',
      anchorIgnoreIfNotPresent: 'false',
    },
  ];

  if (includeSepaTabs) {
    // SEPA (page 4) — zone date et signature du débiteur
    signHereTabs.push({
      documentId: '1',
      tabLabel: 'SignatureSEPA',
      anchorString: 'DS_SIGNATURE_SEPA',
      anchorUnits: 'pixels',
      anchorXOffset: '0',
      anchorYOffset: '0',
      anchorMatchWholeWord: 'true',
      anchorCaseSensitive: 'true',
      anchorIgnoreIfNotPresent: 'false',
    });
  }

  // Page 5 (rétractation) : pas de signature DocuSign — le client remplit ce formulaire
  // uniquement en cas de rétractation ultérieure (courrier / e-mail).

  // Pas d’onglets « Date signée » : le format affiché suit le compte DocuSign (souvent US) et l’API
  // n’accepte pas un motif JJ/MM/AAAA fiable. La date « Le : » est imprimée en JJ/MM/AAAA dans le PDF.

  const envelopeDefinition = {
    emailSubject: options.emailSubject || 'Votre contrat Label Énergie — Signature requise',
    emailBlurb: options.emailBody || 'Madame, Monsieur,\n\nNous vous remercions de l\'intérêt que vous portez à nos services.\n\nVeuillez trouver ci-joint votre contrat de souscription. Nous vous invitons à en prendre connaissance attentivement avant de procéder à la signature électronique via le bouton ci-dessus.\n\nPour toute question relative au document ou à nos offres, notre équipe reste disponible à votre disposition.\n\nCordialement,\nL\'équipe Label Énergie',
    documents: [
      {
        documentBase64,
        name: fileName || 'document.pdf',
        fileExtension: 'pdf',
        documentId: '1'
      }
    ],
    recipients: {
      signers: [
        {
          email: signerEmail,
          name: signerName,
          recipientId: '1',
          // Pas de emailNotification ici : certains comptes DocuSign renvoient
          // USER_LACKS_RECIPIENTEMAILNOTIFICATION_PERMISSION (paramètre admin requis).
          tabs: {
            signHereTabs,
          }
        }
      ]
    },
    status: 'sent'
  };

  const data = await apiRequest('POST', '/envelopes', {
    data: envelopeDefinition
  });

  console.log('[DocuSign] Enveloppe créée:', data.envelopeId);
  return { envelopeId: data.envelopeId };
}

/**
 * Crée une enveloppe en téléchargeant le PDF depuis une URL (ex: Firebase Storage).
 */
async function createEnvelopeFromPdfUrl(pdfUrl, signerEmail, signerFirstName, signerLastName, options = {}) {
  const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
  const pdfBuffer = Buffer.from(response.data);
  const fileName = options.fileName || path.basename(new URL(pdfUrl).pathname) || 'contract.pdf';
  return createEnvelopeFromPdfBuffer(pdfBuffer, fileName, signerEmail, signerFirstName, signerLastName, options);
}

/**
 * Récupère le statut d'une enveloppe (et des signataires).
 * include=recipients permet d'obtenir signedDateTime pour chaque signataire.
 */
async function getEnvelopeStatus(envelopeId) {
  try {
    const data = await apiRequest('GET', `/envelopes/${envelopeId}?include=recipients`);
    const signers = (data.recipients && data.recipients.signers) || [];
    return {
      envelopeId: data.envelopeId,
      status: data.status, // sent, delivered, signed, completed, declined, voided
      statusDateTime: data.statusDateTime,
      signers: signers.map((s, i) => ({
        id: s.recipientId || String(i + 1),
        email: s.email,
        name: s.name,
        status: s.status,
        signedDateTime: s.signedDateTime
      }))
    };
  } catch (error) {
    // ✅ Gestion erreur DocuSign : limite de polling horaire dépassée
    if (error.response?.data?.errorCode === 'HOURLY_ENVELOPE_POLLING_LIMIT_EXCEEDED' ||
        error.response?.data?.error === 'HOURLY_ENVELOPE_POLLING_LIMIT_EXCEEDED') {
      // Propager l'erreur pour que le frontend puisse la gérer
      throw {
        errorCode: 'HOURLY_ENVELOPE_POLLING_LIMIT_EXCEEDED',
        message: error.response?.data?.message || 'Limite de polling horaire dépassée (250 appels/heure)'
      };
    }
    throw error;
  }
}

/**
 * Télécharge le document combiné (PDF signé) d'une enveloppe.
 * @returns {Promise<Buffer>}
 */
async function getEnvelopeDocumentCombined(envelopeId) {
  const url = `${getBasePath()}/accounts/${DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}/documents/combined`;
  const token = await getAccessToken();
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer'
  });
  return Buffer.from(response.data);
}

/**
 * Récupère l'image de signature du premier signataire (recipientId '1').
 * Utilisé pour afficher la signature sur le PDF contrat généré côté front.
 * @param {string} envelopeId - ID de l'enveloppe DocuSign
 * @param {string} [recipientId='1'] - ID du signataire (défaut: '1' comme à la création)
 * @returns {Promise<{ buffer: Buffer; contentType: string } | null>} Image binaire + type, ou null si indisponible
 */
async function getRecipientSignatureImage(envelopeId, recipientId = '1') {
  const token = await getAccessToken();
  const baseUrl = `${getBasePath()}/accounts/${DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}/recipients/${recipientId}/signature_image`;
  const tryGet = async (includeChrome = false) => {
    const url = includeChrome ? `${baseUrl}?include_chrome=true` : baseUrl;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      validateStatus: () => true
    });
    if (response.status !== 200) return null;
    const contentType = response.headers['content-type'] || 'image/png';
    return { buffer: Buffer.from(response.data), contentType };
  };
  try {
    let result = await tryGet(false);
    if (!result) result = await tryGet(true);
    return result;
  } catch (err) {
    console.warn('[DocuSign] getRecipientSignatureImage:', err.message);
    return null;
  }
}

/**
 * Vérifie si le service DocuSign est configuré.
 */
function isConfigured() {
  return !!(DOCUSIGN_INTEGRATION_KEY && DOCUSIGN_USER_ID && DOCUSIGN_ACCOUNT_ID && getPrivateKey());
}

module.exports = {
  getAccessToken,
  createEnvelopeFromPdfBuffer,
  createEnvelopeFromPdfUrl,
  getEnvelopeStatus,
  getEnvelopeDocumentCombined,
  getRecipientSignatureImage,
  isConfigured
};
