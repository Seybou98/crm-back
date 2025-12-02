/**
 * Script de Test Rapide - Prélèvements Automatiques
 * 
 * Version accélérée pour tester rapidement (toutes les 10 secondes au lieu d'1 heure)
 * 
 * Usage: node test-automatic-payments-quick.js [maintenanceId] [nombre-de-cycles]
 */

const axios = require('axios');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, updateDoc, connectFirestoreEmulator } = require('firebase/firestore');
require('dotenv').config();

// Configuration Firebase (avec gestion d'erreur)
let db = null;
try {
  // ✅ NOUVEAU : Charger depuis le fichier .env du backend
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  require('dotenv').config({ path: envPath });
  
  const firebaseConfig = {
    apiKey: process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.VITE_FIREBASE_APP_ID || process.env.FIREBASE_APP_ID
  };

  if (firebaseConfig.apiKey && firebaseConfig.projectId) {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    console.log('✅ Firebase initialisé');
  } else {
    console.log('⚠️  Configuration Firebase incomplète');
    console.log('   Variables trouvées:', {
      apiKey: !!firebaseConfig.apiKey,
      projectId: !!firebaseConfig.projectId,
      authDomain: !!firebaseConfig.authDomain
    });
    console.log('💡 Vérifiez votre fichier .env dans gocardless-backend/');
  }
} catch (error) {
  console.log('⚠️  Erreur initialisation Firebase:', error.message);
  console.log('💡 Le script utilisera uniquement l\'API backend si disponible');
}

// Configuration
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3002';
const DEFAULT_CYCLES = 12;
const INTERVAL_SECONDS = 10; // 10 secondes pour les tests rapides

// Couleurs pour les logs
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = 'reset') {
  const timestamp = new Date().toLocaleTimeString('fr-FR');
  console.log(`${colors[color]}[${timestamp}] ${message}${colors.reset}`);
}

/**
 * Récupérer une maintenance depuis Firebase ou via l'API backend
 */
async function getMaintenance(maintenanceId) {
  try {
    log(`🔍 Récupération de la maintenance: ${maintenanceId}`, 'cyan');
    
    // ✅ NOUVEAU : Essayer d'abord via l'API backend (plus fiable)
    try {
      log(`🔗 Tentative de connexion au backend: ${BACKEND_URL}`, 'cyan');
      const response = await axios.get(`${BACKEND_URL}/api/maintenance/${maintenanceId}`, {
        timeout: 5000 // Timeout de 5 secondes
      });
      if (response.data) {
        log(`✅ Maintenance trouvée via API: ${response.data.contractNumber || maintenanceId}`, 'green');
        log(`   Client: ${response.data.clientName || 'N/A'}`, 'cyan');
        log(`   Montant: ${response.data.monthlyAmount || 50}€`, 'cyan');
        log(`   Mandat: ${response.data.gocardlessMandateId || 'N/A'}`, 'cyan');
        return response.data;
      }
    } catch (apiError) {
      if (apiError.code === 'ECONNREFUSED' || apiError.code === 'ETIMEDOUT') {
        log(`⚠️  Backend non disponible à ${BACKEND_URL}`, 'yellow');
        log(`💡 Assurez-vous que le backend est démarré: cd gocardless-backend && npm start`, 'yellow');
      } else {
        log(`⚠️  Erreur API backend: ${apiError.message}`, 'yellow');
      }
      log(`🔄 Tentative via Firebase...`, 'yellow');
    }

    // Fallback : Firebase direct (seulement si db est disponible)
    if (!db) {
      log(`\n❌ Erreur: Ni le backend ni Firebase ne sont disponibles`, 'red');
      log(`\n💡 Solutions:`, 'yellow');
      log(`   1. Démarrer le backend:`, 'cyan');
      log(`      cd gocardless-backend`, 'cyan');
      log(`      npm start`, 'cyan');
      log(`\n   2. OU configurer Firebase dans le fichier .env:`, 'cyan');
      log(`      VITE_FIREBASE_API_KEY=...`, 'cyan');
      log(`      VITE_FIREBASE_PROJECT_ID=...`, 'cyan');
      log(`      (etc.)`, 'cyan');
      throw new Error('Backend et Firebase non disponibles');
    }
    
    const maintenanceRef = doc(db, 'maintenances', maintenanceId);
    const maintenanceDoc = await getDoc(maintenanceRef);

    if (!maintenanceDoc.exists()) {
      // ✅ NOUVEAU : Vérifier si c'est un ID de mandat au lieu d'une maintenance
      if (maintenanceId.startsWith('MD01')) {
        throw new Error(`❌ Erreur: Vous avez fourni un ID de MANDAT (${maintenanceId}) au lieu d'un ID de MAINTENANCE.\n   Veuillez fournir l'ID de la maintenance (commence par une lettre aléatoire, pas MD01)`);
      }
      throw new Error(`Maintenance ${maintenanceId} non trouvée dans Firebase`);
    }

    const data = maintenanceDoc.data();
    log(`✅ Maintenance trouvée: ${data.contractNumber || maintenanceId}`, 'green');
    log(`   Client: ${data.clientName || 'N/A'}`, 'cyan');
    log(`   Montant: ${data.monthlyAmount || 50}€`, 'cyan');
    log(`   Mandat: ${data.gocardlessMandateId || 'N/A'}`, 'cyan');

    return { id: maintenanceDoc.id, ...data };
  } catch (error) {
    if (error.code === 'unavailable' || error.message.includes('offline')) {
      log(`❌ Erreur Firebase: Client hors ligne`, 'red');
      log(`💡 Solution: Vérifiez votre connexion Internet et les variables d'environnement Firebase`, 'yellow');
      log(`💡 Alternative: Utilisez l'API backend si disponible`, 'yellow');
    }
    log(`❌ Erreur: ${error.message}`, 'red');
    throw error;
  }
}

/**
 * Créer un paiement via le scheduler
 */
async function createPaymentViaScheduler(maintenanceId) {
  try {
    log(`💳 Création d'un paiement via le scheduler...`, 'blue');
    
    // Appeler l'endpoint qui déclenche le scheduler
    const response = await axios.post(`${BACKEND_URL}/api/gocardless/create-payment`, {
      maintenanceId,
      action: 'create_next'
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    log(`✅ Paiement créé: ${response.data.paymentId || 'N/A'}`, 'green');
    return response.data;
  } catch (error) {
    // Si l'endpoint n'existe pas, créer directement via l'API
    log(`⚠️  Endpoint scheduler non disponible, création directe...`, 'yellow');
    return await createPaymentDirect(maintenanceId);
  }
}

/**
 * Créer un paiement directement
 */
async function createPaymentDirect(maintenanceId) {
  try {
    const maintenance = await getMaintenance(maintenanceId);
    
    if (!maintenance.gocardlessMandateId) {
      throw new Error('Mandat GoCardless non configuré');
    }

    const response = await axios.post(`${BACKEND_URL}/api/gocardless/create-payment`, {
      amount: maintenance.monthlyAmount || 50,
      currency: 'EUR',
      mandate_id: maintenance.gocardlessMandateId,
      description: `Test automatique - ${maintenance.contractNumber || maintenanceId}`,
      reference: maintenance.contractNumber || maintenanceId,
      metadata: {
        maintenanceId: maintenance.id,
        // ✅ CORRECTION : Date minimum 3 jours dans le futur pour GoCardless SEPA
        dueDate: (() => {
          const minDate = new Date();
          minDate.setDate(minDate.getDate() + 3); // Minimum 3 jours pour SEPA
          return minDate.toISOString().split('T')[0];
        })(),
        type: 'monthly_maintenance',
        test: true,
        testCycle: Date.now()
      }
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    log(`✅ Paiement créé: ${response.data.paymentId}`, 'green');
    return response.data;
  } catch (error) {
    log(`❌ Erreur création paiement: ${error.response?.data?.error?.message || error.message}`, 'red');
    throw error;
  }
}

/**
 * Simuler la confirmation d'un paiement
 */
async function simulatePaymentConfirmation(paymentId, maintenanceId) {
  try {
    log(`🔄 Simulation confirmation: ${paymentId}`, 'yellow');
    
    const webhookPayload = {
      events: [{
        id: `EV${Date.now()}`,
        created_at: new Date().toISOString(),
        resource_type: 'payments',
        action: 'confirmed',
        links: {
          payment: paymentId
        },
        details: {
          origin: 'gocardless',
          cause: 'payment_confirmed',
          description: 'Test automatique - Payment confirmed'
        }
      }]
    };

    const response = await axios.post(`${BACKEND_URL}/api/gocardless/webhook`, webhookPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Webhook-Signature': 'test-signature'
      }
    });

    log(`✅ Webhook traité`, 'green');
    return response.data;
  } catch (error) {
    log(`❌ Erreur webhook: ${error.response?.data?.error || error.message}`, 'red');
    throw error;
  }
}

/**
 * Vérifier le paymentSchedule
 */
async function checkPaymentSchedule(maintenanceId) {
  try {
    // ✅ NOUVEAU : Essayer via l'API backend d'abord
    try {
      const response = await axios.get(`${BACKEND_URL}/api/maintenance/${maintenanceId}`);
      const maintenance = response.data;
      const schedule = maintenance.paymentSchedule || [];
      
      const paid = schedule.filter(p => p.status === 'paid').length;
      const processing = schedule.filter(p => p.status === 'processing').length;
      const pending = schedule.filter(p => p.status === 'pending').length;

      log(`📅 PaymentSchedule: ${paid} payé(s), ${processing} en cours, ${pending} en attente`, 'cyan');
      return { paid, processing, pending, total: schedule.length };
    } catch (apiError) {
      // Fallback : Firebase
      if (!db) {
        throw new Error('Firebase non disponible et API backend échouée');
      }
      const maintenance = await getMaintenance(maintenanceId);
      const schedule = maintenance.paymentSchedule || [];
      
      const paid = schedule.filter(p => p.status === 'paid').length;
      const processing = schedule.filter(p => p.status === 'processing').length;
      const pending = schedule.filter(p => p.status === 'pending').length;

      log(`📅 PaymentSchedule: ${paid} payé(s), ${processing} en cours, ${pending} en attente`, 'cyan');
      return { paid, processing, pending, total: schedule.length };
    }
  } catch (error) {
    log(`❌ Erreur vérification schedule: ${error.message}`, 'red');
    return null;
  }
}

/**
 * Cycle de test
 */
async function testCycle(maintenanceId, cycleNumber, totalCycles) {
  log(`\n${'='.repeat(70)}`, 'bright');
  log(`🔄 CYCLE ${cycleNumber}/${totalCycles}`, 'bright');
  log(`${'='.repeat(70)}`, 'bright');

  try {
    // 1. Créer un paiement
    const payment = await createPaymentDirect(maintenanceId);
    const paymentId = payment.paymentId;

    if (!paymentId) {
      throw new Error('PaymentId manquant dans la réponse');
    }

    // 2. Attendre un peu
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 3. Vérifier le schedule avant confirmation
    log(`📊 Schedule AVANT confirmation:`, 'magenta');
    await checkPaymentSchedule(maintenanceId);

    // 4. Simuler la confirmation
    await simulatePaymentConfirmation(paymentId, maintenanceId);

    // 5. Attendre la mise à jour
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 6. Vérifier le schedule après confirmation
    log(`📊 Schedule APRÈS confirmation:`, 'magenta');
    const scheduleStats = await checkPaymentSchedule(maintenanceId);

    log(`✅ Cycle ${cycleNumber} terminé`, 'green');
    return { success: true, paymentId, scheduleStats };

  } catch (error) {
    log(`❌ Cycle ${cycleNumber} échoué: ${error.message}`, 'red');
    return { success: false, error: error.message };
  }
}

/**
 * Fonction principale
 */
async function main() {
  const maintenanceId = process.argv[2];
  const numCycles = parseInt(process.argv[3]) || DEFAULT_CYCLES;

  log('\n🚀 TEST RAPIDE - Prélèvements Automatiques', 'bright');
  log(`⏱️  Cycles: ${numCycles}`, 'cyan');
  log(`⏰ Intervalle: ${INTERVAL_SECONDS} secondes`, 'cyan');
  log(`🔗 Backend: ${BACKEND_URL}`, 'cyan');

  if (!maintenanceId) {
    log('\n❌ Erreur: ID de maintenance requis', 'red');
    log('Usage: node test-automatic-payments-quick.js [maintenanceId] [nombre-cycles]', 'yellow');
    log('Exemple: node test-automatic-payments-quick.js KqmAhk5PnFmjJnznVoqd 12', 'yellow');
    log('\n💡 Note: Utilisez l\'ID de la MAINTENANCE (pas le mandat MD01...)', 'cyan');
    log('   Vous pouvez trouver l\'ID dans Firebase Console > maintenances', 'cyan');
    process.exit(1);
  }

  // ✅ NOUVEAU : Vérifier que ce n'est pas un ID de mandat
  if (maintenanceId.startsWith('MD01')) {
    log('\n❌ Erreur: Vous avez fourni un ID de MANDAT au lieu d\'un ID de MAINTENANCE', 'red');
    log(`   ID fourni: ${maintenanceId}`, 'yellow');
    log('\n💡 Solution:', 'cyan');
    log('   1. Allez dans Firebase Console > maintenances', 'cyan');
    log('   2. Trouvez la maintenance qui contient ce mandat', 'cyan');
    log('   3. Utilisez l\'ID du document (pas le gocardlessMandateId)', 'cyan');
    log('\n   Ou trouvez l\'ID dans l\'URL de la page de détail:', 'cyan');
    log('   /maintenance/[MAINTENANCE_ID]', 'cyan');
    process.exit(1);
  }

  try {
    // Vérifier que la maintenance existe
    const maintenance = await getMaintenance(maintenanceId);
    
    if (!maintenance.gocardlessMandateId) {
      log('❌ Erreur: Mandat GoCardless non configuré', 'red');
      process.exit(1);
    }

    // Statistiques
    const stats = {
      total: 0,
      success: 0,
      failed: 0,
      payments: [],
      scheduleEvolution: []
    };

    // Boucle de test
    for (let cycle = 1; cycle <= numCycles; cycle++) {
      stats.total++;

      const result = await testCycle(maintenanceId, cycle, numCycles);

      if (result.success) {
        stats.success++;
        stats.payments.push(result.paymentId);
        if (result.scheduleStats) {
          stats.scheduleEvolution.push(result.scheduleStats);
        }
      } else {
        stats.failed++;
      }

      // Attendre avant le prochain cycle
      if (cycle < numCycles) {
        log(`\n⏳ Attente de ${INTERVAL_SECONDS} secondes...`, 'yellow');
        await new Promise(resolve => setTimeout(resolve, INTERVAL_SECONDS * 1000));
      }
    }

    // Rapport final
    log(`\n${'='.repeat(70)}`, 'bright');
    log('📊 RAPPORT FINAL', 'bright');
    log(`${'='.repeat(70)}`, 'bright');
    log(`✅ Cycles réussis: ${stats.success}/${stats.total}`, stats.success === stats.total ? 'green' : 'yellow');
    log(`❌ Cycles échoués: ${stats.failed}/${stats.total}`, stats.failed > 0 ? 'red' : 'green');
    log(`💳 Paiements créés: ${stats.payments.length}`, 'cyan');

    if (stats.scheduleEvolution.length > 0) {
      log(`\n📈 Évolution du PaymentSchedule:`, 'magenta');
      stats.scheduleEvolution.forEach((stat, index) => {
        log(`   Cycle ${index + 1}: ${stat.paid} payé(s), ${stat.processing} en cours, ${stat.pending} en attente`, 'cyan');
      });
    }

    if (stats.payments.length > 0) {
      log(`\n📋 Paiements créés:`, 'cyan');
      stats.payments.forEach((id, index) => {
        log(`   ${index + 1}. ${id}`, 'cyan');
      });
    }

    log(`\n✅ Test terminé!`, 'green');

  } catch (error) {
    log(`\n❌ Erreur fatale: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
  }
}

// Exécuter
if (require.main === module) {
  main().catch(error => {
    console.error('Erreur non gérée:', error);
    process.exit(1);
  });
}

module.exports = { testCycle, createPaymentDirect, simulatePaymentConfirmation };

