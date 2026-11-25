const crypto = require('node:crypto');

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyInitData(initData, token, allowedUserIds, now = Date.now(), maxAgeMs = 10 * 60 * 1000) {
  if (!initData || !token) return null;
  let pairs;
  try { pairs = new URLSearchParams(initData); }
  catch { return null; }
  const receivedHash = pairs.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
  pairs.delete('hash');
  const checkString = [...pairs.entries()].map(([key, value]) => [key, value])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (!safeEqual(receivedHash.toLowerCase(), expected)) return null;
  const authDate = Number(pairs.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate * 1000 > now + 60_000 || now - authDate * 1000 > maxAgeMs) return null;
  let user;
  try { user = JSON.parse(pairs.get('user') || 'null'); } catch { return null; }
  if (!user?.id) return null;
  if (!allowedUserIds.size || !allowedUserIds.has(String(user.id))) return null;
  return { id: String(user.id), username: String(user.username || ''), firstName: String(user.first_name || '') };
}

function verifyServiceToken(header, serviceToken) {
  if (!serviceToken || !header?.startsWith('Bearer ')) return false;
  return safeEqual(header.slice(7), serviceToken);
}

module.exports = { verifyInitData, verifyServiceToken };
