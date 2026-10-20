// ============================================================================
// SEARCH-BRAIN — your web app's Search tab, upgraded to hybrid search
// ============================================================================
// The browser can't run hybrid search itself: it needs an embedding of the
// search phrase, and making one needs your OpenRouter key — a secret that can
// never sit inside a web page. So the app asks this function instead.
//
// DEPLOY WITH:  npx supabase functions deploy search-brain
// (normal deploy — no --no-verify-jwt. Only a logged-in user can call it.)
//
// WHO is searching comes from the caller's own login token, never from the
// request body — a browser call could put any user id it likes in there.
// That id is what's passed as p_user_id, so you only ever search your own brain.
//
// If the embedding can't be made (provider down, key problem), it still
// searches — by exact words only — rather than showing you an error.
// ============================================================================

import { adminClient, corsHeaders, getCaller, json } from '../_shared/capture.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

async function embedQuery(query: string, userId: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ text: query, userId, source: 'app-search' }),
      signal: AbortSignal.timeout(20_000),
    })
    const d = await res.json().catch(() => ({}))
    return Array.isArray(d.embedding) ? d.embedding : null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405)
  try {
    const admin = adminClient()
    const caller = await getCaller(req, admin)
    if (!caller) return json({ ok: false, error: 'Please sign in again.' }, 401)

    const body = await req.json().catch(() => ({}))
    const query = typeof body?.query === 'string' ? body.query.trim().slice(0, 500) : ''
    if (!query) return json({ ok: false, error: 'Type something to search for.' }, 400)
    const limit = Math.min(Math.max(Math.floor(Number(body?.limit) || 20), 1), 50)

    const embedding = await embedQuery(query, caller.id)
    const { data, error } = await admin.rpc('search_thoughts', {
      query_text: query,
      p_user_id: caller.id,
      query_embedding: embedding ? JSON.stringify(embedding) : null,
      match_threshold: 0.3,
      match_count: limit,
      max_per_document: 2,
    })
    if (error) throw error

    return json({ ok: true, mode: embedding ? 'hybrid' : 'keyword', results: data ?? [] })
  } catch (err) {
    console.error('[search-brain] failed:', err)
    const m = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err)
    return json({ ok: false, error: m }, 500)
  }
})
