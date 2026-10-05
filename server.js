const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const pool = require('./src/db');
const { ensureRedisConnected, isRedisEnabled } = require('./src/redis');
const authRoutes = require('./src/routes/auth.routes');
const companiesRoutes = require('./src/routes/companies.routes');
const departmentsRoutes = require('./src/routes/departments.routes');
const orgChartRoutes = require('./src/routes/orgChart.routes');
const designationsRoutes = require('./src/routes/designations.routes');
const employeeRoutes = require('./src/routes/employee.routes');
const uploadRoutes = require('./src/routes/upload.routes');
const attendanceRoutes = require('./src/routes/attendance.routes');
const attendanceScheduleRoutes = require('./src/routes/attendanceSchedule.routes');
const employeeTypesRoutes = require('./src/routes/employeeTypes.routes');
const dependantsRoutes = require('./src/routes/dependants.routes');
const dependantRelationshipTypesRoutes = require('./src/routes/dependantRelationshipTypes.routes');
const salariesRoutes = require('./src/routes/salaries.routes');
const documentTypesRoutes = require('./src/routes/documentTypes.routes');
const rolesRoutes = require('./src/routes/roles.routes');
const accessRolesRoutes = require('./src/routes/accessRoles.routes');
const workLocationsRoutes = require('./src/routes/workLocations.routes');
const shiftsRoutes = require('./src/routes/shifts.routes');
const holidayRoutes = require('./src/routes/holiday.routes');
const leaveRoutes = require('./src/routes/leaves.routes');
const performanceRoutes = require('./src/routes/performance.routes');
const religionsRoutes = require('./src/routes/religions.routes');
const employeeBankDetailsAdminRoutes = require('./src/routes/employeeBankDetails.admin.routes');
const requestsRoutes = require('./src/routes/requests.routes');
const expenseCategoriesRoutes = require('./src/routes/expenseCategories.routes');
const noticePeriodRoutes = require('./src/routes/noticePeriod.routes');
const employeeReminderRoutes = require('./src/routes/employeeReminder.routes');
const documentRequestsRoutes = require('./src/routes/documentRequests.routes');
const documentsRoutes = require('./src/routes/documents.routes');
const notesRoutes = require('./src/routes/notes.routes');
const employeeOnboardingRoutes = require('./src/routes/employeeOnboarding.routes');
const trainingMaterialsRoutes = require('./src/routes/trainingMaterials.routes');
const employeeTrainingRoutes = require('./src/routes/employeeTraining.routes');

// Dashboard endpoints
const hrDashboardRoutes = require('./src/routes/hrDashboard.routes');
const employeeDashboardRoutes = require('./src/routes/employeeDashboard.routes');
const employeePayslipRoutes = require('./src/routes/employeePayslip.routes');
const payrollSettingsRoutes = require('./src/routes/payrollSettings.routes');
const monthlyInputsRoutes = require('./src/routes/monthlyInputs.routes');
const payrollAssignmentsRoutes = require('./src/routes/payrollAssignments.routes');
const payslipRoutes = require('./src/routes/payslip.routes');
const payrollRunRoutes = require('./src/routes/payrollRun.routes');
const taxCertificateRoutes = require('./src/routes/taxCertificate.routes');
const pfRoutes = require('./src/routes/pf.routes');
const { ensureDocumentModuleSchema } = require('./src/db/ensureDocumentModule');
const { ensureEmployeeOnboardingModuleSchema } = require('./src/db/ensureEmployeeOnboardingModule');
const { ensureTrainingModuleSchema } = require('./src/db/ensureTrainingModule');
const { ensureFcmModuleSchema } = require('./src/db/ensureFcmModule');
const { getFirebaseSetupStatus } = require('./src/services/fcm.service');
const deviceTokenRoutes = require('./src/routes/deviceToken.routes');
const { startNoticePeriodCron } = require('./src/jobs/noticePeriodCron');
const { startLeaveCycleCron } = require('./src/jobs/leaveCycleCron');
const { startBirthdayNotificationCron } = require('./src/jobs/birthdayNotificationCron');
const { startAnniversaryNotificationCron } = require('./src/jobs/anniversaryNotificationCron');
const { ensureLeaveCycleModuleSchema } = require('./src/db/ensureLeaveCycleModule');
const { ensurePerformanceModuleSchema } = require('./src/db/ensurePerformanceModule');
const { ensureBirthdayNotificationModuleSchema } = require('./src/db/ensureBirthdayNotificationModule');
const { ensureAnniversaryNotificationModuleSchema } = require('./src/db/ensureAnniversaryNotificationModule');


const app = express();
const port = parseInt(process.env.PORT, 10) || 3002;
const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

// Log every request before CORS (so OPTIONS / Origin are always visible)
// // Log every request after CORS (so OPTIONS / Origin are always visible)
app.use((req, res, next) => {
  const origin = req.headers.origin ?? '(no Origin — same-origin or non-browser)';
  if (req.method === 'OPTIONS') {
    console.log('[http] preflight OPTIONS', req.url, {
      origin,
      'access-control-request-method': req.headers['access-control-request-method'],
      'access-control-request-headers': req.headers['access-control-request-headers']
    });
  } else {
    console.log('[http]', req.method, req.url, '| Origin:', origin);
  }
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    console.log('[http]', req.method, req.url, '→', res.statusCode, `(${ms}ms)`);
  });
  next();
});
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
);
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/companies', companiesRoutes);
app.use('/api/v1/departments', departmentsRoutes);
app.use('/api/v1/org-chart', orgChartRoutes);
app.use('/api/v1/designations', designationsRoutes);
app.use('/api/v1/employees', employeeRoutes);
app.use('/api/v1/uploads', uploadRoutes);
app.use('/api/v1/attendance', attendanceRoutes);
app.use('/api/v1/attendance-schedules', attendanceScheduleRoutes);
app.use('/api/v1/employee-types', employeeTypesRoutes);
app.use('/api/v1/dependants', dependantsRoutes);
app.use('/api/v1/dependant-relationship-types', dependantRelationshipTypesRoutes);
app.use('/api/v1/salaries', salariesRoutes);
app.use('/api/v1/document-types', documentTypesRoutes);
app.use('/api/v1/roles', rolesRoutes);
app.use('/api/v1/job-roles', rolesRoutes);
app.use('/api/v1/access-roles', accessRolesRoutes);
app.use('/api/v1/work-locations', workLocationsRoutes);
app.use('/api/v1/shifts', shiftsRoutes);
app.use('/api/v1/holidays', holidayRoutes);
app.use('/api/v1/leaves', leaveRoutes);
app.use('/api/v1/performance', performanceRoutes);
app.use('/api/v1/religions', religionsRoutes);
app.use('/api/v1/admin/employee-bank-details', employeeBankDetailsAdminRoutes);
app.use('/api/v1/requests', requestsRoutes);
app.use('/api/v1/expense-categories', expenseCategoriesRoutes);
app.use('/api/v1/notice-periods', noticePeriodRoutes);
app.use('/api/v1/employee-reminders', employeeReminderRoutes);
app.use('/api/v1/document-requests', documentRequestsRoutes);
app.use('/api/v1/documents', documentsRoutes);
app.use('/api/v1/notes', notesRoutes);
app.use('/api/v1/employee-onboarding', employeeOnboardingRoutes);
app.use('/api/v1/training', trainingMaterialsRoutes);
app.use('/api/v1/employee-training', employeeTrainingRoutes);
app.use('/api/v1/devices', deviceTokenRoutes);

// Dashboard endpoints
app.use('/api/v1/hr/dashboard', hrDashboardRoutes);
app.use('/api/v1/employee/dashboard', employeeDashboardRoutes);
app.use('/api/v1/employee/payslips', employeePayslipRoutes);
app.use('/api/v1/payroll/monthly-inputs', monthlyInputsRoutes);
app.use('/api/v1/payroll/assignments', payrollAssignmentsRoutes);
app.use('/api/v1/payroll/payslips', payslipRoutes);
app.use('/api/v1/payroll/runs', payrollRunRoutes);
app.use('/api/v1/payroll/tax-certificates', taxCertificateRoutes);
app.use('/api/v1/payroll', payrollSettingsRoutes);
app.use('/api/v1/pf', pfRoutes);

app.get('/api/v1/health/document-module', (req, res) => {
  res.json({
    error: false,
    message: 'Document module API is available.',
    data: {
      endpoints: [
        'POST /api/v1/document-requests',
        'GET /api/v1/document-requests/my',
        'GET /api/v1/document-requests',
        'GET /api/v1/document-requests/:id',
        'PATCH /api/v1/document-requests/:id/cancel',
        'PATCH /api/v1/document-requests/:id/upload',
        'PATCH /api/v1/document-requests/:id/reject',
      ],
    },
  });
}); 

app.get('/', (req, res) => {
  res.send('Server is running successfully 🚀');
});

app.use((req, res) => {
  console.warn('[http] no route matched', req.method, req.url);
  res.status(404).json({
    error: true,
    message: 'Not found',
    data: { path: req.url },
  });
});

app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.url, err.message);
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    console.error(err.stack);
  }
  if (res.headersSent) {
    return next(err);
  }
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: true,
    message: err.message || 'Internal server error',
    data: null,
    ...(process.env.NODE_ENV !== 'production' && { detail: err.stack })
  });
});


app.listen(port, async () => {
  console.log('[boot] server listening on http://localhost:%s', port);
  console.log('[boot] CORS allowed origin (CLIENT_URL): %s', clientUrl);
  console.log(
    '[boot] tip: frontend Origin must match exactly (scheme, host, port). Vite default is http://localhost:5173'
  );
  try {
    await pool.query('SELECT 1');
    console.log('[boot] database: connected');
    if (!isRedisEnabled()) {
      console.log('[boot] redis: disabled (REDIS_ENABLED=false)');
    } else if (await ensureRedisConnected()) {
      console.log('[boot] redis: connected');
    } else {
      console.warn('[boot] redis: unavailable (cache disabled, using database only)');
    }
    await ensureDocumentModuleSchema();
    console.log('[boot] document module: schema ready');
    await ensureEmployeeOnboardingModuleSchema();
    console.log('[boot] employee onboarding module: schema ready');
    await ensureTrainingModuleSchema();
    console.log('[boot] training module: schema ready');
    await ensureFcmModuleSchema();
    console.log('[boot] fcm module: schema ready');
    await ensureLeaveCycleModuleSchema();
    console.log('[boot] leave cycle module: schema ready');
    await ensurePerformanceModuleSchema();
    console.log('[boot] performance module: schema ready');
    await ensureBirthdayNotificationModuleSchema();
    console.log('[boot] birthday notification module: schema ready');
    await ensureAnniversaryNotificationModuleSchema();
    console.log('[boot] anniversary notification module: schema ready');

    const fcmStatus = getFirebaseSetupStatus();
    if (fcmStatus.configured) {
      console.log('[boot] fcm: ready (project: %s)', fcmStatus.project_id);
    } else if (fcmStatus.google_services_path) {
      console.warn('[boot] fcm: %s detected at %s', 'google-services.json', fcmStatus.google_services_path);
      console.warn('[boot] fcm: add firebase-service-account.json to enable push sending');
      if (fcmStatus.setup_error) {
        console.warn('[boot] fcm: %s', fcmStatus.setup_error);
      }
    } else {
      console.warn('[boot] fcm: not configured');
    }
    startNoticePeriodCron();
    console.log('[boot] notice period cron: scheduled (daily 00:05 UTC)');
    startLeaveCycleCron();
    console.log('[boot] leave cycle cron: scheduled (daily 00:10 UTC)');
    startBirthdayNotificationCron();
    console.log('[boot] birthday notification cron: scheduled (every 15 min, per-employee local midnight via work location / company timezone)');
    startAnniversaryNotificationCron();
    console.log('[boot] anniversary notification cron: scheduled (every 15 min, per-employee local midnight via work location / company timezone)');
    console.log('[boot] pf module: routes at /api/v1/pf');
    console.log('[boot] expense module: routes at /api/v1/expense-categories');
    console.log('[boot] monthly inputs: routes at /api/v1/payroll/monthly-inputs');
    console.log('[boot] payroll assignments: routes at /api/v1/payroll/assignments');
    console.log('[boot] payroll runs: routes at /api/v1/payroll/runs');
    console.log('[boot] ready');
  } catch (err) {
    console.error('[boot] database: FAILED —', err.message);
  }
});




