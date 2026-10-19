// ============================================================================
// GENERATE-EMBEDDING — turns text into 1,536 numbers that describe its meaning
// ============================================================================
// Same gateway idea as call-llm: this is the ONLY place in your project that
// knows which embedding provider you use or holds its key. enrich-thought
// (every new thought) and open-brain-mcp (every search) both come through here.
//
// To switch embedding providers, change the model string. The vector dimension
// must stay 1536 or you need a new migration.
//
// DEPLOY WITH:  npx supabase functions deploy generate-embedding --no-verify-jwt
// Only your own functions may call this — it checks for your project's service
// role key, which only your functions hold. Without that check, anyone who
// found the address could spend your OpenRouter credit.
//
// Never crashes the caller: on any failure it answers { embedding: null } and
// the reason, so a thought still saves and can be embedded later by backfill.
//
// Secrets it reads: OPENROUTER_API_KEY, plus the automatic SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const EMBED_MODEL = 'openai/text-embedding-3-small'
const DIMENSIONS = 1536
const PRICE_PER_MILLION_TOKENS = 0.02 // US$ — check openrouter.ai/models if it changes
// The model reads at most ~8,000 tokens (~30k characters). Longer text is cut,
// so a long transcript is embedded by its opening. Level 7 fixes that properly.
const MAX_INPUT_CHARS = 24_000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

// Receipt in llm_usage — fire-and-forget, never allowed to fail the call
function logUsage(row: Record<string, unknown>) {
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const p = Promise.resolve(admin.from('llm_usage').insert(row))
      .then(({ error }) => { if (error) console.warn('[embed] receipt not saved:', error.message) })
      .catch(e => console.warn('[embed] receipt not saved:', String(e)))
    // deno-lint-ignore no-explicit-any
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(p) } catch { /* fine */ }
  } catch (e) {
    console.warn('[embed] receipt not saved:', String(e))
  }
}

export async function embed(text: string): Promise<{ embedding: number[] | null; tokens: number; error?: string }> {
  const key = Deno.env.get('OPENROUTER_API_KEY') ?? ''
  if (!key) return { embedding: null, tokens: 0, error: 'OPENROUTER_API_KEY secret is missing' }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Open Brain' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, MAX_INPUT_CHARS) }),
      signal: AbortSignal.timeout(15_000),
    })
    const raw = await res.text()
    if (!res.ok) return { embedding: null, tokens: 0, error: `OpenRouter HTTP ${res.status}: ${raw.slice(0, 300)}` }
    const d = JSON.parse(raw)
    const v = d?.data?.[0]?.embedding
    if (!Array.isArray(v) || v.length !== DIMENSIONS || !v.every(n => typeof n === 'number')) {
      return { embedding: null, tokens: 0, error: `Unexpected reply (got ${Array.isArray(v) ? v.length : 'no'} numbers): ${raw.slice(0, 200)}` }
    }
    return { embedding: v, tokens: Number(d?.usage?.prompt_tokens ?? d?.usage?.total_tokens ?? 0) || 0 }
  } catch (err) {
    return { embedding: null, tokens: 0, error: String(err instanceof Error ? err.message : err) }
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ embedding: null, error: 'POST only' }, 405)

  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!sameSecret(bearer, SERVICE_ROLE_KEY)) return json({ embedding: null, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => null)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) return json({ embedding: null, error: 'text is required' })

  const r = await embed(text)
  if (!r.embedding) {
    console.error('[embed] failed:', r.error)
    return json({ embedding: null, error: r.error })
  }
  if (typeof body?.userId === 'string' && body.userId) {
    logUsage({
      user_id: body.userId,
      kind: 'embedding',
      model: EMBED_MODEL,
      source: typeof body?.source === 'string' ? body.source : null,
      prompt_tokens: r.tokens,
      completion_tokens: 0,
      cost_usd: (r.tokens * PRICE_PER_MILLION_TOKENS) / 1_000_000,
    })
  }
  return json({ embedding: r.embedding })
})
