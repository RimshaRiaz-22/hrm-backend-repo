const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '../../');
const DEFAULT_CLIENT_CONFIG = path.join(BACKEND_ROOT, 'google-services.json');
const DEFAULT_SERVICE_ACCOUNT_FILES = [
  'firebase-service-account.json',
  'service-account.json',
];

function listServiceAccountCandidates() {
  const fromEnv = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
  ]
    .map(resolvePath)
    .filter(Boolean);

  const defaults = DEFAULT_SERVICE_ACCOUNT_FILES.map((name) => path.join(BACKEND_ROOT, name));

  let discovered = [];
  try {
    discovered = fs
      .readdirSync(BACKEND_ROOT)
      .filter((file) => file.endsWith('.json') && /firebase-adminsdk/i.test(file))
      .map((file) => path.join(BACKEND_ROOT, file));
  } catch {
  }

  return [...fromEnv, ...defaults, ...discovered];
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolvePath(filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(BACKEND_ROOT, filePath);
}

function isServiceAccountJson(data) {
  return data?.type === 'service_account' && data?.private_key && data?.client_email;
}

function isGoogleServicesJson(data) {
  return Boolean(data?.project_info?.project_id);
}

function extractProjectId(data) {
  if (isGoogleServicesJson(data)) {
    return data.project_info.project_id;
  }
  if (data?.project_id) {
    return data.project_id;
  }
  return null;
}

function resolveGoogleServicesConfig() {
  const envPath = process.env.FIREBASE_CLIENT_CONFIG_PATH || process.env.GOOGLE_SERVICES_JSON_PATH;
  const candidates = [resolvePath(envPath), DEFAULT_CLIENT_CONFIG].filter(Boolean);

  for (const filePath of candidates) {
    const data = readJsonFile(filePath);
    if (isGoogleServicesJson(data)) {
      return {
        path: filePath,
        projectId: extractProjectId(data),
        packageName: data.client?.[0]?.client_info?.android_client_info?.package_name || null,
      };
    }
  }

  return null;
}

function resolveServiceAccountConfig() {
  const candidates = listServiceAccountCandidates();

  for (const filePath of candidates) {
    const data = readJsonFile(filePath);
    if (isServiceAccountJson(data)) {
      return {
        path: filePath,
        data,
        projectId: data.project_id,
        clientEmail: data.client_email,
      };
    }

    if (isGoogleServicesJson(data)) {
      return {
        error:
          `${path.basename(filePath)} is a client config file. Download a Firebase service account key from Firebase Console > Project Settings > Service Accounts and save it as firebase-service-account.json.`,
      };
    }
  }

  try {
    const files = fs.readdirSync(BACKEND_ROOT);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      if (['google-services.json', 'package.json', 'package-lock.json'].includes(file)) continue;

      const filePath = path.join(BACKEND_ROOT, file);
      const data = readJsonFile(filePath);
      if (isServiceAccountJson(data)) {
        return {
          path: filePath,
          data,
          projectId: data.project_id,
          clientEmail: data.client_email,
        };
      }
    }
  } catch {
    // ignore directory read errors
  }

  return null;
}

function getInlineServiceAccount() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKeyRaw) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
  };
}

function getFirebaseConfig() {
  const googleServices = resolveGoogleServicesConfig();
  const serviceAccount = resolveServiceAccountConfig();
  const inlineServiceAccount = getInlineServiceAccount();

  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    serviceAccount?.projectId ||
    googleServices?.projectId ||
    inlineServiceAccount?.projectId ||
    null;

  const configured = Boolean(serviceAccount?.data || inlineServiceAccount);
  const setupError =
    serviceAccount?.error ||
    (!configured && googleServices
      ? 'google-services.json found, but firebase-service-account.json is required for backend push sending.'
      : null);

  return {
    configured,
    projectId,
    googleServicesPath: googleServices?.path || null,
    androidPackageName: googleServices?.packageName || null,
    serviceAccountPath: serviceAccount?.path || null,
    serviceAccount: serviceAccount?.data || null,
    inlineServiceAccount,
    setupError,
  };
}

module.exports = {
  getFirebaseConfig,
  isServiceAccountJson,
  isGoogleServicesJson,
};
