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
// BOTS: a caller may also ask for {"provider": "xai", "search": true} — Grok
// with live web + X search, for the news watcher. Uses XAI_API_KEY (and
// optional XAI_MODEL, default grok-4.7). Only public topics should ever be
// sent this way; anything personal stays on LLM_PROVIDER.
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
  ['grok-4', 2, 6],
]
// Grok's search tools are billed on top of tokens (US$, per item)
const XAI_WEB_SEARCH_PER_CALL = 0.005
const XAI_X_POST_PER_POST = 0.005

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

type Req = { prompt: string; systemPrompt?: string; model: string; maxTokens: number; search?: boolean; searchDays?: number }
type Res = { text: string; inTok: number; outTok: number; toolCost?: number; sources?: string[] }

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

// Grok via xAI's Responses API. With search on, Grok can run live web and X
// searches itself (server-side) before answering.
async function callXai(r: Req): Promise<Res> {
  const key = (Deno.env.get('XAI_API_KEY') ?? '').trim()
  if (!key) throw new Error('XAI_API_KEY secret is missing')
  const days = Math.min(Math.max(Math.floor(r.searchDays ?? 7), 1), 30)
  const fromDate = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: r.model,
      input: [
        ...(r.systemPrompt ? [{ role: 'system', content: r.systemPrompt }] : []),
        { role: 'user', content: r.prompt },
      ],
      max_output_tokens: r.maxTokens,
      ...(r.search ? { tools: [{ type: 'web_search' }, { type: 'x_search', from_date: fromDate }], max_turns: 6 } : {}),
    }),
    signal: AbortSignal.timeout(140_000),
  })
  if (!res.ok) throw new Error(`xAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const d = await res.json()
  // The answer is the output_text block(s) inside the 'message' item of output[]
  const text = (d.output ?? [])
    .filter((o: { type: string }) => o.type === 'message')
    .flatMap((o: { content?: { type: string; text?: string }[] }) => o.content ?? [])
    .filter((c: { type: string }) => c.type === 'output_text')
    .map((c: { text?: string }) => c.text ?? '').join('')
  const tools = d.usage?.server_side_tool_usage_details ?? {}
  const toolCost = Number(tools.web_search_calls ?? 0) * XAI_WEB_SEARCH_PER_CALL + Number(tools.x_posts_fetched ?? 0) * XAI_X_POST_PER_POST
  return {
    text,
    inTok: d.usage?.input_tokens ?? 0,
    outTok: d.usage?.output_tokens ?? 0,
    toolCost,
    sources: Array.isArray(d.citations) ? d.citations.filter((u: unknown) => typeof u === 'string') : [],
  }
}

const PROVIDERS: Record<string, (r: Req) => Promise<Res>> = {
  anthropic: callAnthropic,
  openai: callOpenAICompatible,
  xai: callXai,
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

  // A caller may pick a provider for one call (the news bot asks for xai);
  // otherwise the project-wide LLM_PROVIDER is used
  const provider = typeof body?.provider === 'string' && body.provider ? body.provider.trim().toLowerCase() : PROVIDER
  const model = String(body?.model || (provider === PROVIDER ? DEFAULT_MODEL : provider === 'xai' ? (Deno.env.get('XAI_MODEL') ?? 'grok-4.7').trim() : '')).trim()
  if (!model) return json({ error: 'No model set — add LLM_MODEL to your Supabase secrets' }, 500)

  const call = PROVIDERS[provider]
  if (!call) return json({ error: `Unknown provider "${provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}` }, 500)

  const maxTokens = Math.min(Math.max(Math.floor(Number(body?.maxTokens) || 1024), 1), 8192)

  try {
    const r = await call({ prompt, systemPrompt: body?.systemPrompt, model, maxTokens, search: body?.search === true, searchDays: Number(body?.searchDays) || undefined })
    if (typeof body?.userId === 'string' && body.userId) {
      logUsage({
        user_id: body.userId,
        kind: 'chat',
        model,
        source: typeof body?.source === 'string' ? body.source : null,
        prompt_tokens: r.inTok,
        completion_tokens: r.outTok,
        cost_usd: estimateCost(model, r.inTok, r.outTok) + (r.toolCost ?? 0),
      })
    }
    return json({ text: r.text, model, sources: r.sources ?? [], usage: { input_tokens: r.inTok, output_tokens: r.outTok } })
  } catch (err) {
    console.error('[call-llm] failed:', String(err))
    return json({ error: String(err instanceof Error ? err.message : err) }, 502)
  }
})
