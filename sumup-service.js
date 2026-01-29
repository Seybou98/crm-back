const axios = require('axios');

// Configuration SumUp
const SUMUP_API_URL = process.env.SUMUP_API_URL || 'https://api.sumup.com';
const SUMUP_CLIENT_ID = process.env.SUMUP_CLIENT_ID;
const SUMUP_CLIENT_SECRET = process.env.SUMUP_CLIENT_SECRET;
const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE;

// Log des variables SumUp au chargement
console.log('🔑 Variables SumUp chargées:', {
  SUMUP_CLIENT_ID: SUMUP_CLIENT_ID ? 'PRÉSENTE' : 'MANQUANTE',
  SUMUP_CLIENT_SECRET: SUMUP_CLIENT_SECRET ? 'PRÉSENTE' : 'MANQUANTE',
  SUMUP_MERCHANT_CODE: SUMUP_MERCHANT_CODE || 'MANQUANT',
  SUMUP_API_URL: SUMUP_API_URL
});

// Variable pour stocker le token d'accès
let accessToken = null;
let tokenExpiry = null;

/**
 * Obtenir un token d'accès OAuth2 pour SumUp
 */
async function getAccessToken() {
  try {
    // Si le token est valide, le retourner
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
      console.log('[SumUp] Token existant valide');
      return accessToken;
    }

    console.log('[SumUp] Demande d\'un nouveau token OAuth2');

    if (!SUMUP_CLIENT_ID || !SUMUP_CLIENT_SECRET) {
      throw new Error('SUMUP_CLIENT_ID ou SUMUP_CLIENT_SECRET manquant');
    }

    const response = await axios.post(
      `${SUMUP_API_URL}/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SUMUP_CLIENT_ID,
        client_secret: SUMUP_CLIENT_SECRET,
        scope: 'payments'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    accessToken = response.data.access_token;
    // Définir l'expiration à 1 heure (token valide généralement 1h)
    tokenExpiry = Date.now() + (3600 * 1000);

    console.log('[SumUp] ✅ Token OAuth2 obtenu avec succès');
    return accessToken;

  } catch (error) {
    console.error('[SumUp] ❌ Erreur obtention token:', error.response?.data || error.message);
    throw new Error(`Erreur d'authentification SumUp: ${error.response?.data?.message || error.message}`);
  }
}

/**
 * Créer un checkout SumUp (lien de paiement)
 * @param {Object} checkoutData - Données du checkout
 * @returns {Object} - Informations du checkout créé
 */
async function createCheckout(checkoutData) {
  try {
    console.log('[SumUp] Création d\'un checkout:', {
      amount: checkoutData.amount,
      currency: checkoutData.currency,
      devisId: checkoutData.devisId
    });

    const token = await getAccessToken();

    // Formater le montant (SumUp attend un nombre avec 2 décimales)
    const amount = parseFloat(checkoutData.amount).toFixed(2);

    // Préparer le payload
    const payload = {
      checkout_reference: checkoutData.devisId || `DEVIS-${Date.now()}`,
      amount: amount,
      currency: checkoutData.currency || 'EUR',
      merchant_code: SUMUP_MERCHANT_CODE,
      description: checkoutData.description || 'Paiement Label Energie',
      return_url: checkoutData.returnUrl,
      // Informations optionnelles
      ...(checkoutData.clientEmail && {
        pay_to_email: checkoutData.clientEmail
      })
    };

    console.log('[SumUp] Payload envoyé:', payload);

    const response = await axios.post(
      `${SUMUP_API_URL}/v0.1/checkouts`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('[SumUp] ✅ Checkout créé avec succès:', {
      id: response.data.id,
      status: response.data.status
    });

    return {
      success: true,
      checkout_id: response.data.id,
      checkout_reference: response.data.checkout_reference,
      payment_url: `https://pay.sumup.com/checkout/${response.data.id}`,
      amount: response.data.amount,
      currency: response.data.currency,
      status: response.data.status,
      valid_until: response.data.valid_until,
      raw_response: response.data
    };

  } catch (error) {
    console.error('[SumUp] ❌ Erreur création checkout:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });

    throw {
      success: false,
      error: 'Erreur lors de la création du checkout SumUp',
      details: error.response?.data || error.message,
      status: error.response?.status
    };
  }
}

/**
 * Récupérer les informations d'un checkout
 * @param {string} checkoutId - ID du checkout
 */
async function getCheckout(checkoutId) {
  try {
    console.log('[SumUp] Récupération checkout:', checkoutId);

    const token = await getAccessToken();

    const response = await axios.get(
      `${SUMUP_API_URL}/v0.1/checkouts/${checkoutId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('[SumUp] ✅ Checkout récupéré:', {
      id: response.data.id,
      status: response.data.status,
      amount: response.data.amount
    });

    return {
      success: true,
      checkout: response.data
    };

  } catch (error) {
    console.error('[SumUp] ❌ Erreur récupération checkout:', error.response?.data || error.message);
    throw {
      success: false,
      error: 'Erreur lors de la récupération du checkout',
      details: error.response?.data || error.message
    };
  }
}

/**
 * Vérifier la configuration SumUp
 */
function checkSumUpConfig() {
  const config = {
    configured: !!(SUMUP_CLIENT_ID && SUMUP_CLIENT_SECRET && SUMUP_MERCHANT_CODE),
    clientId: !!SUMUP_CLIENT_ID,
    clientSecret: !!SUMUP_CLIENT_SECRET,
    merchantCode: !!SUMUP_MERCHANT_CODE,
    apiUrl: SUMUP_API_URL
  };

  console.log('[SumUp] Configuration:', config);
  return config;
}

module.exports = {
  createCheckout,
  getCheckout,
  getAccessToken,
  checkSumUpConfig
};
