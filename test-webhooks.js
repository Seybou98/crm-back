#!/usr/bin/env node

/**
 * Script de test pour les webhooks GoCardless
 * Usage: node test-webhooks.js [baseUrl]
 */

const axios = require('axios');

// Configuration
const BASE_URL = process.argv[2] || 'http://localhost:3002';
const TEST_ENDPOINTS = [
  '/webhooks/gocardless/test',
  '/api/gocardless/webhooks/status',
  '/api/gocardless/webhooks/setup'
];

// Couleurs pour la console
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logHeader(title) {
  log('\n' + '='.repeat(60), 'bright');
  log(`  ${title}`, 'bright');
  log('='.repeat(60), 'bright');
}

function logSection(title) {
  log(`\n${title}`, 'cyan');
  log('-'.repeat(title.length));
}

async function testEndpoint(endpoint, method = 'GET', data = null) {
  try {
    log(`Testing ${method} ${endpoint}`, 'yellow');
    
    const config = {
      method: method.toLowerCase(),
      url: `${BASE_URL}${endpoint}`,
      timeout: 10000
    };
    
    if (data && method !== 'GET') {
      config.data = data;
      config.headers = { 'Content-Type': 'application/json' };
    }
    
    const response = await axios(config);
    
    log(`✅ Status: ${response.status}`, 'green');
    log(`📊 Response:`, 'blue');
    console.log(JSON.stringify(response.data, null, 2));
    
    return { success: true, data: response.data };
  } catch (error) {
    log(`❌ Error: ${error.message}`, 'red');
    if (error.response) {
      log(`Status: ${error.response.status}`, 'red');
      log(`Response: ${JSON.stringify(error.response.data, null, 2)}`, 'red');
    }
    return { success: false, error: error.message };
  }
}

async function testWebhookSimulation() {
  logSection('🧪 Test de Simulation de Webhook');
  
  const testEvent = {
    events: [
      {
        id: `test_event_${Date.now()}`,
        resource_type: 'payment',
        action: 'confirmed',
        links: {
          payment: 'test_payment_id_123'
        },
        created_at: new Date().toISOString()
      }
    ]
  };
  
  const result = await testEndpoint('/webhooks/gocardless', 'POST', testEvent);
  
  if (result.success) {
    log('✅ Simulation de webhook réussie !', 'green');
  } else {
    log('❌ Échec de la simulation de webhook', 'red');
  }
}

async function testWebhookSetup() {
  logSection('⚙️ Test de Configuration des Webhooks');
  
  // Test de la configuration (nécessite GOCARDLESS_ACCESS_TOKEN)
  const result = await testEndpoint('/api/gocardless/webhooks/setup', 'POST');
  
  if (result.success) {
    log('✅ Configuration des webhooks réussie !', 'green');
  } else {
    log('⚠️ Configuration des webhooks échouée (vérifiez GOCARDLESS_ACCESS_TOKEN)', 'yellow');
  }
}

async function testWebhookStatus() {
  logSection('📊 Test du Statut des Webhooks');
  
  const result = await testEndpoint('/api/gocardless/webhooks/status');
  
  if (result.success) {
    log('✅ Statut des webhooks récupéré !', 'green');
  } else {
    log('❌ Impossible de récupérer le statut des webhooks', 'red');
  }
}

async function runAllTests() {
  logHeader('🚀 TESTS DES WEBHOOKS GOCARDLESS');
  log(`Base URL: ${BASE_URL}`, 'blue');
  
  try {
    // Test 1: Simulation de webhook
    await testWebhookSimulation();
    
    // Test 2: Statut des webhooks
    await testWebhookStatus();
    
    // Test 3: Configuration des webhooks (optionnel)
    await testWebhookSetup();
    
    logHeader('🎯 RÉSUMÉ DES TESTS');
    log('✅ Tests terminés !', 'green');
    log('\n📋 Prochaines étapes:', 'blue');
    log('1. Vérifiez que votre serveur backend est démarré', 'yellow');
    log('2. Configurez GOCARDLESS_ACCESS_TOKEN dans votre .env', 'yellow');
    log('3. Testez avec un vrai événement GoCardless', 'yellow');
    log('4. Vérifiez les logs du serveur pour le débogage', 'yellow');
    
  } catch (error) {
    log(`❌ Erreur générale: ${error.message}`, 'red');
  }
}

// Fonction principale
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = {
  testEndpoint,
  testWebhookSimulation,
  testWebhookStatus,
  testWebhookSetup
};
