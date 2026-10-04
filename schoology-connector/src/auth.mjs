import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCOPE = 'schoology:read';
const now = () => Math.floor(Date.now() / 1000);
export const random = () => randomBytes(32).toString('base64url');
export const hash = v => createHash('sha256').update(String(v)).digest('base64url');
export const equal = (a,b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
export class AuthError extends Error {
  constructor(error, message = error, status = 400) { super(message); this.error = error; this.status = status; }
}
const fail = (code, message) => { throw new AuthError(code, message); };

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, value TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(kind,id));');
  }
  put(kind,id,value,ttl) { this.db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)').run(kind,id,JSON.stringify(value), ttl ? now()+ttl : 0); }
  get(kind,id) {
    const r = this.db.prepare('SELECT value,expires FROM records WHERE kind=? AND id=?').get(kind,id);
    if (!r || (r.expires && r.expires <= now())) return null;
    return JSON.parse(r.value);
  }
  remove(kind,id) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id); }
  prune() { this.db.prepare('DELETE FROM records WHERE expires > 0 AND expires <= ?').run(now()); }
  count(kind) { return this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE kind=?').get(kind).n; }
  close() { this.db.close(); }
}

export function validRedirect(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.origin === 'https://chatgpt.com' && !u.username && !u.password && !u.hash && !u.search &&
      (u.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname));
  } catch { return false; }
}

export class Auth {
  constructor({ origin, password, store }) {
    this.origin = origin; this.resource = origin + '/mcp'; this.password = password; this.store = store;
    this.cookieName = origin.startsWith('https:') ? '__Host-schoology-consent' : 'schoology-consent';
  }
  metadata() { return { issuer: this.origin, authorization_endpoint: this.origin+'/authorize', token_endpoint: this.origin+'/token',
    registration_endpoint: this.origin+'/register', revocation_endpoint: this.origin+'/revoke',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code','refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true, scopes_supported: [SCOPE] }; }
  resourceMetadata() { return { resource: this.resource, authorization_servers: [this.origin], scopes_supported: [SCOPE], resource_name: 'Personal Schoology — read only' }; }
  register(p) {
    this.store.prune();
    if (!Array.isArray(p.redirect_uris) || p.redirect_uris.length < 1 || p.redirect_uris.length > 5 || !p.redirect_uris.every(validRedirect)) fail('invalid_redirect_uri');
    if (p.token_endpoint_auth_method && p.token_endpoint_auth_method !== 'none') fail('invalid_client_metadata');
    if (p.grant_types && (!Array.isArray(p.grant_types) || p.grant_types.some(t => !['authorization_code','refresh_token'].includes(t)))) fail('invalid_client_metadata');
    if (p.response_types && (!Array.isArray(p.response_types) || p.response_types.some(t => t !== 'code'))) fail('invalid_client_metadata');
    if (this.store.count('client') >= 200) throw new AuthError('temporarily_unavailable','Client registration capacity reached.',503);
    const client = { client_id: random(), client_name: 'ChatGPT', redirect_uris: [...new Set(p.redirect_uris)],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types: ['code'], scope: SCOPE, client_id_issued_at: now() };
    this.store.put('client',client.client_id,client,0); return client;
  }
  begin(p) {
    const client = this.store.get('client',p.client_id);
    if (!client || !client.redirect_uris.includes(p.redirect_uri)) fail('invalid_request','Unrecognized client or redirect URI.');
    if (p.response_type !== 'code' || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? '')) fail('invalid_request','Authorization code with PKCE S256 is required.');
    if (p.resource !== this.resource) fail('invalid_target');
    if ((p.scope || SCOPE) !== SCOPE) fail('invalid_scope');
    if (typeof p.state !== 'string' || p.state.length < 1 || p.state.length > 1024) fail('invalid_request','OAuth state is required.');
    const tx = random(), cookie = random();
    this.store.put('consent',tx,{ client_id:p.client_id, redirect_uri:p.redirect_uri, state:p.state,
      challenge:p.code_challenge, resource:p.resource, scope:SCOPE, cookie_hash:hash(cookie) },300);
    return { tx, cookie, redirect:p.redirect_uri };
  }
  consent(p,cookie,origin) {
    if (origin !== this.origin) fail('access_denied','Invalid form origin.');
    const data = this.store.get('consent',p.transaction);
    if (!data || !cookie || !equal(data.cookie_hash,hash(cookie))) fail('access_denied','The sign-in form expired. Start the connection again.');
    // A transaction is single-use, even if the password is wrong.
    this.store.remove('consent',p.transaction);
    if (!equal(p.password ?? '',this.password)) fail('access_denied','Incorrect connector password. Start the connection again.');
    const code = random();
    this.store.put('code',hash(code),{...data, cookie_hash:undefined},120);
    const redirect = new URL(data.redirect_uri);
    redirect.searchParams.set('code',code); redirect.searchParams.set('state',data.state); redirect.searchParams.set('iss',this.origin);
    return redirect.href;
  }
  token(p) {
    if (!this.store.get('client',p.client_id)) fail('invalid_client');
    if (p.resource !== this.resource) fail('invalid_target');
    if (p.grant_type === 'authorization_code') {
      const id = hash(p.code ?? ''), code = this.store.get('code',id);
      if (!code || code.client_id !== p.client_id || code.redirect_uri !== p.redirect_uri || code.resource !== p.resource) fail('invalid_grant');
      if (typeof p.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier) || !equal(hash(p.code_verifier),code.challenge)) fail('invalid_grant');
      this.store.remove('code',id);
      return this.issue(p.client_id,random());
    }
    if (p.grant_type === 'refresh_token') {
      const id = hash(p.refresh_token ?? ''), r = this.store.get('refresh',id);
      if (!r || r.client_id !== p.client_id || this.store.get('revoked',r.family)) fail('invalid_grant');
      if (r.used) { this.store.put('revoked',r.family,true,15*86400); fail('invalid_grant'); }
      if (p.scope && p.scope !== SCOPE) fail('invalid_scope');
      this.store.put('refresh',id,{...r,used:true},14*86400);
      return this.issue(p.client_id,r.family);
    }
    fail('unsupported_grant_type');
  }
  issue(client_id,family) {
    const access = random(), refresh = random();
    const data = { client_id,family,scope:SCOPE,resource:this.resource };
    this.store.put('access',hash(access),data,3600); this.store.put('refresh',hash(refresh),data,14*86400);
    return { access_token:access, token_type:'Bearer', expires_in:3600, refresh_token:refresh, scope:SCOPE };
  }
  verify(header) {
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return false;
    const data = this.store.get('access',hash(header.slice(7)));
    return !!data && data.scope === SCOPE && data.resource === this.resource && !this.store.get('revoked',data.family);
  }
  revoke(p) {
    const id = hash(p.token ?? ''), data = this.store.get('access',id) || this.store.get('refresh',id);
    if (data && data.client_id === p.client_id) this.store.put('revoked',data.family,true,15*86400);
  }
  rate(key,limit,seconds) {
    const id = key + ':' + Math.floor(now()/seconds), value = this.store.get('rate',id) || 0;
    if (value >= limit) throw new AuthError('temporarily_unavailable','Too many requests. Try again later.',429);
    this.store.put('rate',id,value+1,seconds);
  }
}
