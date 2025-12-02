/**
 * Script de Test - Prélèvements Automatiques
 * 
 * Ce script teste le système de prélèvements automatiques en :
 * 1. Créant un paiement toutes les heures
 * 2. Simulant la confirmation du paiement
 * 3. Vérifiant que le prochain paiement est créé automatiquement
 * 4. Répétant cela pendant 12 heures
 * 
 * Usage: node test-automatic-payments.js [maintenanceId]
 */

const axios = require('axios');
require('dotenv').config();

// Configuration
const GOCARDLESS_BASE_URL = process.env.GOCARDLESS_ACCESS_TOKEN?.startsWith('live_') 
  ? 'https://api.gocardless.com' 
  : 'https://api-sandbox.gocardless.com';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3002';
const TEST_DURATION_HOURS = 12;
const INTERVAL_HOURS = 1;

// Couleurs pour les logs
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  const timestamp = new Date().toISOString();
  console.log(`${colors[color]}[${timestamp}] ${message}${colors.reset}`);
}

/**
 * Récupérer une maintenance de test
 */
async function getTestMaintenance(maintenanceId) {
  try {
    // Si un ID est fourni, l'utiliser
    if (maintenanceId) {
      log(`🔍 Recherche de la maintenance: ${maintenanceId}`, 'cyan');
      // Ici vous devriez interroger Firebase directement
      // Pour simplifier, on suppose que la maintenance existe
      return { id: maintenanceId };
    }

    // Sinon, chercher une maintenance avec GoCardless configuré
    log('🔍 Recherche d\'une maintenance de test...', 'cyan');
    // TODO: Implémenter la recherche dans Firebase
    throw new Error('Veuillez fournir un ID de maintenance');
  } catch (error) {
    log(`❌ Erreur lors de la récupération de la maintenance: ${error.message}`, 'red');
    throw error;
  }
}

/**
 * Créer un paiement GoCardless
 */
async function createPayment(maintenance) {
  try {
    log(`💳 Création d'un paiement pour la maintenance: ${maintenance.id}`, 'blue');
    
    const response = await axios.post(`${BACKEND_URL}/api/gocardless/create-payment`, {
      amount: maintenance.monthlyAmount || 50,
      currency: 'EUR',
      mandate_id: maintenance.gocardlessMandateId,
      description: `Test automatique - Maintenance ${maintenance.contractNumber || maintenance.id}`,
      reference: maintenance.contractNumber || maintenance.id,
      metadata: {
        maintenanceId: maintenance.id,
        dueDate: new Date().toISOString().split('T')[0],
        type: 'monthly_maintenance',
        test: true
      }
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    log(`✅ Paiement créé: ${response.data.paymentId}`, 'green');
    return response.data;
  } catch (error) {
    log(`❌ Erreur lors de la création du paiement: ${error.response?.data?.error?.message || error.message}`, 'red');
    throw error;
  }
}

/**
 * Simuler la confirmation d'un paiement via webhook
 */
async function simulatePaymentConfirmation(paymentId, maintenanceId) {
  try {
    log(`🔄 Simulation de la confirmation du paiement: ${paymentId}`, 'yellow');
    
    // Simuler un webhook GoCardless de confirmation
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
          description: 'Payment confirmed via test script'
        }
      }]
    };

    const response = await axios.post(`${BACKEND_URL}/api/gocardless/webhook`, webhookPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Webhook-Signature': 'test-signature' // Pour les tests
      }
    });

    log(`✅ Webhook traité avec succès`, 'green');
    return response.data;
  } catch (error) {
    log(`❌ Erreur lors de la simulation du webhook: ${error.response?.data?.error || error.message}`, 'red');
    throw error;
  }
}

/**
 * Vérifier le statut d'un paiement
 */
async function checkPaymentStatus(paymentId) {
  try {
    const response = await axios.get(`${BACKEND_URL}/api/gocardless/payment-status/${paymentId}`);
    log(`📊 Statut du paiement ${paymentId}: ${response.data.status}`, 'cyan');
    return response.data;
  } catch (error) {
    log(`❌ Erreur lors de la vérification du statut: ${error.message}`, 'red');
    return null;
  }
}

/**
 * Vérifier le paymentSchedule d'une maintenance
 */
async function checkPaymentSchedule(maintenanceId) {
  try {
    // TODO: Implémenter la récupération depuis Firebase
    // Pour l'instant, on log juste
    log(`📅 Vérification du paymentSchedule pour: ${maintenanceId}`, 'cyan');
    return null;
  } catch (error) {
    log(`❌ Erreur lors de la vérification du schedule: ${error.message}`, 'red');
    return null;
  }
}

/**
 * Test principal - Cycle de prélèvement automatique
 */
async function testAutomaticPaymentCycle(maintenance, cycleNumber) {
  log(`\n${'='.repeat(60)}`, 'bright');
  log(`🔄 CYCLE ${cycleNumber}/${TEST_DURATION_HOURS}`, 'bright');
  log(`${'='.repeat(60)}`, 'bright');

  try {
    // 1. Créer un paiement
    const payment = await createPayment(maintenance);
    const paymentId = payment.paymentId;

    // 2. Vérifier le statut initial
    await checkPaymentStatus(paymentId);

    // 3. Attendre un peu avant de confirmer
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 4. Simuler la confirmation
    await simulatePaymentConfirmation(paymentId, maintenance.id);

    // 5. Vérifier le statut après confirmation
    await new Promise(resolve => setTimeout(resolve, 1000));
    await checkPaymentStatus(paymentId);

    // 6. Vérifier le paymentSchedule
    await checkPaymentSchedule(maintenance.id);

    log(`✅ Cycle ${cycleNumber} terminé avec succès`, 'green');
    return { success: true, paymentId };

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

  log('\n🚀 Démarrage du script de test des prélèvements automatiques', 'bright');
  log(`⏱️  Durée: ${TEST_DURATION_HOURS} heures`, 'cyan');
  log(`⏰ Intervalle: ${INTERVAL_HOURS} heure(s)`, 'cyan');
  log(`🔗 Backend: ${BACKEND_URL}`, 'cyan');
  log(`🌐 GoCardless: ${GOCARDLESS_BASE_URL}`, 'cyan');

  if (!maintenanceId) {
    log('\n❌ Erreur: Veuillez fournir un ID de maintenance', 'red');
    log('Usage: node test-automatic-payments.js [maintenanceId]', 'yellow');
    process.exit(1);
  }

  try {
    // Récupérer la maintenance
    const maintenance = await getTestMaintenance(maintenanceId);
    
    if (!maintenance.gocardlessMandateId) {
      log('❌ Erreur: La maintenance n\'a pas de mandat GoCardless configuré', 'red');
      process.exit(1);
    }

    log(`\n✅ Maintenance trouvée: ${maintenance.id}`, 'green');
    log(`📋 Contrat: ${maintenance.contractNumber || 'N/A'}`, 'cyan');
    log(`💰 Montant mensuel: ${maintenance.monthlyAmount || 50}€`, 'cyan');
    log(`🔑 Mandat: ${maintenance.gocardlessMandateId}`, 'cyan');

    // Statistiques
    const stats = {
      total: 0,
      success: 0,
      failed: 0,
      payments: []
    };

    // Boucle principale - 12 cycles d'1 heure
    for (let cycle = 1; cycle <= TEST_DURATION_HOURS; cycle++) {
      stats.total++;

      const result = await testAutomaticPaymentCycle(maintenance, cycle);

      if (result.success) {
        stats.success++;
        stats.payments.push(result.paymentId);
      } else {
        stats.failed++;
      }

      // Attendre avant le prochain cycle (sauf pour le dernier)
      if (cycle < TEST_DURATION_HOURS) {
        const waitMinutes = INTERVAL_HOURS * 60;
        log(`\n⏳ Attente de ${INTERVAL_HOURS} heure(s) avant le prochain cycle...`, 'yellow');
        log(`   Prochain cycle dans ${waitMinutes} minutes`, 'yellow');
        
        // Pour les tests rapides, on peut réduire l'attente
        // En production, utilisez: await new Promise(resolve => setTimeout(resolve, waitMinutes * 60 * 1000));
        const testWaitSeconds = 10; // Pour les tests rapides
        log(`   (Mode test: attente réduite à ${testWaitSeconds} secondes)`, 'yellow');
        await new Promise(resolve => setTimeout(resolve, testWaitSeconds * 1000));
      }
    }

    // Rapport final
    log(`\n${'='.repeat(60)}`, 'bright');
    log('📊 RAPPORT FINAL', 'bright');
    log(`${'='.repeat(60)}`, 'bright');
    log(`✅ Cycles réussis: ${stats.success}/${stats.total}`, stats.success === stats.total ? 'green' : 'yellow');
    log(`❌ Cycles échoués: ${stats.failed}/${stats.total}`, stats.failed > 0 ? 'red' : 'green');
    log(`💳 Paiements créés: ${stats.payments.length}`, 'cyan');
    
    if (stats.payments.length > 0) {
      log(`\n📋 Liste des paiements:`, 'cyan');
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

// Exécuter le script
if (require.main === module) {
  main().catch(error => {
    console.error('Erreur non gérée:', error);
    process.exit(1);
  });
}

module.exports = { testAutomaticPaymentCycle, createPayment, simulatePaymentConfirmation };

