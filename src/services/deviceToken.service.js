const pool = require('../db');

const VALID_PLATFORMS = new Set(['android', 'ios', 'web']);

function normalizePlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  return VALID_PLATFORMS.has(value) ? value : null;
}

function normalizeToken(token) {
  const value = String(token || '').trim();
  return value || null;
}

async function registerDeviceToken(userId, payload = {}) {
  const fcmToken = normalizeToken(payload.fcm_token ?? payload.fcmToken);
  const platform = normalizePlatform(payload.platform);

  if (!fcmToken) {
    return { error: 'fcm_token is required.', status: 400 };
  }
  if (!platform) {
    return { error: 'platform must be android, ios, or web.', status: 400 };
  }

  const deviceId = payload.device_id ?? payload.deviceId ?? null;
  const deviceLabel = payload.device_label ?? payload.deviceLabel ?? null;

  const result = await pool.query(
    `
      INSERT INTO user_device_tokens (
        user_id,
        fcm_token,
        platform,
        device_id,
        device_label,
        is_active,
        last_used_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, TRUE, NOW() AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC')
      ON CONFLICT (user_id, fcm_token)
      DO UPDATE SET
        platform = EXCLUDED.platform,
        device_id = COALESCE(EXCLUDED.device_id, user_device_tokens.device_id),
        device_label = COALESCE(EXCLUDED.device_label, user_device_tokens.device_label),
        is_active = TRUE,
        last_used_at = NOW() AT TIME ZONE 'UTC',
        updated_at = NOW() AT TIME ZONE 'UTC'
      RETURNING id, user_id, platform, device_id, device_label, is_active, last_used_at, created_at, updated_at
    `,
    [userId, fcmToken, platform, deviceId, deviceLabel]
  );

  return {
    data: {
      token: result.rows[0],
    },
  };
}

async function unregisterDeviceToken(userId, payload = {}) {
  const fcmToken = normalizeToken(payload.fcm_token ?? payload.fcmToken);

  if (fcmToken) {
    const result = await pool.query(
      `
        UPDATE user_device_tokens
        SET is_active = FALSE, updated_at = NOW() AT TIME ZONE 'UTC'
        WHERE user_id = $1 AND fcm_token = $2
        RETURNING id
      `,
      [userId, fcmToken]
    );

    return {
      data: {
        deactivated_count: result.rowCount,
      },
    };
  }

  const result = await pool.query(
    `
      UPDATE user_device_tokens
      SET is_active = FALSE, updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE user_id = $1 AND is_active = TRUE
      RETURNING id
    `,
    [userId]
  );

  return {
    data: {
      deactivated_count: result.rowCount,
    },
  };
}

function normalizeDeviceId(deviceId) {
  const value = String(deviceId ?? '').trim();
  return value || null;
}

async function updateUserDeviceId(userId, deviceId) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  if (!normalizedDeviceId) {
    return null;
  }

  await pool.query(
    `
      UPDATE users
      SET device_id = $2, updated_at = NOW()
      WHERE id = $1
    `,
    [userId, normalizedDeviceId]
  );

  return normalizedDeviceId;
}

async function handleLoginDeviceSync(userId, payload = {}) {
  const deviceId = normalizeDeviceId(payload.device_id ?? payload.deviceId);
  const fcmToken = normalizeToken(payload.fcm_token ?? payload.fcmToken);
  const platform = normalizePlatform(payload.platform);
  const deviceLabel = payload.device_label ?? payload.deviceLabel ?? null;

  if (deviceId) {
    await updateUserDeviceId(userId, deviceId);
  }

  if (!fcmToken) {
    return {
      data: {
        device_id: deviceId,
        fcm_registered: false,
      },
    };
  }

  if (!platform) {
    return {
      error: 'platform is required when fcm_token is provided.',
      status: 400,
    };
  }

  const registerResult = await registerDeviceToken(userId, {
    fcm_token: fcmToken,
    platform,
    device_id: deviceId,
    device_label: deviceLabel,
  });

  if (registerResult.error) {
    return registerResult;
  }

  return {
    data: {
      device_id: deviceId,
      fcm_registered: true,
      token: registerResult.data.token,
    },
  };
}

async function getActiveTokensForUser(userId, options = {}) {
  const deviceId = normalizeDeviceId(options.deviceId ?? options.device_id);
  const params = [userId];
  let deviceFilter = '';

  if (deviceId) {
    params.push(deviceId);
    deviceFilter = ' AND device_id = $2';
  }

  const result = await pool.query(
    `
      SELECT id, user_id, fcm_token, platform, device_id, device_label, last_used_at
      FROM user_device_tokens
      WHERE user_id = $1 AND is_active = TRUE${deviceFilter}
      ORDER BY last_used_at DESC NULLS LAST, updated_at DESC
    `,
    params
  );

  return result.rows;
}

async function getUserAccountByEmployeeId(companyId, employeeId) {
  const result = await pool.query(
    `
      SELECT id, device_id
      FROM users
      WHERE company_id = $1
        AND employee_id = $2
        AND is_active = TRUE
      LIMIT 1
    `,
    [companyId, employeeId]
  );

  return result.rows[0] || null;
}

async function getReviewerUserAccounts(companyId, roles) {
  const result = await pool.query(
    `
      SELECT id, device_id
      FROM users
      WHERE company_id = $1
        AND is_active = TRUE
        AND role = ANY($2::text[])
    `,
    [companyId, roles]
  );

  return result.rows;
}

async function deactivateToken(fcmToken) {
  const token = normalizeToken(fcmToken);
  if (!token) return 0;

  const result = await pool.query(
    `
      UPDATE user_device_tokens
      SET is_active = FALSE, updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE fcm_token = $1 AND is_active = TRUE
    `,
    [token]
  );

  return result.rowCount;
}

async function touchTokenLastUsed(fcmToken) {
  const token = normalizeToken(fcmToken);
  if (!token) return;

  await pool.query(
    `
      UPDATE user_device_tokens
      SET last_used_at = NOW() AT TIME ZONE 'UTC', updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE fcm_token = $1 AND is_active = TRUE
    `,
    [token]
  );
}

module.exports = {
  registerDeviceToken,
  unregisterDeviceToken,
  handleLoginDeviceSync,
  updateUserDeviceId,
  getActiveTokensForUser,
  getUserAccountByEmployeeId,
  getReviewerUserAccounts,
  deactivateToken,
  touchTokenLastUsed,
};
