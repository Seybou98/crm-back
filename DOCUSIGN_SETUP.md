# Configuration DocuSign (signature électronique)

Ce backend utilise **DocuSign** pour la signature électronique (contrats maintenance, devis SAV). Les anciennes variables YouSign ne sont plus utilisées.

## Variables d'environnement (.env)

Ajoutez dans `gocardless-backend/.env` :

```env
# DocuSign eSignature (JWT Grant)
DOCUSIGN_INTEGRATION_KEY=votre_integration_key
DOCUSIGN_USER_ID=GUID_utilisateur_api
DOCUSIGN_ACCOUNT_ID=id_compte_docusign
DOCUSIGN_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

- **DOCUSIGN_INTEGRATION_KEY** : Clé d’intégration (Application / Integration Key) dans le portail DocuSign Developer.
- **DOCUSIGN_USER_ID** : GUID de l’utilisateur “API” (créé dans Admin > Users, avec “Send on behalf” pour l’app).
- **DOCUSIGN_ACCOUNT_ID** : ID du compte (ex. dans l’URL du portail DocuSign ou via API).
- **DOCUSIGN_PRIVATE_KEY** : Clé privée RSA (générée lors de la création de l’app DocuSign), au format PEM. Dans `.env`, garder les retours à la ligne comme `\n`.

Pour l’environnement de démo :

```env
DOCUSIGN_BASE_URL=https://demo.docusign.net
DOCUSIGN_OAUTH_HOST=account-d.docusign.com
```

Pour la production :

```env
DOCUSIGN_BASE_URL=https://www.docusign.net
DOCUSIGN_OAUTH_HOST=account.docusign.com
```

## Webhook DocuSign Connect

Pour mettre à jour automatiquement le statut “signé” dans Firestore quand le client a signé :

1. Dans DocuSign : **Settings > Connect** (ou Configuration Connect).
2. Créez une configuration avec l’URL de votre backend :  
   `https://label-energie-api.onrender.com/api/docusign/webhook`  
   (ne pas mettre `https://` deux fois ; le champ doit contenir ce bloc tel quel.)
3. Cochez l’événement **Envelope Signed/Completed** ; optionnel : **Envelope Declined**.
4. Enregistrez.

Le backend reçoit la notification, récupère l’`envelopeId`, trouve la maintenance dont le champ `yousignRequestId` est égal à cet ID, et met à jour `signatureStatus: 'signed'` et `signatureDate`.

## Dépendance

Le service utilise `jsonwebtoken` pour l’authentification JWT. Installation :

```bash
cd gocardless-backend && npm install
```

## Routes conservées pour compatibilité frontend

Le frontend continue d’appeler les mêmes URLs ; le backend répond avec DocuSign :

- `POST /api/yousign/signature-request` → crée une enveloppe DocuSign
- `GET /api/yousign/signature-request/:id` → statut de l’enveloppe
- `GET /api/yousign/signature-request/:id/document` → PDF signé
- `GET /api/yousign/status/:requestId` → statut (format compatible)
- `GET /api/yousign/download/:requestId` → téléchargement PDF
- `POST /api/yousign-devis` → devis SAV (actions create_signature_request, get_status, download_signed)
- `POST /api/docusign/webhook` → webhook DocuSign Connect
