// garden Edge Function — backend for KidFarm (Zana Little Garden), the customer gift game hosted as a
// static site on Netlify (site/). Deployed to the ZANA DYNASTY COS (ERP) Supabase project with
// verify_jwt = false: the page is public, so it must not ship the anon key (most ERP tables have RLS
// off). garden_* tables are RLS-on with no policies — only this function (service role) touches them.
//
// Accounts work like an online game:
//   1. redeem  — a new customer enters an access code (handed out with a purchase) + name/phone/consent.
//                The code carries the sales channel and the account role (player / gm / tester).
//   2. setup   — straight after, they must choose their own USER ID + password (also used after an
//                admin password reset, when must_change_password is set).
//   3. login   — USER ID + password on any device; returns a per-device session token + the cloud save.
// Passwords are PBKDF2-SHA256 hashed; plaintext is never stored, so admins reset (staff op 'resetpw')
// instead of reading them. Sessions are random tokens; only their SHA-256 is stored (garden_sessions).
//
// POST { action: 'redeem' | 'setup' | 'login' | 'password' | 'logout' | 'sync' | 'claim' | 'staff', ... }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const CHANNELS = ['shopee', 'lazada', 'tiktok', 'line', 'facebook', 'store', 'other'];
const ROLES = ['player', 'gm', 'tester'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PBKDF2_ITER = 100_000;
const MAX_BODY = 120_000;
const MAX_SAVE = 100_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info'
};

type Player = {
  id: string;
  display_name: string;
  phone: string;
  line_id: string | null;
  channel: string;
  role: string;
  username: string | null;
  password_hash: string | null;
  must_change_password: boolean;
  consent_marketing: boolean;
  level: number;
  harvested: number;
  play_seconds: number;
  save_data: unknown;
  save_at: string | null;
  failed_logins: number;
  locked_until: string | null;
  created_at: string;
  last_seen_at: string;
};
type Milestone = { level: number; label: string; min_minutes: number; valid_days: number };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function pbkdf2(password: string, salt: Uint8Array, iter: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}
async function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [kind, iter, salt, hash] = stored.split('$');
  if (kind !== 'pbkdf2') return false;
  const got = await pbkdf2(password, unb64(salt), Number(iter));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
function randomToken() {
  return b64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomChars = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
const newAccessCode = (role: string) => (role === 'gm' ? 'KF-GM' : role === 'tester' ? 'KF-QA' : 'KF-') + randomChars(6);
const newCouponCode = () => { const s = randomChars(8); return `ZG-${s.slice(0, 4)}-${s.slice(4)}`; };
const tempPassword = () => randomChars(4) + '-' + randomChars(4);
const clampInt = (v: unknown, lo: number, hi: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
function normalizeThaiPhone(raw: string): string | null {
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+66')) d = '0' + d.slice(3);
  else if (d.startsWith('66') && d.length === 11) d = '0' + d.slice(2);
  return /^0[689]\d{8}$/.test(d) ? d : null;
}
const USERNAME_RE = /^[a-zA-Z0-9_.]{4,20}$/;

async function milestones(): Promise<Milestone[]> {
  const { data } = await db.from('garden_milestones').select('level, label, min_minutes, valid_days').order('level');
  return data ?? [];
}

async function snapshot(p: Player, withSave = false) {
  const [ms, { data: rewards }] = await Promise.all([
    milestones(),
    db.from('garden_rewards').select('milestone, code, discount_label, expires_at, redeemed_at, is_test').eq('player_id', p.id)
  ]);
  const created = new Date(p.created_at).getTime();
  const team = p.role !== 'player';
  return {
    player: { name: p.display_name, level: p.level, username: p.username, role: p.role },
    needSetup: !p.username || !p.password_hash || p.must_change_password,
    ...(withSave ? { save: p.save_data ?? null, saveAt: p.save_at } : {}),
    milestones: ms.map((m) => {
      const r = (rewards ?? []).find((x) => x.milestone === m.level);
      return {
        level: m.level,
        label: m.label,
        unlockAt: new Date(team ? created : created + m.min_minutes * 60_000).toISOString(),
        reward: r ? { code: r.code, label: r.discount_label, expiresAt: r.expires_at, redeemedAt: r.redeemed_at, test: r.is_test } : null
      };
    })
  };
}

async function newSession(playerId: string) {
  const token = randomToken();
  await db.from('garden_sessions').insert({ token_hash: await sha256(token), player_id: playerId });
  return token;
}

async function auth(token: unknown): Promise<Player | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const h = await sha256(token);
  const { data: s } = await db.from('garden_sessions').select('player_id').eq('token_hash', h).maybeSingle();
  if (s) {
    db.from('garden_sessions').update({ last_seen_at: new Date().toISOString() }).eq('token_hash', h).then(() => {});
    const { data } = await db.from('garden_players').select('*').eq('id', s.player_id).maybeSingle();
    return data ?? null;
  }
  // Players registered before sessions existed kept their token on the player row.
  const { data } = await db.from('garden_players').select('*').eq('token_hash', h).maybeSingle();
  return data ?? null;
}

// Step 1: first visit with an access code from the store.
async function redeem(b: any) {
  const name = String(b.name ?? '').trim().slice(0, 60);
  if (!name) return fail('กรุณากรอกชื่อเล่น');
  const phone = normalizeThaiPhone(String(b.phone ?? ''));
  if (!phone) return fail('เบอร์มือถือไม่ถูกต้อง กรอก 10 หลัก เช่น 0812345678');
  const line = String(b.line ?? '').trim().slice(0, 40) || null;
  const accessCode = String(b.accessCode ?? '').trim().toUpperCase().slice(0, 40);
  if (b.consentTerms !== true) return fail('กรุณายอมรับเงื่อนไขการใช้ข้อมูลก่อนเริ่มเล่น');
  if (!accessCode) return fail('กรอกรหัสเข้าใช้งานที่ได้รับจากร้าน (อยู่บนการ์ดในกล่องหรือในแชท)', 403, { needCode: true });

  const { data: existing } = await db.from('garden_players').select('id, username').eq('phone', phone).maybeSingle();
  if (existing?.username) {
    return fail(`เบอร์นี้มีบัญชีแล้ว (USER ID: ${existing.username}) เข้าสู่ระบบด้วย USER ID และรหัสผ่าน หรือแจ้งแอดมินถ้าลืมรหัส`, 409, { hasAccount: true });
  }
  const { data: channel } = await db.rpc('garden_use_access_code', { p_code: accessCode });
  if (!channel) {
    await sleep(600);
    return fail('รหัสเข้าใช้งานไม่ถูกต้อง หรือถูกใช้ครบแล้ว ตรวจตัวอักษรอีกครั้ง', 403, { needCode: true });
  }
  const { data: codeRow } = await db.from('garden_access_codes').select('role').eq('code', accessCode).maybeSingle();
  const role = ROLES.includes(codeRow?.role) ? codeRow!.role : 'player';
  const now = new Date().toISOString();
  const fields = {
    display_name: name, line_id: line, role, access_code: accessCode,
    consent_terms_at: now, consent_marketing: b.consentMarketing === true, last_seen_at: now
  };
  // A phone that registered earlier but never finished choosing a USER ID continues that same record.
  const q = existing
    ? db.from('garden_players').update(fields).eq('id', existing.id)
    : db.from('garden_players').insert({ ...fields, phone, channel: CHANNELS.includes(channel) ? channel : 'other', token_hash: await sha256(randomToken()) });
  const { data: player, error } = await q.select('*').single();
  if (error || !player) return fail('บันทึกข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง', 500);
  return json({ token: await newSession(player.id), ...(await snapshot(player)) });
}

// Step 2: choose USER ID + password (first time), or a new password after an admin reset.
async function setup(b: any) {
  const p = await auth(b.token);
  if (!p) return fail('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  const password = String(b.password ?? '');
  if (password.length < 6 || password.length > 64) return fail('รหัสผ่านต้องยาว 6–64 ตัวอักษร');
  const update: Record<string, unknown> = { password_hash: await hashPassword(password), must_change_password: false, failed_logins: 0, locked_until: null };
  if (!p.username) {
    const username = String(b.username ?? '').trim();
    if (!USERNAME_RE.test(username)) return fail('USER ID ใช้ได้ 4–20 ตัว: a-z, 0-9, _ หรือ . (ห้ามเว้นวรรค ห้ามภาษาไทย)');
    const { data: taken } = await db.from('garden_players').select('id').ilike('username', username).maybeSingle();
    if (taken) return fail('USER ID นี้มีคนใช้แล้ว ลองชื่ออื่น', 409);
    update.username = username;
  } else if (!p.must_change_password && p.password_hash) {
    return fail('บัญชีนี้ตั้งค่าเรียบร้อยแล้ว', 409);
  }
  const { data, error } = await db.from('garden_players').update(update).eq('id', p.id).select('*').single();
  if (error) return fail(error.code === '23505' ? 'USER ID นี้มีคนใช้แล้ว ลองชื่ออื่น' : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง', error.code === '23505' ? 409 : 500);
  return json(await snapshot(data));
}

async function login(b: any) {
  const username = String(b.username ?? '').trim();
  const password = String(b.password ?? '');
  if (!username || !password) return fail('กรอก USER ID และรหัสผ่าน');
  const { data: p } = await db.from('garden_players').select('*').ilike('username', username).maybeSingle();
  if (!p) { await sleep(700); return fail('USER ID หรือรหัสผ่านไม่ถูกต้อง', 401); }
  if (p.locked_until && new Date(p.locked_until).getTime() > Date.now()) {
    return fail('ใส่รหัสผิดหลายครั้ง บัญชีถูกพักชั่วคราว ลองใหม่ในอีก 5 นาที หรือแจ้งแอดมิน', 423);
  }
  if (!(await verifyPassword(password, p.password_hash))) {
    const n = p.failed_logins + 1;
    await db.from('garden_players').update({ failed_logins: n >= 5 ? 0 : n, locked_until: n >= 5 ? new Date(Date.now() + 5 * 60_000).toISOString() : null }).eq('id', p.id);
    await sleep(700);
    return fail('USER ID หรือรหัสผ่านไม่ถูกต้อง', 401);
  }
  const { data } = await db.from('garden_players').update({ failed_logins: 0, locked_until: null, last_seen_at: new Date().toISOString() }).eq('id', p.id).select('*').single();
  return json({ token: await newSession(p.id), ...(await snapshot(data ?? p, true)) });
}

async function changePassword(b: any) {
  const p = await auth(b.token);
  if (!p) return fail('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  if (!(await verifyPassword(String(b.oldPassword ?? ''), p.password_hash))) { await sleep(600); return fail('รหัสผ่านเดิมไม่ถูกต้อง', 403); }
  const np = String(b.newPassword ?? '');
  if (np.length < 6 || np.length > 64) return fail('รหัสผ่านใหม่ต้องยาว 6–64 ตัวอักษร');
  await db.from('garden_players').update({ password_hash: await hashPassword(np), must_change_password: false }).eq('id', p.id);
  return json({ ok: true });
}

async function logout(b: any) {
  if (typeof b.token === 'string') await db.from('garden_sessions').delete().eq('token_hash', await sha256(b.token));
  return json({ ok: true });
}

async function applyProgress(p: Player, b: any): Promise<Player> {
  const update: Record<string, unknown> = {
    level: Math.max(p.level, clampInt(b.level, 1, 99)),
    harvested: Math.max(p.harvested, clampInt(b.harvested, 0, 1_000_000)),
    play_seconds: Math.max(p.play_seconds, clampInt(b.playSeconds, 0, 10_000_000)),
    last_seen_at: new Date().toISOString()
  };
  if (b.save && typeof b.save === 'object') {
    const text = JSON.stringify(b.save);
    if (text.length <= MAX_SAVE) { update.save_data = b.save; update.save_at = new Date().toISOString(); }
  }
  const { data } = await db.from('garden_players').update(update).eq('id', p.id).select('*').single();
  return data ?? p;
}

async function sync(b: any) {
  const p = await auth(b.token);
  if (!p) return fail('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  return json(await snapshot(await applyProgress(p, b), b.wantSave === true));
}

async function claim(b: any) {
  let p = await auth(b.token);
  if (!p) return fail('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  p = await applyProgress(p, b);
  const m = (await milestones()).find((x) => x.level === Number(b.milestone));
  if (!m) return fail('ไม่พบรางวัลนี้');
  if (p.level < m.level) return fail(`ต้องถึงเลเวล ${m.level} ก่อน`, 409);
  const team = p.role !== 'player';
  const waitMs = new Date(p.created_at).getTime() + m.min_minutes * 60_000 - Date.now();
  if (!team && waitMs > 0) return fail('ยังรับคูปองไม่ได้', 409, { waitMinutes: Math.ceil(waitMs / 60_000) });

  const { data: existing } = await db.from('garden_rewards').select('id').eq('player_id', p.id).eq('milestone', m.level).maybeSingle();
  if (!existing) {
    const expires = new Date(Date.now() + m.valid_days * 86_400_000).toISOString();
    for (let attempt = 0; attempt < 4; attempt++) {
      const { error } = await db.from('garden_rewards').insert({
        player_id: p.id, milestone: m.level, code: newCouponCode(), expires_at: expires,
        discount_label: team ? `ทดสอบ · ${m.label}` : m.label, is_test: team
      });
      if (!error) break;
      // 23505 = unique violation: a concurrent claim for this milestone (return it) or a code collision (retry).
      if (error.code !== '23505') return fail('ออกคูปองไม่สำเร็จ ลองใหม่อีกครั้ง', 500);
      const { data: again } = await db.from('garden_rewards').select('id').eq('player_id', p.id).eq('milestone', m.level).maybeSingle();
      if (again) break;
    }
  }
  return json(await snapshot(p));
}

async function staff(b: any) {
  const pin = String(b.pin ?? '').trim().toUpperCase();
  const { data: cfg } = await db.from('garden_config').select('value').eq('key', 'staff_pin_hash').maybeSingle();
  if (!cfg || !pin || (await sha256(pin)) !== cfg.value) {
    await sleep(800);
    return fail('รหัสพนักงานไม่ถูกต้อง', 401);
  }

  if (b.op === 'redeem') {
    const code = String(b.code ?? '').trim().toUpperCase();
    const { data: r } = await db.from('garden_rewards').select('id, code, discount_label, expires_at, redeemed_at').eq('code', code).maybeSingle();
    if (!r) return fail(`ไม่พบคูปอง ${code}`, 404);
    if (r.redeemed_at) return fail(`คูปอง ${code} ถูกใช้ไปแล้วเมื่อ ${new Date(r.redeemed_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`, 409);
    if (new Date(r.expires_at).getTime() < Date.now()) return fail(`คูปอง ${code} หมดอายุแล้ว`, 409);
    const { data: upd } = await db
      .from('garden_rewards')
      .update({ redeemed_at: new Date().toISOString(), redeemed_note: String(b.note ?? '').slice(0, 120) || null })
      .eq('id', r.id)
      .is('redeemed_at', null)
      .select('id');
    if (!upd?.length) return fail('คูปองนี้เพิ่งถูกใช้ไป', 409);
    return json({ ok: true, message: `ใช้คูปอง ${code} (${r.discount_label}) เรียบร้อย` });
  }

  if (b.op === 'gencodes') {
    const role = ROLES.includes(b.role) ? b.role : 'player';
    const channel = role === 'player' && CHANNELS.includes(b.channel) ? b.channel : 'other';
    const count = clampInt(b.count, 1, 500);
    const maxUses = clampInt(b.maxUses, 1, 100_000);
    const batch = String(b.batch ?? '').trim().slice(0, 60) || null;
    const codes: string[] = [];
    while (codes.length < count) {
      const chunk = Array.from({ length: Math.min(200, count - codes.length) }, () => newAccessCode(role));
      const { data, error } = await db
        .from('garden_access_codes')
        .upsert(chunk.map((code) => ({ code, channel, batch, max_uses: maxUses, role })), { onConflict: 'code', ignoreDuplicates: true })
        .select('code');
      if (error) return fail('สร้างรหัสไม่สำเร็จ ลองใหม่อีกครั้ง', 500);
      codes.push(...(data ?? []).map((r) => r.code));
    }
    return json({ ok: true, codes, channel, maxUses, batch, role });
  }

  if (b.op === 'lookup' || b.op === 'resetpw') {
    const q = String(b.username ?? '').trim();
    if (!q) return fail('กรอก USER ID ที่ลูกค้าแจ้งมา');
    const { data: p } = await db.from('garden_players').select('id, username, display_name, phone, line_id, role, level, created_at, last_seen_at').ilike('username', q).maybeSingle();
    if (!p) return fail(`ไม่พบ USER ID "${q}"`, 404);
    const info = { ...p, phoneLast4: p.phone.slice(-4) };
    if (b.op === 'lookup') return json({ ok: true, player: info });
    const temp = tempPassword();
    await db.from('garden_players').update({ password_hash: await hashPassword(temp), must_change_password: true, failed_logins: 0, locked_until: null }).eq('id', p.id);
    await db.from('garden_sessions').delete().eq('player_id', p.id);
    return json({ ok: true, player: info, tempPassword: temp });
  }

  // op 'summary' (default): everything the staff page shows.
  const [{ data: players }, { data: rewards }, ms, { data: accessCodes }] = await Promise.all([
    db.from('garden_players').select('id, username, display_name, phone, line_id, channel, role, consent_marketing, level, harvested, play_seconds, created_at, last_seen_at').order('created_at', { ascending: false }).limit(2000),
    db.from('garden_rewards').select('player_id, milestone, code, discount_label, expires_at, created_at, redeemed_at, is_test').order('created_at', { ascending: false }).limit(5000),
    milestones(),
    db.from('garden_access_codes').select('code, channel, role, batch, max_uses, uses, created_at, last_used_at').order('created_at', { ascending: false }).limit(5000)
  ]);
  const phones = (players ?? []).map((p) => p.phone);
  const { data: matched } = phones.length ? await db.rpc('garden_matching_customers', { phones }) : { data: [] };
  const known = new Set((matched ?? []).map((m: { phone: string }) => m.phone));
  return json({
    milestones: ms,
    players: (players ?? []).map((p) => ({ ...p, is_customer: known.has(p.phone) })),
    rewards: rewards ?? [],
    accessCodes: accessCodes ?? []
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return fail('method not allowed', 405);
  let body: any;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return fail('ข้อมูลยาวเกินไป', 413);
    body = JSON.parse(text);
  } catch {
    return fail('ข้อมูลไม่ถูกต้อง');
  }
  try {
    switch (body?.action) {
      case 'redeem': return await redeem(body);
      case 'register': return await redeem(body); // older game builds
      case 'setup': return await setup(body);
      case 'login': return await login(body);
      case 'password': return await changePassword(body);
      case 'logout': return await logout(body);
      case 'sync': return await sync(body);
      case 'claim': return await claim(body);
      case 'staff': return await staff(body);
      default: return fail('unknown action');
    }
  } catch (e) {
    console.error(e);
    return fail('ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้ง', 500);
  }
});
