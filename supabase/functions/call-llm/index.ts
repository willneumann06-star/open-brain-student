// ============================================================================
// CALL-LLM — the one and only door your agents use to talk to an AI
// ============================================================================
// To switch providers, change LLM_PROVIDER in Supabase secrets. Add the new
// provider's API key. No other code changes needed.
//
//   LLM_PROVIDER = anthropic   → uses ANTHROPIC_API_KEY (+ ANTHROPIC_WORKSPACE_ID if
//                                the key is organisation-wide)
//   LLM_PROVIDER = openai      → uses OPENAI_API_KEY (and optional LLM_BASE_URL,
//                                which also covers any OpenAI-compatible
//                                service: Groq, Together, a local model…)
//   LLM_MODEL    = the model name for that provider
//
// Every agent (enrich-thought, weekly-digest, anything you build later) calls
// THIS function instead of calling an AI directly. Nothing else in your
// project knows which AI you use, or holds its key.
//
// DEPLOY WITH:  npx supabase functions deploy call-llm --no-verify-jwt
// Only your own functions may call this — it checks for your project's
// service role key, which only your functions hold. Without that check,
// anyone who found the address could spend your AI credit.
//
// RECEIPTS: after every successful call it writes a row to llm_usage (tokens
// + estimated cost). That write is fire-and-forget: if it fails, the AI call
// still succeeds. A failed receipt must never break a real save.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const PROVIDER = (Deno.env.get('LLM_PROVIDER') ?? 'anthropic').trim().toLowerCase()
const DEFAULT_MODEL = (Deno.env.get('LLM_MODEL') ?? '').trim()

// US$ per million tokens [input, output]. Used only for the receipt estimate.
// Prices change — check your provider's pricing page and update if needed.
// A model not listed here is logged with cost 0 (tokens are still recorded).
const PRICES: Array<[prefix: string, input: number, output: number]> = [
  ['claude-haiku-4-5', 1, 5],
]

function estimateCost(model: string, inTok: number, outTok: number): number {
  const p = PRICES.find(([prefix]) => model.startsWith(prefix))
  return p ? (inTok * p[1] + outTok * p[2]) / 1_000_000 : 0
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

type Req = { prompt: string; systemPrompt?: string; model: string; maxTokens: number }
type Res = { text: string; inTok: number; outTok: number }

// ── Providers ───────────────────────────────────────────────────────────────
async function callAnthropic(r: Req): Promise<Res> {
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  if (!key) throw new Error('ANTHROPIC_API_KEY secret is missing')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // Needed only when the key is organisation-wide rather than tied to one
      // workspace. Set ANTHROPIC_WORKSPACE_ID in secrets (Console → Workspaces).
      ...(Deno.env.get('ANTHROPIC_WORKSPACE_ID') ? { 'anthropic-workspace-id': Deno.env.get('ANTHROPIC_WORKSPACE_ID')!.trim() } : {}),
    },
    body: JSON.stringify({
      model: r.model,
      max_tokens: r.maxTokens,
      ...(r.systemPrompt ? { system: r.systemPrompt } : {}),
      messages: [{ role: 'user', content: r.prompt }],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const d = await res.json()
  const text = (d.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
  return { text, inTok: d.usage?.input_tokens ?? 0, outTok: d.usage?.output_tokens ?? 0 }
}

async function callOpenAICompatible(r: Req): Promise<Res> {
  const key = Deno.env.get('OPENAI_API_KEY') ?? ''
  if (!key) throw new Error('OPENAI_API_KEY secret is missing')
  const base = (Deno.env.get('LLM_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: r.model,
      max_tokens: r.maxTokens,
      messages: [
        ...(r.systemPrompt ? [{ role: 'system', content: r.systemPrompt }] : []),
        { role: 'user', content: r.prompt },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`${base} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const d = await res.json()
  return { text: d.choices?.[0]?.message?.content ?? '', inTok: d.usage?.prompt_tokens ?? 0, outTok: d.usage?.completion_tokens ?? 0 }
}

const PROVIDERS: Record<string, (r: Req) => Promise<Res>> = {
  anthropic: callAnthropic,
  openai: callOpenAICompatible,
}

// ── Receipt (never allowed to fail the call) ────────────────────────────────
function logUsage(row: Record<string, unknown>) {
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const p = Promise.resolve(admin.from('llm_usage').insert(row))
      .then(({ error }) => { if (error) console.warn('[call-llm] receipt not saved:', error.message) })
      .catch(e => console.warn('[call-llm] receipt not saved:', String(e)))
    // Let the receipt finish after we've already replied, if the runtime allows
    // deno-lint-ignore no-explicit-any
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(p) } catch { /* fine */ }
  } catch (e) {
    console.warn('[call-llm] receipt not saved:', String(e))
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!sameSecret(bearer, SERVICE_ROLE_KEY)) return json({ error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => null)
  const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
  if (!prompt.trim()) return json({ error: 'prompt is required' }, 400)

  const model = String(body?.model || DEFAULT_MODEL).trim()
  if (!model) return json({ error: 'No model set — add LLM_MODEL to your Supabase secrets' }, 500)

  const call = PROVIDERS[PROVIDER]
  if (!call) return json({ error: `Unknown LLM_PROVIDER "${PROVIDER}". Use one of: ${Object.keys(PROVIDERS).join(', ')}` }, 500)

  const maxTokens = Math.min(Math.max(Math.floor(Number(body?.maxTokens) || 1024), 1), 8192)

  try {
    const r = await call({ prompt, systemPrompt: body?.systemPrompt, model, maxTokens })
    if (typeof body?.userId === 'string' && body.userId) {
      logUsage({
        user_id: body.userId,
        kind: 'chat',
        model,
        source: typeof body?.source === 'string' ? body.source : null,
        prompt_tokens: r.inTok,
        completion_tokens: r.outTok,
        cost_usd: estimateCost(model, r.inTok, r.outTok),
      })
    }
    return json({ text: r.text, model, usage: { input_tokens: r.inTok, output_tokens: r.outTok } })
  } catch (err) {
    console.error('[call-llm] failed:', String(err))
    return json({ error: String(err instanceof Error ? err.message : err) }, 502)
  }
})
