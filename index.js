require('dotenv').config();
const express = require('express');
const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(cors());

const YOUSIGN_API_URL = 'https://api-sandbox.yousign.app/v3';
const YOUSIGN_API_TOKEN = process.env.YOUSIGN_API_TOKEN;
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || 'service_wl6kjuo';
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || 'template_nfsa5wv';
const EMAILJS_USER_ID = process.env.EMAILJS_USER_ID || '9DbPDdjUGFwv3WVZ0';

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
    res.json(signatureRequest);
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

// POST : endpoint webhook pour recevoir les notifications Yousign
app.post('/api/yousign/webhook', express.json(), (req, res) => {
  // Ici tu peux traiter les notifications de statut Yousign
  console.log('[Yousign][Webhook] Notification reçue:', req.body);
  // Tu peux stocker le statut, envoyer un email, etc.
  res.status(200).json({ received: true });
});

// Lancer le serveur
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Serveur Yousign backend démarré sur le port ${PORT}`);
});
