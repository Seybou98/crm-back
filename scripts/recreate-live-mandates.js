// Recrée en environnement LIVE le mandat + l'abonnement GoCardless pour des maintenances
// dont le mandat original a été créé par erreur en sandbox — via le flux Billing Requests
// (le client complète lui-même son IBAN sur une page hébergée GoCardless, envoyée par email).
//
// ⚠️ Effet de bord réel : GoCardless envoie un email/lien de mandat SEPA au client à chaque
// exécution "live". Ne pas relancer plusieurs fois pour la même maintenance.
//
// Usage :
//   cd gocardless-backend
//   node scripts/recreate-live-mandates.js                → dry-run (affiche ce qui serait envoyé, aucun appel réel)
//   node scripts/recreate-live-mandates.js --live          → exécute réellement la création + envoi du lien
//   node scripts/recreate-live-mandates.js --live --only=whvzm2GnTfnZQOMAIwqG

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const axios = require('axios');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// IDs des maintenances concernées (collection `maintenances`)
const MAINTENANCE_IDS = [
  'whvzm2GnTfnZQOMAIwqG', // Laurent Bozin
  'RXppUhJc98iCv0qp7I7k', // Didier Theret
];

const isLive = process.argv.includes('--live');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const onlyId = onlyArg ? onlyArg.split('=')[1] : null;
const targetIds = onlyId ? [onlyId] : MAINTENANCE_IDS;

const BACKEND_BASE_URL = process.env.GOCARDLESS_SCRIPT_BASE_URL || 'https://crm-back-lyvg.onrender.com';

function initFirebaseAdmin() {
  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, '..', 'serviceAccountKey.json');

  let serviceAccount = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else if (fs.existsSync(serviceAccountPath)) {
    serviceAccount = require(serviceAccountPath);
  }

  if (serviceAccount) {
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    if (!admin.apps.length) admin.initializeApp();
  }
  return admin.firestore();
}

async function recreateForMaintenance(db, maintenanceId) {
  console.log(`\n=== Maintenance ${maintenanceId} ===`);

  const snap = await db.collection('maintenances').doc(maintenanceId).get();
  if (!snap.exists) {
    console.error('❌ Document introuvable, on saute.');
    return;
  }
  const m = snap.data();

  console.log('Client:', m.clientName || '(inconnu)');
  console.log('Contrat:', m.contractNumber);
  console.log('Ancien mandateId (sandbox):', m.gocardlessMandateId || m.mandateId || '—');
  console.log('Ancien subscriptionId (sandbox):', m.subscriptionId || '—');

  const clientEmail = m.clientContact?.email || m.signerEmail;
  if (!clientEmail) {
    console.error('❌ Aucun email client trouvé, impossible d\'envoyer le lien de prélèvement.');
    return;
  }
  if (!m.monthlyAmount || m.monthlyAmount <= 0) {
    console.error('❌ monthlyAmount invalide, impossible de créer l\'abonnement.');
    return;
  }

  const body = {
    maintenanceId,
    contractNumber: m.contractNumber,
    clientId: m.clientId,
    clientEmail,
    clientName: m.clientName || m.gocardlessAccountHolder || ''
  };

  console.log('Body envoyé à /api/gocardless/billing-requests :', JSON.stringify(body, null, 2));

  if (!isLive) {
    console.log('🟡 DRY-RUN : aucun appel réel effectué (relancer avec --live pour exécuter).');
    return;
  }

  const url = `${BACKEND_BASE_URL}/api/gocardless/billing-requests`;
  const res = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } });
  console.log('✅ Réponse backend:', JSON.stringify(res.data, null, 2));
  console.log('Lien de prélèvement (authorisationUrl):', res.data.authorisationUrl);
  console.log('Email envoyé au client:', res.data.emailSent ? 'oui' : 'non — transmettre le lien manuellement');
  console.log('(Le backend a déjà écrit l\'état "en attente" dans Firestore. L\'abonnement sera créé');
  console.log(' automatiquement via webhook — ou via "Rafraîchir le statut" dans l\'app — une fois');
  console.log(' que le client aura complété son mandat sur la page GoCardless.)');
}

async function main() {
  console.log(`Mode: ${isLive ? '🔴 LIVE (appels réels)' : '🟡 DRY-RUN'}`);
  console.log('Backend cible:', BACKEND_BASE_URL);
  console.log('Maintenances ciblées:', targetIds);

  const db = initFirebaseAdmin();

  for (const id of targetIds) {
    try {
      await recreateForMaintenance(db, id);
    } catch (err) {
      console.error(`❌ Erreur pour ${id}:`, JSON.stringify(err.response?.data || { message: err.message }, null, 2));
    }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('❌ Erreur fatale:', err);
  process.exit(1);
});
