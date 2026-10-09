// garden Edge Function — backend for Zana Little Garden, the customer gift game hosted as a
// static site on Netlify (site/). Deployed to the ZANA DYNASTY COS (ERP)
// Supabase project with verify_jwt = false: the page is public, so it must not ship the anon
// key (most ERP tables have RLS off). Players authenticate with a random token issued at
// registration (only its SHA-256 is stored); staff authenticate with a PIN whose SHA-256 is
// in garden_config.staff_pin_hash. Tables are RLS-on with no policies — only this
// function (service role) touches them.
//
// A new phone number registers only with an access code (garden_access_codes) handed out with a
// purchase; the code carries the sales channel. Players already registered sign back in with
// their phone alone.
//
// POST { action: 'register' | 'sync' | 'claim' | 'staff', ... }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const CHANNELS = ['shopee', 'lazada', 'tiktok', 'line', 'facebook', 'store', 'other'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
  consent_marketing: boolean;
  level: number;
  harvested: number;
  play_seconds: number;
  created_at: string;
  last_seen_at: string;
};
type Milestone = { level: number; label: string; min_minutes: number; valid_days: number };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function newAccessCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return 'KF-' + [...b].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}
function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const s = [...b].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
  return `ZG-${s.slice(0, 4)}-${s.slice(4)}`;
}
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

async function milestones(): Promise<Milestone[]> {
  const { data } = await db.from('garden_milestones').select('level, label, min_minutes, valid_days').order('level');
  return data ?? [];
}

async function snapshot(p: Player) {
  const [ms, { data: rewards }] = await Promise.all([
    milestones(),
    db.from('garden_rewards').select('milestone, code, discount_label, expires_at, redeemed_at').eq('player_id', p.id)
  ]);
  const created = new Date(p.created_at).getTime();
  return {
    player: { name: p.display_name, level: p.level },
    milestones: ms.map((m) => {
      const r = (rewards ?? []).find((x) => x.milestone === m.level);
      return {
        level: m.level,
        label: m.label,
        unlockAt: new Date(created + m.min_minutes * 60_000).toISOString(),
        reward: r ? { code: r.code, label: r.discount_label, expiresAt: r.expires_at, redeemedAt: r.redeemed_at } : null
      };
    })
  };
}

async function auth(token: unknown): Promise<Player | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const { data } = await db.from('garden_players').select('*').eq('token_hash', await sha256(token)).maybeSingle();
  return data ?? null;
}

async function register(b: any) {
  const name = String(b.name ?? '').trim().slice(0, 60);
  if (!name) return fail('กรุณากรอกชื่อ');
  const phone = normalizeThaiPhone(String(b.phone ?? ''));
  if (!phone) return fail('เบอร์มือถือไม่ถูกต้อง กรอก 10 หลัก เช่น 0812345678');
  const line = String(b.line ?? '').trim().slice(0, 40) || null;
  const accessCode = String(b.accessCode ?? '').trim().toUpperCase().slice(0, 40);
  if (b.consentTerms !== true) return fail('กรุณายอมรับเงื่อนไขการใช้ข้อมูลก่อนเริ่มเล่น');

  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const { data: existing } = await db.from('garden_players').select('*').eq('phone', phone).maybeSingle();

  let player: Player | null;
  if (existing) {
    // Same phone on a new device: rotate the token and keep progress and coupons.
    const { data, error } = await db
      .from('garden_players')
      .update({ token_hash: tokenHash, display_name: name, line_id: line ?? existing.line_id, consent_marketing: existing.consent_marketing || b.consentMarketing === true, last_seen_at: now })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) return fail('บันทึกข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง', 500);
    player = data;
  } else {
    if (!accessCode) return fail('กรอกรหัสเข้าใช้งานที่ได้รับจากร้าน (อยู่บนการ์ดในกล่องหรือในแชท)', 403, { needCode: true });
    const { data: channel } = await db.rpc('garden_use_access_code', { p_code: accessCode });
    if (!channel) {
      await new Promise((r) => setTimeout(r, 600));
      return fail('รหัสเข้าใช้งานไม่ถูกต้อง หรือถูกใช้ครบแล้ว ตรวจตัวอักษรอีกครั้ง', 403, { needCode: true });
    }
    const { data, error } = await db
      .from('garden_players')
      .insert({ token_hash: tokenHash, display_name: name, phone, line_id: line, channel: CHANNELS.includes(channel) ? channel : 'other', access_code: accessCode, consent_terms_at: now, consent_marketing: b.consentMarketing === true })
      .select('*')
      .single();
    if (error) return fail('บันทึกข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง', 500);
    player = data;
  }
  return json({ token, returning: !!existing, ...(await snapshot(player!)) });
}

async function applyProgress(p: Player, b: any): Promise<Player> {
  const { data } = await db
    .from('garden_players')
    .update({
      level: Math.max(p.level, clampInt(b.level, 1, 99)),
      harvested: Math.max(p.harvested, clampInt(b.harvested, 0, 1_000_000)),
      play_seconds: Math.max(p.play_seconds, clampInt(b.playSeconds, 0, 10_000_000)),
      last_seen_at: new Date().toISOString()
    })
    .eq('id', p.id)
    .select('*')
    .single();
  return data ?? p;
}

async function sync(b: any) {
  const p = await auth(b.token);
  if (!p) return fail('ไม่พบผู้เล่น กรุณาลงทะเบียนใหม่', 401);
  return json(await snapshot(await applyProgress(p, b)));
}

async function claim(b: any) {
  let p = await auth(b.token);
  if (!p) return fail('ไม่พบผู้เล่น กรุณาลงทะเบียนใหม่', 401);
  p = await applyProgress(p, b);
  const m = (await milestones()).find((x) => x.level === Number(b.milestone));
  if (!m) return fail('ไม่พบรางวัลนี้');
  if (p.level < m.level) return fail(`ต้องถึงเลเวล ${m.level} ก่อน`, 409);
  const waitMs = new Date(p.created_at).getTime() + m.min_minutes * 60_000 - Date.now();
  if (waitMs > 0) return fail('ยังรับคูปองไม่ได้', 409, { waitMinutes: Math.ceil(waitMs / 60_000) });

  const { data: existing } = await db.from('garden_rewards').select('id').eq('player_id', p.id).eq('milestone', m.level).maybeSingle();
  if (!existing) {
    const expires = new Date(Date.now() + m.valid_days * 86_400_000).toISOString();
    for (let attempt = 0; attempt < 4; attempt++) {
      const { error } = await db.from('garden_rewards').insert({ player_id: p.id, milestone: m.level, code: newCode(), discount_label: m.label, expires_at: expires });
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
    await new Promise((r) => setTimeout(r, 800));
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
    const channel = CHANNELS.includes(b.channel) ? b.channel : 'other';
    const count = clampInt(b.count, 1, 500);
    const maxUses = clampInt(b.maxUses, 1, 100_000);
    const batch = String(b.batch ?? '').trim().slice(0, 60) || null;
    const codes: string[] = [];
    while (codes.length < count) {
      const chunk = Array.from({ length: Math.min(200, count - codes.length) }, newAccessCode);
      const { data, error } = await db
        .from('garden_access_codes')
        .upsert(chunk.map((code) => ({ code, channel, batch, max_uses: maxUses })), { onConflict: 'code', ignoreDuplicates: true })
        .select('code');
      if (error) return fail('สร้างรหัสไม่สำเร็จ ลองใหม่อีกครั้ง', 500);
      codes.push(...(data ?? []).map((r) => r.code));
    }
    return json({ ok: true, codes, channel, maxUses, batch });
  }

  // op 'summary' (default): everything the staff page shows.
  const [{ data: players }, { data: rewards }, ms] = await Promise.all([
    db.from('garden_players').select('id, display_name, phone, line_id, channel, consent_marketing, level, harvested, play_seconds, created_at, last_seen_at').order('created_at', { ascending: false }).limit(2000),
    db.from('garden_rewards').select('player_id, milestone, code, discount_label, expires_at, created_at, redeemed_at').order('created_at', { ascending: false }).limit(5000),
    milestones()
  ]);
  const { data: accessCodes } = await db.from('garden_access_codes').select('code, channel, batch, max_uses, uses, created_at, last_used_at').order('created_at', { ascending: false }).limit(5000);
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
    if (text.length > 4000) return fail('ข้อมูลยาวเกินไป', 413);
    body = JSON.parse(text);
  } catch {
    return fail('ข้อมูลไม่ถูกต้อง');
  }
  try {
    switch (body?.action) {
      case 'register': return await register(body);
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
