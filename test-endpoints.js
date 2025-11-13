// Endpoints de test pour YouSign et GoCardless
// Ce fichier peut être importé dans index.js ou utilisé séparément

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

// Charger les variables d'environnement
require('dotenv').config({ path: path.join(__dirname, '.env') });

const router = express.Router();

// Configuration YouSign
let YOUSIGN_API_URL = process.env.YOUSIGN_API_URL || 'https://api-sandbox.yousign.app/v3';
if (!YOUSIGN_API_URL.endsWith('/v3')) {
  YOUSIGN_API_URL = YOUSIGN_API_URL.replace(/\/+$/, '') + '/v3';
}
const YOUSIGN_API_TOKEN = process.env.YOUSIGN_API_KEY;

// Configuration GoCardless
const GOCARDLESS_ACCESS_TOKEN = process.env.GOCARDLESS_ACCESS_TOKEN;
const GOCARDLESS_CREDITOR_ID = process.env.GOCARDLESS_CREDITOR_ID;
const GOCARDLESS_API_URL = 'https://api-sandbox.gocardless.com';

// ============================================
// TESTS YOUSIGN
// ============================================

// Test 1: Vérifier la connexion à l'API YouSign
router.get('/test/yousign/connection', async (req, res) => {
  try {
    console.log('[Test YouSign] Test de connexion...');
    console.log('[Test YouSign] URL:', YOUSIGN_API_URL);
    console.log('[Test YouSign] Token présent:', YOUSIGN_API_TOKEN ? 'Oui' : 'Non');
    
    if (!YOUSIGN_API_TOKEN) {
      return res.status(500).json({
        error: 'YOUSIGN_API_KEY manquante',
        message: 'Veuillez définir YOUSIGN_API_KEY dans le fichier .env'
      });
    }

    // Tester la connexion en essayant de créer une demande de signature minimale
    // L'API YouSign v3 nécessite un POST pour créer une demande
    const testRequest = {
      name: 'Test Connection - ' + new Date().toISOString(),
      delivery_mode: 'email'
    };
    
    console.log('[Test YouSign] Tentative de création d\'une demande de test...');
    const response = await axios.post(`${YOUSIGN_API_URL}/signature_requests`, testRequest, {
      headers: {
        'Authorization': `Bearer ${YOUSIGN_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({
      success: true,
      message: 'Connexion YouSign réussie',
      url: YOUSIGN_API_URL,
      status: response.status,
      data: response.data
    });
  } catch (error) {
    console.error('[Test YouSign] Erreur:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Erreur de connexion YouSign',
      message: error.message,
      details: error.response?.data || error.message,
      url: error.config?.url,
      status: error.response?.status
    });
  }
});

// Test 2: Créer une demande de signature de test
router.post('/test/yousign/create-request', async (req, res) => {
  try {
    console.log('[Test YouSign] Création d\'une demande de signature de test...');
    
    if (!YOUSIGN_API_TOKEN) {
      return res.status(500).json({
        error: 'YOUSIGN_API_KEY manquante',
        message: 'Veuillez définir YOUSIGN_API_KEY dans le fichier .env'
      });
    }

    // Créer une demande de signature minimale
    const signatureRequestData = {
      name: 'Test Signature Request - ' + new Date().toISOString(),
      delivery_mode: 'email'
    };

    console.log('[Test YouSign] Données envoyées:', signatureRequestData);
    console.log('[Test YouSign] URL complète:', `${YOUSIGN_API_URL}/signature_requests`);

    const response = await axios.post(
      `${YOUSIGN_API_URL}/signature_requests`,
      signatureRequestData,
      {
        headers: {
          'Authorization': `Bearer ${YOUSIGN_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('[Test YouSign] Réponse reçue:', response.status, response.statusText);
    console.log('[Test YouSign] Données:', response.data);

    res.json({
      success: true,
      message: 'Demande de signature créée avec succès',
      signatureRequestId: response.data.id || response.data,
      data: response.data
    });
  } catch (error) {
    console.error('[Test YouSign] Erreur:', error.response?.data || error.message);
    console.error('[Test YouSign] URL appelée:', error.config?.url);
    console.error('[Test YouSign] Méthode:', error.config?.method);
    console.error('[Test YouSign] Headers:', error.config?.headers);
    
    res.status(error.response?.status || 500).json({
      error: 'Erreur lors de la création de la demande de signature',
      message: error.message,
      details: error.response?.data || error.message,
      url: error.config?.url,
      method: error.config?.method,
      status: error.response?.status
    });
  }
});

// ============================================
// TESTS GOCARDLESS
// ============================================

// Test 1: Vérifier la connexion à l'API GoCardless
router.get('/test/gocardless/connection', async (req, res) => {
  try {
    console.log('[Test GoCardless] Test de connexion...');
    console.log('[Test GoCardless] URL:', GOCARDLESS_API_URL);
    console.log('[Test GoCardless] Token présent:', GOCARDLESS_ACCESS_TOKEN ? 'Oui' : 'Non');
    console.log('[Test GoCardless] Creditor ID présent:', GOCARDLESS_CREDITOR_ID ? 'Oui' : 'Non');
    
    if (!GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant',
        message: 'Veuillez définir GOCARDLESS_ACCESS_TOKEN dans le fichier .env'
      });
    }

    if (!GOCARDLESS_CREDITOR_ID) {
      return res.status(500).json({
        error: 'GOCARDLESS_CREDITOR_ID manquant',
        message: 'Veuillez définir GOCARDLESS_CREDITOR_ID dans le fichier .env'
      });
    }

    // Tester la connexion en récupérant les informations du creditor
    const response = await axios.get(`${GOCARDLESS_API_URL}/creditors/${GOCARDLESS_CREDITOR_ID}`, {
      headers: {
        'Authorization': `Bearer ${GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      }
    });

    res.json({
      success: true,
      message: 'Connexion GoCardless réussie',
      url: GOCARDLESS_API_URL,
      status: response.status,
      creditor: response.data.creditors
    });
  } catch (error) {
    console.error('[Test GoCardless] Erreur:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Erreur de connexion GoCardless',
      message: error.message,
      details: error.response?.data || error.message,
      url: error.config?.url,
      status: error.response?.status
    });
  }
});

// Test 2: Créer un customer de test
router.post('/test/gocardless/create-customer', async (req, res) => {
  try {
    console.log('[Test GoCardless] Création d\'un customer de test...');
    
    if (!GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant',
        message: 'Veuillez définir GOCARDLESS_ACCESS_TOKEN dans le fichier .env'
      });
    }

    // Données de test pour créer un customer
    const customerData = {
      customers: {
        email: 'test@example.com',
        given_name: 'Test',
        family_name: 'User',
        address_line1: '123 Test Street',
        city: 'Paris',
        postal_code: '75001',
        country_code: 'FR'
      }
    };

    console.log('[Test GoCardless] Données envoyées:', customerData);
    console.log('[Test GoCardless] URL complète:', `${GOCARDLESS_API_URL}/customers`);

    const response = await axios.post(
      `${GOCARDLESS_API_URL}/customers`,
      customerData,
      {
        headers: {
          'Authorization': `Bearer ${GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('[Test GoCardless] Réponse reçue:', response.status, response.statusText);
    console.log('[Test GoCardless] Customer créé:', response.data.customers);

    res.json({
      success: true,
      message: 'Customer créé avec succès',
      customerId: response.data.customers.id,
      customer: response.data.customers
    });
  } catch (error) {
    console.error('[Test GoCardless] Erreur:', error.response?.data || error.message);
    console.error('[Test GoCardless] URL appelée:', error.config?.url);
    console.error('[Test GoCardless] Erreurs de validation:', error.response?.data?.error?.errors);
    
    res.status(error.response?.status || 500).json({
      error: 'Erreur lors de la création du customer',
      message: error.message,
      details: error.response?.data || error.message,
      validationErrors: error.response?.data?.error?.errors || [],
      url: error.config?.url,
      status: error.response?.status
    });
  }
});

// Test 3: Créer un compte bancaire de test
router.post('/test/gocardless/create-bank-account', async (req, res) => {
  try {
    console.log('[Test GoCardless] Création d\'un compte bancaire de test...');
    
    const { customerId, accountHolderName, iban } = req.body;
    
    if (!customerId || !accountHolderName || !iban) {
      return res.status(400).json({
        error: 'Paramètres manquants',
        message: 'customerId, accountHolderName et iban sont requis',
        example: {
          customerId: 'CU01K9VRJCC73P9N19MG7YTPY9TN',
          accountHolderName: 'Test User',
          iban: 'FR1420010101150500013M02606'
        }
      });
    }

    if (!GOCARDLESS_ACCESS_TOKEN) {
      return res.status(500).json({
        error: 'GOCARDLESS_ACCESS_TOKEN manquant',
        message: 'Veuillez définir GOCARDLESS_ACCESS_TOKEN dans le fichier .env'
      });
    }

    // Nettoyer l'IBAN
    const cleanIban = iban.replace(/\s/g, '').toUpperCase();
    const cleanAccountHolderName = accountHolderName.trim();

    console.log('[Test GoCardless] Données:', {
      customerId,
      accountHolderName: cleanAccountHolderName,
      iban: cleanIban,
      ibanLength: cleanIban.length
    });

    const bankAccountData = {
      customer_bank_accounts: {
        account_holder_name: cleanAccountHolderName,
        iban: cleanIban,
        links: {
          customer: customerId
        }
      }
    };

    console.log('[Test GoCardless] Données envoyées:', bankAccountData);
    console.log('[Test GoCardless] URL complète:', `${GOCARDLESS_API_URL}/customer_bank_accounts`);

    const response = await axios.post(
      `${GOCARDLESS_API_URL}/customer_bank_accounts`,
      bankAccountData,
      {
        headers: {
          'Authorization': `Bearer ${GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('[Test GoCardless] Réponse reçue:', response.status, response.statusText);
    console.log('[Test GoCardless] Compte bancaire créé:', response.data.customer_bank_accounts);

    res.json({
      success: true,
      message: 'Compte bancaire créé avec succès',
      bankAccountId: response.data.customer_bank_accounts.id,
      bankAccount: response.data.customer_bank_accounts
    });
  } catch (error) {
    console.error('[Test GoCardless] Erreur:', error.response?.data || error.message);
    console.error('[Test GoCardless] URL appelée:', error.config?.url);
    console.error('[Test GoCardless] Erreurs de validation:', error.response?.data?.error?.errors);
    
    res.status(error.response?.status || 500).json({
      error: 'Erreur lors de la création du compte bancaire',
      message: error.message,
      details: error.response?.data || error.message,
      validationErrors: error.response?.data?.error?.errors || [],
      url: error.config?.url,
      status: error.response?.status
    });
  }
});

// Test 4: Créer un mandat complet de test
router.post('/test/gocardless/create-mandate', async (req, res) => {
  try {
    console.log('[Test GoCardless] Création d\'un mandat complet de test...');
    
    const { accountHolderName, iban } = req.body;
    
    if (!accountHolderName || !iban) {
      return res.status(400).json({
        error: 'Paramètres manquants',
        message: 'accountHolderName et iban sont requis',
        example: {
          accountHolderName: 'Test User',
          iban: 'FR1420010101150500013M02606'
        }
      });
    }

    if (!GOCARDLESS_ACCESS_TOKEN || !GOCARDLESS_CREDITOR_ID) {
      return res.status(500).json({
        error: 'Configuration manquante',
        message: 'Veuillez définir GOCARDLESS_ACCESS_TOKEN et GOCARDLESS_CREDITOR_ID dans le fichier .env'
      });
    }

    // Nettoyer l'IBAN
    const cleanIban = iban.replace(/\s/g, '').toUpperCase();
    const cleanAccountHolderName = accountHolderName.trim();

    // 1. Créer un customer
    console.log('[Test GoCardless] Étape 1: Création du customer...');
    const customerResponse = await axios.post(
      `${GOCARDLESS_API_URL}/customers`,
      {
        customers: {
          email: `${cleanAccountHolderName.toLowerCase().replace(/\s+/g, '.')}@test.example.com`,
          given_name: cleanAccountHolderName.split(' ')[0] || cleanAccountHolderName,
          family_name: cleanAccountHolderName.split(' ').slice(1).join(' ') || cleanAccountHolderName,
          address_line1: '123 Test Street',
          city: 'Paris',
          postal_code: '75001',
          country_code: 'FR'
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      }
    );
    const customerId = customerResponse.data.customers.id;
    console.log('[Test GoCardless] Customer créé:', customerId);

    // 2. Créer un compte bancaire
    console.log('[Test GoCardless] Étape 2: Création du compte bancaire...');
    const bankAccountResponse = await axios.post(
      `${GOCARDLESS_API_URL}/customer_bank_accounts`,
      {
        customer_bank_accounts: {
          account_holder_name: cleanAccountHolderName,
          iban: cleanIban,
          links: {
            customer: customerId
          }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      }
    );
    const bankAccountId = bankAccountResponse.data.customer_bank_accounts.id;
    console.log('[Test GoCardless] Compte bancaire créé:', bankAccountId);

    // 3. Créer un mandat
    console.log('[Test GoCardless] Étape 3: Création du mandat...');
    const mandateResponse = await axios.post(
      `${GOCARDLESS_API_URL}/mandates`,
      {
        mandates: {
          scheme: 'sepa_core',
          links: {
            customer_bank_account: bankAccountId,
            creditor: GOCARDLESS_CREDITOR_ID
          }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        }
      }
    );
    const mandateId = mandateResponse.data.mandates.id;
    console.log('[Test GoCardless] Mandat créé:', mandateId);

    res.json({
      success: true,
      message: 'Mandat créé avec succès',
      customerId,
      bankAccountId,
      mandateId,
      mandate: mandateResponse.data.mandates
    });
  } catch (error) {
    console.error('[Test GoCardless] Erreur:', error.response?.data || error.message);
    console.error('[Test GoCardless] URL appelée:', error.config?.url);
    console.error('[Test GoCardless] Erreurs de validation:', error.response?.data?.error?.errors);
    
    res.status(error.response?.status || 500).json({
      error: 'Erreur lors de la création du mandat',
      message: error.message,
      details: error.response?.data || error.message,
      validationErrors: error.response?.data?.error?.errors || [],
      url: error.config?.url,
      status: error.response?.status
    });
  }
});

module.exports = router;

