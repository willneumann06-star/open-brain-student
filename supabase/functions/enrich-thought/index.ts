// ============================================================================
// ENRICH-THOUGHT — tags, a category and a one-line summary for every capture
// ============================================================================
// Your database calls this automatically the moment a new thought is saved
// (a trigger on the thoughts table — see the Level 5 SQL). It works no matter
// how the thought arrived: web app, Telegram, YouTube/URL capture, or Claude.
//
// DEPLOY WITH:  npx supabase functions deploy enrich-thought --no-verify-jwt
//
// Why it's safe to leave this door open: the caller only ever sends a thought
// ID. This function looks the thought up itself and only enriches it if it
// hasn't been enriched already. So the worst a stranger could do is ask it to
// enrich one of your new thoughts a few seconds early — it can't read anything,
// change anything else, or make it spend more than once per thought.
//
// It never calls an AI directly — it goes through call-llm (the gateway).
//
// BACKFILL: POST {"backfill": true} to enrich every thought that hasn't been
// enriched yet (up to 100 per call) — used once for everything saved before
// Level 5.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection'] as const
const MIN_CHARS = 20
const MAX_INPUT_CHARS = 12_000 // long transcripts: the opening 12k chars is plenty to tag and summarise

const SYSTEM_PROMPT =
  'You organise notes in a personal knowledge base. You are given one note. ' +
  'Reply with ONLY a JSON object and nothing else, in exactly this shape:\n' +
  '{"tags": ["3 to 5 short lowercase tags"], "category": "one of: ' + CATEGORIES.join(', ') + '", ' +
  '"summary": "one sentence, max 30 words"}\n' +
  'Category guide: idea = an original idea or proposal; learning = something learned from a video, article, ' +
  'book or experience; question = an open question; reference = saved material kept for later; ' +
  'plan = intentions, goals or next steps; reflection = personal writing, journaling or thinking out loud. ' +
  'Tags should be specific topics (e.g. "venture capital", "airbnb"), not generic words like "note". ' +
  'Write the summary in the same language as the note.'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const db = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Through the gateway. Function-to-function calls carry the service role key.
async function askLLM(prompt: string, userId: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ prompt, systemPrompt: SYSTEM_PROMPT, maxTokens: 300, userId, source: 'enrich-thought' }),
    signal: AbortSignal.timeout(100_000),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`call-llm ${res.status}: ${d.error ?? 'no detail'}`)
  return String(d.text ?? '')
}

// The AI is asked for JSON, but be forgiving about stray text around it
export function parseEnrichment(raw: string) {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON in AI reply')
  const o = JSON.parse(match[0])
  const tags = (Array.isArray(o.tags) ? o.tags : [])
    .filter((t: unknown) => typeof t === 'string')
    .map((t: string) => t.trim().toLowerCase().replace(/^#/, '').slice(0, 40))
    .filter(Boolean)
  const category = CATEGORIES.includes(String(o.category).toLowerCase().trim() as typeof CATEGORIES[number])
    ? String(o.category).toLowerCase().trim()
    : 'reference'
  const summary = typeof o.summary === 'string' ? o.summary.trim().slice(0, 400) : null
  return { tags: [...new Set(tags)].slice(0, 5) as string[], category, summary }
}

async function enrichOne(id: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return 'bad id'
  const supa = db()
  const { data: t, error } = await supa.from('thoughts')
    .select('id, user_id, content, category, enriched_at')
    .eq('id', id).maybeSingle()
  if (error) throw error
  if (!t) return 'not found'
  if (t.enriched_at || t.category === 'digest') return 'already done'
  if (!t.user_id) return 'no owner'

  const content = String(t.content ?? '').trim()
  if (content.length < MIN_CHARS) {
    // Too short to be worth an AI call — mark it so backfill doesn't keep retrying
    await supa.from('thoughts').update({ enriched_at: new Date().toISOString() }).eq('id', id)
    return 'too short'
  }

  const raw = await askLLM(`Note:\n"""\n${content.slice(0, MAX_INPUT_CHARS)}\n"""`, t.user_id)
  const e = parseEnrichment(raw)
  const { error: upErr } = await supa.from('thoughts')
    .update({ tags: e.tags, category: e.category, summary: e.summary, enriched_at: new Date().toISOString() })
    .eq('id', id)
    .is('enriched_at', null) // never overwrite if something else got there first
  if (upErr) throw upErr
  return 'enriched'
}

Deno.serve(async (req) => {
  // Always answer 200: the database trigger shouldn't care whether this worked
  try {
    if (req.method !== 'POST') return json({ ok: true, note: 'POST only' })
    const body = await req.json().catch(() => ({}))

    let ids: string[] = []
    if (body?.backfill === true) {
      const { data, error } = await db().from('thoughts')
        .select('id').is('enriched_at', null)
        .order('created_at', { ascending: true }).limit(100)
      if (error) throw error
      ids = (data ?? []).map((r: { id: string }) => r.id)
    } else {
      const id = body?.record?.id ?? body?.id
      if (typeof id === 'string') ids = [id]
    }

    const results: Record<string, number> = {}
    for (const id of ids) {
      let outcome: string
      try { outcome = await enrichOne(id) } catch (err) {
        console.error(`[enrich] ${id} failed:`, String(err))
        outcome = 'failed'
      }
      results[outcome] = (results[outcome] ?? 0) + 1
    }
    if (ids.length) console.log('[enrich]', JSON.stringify(results))
    return json({ ok: true, processed: ids.length, results })
  } catch (err) {
    console.error('[enrich] error:', String(err))
    return json({ ok: false, error: String(err) })
  }
})
