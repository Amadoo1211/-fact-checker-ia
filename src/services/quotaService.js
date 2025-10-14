const pool = require('./db');

const PLAN_LIMITS = {
  free: { dailyVerifications: 3, dailyOtto: 1 },
  starter: { dailyVerifications: 10, dailyOtto: 5 },
  pro: { dailyVerifications: 30, dailyOtto: Infinity },
  business: { dailyVerifications: Infinity, dailyOtto: Infinity },
};

const DEFAULT_PLAN = 'free';

const toIsoDateString = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

const getTodayUtcDateString = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
};

const getNextUtcMidnightIso = () => {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.toISOString();
};

const normalizeUsageValue = (value) => Math.max(0, Number(value) || 0);

const getPlanFromUser = (user) => {
  if (!user) return DEFAULT_PLAN;

  const rawPlan = (user.plan || '').toLowerCase();
  if (PLAN_LIMITS[rawPlan]) return rawPlan;

  const role = (user.role || '').toLowerCase();
  if (role === 'admin' || role === 'business') {
    return 'business';
  }

  return DEFAULT_PLAN;
};

function buildQuotaPayload(user) {
  const plan = getPlanFromUser(user);
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN];
  const usedVerifications = normalizeUsageValue(user?.daily_checks_used);
  const usedOtto = normalizeUsageValue(user?.daily_otto_analysis);

  const normalizeLimit = (value) => (Number.isFinite(value) ? value : Infinity);

  const dailyVerificationLimit = normalizeLimit(limits.dailyVerifications);
  const dailyOttoLimit = normalizeLimit(limits.dailyOtto);

  const remainingVerifications = Number.isFinite(dailyVerificationLimit)
    ? Math.max(0, dailyVerificationLimit - usedVerifications)
    : Infinity;
  const remainingOtto = Number.isFinite(dailyOttoLimit)
    ? Math.max(0, dailyOttoLimit - usedOtto)
    : Infinity;

  return {
    plan,
    limits: {
      dailyVerifications: dailyVerificationLimit,
      dailyOtto: dailyOttoLimit,
    },
    usage: {
      verificationsUsed: usedVerifications,
      ottoUsed: usedOtto,
    },
    remaining: {
      verifications: remainingVerifications,
      otto: remainingOtto,
    },
    period: 'daily',
    resetAtUtc: getNextUtcMidnightIso(),
  };
}

async function ensureDailyReset(user) {
  if (!user) return null;

  const todayIso = getTodayUtcDateString();
  const lastCheckIso = toIsoDateString(user.last_check_date);

  if (lastCheckIso === todayIso) {
    return {
      ...user,
      last_check_date: todayIso,
      daily_checks_used: normalizeUsageValue(user.daily_checks_used),
      daily_otto_analysis: normalizeUsageValue(user.daily_otto_analysis),
    };
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users
         SET daily_checks_used = 0,
             daily_otto_analysis = 0,
             last_check_date = $1,
             updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [todayIso, user.id],
    );

    const refreshed = result.rows[0] || user;
    return {
      ...refreshed,
      last_check_date: todayIso,
      daily_checks_used: 0,
      daily_otto_analysis: 0,
    };
  } finally {
    client.release();
  }
}

async function incrementUsageCounters(userId, increments = {}) {
  if (!userId) return null;

  const fields = [];
  const values = [];
  let placeholderIndex = 1;

  if (increments.verifications) {
    fields.push(`daily_checks_used = COALESCE(daily_checks_used, 0) + $${placeholderIndex++}`);
    values.push(Number(increments.verifications));
  }

  if (increments.otto) {
    fields.push(`daily_otto_analysis = COALESCE(daily_otto_analysis, 0) + $${placeholderIndex++}`);
    values.push(Number(increments.otto));
  }

  const todayIso = getTodayUtcDateString();
  fields.push(`last_check_date = $${placeholderIndex++}`);
  values.push(todayIso);
  fields.push('updated_at = NOW()');

  const query = `UPDATE users SET ${fields.join(', ')} WHERE id = $${placeholderIndex} RETURNING *`;
  values.push(userId);

  const result = await pool.query(query, values);
  const updatedUser = result.rows[0] || null;

  if (updatedUser) {
    return {
      ...updatedUser,
      daily_checks_used: normalizeUsageValue(updatedUser.daily_checks_used),
      daily_otto_analysis: normalizeUsageValue(updatedUser.daily_otto_analysis),
      last_check_date: toIsoDateString(updatedUser.last_check_date) || todayIso,
    };
  }

  return null;
}

async function resetAllCounters() {
  const client = await pool.connect();
  try {
    await client.query(`
      UPDATE users
         SET daily_checks_used = 0,
             daily_otto_analysis = 0,
             last_check_date = CURRENT_DATE,
             updated_at = NOW()
    `);
  } finally {
    client.release();
  }
}

module.exports = {
  PLAN_LIMITS,
  DEFAULT_PLAN,
  buildQuotaPayload,
  ensureDailyReset,
  incrementUsageCounters,
  resetAllCounters,
  getPlanFromUser,
  normalizeUsageValue,
};
