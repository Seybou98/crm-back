// Diagnostic 100% en lecture seule : vérifie le statut du creditor GoCardless
// associé au token configuré dans .env (aucune création, aucun effet de bord).
//
// Usage :
//   cd gocardless-backend
//   node scripts/check-live-creditor.js

const path = require('path');
const fs = require('fs');
const axios = require('axios');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const token = process.env.GOCARDLESS_ACCESS_TOKEN;
const creditorId = process.env.GOCARDLESS_CREDITOR_ID;

async function main() {
  if (!token) {
    console.error('❌ GOCARDLESS_ACCESS_TOKEN manquant dans .env');
    process.exit(1);
  }
  if (!creditorId) {
    console.error('❌ GOCARDLESS_CREDITOR_ID manquant dans .env');
    process.exit(1);
  }

  const isLive = token.startsWith('live_');
  const apiUrl = isLive ? 'https://api.gocardless.com' : 'https://api-sandbox.gocardless.com';

  console.log('Environnement détecté:', isLive ? 'LIVE' : 'SANDBOX');
  console.log('API utilisée:', apiUrl);
  console.log('Creditor ID:', creditorId);
  console.log('Token (masqué):', token.slice(0, 10) + '...' + token.slice(-4));
  console.log('');

  try {
    const res = await axios.get(`${apiUrl}/creditors/${creditorId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'GoCardless-Version': '2015-07-06',
      },
    });
    const creditor = res.data.creditors;
    console.log('✅ Lecture du creditor réussie :');
    console.log('  name:', creditor.name);
    console.log('  activated:', creditor.activated);
    console.log('  verification_status:', creditor.verification_status);
    console.log('  collections_permitted:', creditor.collections_permitted); // faux tant que le compte n'est pas totalement approuvé
    console.log('  can_create_refunds:', creditor.can_create_refunds);
  } catch (err) {
    console.error('❌ Erreur lors de la lecture du creditor:');
    console.error(JSON.stringify(err.response?.data || { message: err.message }, null, 2));
    console.error('HTTP status:', err.response?.status);
  }

  // Test complémentaire : lister les mandats existants (lecture seule) pour voir si le compte a déjà un historique live
  try {
    const res = await axios.get(`${apiUrl}/mandates?limit=5`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'GoCardless-Version': '2015-07-06',
      },
    });
    console.log('\n✅ Lecture des mandats réussie, total (page):', res.data.mandates?.length ?? 0);
  } catch (err) {
    console.error('\n❌ Erreur lors de la lecture des mandats:');
    console.error(JSON.stringify(err.response?.data || { message: err.message }, null, 2));
  }
}

main();
