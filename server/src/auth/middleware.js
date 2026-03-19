'use strict';
/**
 * Session-based authentication + permission middleware.
 *
 * Token sources (in priority order):
 *   1. Cookie:  apix_session=<token>
 *   2. Header:  Authorization: Bearer <token>
 *   3. Query:   ?session=<token>
 *
 * Role hierarchy (built-in):
 *   admin   → wildcard (*), bypasses everything
 *   mod     → devices, messages, campaigns, settings, partial accounts
 *   support → accounts:view + edit_basic, messages:read
 *   user    → messages:send/read, contacts, templates
 *   viewer  → messages:read, analytics
 *
 * Custom roles: stored in the `roles` table, any permissions can be set.
 */
const { Sessions, Plans, Roles, Users } = require('../db');

function getToken(req) {
    if (req.cookies?.apix_session) return req.cookies.apix_session;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    if (req.query?.session) return req.query.session;
    return null;
}

/**
 * Check IP allowlist for a user. Returns true if allowed.
 */
function _checkIpAllowlist(user, ip) {
    let list;
    try {
        list = JSON.parse(user.ip_allowlist || '[]');
    } catch { return true; }
    if (!Array.isArray(list) || list.length === 0) return true; // No restriction
    // Check if request IP matches any entry (CIDR or exact)
    const normalised = (ip || '').replace(/^::ffff:/, '');
    for (const entry of list) {
        const e = entry.trim();
        if (!e) continue;
        if (e.includes('/')) {
            // CIDR — basic IPv4 only for simplicity
            if (_ipInCidr(normalised, e)) return true;
        } else if (e === normalised || e === ip) {
            return true;
        }
    }
    return false;
}

function _ipInCidr(ip, cidr) {
    try {
        const [range, bits] = cidr.split('/');
        const mask = ~(0xffffffff >>> parseInt(bits));
        const ipInt  = ip.split('.').reduce((a,b)=>(a<<8)|parseInt(b),0)>>>0;
        const rangeInt = range.split('.').reduce((a,b)=>(a<<8)|parseInt(b),0)>>>0;
        return (ipInt & mask) === (rangeInt & mask);
    } catch { return false; }
}

/**
 * Attach session + plan to req.  Never rejects on its own.
 */
function _attachSession(req) {
    const token = getToken(req);
    if (!token) return false;
    const session = Sessions.verify(token);
    if (!session) return false;

    // IP allowlist check
    const fullUser = Users.findById(session.uid || session.user_id);
    if (fullUser && !_checkIpAllowlist(fullUser, req.ip)) {
        return 'ip_blocked';
    }

    req.user = session;
    req.plan = session.plan_id ? Plans.findById(session.plan_id) : Plans.getDefault();
    return true;
}

/**
 * requireAuth(roleOrPerm?)
 *
 * If called with no argument: just requires a valid session.
 * If called with a role name ('admin','mod','support',...): requires that exact role
 *   (admin always passes).
 * If called with a permission string containing ':' ('devices:manage'):
 *   uses the full permission-check via Roles.hasPerm.
 */
function requireAuth(roleOrPerm = null) {
    return (req, res, next) => {
        const ok = _attachSession(req);
        if (ok === 'ip_blocked') return res.status(403).json({ error: 'Access denied from this IP address', code: 'IP_BLOCKED' });
        if (!ok) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
        if (req.user.status === 'suspended') return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });

        if (roleOrPerm) {
            if (req.user.role === 'admin') return next(); // admin bypasses everything

            if (roleOrPerm.includes(':')) {
                // Permission-based check
                if (!Roles.hasPerm(req.user.role, roleOrPerm)) {
                    return res.status(403).json({
                        error: `Permission denied: ${roleOrPerm}`,
                        code:  'AUTH_FORBIDDEN',
                        required_permission: roleOrPerm,
                    });
                }
            } else {
                // Role-based check (exact match, admin already handled above)
                if (req.user.role !== roleOrPerm) {
                    return res.status(403).json({
                        error: `Requires ${roleOrPerm} role`,
                        code:  'AUTH_FORBIDDEN',
                    });
                }
            }
        }
        next();
    };
}

/** optionalAuth — attaches user if session present, never rejects */
function optionalAuth(req, res, next) {
    _attachSession(req);
    next();
}

/** requireAdmin — shorthand for admin-only routes */
const requireAdmin = requireAuth('admin');

/**
 * requirePerm(permission)
 * Cleaner alias for requireAuth('some:perm') — preferred for route protection.
 * Admin always passes.  Checks the role's permissions JSON.
 */
function requirePerm(permission) {
    return requireAuth(permission);
}

/**
 * requireAnyRole(...roles)
 * Passes if the user has ANY of the listed roles (or is admin).
 */
function requireAnyRole(...roles) {
    return (req, res, next) => {
        const ok = _attachSession(req);
        if (ok === 'ip_blocked') return res.status(403).json({ error: 'Access denied from this IP address', code: 'IP_BLOCKED' });
        if (!ok) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
        if (req.user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
        if (req.user.role === 'admin') return next();
        if (roles.includes(req.user.role)) return next();
        return res.status(403).json({ error: `Requires one of: ${roles.join(', ')}`, code: 'AUTH_FORBIDDEN' });
    };
}

/**
 * requireFeature(featureKey)
 * Blocks if the user's plan doesn't include featureKey.
 * Must follow requireAuth.  Admin bypasses.
 */
function requireFeature(featureKey) {
    return (req, res, next) => {
        if (req.user?.role === 'admin') return next();
        const plan = req.plan;
        if (!plan) return res.status(403).json({ error: 'No plan assigned', code: 'PLAN_REQUIRED' });
        if (plan.features?.[featureKey]) return next();
        return res.status(402).json({
            error: 'This feature requires a higher plan',
            code:  'PLAN_UPGRADE_REQUIRED',
            feature: featureKey,
            current_plan: plan.name,
            upgrade_url: '/plans',
        });
    };
}

/**
 * Helper — check permission inline (for use inside route handlers).
 * Returns true if user.role has the given permission.
 */
function can(user, permission) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return Roles.hasPerm(user.role, permission);
}

module.exports = {
    requireAuth, optionalAuth, requireAdmin,
    requirePerm, requireAnyRole, requireFeature,
    can, getToken,
};
