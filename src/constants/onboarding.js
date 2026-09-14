const ONBOARDING_TOKEN_PURPOSE = 'employee-onboarding';
// Both derive from the same number by default so the JWT's exp claim and the
// "is the previous invite still valid" SQL check (employeeOnboarding.controller.js,
// requestOnboardingInviteResend) never drift out of sync.
const ONBOARDING_INVITE_EXPIRES_MINUTES = Number(process.env.ONBOARDING_INVITE_EXPIRES_MINUTES) || 30;
const ONBOARDING_INVITE_EXPIRES_IN =
  process.env.ONBOARDING_INVITE_EXPIRES_IN || `${ONBOARDING_INVITE_EXPIRES_MINUTES}m`;

const ONBOARDING_STATUSES = {
  PENDING_INVITE: 'pending_invite',
  PRE_BOARDING: 'pre_boarding',
  ACTIVE: 'active',
};

module.exports = {
  ONBOARDING_TOKEN_PURPOSE,
  ONBOARDING_INVITE_EXPIRES_IN,
  ONBOARDING_INVITE_EXPIRES_MINUTES,
  ONBOARDING_STATUSES,
};
