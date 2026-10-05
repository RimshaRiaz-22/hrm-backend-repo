const pool = require('./index');

const FCM_MODULE_SQL = `
CREATE TABLE IF NOT EXISTS user_device_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL,
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  device_id VARCHAR(255),
  device_label VARCHAR(120),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE (user_id, fcm_token)
);

CREATE INDEX IF NOT EXISTS user_device_tokens_user_id_idx ON user_device_tokens(user_id);
CREATE INDEX IF NOT EXISTS user_device_tokens_active_user_idx ON user_device_tokens(user_id, is_active);
`;

async function ensureFcmModuleSchema() {
  await pool.query(FCM_MODULE_SQL);
}

module.exports = {
  ensureFcmModuleSchema,
};
