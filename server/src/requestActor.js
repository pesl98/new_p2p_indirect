/**
 * Session is the only actor on P2P routes.
 *
 * Mutating and sensitive reads call `withSessionActor` so body fields such as
 * `approver_id`, `requester_id`, and `actor_name` cannot name someone else.
 * A future OIDC/SAML login must mint the same `pf_session` cookie (see auth.js)
 * and then go through this helper — not a parallel identity header.
 */

import { IDENTITY_PROVIDER } from './auth.js';

export { IDENTITY_PROVIDER };

export class ActorBindingError extends Error {
  constructor(message, statusCode = 403) {
    super(message);
    this.name = 'ActorBindingError';
    this.statusCode = statusCode;
  }
}

export function isPublicApiRequest(req) {
  if (req.method === 'GET' && req.path === '/api/health') return true;
  if (req.path === '/api/auth' || req.path.startsWith('/api/auth/')) return true;
  return false;
}

/** Fail closed: every /api route except health and /api/auth/* needs a session. */
export function requireApiSession(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  if (isPublicApiRequest(req)) return next();
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return next();
}

export function requireRole(...roles) {
  const allowed = new Set(roles);
  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role for this action' });
    }
    return next();
  };
}

export const AP_ROLES = ['finance', 'admin'];

export function sessionActor(req) {
  if (!req.user) {
    throw new ActorBindingError('Authentication required', 401);
  }
  return {
    id: Number(req.user.id),
    name: req.user.name,
    role: req.user.role,
    department_id: req.user.department_id == null ? null : Number(req.user.department_id),
    email: req.user.email
  };
}

function readActorId(raw) {
  if (raw == null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ActorBindingError('Persona id is not a valid user id.');
  }
  return id;
}

/** Reject a body or query id that names someone other than the session user. */
export function assertSessionId(actor, raw, field) {
  const id = readActorId(raw);
  if (id == null) return;
  if (id !== actor.id) {
    throw new ActorBindingError(
      `${field} does not match the signed-in user. Persona ids in the request are not accepted.`
    );
  }
}

/**
 * Copy `body`, reject spoofed id fields, then stamp those ids and names
 * from the session. Omitted ids are filled; mismatched ids are 403.
 */
export function withSessionActor(req, body = {}, { ids = [], names = [] } = {}) {
  const actor = sessionActor(req);
  const source = body && typeof body === 'object' ? body : {};
  for (const field of ids) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      assertSessionId(actor, source[field], field);
    }
  }
  const next = { ...source };
  for (const field of ids) next[field] = actor.id;
  for (const field of names) next[field] = actor.name;
  return next;
}

export function assertSelfOrAdmin(actor, ownerId, message) {
  if (actor.role === 'admin') return;
  if (Number(ownerId) !== actor.id) {
    throw new ActorBindingError(message || 'This action is limited to the signed-in user.');
  }
}

/**
 * Non-admins may only post a requisition against their own department.
 * Returns the department id to persist.
 */
export function resolveActorDepartment(actor, departmentId) {
  if (departmentId == null || departmentId === '') {
    if (actor.department_id == null) {
      throw new ActorBindingError('department_id is required.', 400);
    }
    return actor.department_id;
  }
  const id = Number(departmentId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ActorBindingError('department_id must be a positive integer.', 400);
  }
  if (actor.role !== 'admin' && id !== actor.department_id) {
    throw new ActorBindingError('department_id does not match the signed-in user.');
  }
  return id;
}
