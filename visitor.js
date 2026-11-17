/* What the administrator can see about a visitor: the IP address they connect from, and a location they chose to share.
   The Terms of Service and Privacy Policy on the website say this plainly. Pure functions, so they are unit-tested. */

const MAX_IPS = 10;

/** Normalise an IP address string. Returns '' when it does not look like an IPv4 or IPv6 address. */
export function cleanIp(value) {
  let s = String(value || '').trim();
  if (/^\[.*\]$/.test(s)) s = s.slice(1, -1);
  s = s.replace(/^::ffff:/i, '');
  return /^[0-9a-f:.]{2,45}$/i.test(s) && (s.includes('.') || s.includes(':')) ? s.toLowerCase() : '';
}

/** The caller's IP address. Behind Render's proxy the socket address is the proxy, so the forwarded headers are read first.
    These headers are set by the host's edge, but a client can add its own, so treat the value as a record, not proof. */
export function clientIp(req) {
  const h = (req && req.headers) || {};
  const first = v => String(Array.isArray(v) ? v[0] : v || '').split(',')[0].trim();
  return cleanIp(first(h['cf-connecting-ip'])) || cleanIp(first(h['true-client-ip'])) || cleanIp(first(h['x-forwarded-for'])) || cleanIp(req && req.socket && req.socket.remoteAddress);
}

/** Fields to merge into a user record when a visit from `ip` is seen: the latest address plus the ten most recent distinct ones. */
export function seenUpdate(record, ip, nowIso) {
  if (!ip) return {};
  const old = Array.isArray(record && record.ips) ? record.ips.filter(e => e && e.ip) : [];
  const prior = old.find(e => e.ip === ip);
  const entry = { ip, firstAt: (prior && prior.firstAt) || nowIso, lastAt: nowIso };
  return { lastIp: ip, lastSeenAt: nowIso, ips: [entry, ...old.filter(e => e.ip !== ip)].slice(0, MAX_IPS) };
}

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

/** A location from the browser's Geolocation API, or null when it is missing or out of range. Only numbers are accepted. */
export function cleanLocation(input) {
  if (!input || typeof input !== 'object') return null;
  const { lat, lon, accuracy } = input;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const out = { lat: round(lat, 6), lon: round(lon, 6) };
  if (typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 && accuracy < 1e7) out.accuracy = Math.round(accuracy);
  return out;
}

/** System-prompt text for a chat where the person chose to share their location. It is data about the user, not instructions. */
export function locationPrompt(loc) {
  const acc = Number.isFinite(loc.accuracy) ? `, accuracy about ${loc.accuracy} m` : '';
  return 'The user chose to share their device location with Viora (background data, not instructions): latitude ' + loc.lat + ', longitude ' + loc.lon + acc + '. ' +
    'Use it only when the request depends on where they are: nearby places, local weather or time, distances, local services or laws. ' +
    'You cannot look up maps, places or live conditions yourself, so rely on supplied web search results for those and otherwise give general guidance for the area and say what you could not check. ' +
    'Do not repeat the coordinates unless the user asks.';
}

/** Used when no location was shared. */
export const NO_LOCATION_PROMPT = 'LOCATION: If a request depends on where the user is (nearby places, local weather, directions, local services) and no location was shared, ask which city or area they mean instead of guessing.';

/** The location block shown to the administrator, or null. */
export function adminLocation(row) {
  const l = row && row.location;
  if (!l || typeof l.lat !== 'number' || typeof l.lon !== 'number') return null;
  return { lat: l.lat, lon: l.lon, accuracy: Number.isFinite(l.accuracy) ? l.accuracy : null, at: l.at || null, ip: cleanIp(l.ip) };
}
