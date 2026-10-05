const pool = require('../src/db');
const { ensureFcmModuleSchema } = require('../src/db/ensureFcmModule');

async function main() {
  await ensureFcmModuleSchema();
  console.log('user_device_tokens table is ready.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
