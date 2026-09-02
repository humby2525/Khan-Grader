import { createHmac, randomBytes } from 'node:crypto';

const BASE = 'https://api.schoology.com/v1';
export const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const array = v => v == null ? [] : Array.isArray(v) ? v : [v];
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Adapted from Khan Grader's src/background.js. Always GET; no write path exists.
export function authorization(url, key, secret, nonce = randomBytes(24).toString('hex'), timestamp = Math.floor(Date.now() / 1000)) {
  const oauth = { oauth_consumer_key: key, oauth_token: '', oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(timestamp), oauth_version: '1.0' };
  const params = [...url.searchParams, ...Object.entries(oauth)].map(([k,v]) => [encode(k), encode(v)]);
  params.sort((a,b) => cmp(a[0],b[0]) || cmp(a[1],b[1]));
  const normalized = params.map(p => p.join('=')).join('&');
  const base = ['GET', encode(url.origin + url.pathname), encode(normalized)].join('&');
  oauth.oauth_signature = createHmac('sha1', `${encode(secret)}&`).update(base).digest('base64');
  return 'OAuth ' + Object.entries(oauth).map(([k,v]) => `${encode(k)}="${encode(v)}"`).join(', ');
}

export class Schoology {
  constructor({ key, secret, sections, fetcher = fetch }) {
    this.key = key; this.secret = secret; this.sections = sections; this.fetcher = fetcher;
  }
  section(id) {
    if (typeof id !== 'string' || !/^\d+$/.test(id) || !this.sections.includes(id)) throw new Error('Section is not in the configured class allowlist.');
    return id;
  }
  async get(path) {
    let url = new URL(BASE + path);
    const initialPath = url.pathname;
    for (let hop = 0; hop < 4; hop++) {
      let response;
      try { response = await this.fetcher(url, { method: 'GET', redirect: 'manual',
        headers: { Accept: 'application/json', Authorization: authorization(url, this.key, this.secret) },
        signal: AbortSignal.timeout(20000) }); }
      catch { throw new Error('Schoology could not be reached. No changes were made.'); }
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Schoology returned a redirect without a destination.');
        const next = new URL(location, url);
        // Schoology users/me redirects to the numeric user endpoint. Re-sign it.
        if (initialPath !== '/v1/users/me' || next.origin !== 'https://api.schoology.com' ||
            !/^\/v1\/users\/\d+$/.test(next.pathname) || next.username || next.password || next.search || next.hash) {
          throw new Error('Schoology returned an unexpected redirect.');
        }
        url = next; continue;
      }
      if (!response.ok) throw new Error(`Schoology returned HTTP ${response.status}. Check API permission and class access.`);
      const body = await response.text();
      if (body.length > 5_000_000) throw new Error('Schoology response exceeded the size limit.');
      try { return JSON.parse(body); } catch { throw new Error('Schoology returned an unexpected response format.'); }
    }
    throw new Error('Schoology returned too many redirects.');
  }
  async collection(path, key) {
    const start = new URL(BASE + path), seen = new Set(), out = [];
    let current = start;
    for (let page = 0; page < 50; page++) {
      if (seen.has(current.href)) throw new Error('Schoology pagination repeated a page; results are incomplete.');
      seen.add(current.href);
      const data = await this.get(current.pathname.slice(3) + current.search);
      const values = key === 'grades' ? data.grades?.grade : data[key];
      out.push(...array(values));
      const nextValue = data.links?.next;
      if (!nextValue) return out;
      if (typeof nextValue !== 'string') throw new Error('Schoology pagination format is unsupported.');
      const next = new URL(nextValue, current);
      // Schoology may return documented http links; upgrade only the exact API host.
      if (next.protocol === 'http:' && next.hostname === 'api.schoology.com' && !next.port) next.protocol = 'https:';
      if (next.origin !== start.origin || next.pathname !== start.pathname || next.username || next.password || next.hash) throw new Error('Schoology pagination left the requested resource.');
      for (const [k,v] of start.searchParams) {
        if (!['start','limit','offset','page'].includes(k) && next.searchParams.get(k) !== v) throw new Error('Schoology pagination changed the requested filters.');
      }
      current = next;
    }
    throw new Error('Schoology pagination exceeded the limit; results are incomplete.');
  }
  async connection() {
    const u = await this.get('/users/me');
    return { user_id: String(u.id ?? u.uid ?? ''), name: clean(u.name_display || `${u.name_first ?? ''} ${u.name_last ?? ''}`), mode: 'read_only', allowed_section_ids: this.sections };
  }
  async listSections() {
    const result = [];
    for (const id of this.sections) {
      const s = await this.get(`/sections/${id}`);
      result.push({ section_id: id, course_title: clean(s.course_title), section_title: clean(s.section_title), section_code: clean(s.section_code) });
    }
    return { sections: result };
  }
  async roster(id) {
    this.section(id);
    const rows = await this.collection(`/sections/${id}/enrollments?type=member&enrollment_status=1&limit=200`, 'enrollment');
    return { section_id: id, students: rows.filter(r => String(r.admin ?? 0) !== '1' && (!r.status || String(r.status) === '1')).map(r => ({
      enrollment_id: String(r.id), user_id: String(r.uid ?? ''),
      name: clean(r.name_display) || clean(`${r.name_first ?? ''} ${r.name_last ?? ''}`) || clean(r.name),
      first_name: clean(r.name_first_preferred || r.name_first), last_name: clean(r.name_last)
    })) };
  }
  async assignments(id) {
    this.section(id);
    const rows = await this.collection(`/sections/${id}/assignments?limit=200`, 'assignment');
    return { section_id: id, assignments: rows.map(r => ({ assignment_id: String(r.id), title: clean(r.title), due: r.due ?? null,
      max_points: r.max_points ?? null, grading_category: r.grading_category ?? null, grading_period: r.grading_period ?? null })) };
  }
  async grades(id, assignment) {
    this.section(id);
    if (typeof assignment !== 'string' || !/^\d+$/.test(assignment)) throw new Error('A numeric assignment ID is required.');
    const rows = await this.collection(`/sections/${id}/grades?assignment_id=${assignment}&limit=200`, 'grades');
    return { section_id: id, assignment_id: assignment, grades: rows.map(r => ({
      enrollment_id: String(r.enrollment_id), assignment_id: String(r.assignment_id), grade: r.grade ?? null,
      exception: r.exception ?? 0, max_points: r.max_points ?? null
    })).filter(r => r.assignment_id === assignment) };
  }
}
