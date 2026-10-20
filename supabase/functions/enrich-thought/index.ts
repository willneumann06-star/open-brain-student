// ============================================================================
// ENRICH-THOUGHT — tags, category, summary, embedding and links for every capture
// ============================================================================
// Your database calls this automatically the moment a new thought is saved
// (a trigger on the thoughts table — see the Level 5 SQL). It works no matter
// how the thought arrived: web app, Telegram, YouTube/URL capture, or Claude.
//
// For each thought it does four jobs, each only if not already done:
//   1. Enrichment (Level 5) — tags, category, one-line summary, via call-llm
//   2. Embedding  (Level 6) — its "meaning coordinates", via generate-embedding
//   3. Linking    (Level 6) — saves links to its 5 closest neighbours (>50%)
//   4. Chunking   (Level 7) — long captures (>2,000 chars) cut into ~300-word
//                             pieces, each with its own embedding
// A failure in one job never stops the others, and never fails the save.
//
// DEPLOY WITH:  npx supabase functions deploy enrich-thought --no-verify-jwt
//
// Why it's safe to leave this door open: the caller only ever sends a thought
// ID. This function looks the thought up itself and only does work that hasn't
// been done yet. So the worst a stranger could do is make it finish one of your
// new thoughts a few seconds early — it can't read anything, change anything
// else, or make it spend more than once per thought.
//
// BACKFILL: POST {"backfill": true} to process every thought that is missing
// its enrichment OR its embedding (up to 50 per call). Run it again until it
// says processed: 0. Safe to run any number of times. (Chunking old thoughts
// has its own backfill: the backfill-chunks function.)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'
import { shouldChunk } from '../_shared/chunking.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection'] as const
const MIN_CHARS = 20
const MAX_INPUT_CHARS = 12_000 // long transcripts: the opening 12k chars is plenty to tag and summarise
const LINK_THRESHOLD = 0.5
const LINK_COUNT = 5
const BACKFILL_BATCH = 50

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

// Function-to-function calls carry the service role key. It is not optional:
// without it the other function refuses the call before doing anything.
async function callFn(name: string, body: unknown, timeoutMs: number) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const d = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, d }
}

// Through the gateway, never straight to an AI
async function askLLM(prompt: string, userId: string): Promise<string> {
  const { ok, status, d } = await callFn('call-llm',
    { prompt, systemPrompt: SYSTEM_PROMPT, maxTokens: 300, userId, source: 'enrich-thought' }, 100_000)
  if (!ok) throw new Error(`call-llm ${status}: ${d.error ?? 'no detail'}`)
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

type Thought = { id: string; user_id: string | null; content: string | null; category: string | null; enriched_at: string | null; has_embedding: boolean }

// ── Job 1: tags, category, summary ──────────────────────────────────────────
async function enrich(t: Thought): Promise<string> {
  if (t.enriched_at || t.category === 'digest') return ''
  const supa = db()
  const content = String(t.content ?? '').trim()
  if (content.length < MIN_CHARS) {
    // Too short to be worth an AI call — mark it so backfill doesn't keep retrying
    await supa.from('thoughts').update({ enriched_at: new Date().toISOString() }).eq('id', t.id)
    return 'too short'
  }
  const raw = await askLLM(`Note:\n"""\n${content.slice(0, MAX_INPUT_CHARS)}\n"""`, t.user_id!)
  const e = parseEnrichment(raw)
  const { error } = await supa.from('thoughts')
    .update({ tags: e.tags, category: e.category, summary: e.summary, enriched_at: new Date().toISOString() })
    .eq('id', t.id)
    .is('enriched_at', null) // never overwrite if something else got there first
  if (error) throw error
  return 'enriched'
}

// ── Jobs 2 + 3: embedding, then links to its nearest neighbours ─────────────
let lastEmbedError = ''
async function embedAndLink(t: Thought): Promise<{ embedded: boolean; links: number }> {
  if (t.has_embedding) return { embedded: false, links: 0 }
  const content = String(t.content ?? '').trim()
  if (!content) return { embedded: false, links: 0 }

  const { d } = await callFn('generate-embedding', { text: content, userId: t.user_id, source: 'enrich-thought' }, 30_000)
  const embedding: number[] | null = Array.isArray(d.embedding) ? d.embedding : null
  if (!embedding) {
    lastEmbedError = String(d.error ?? 'no embedding returned')
    throw new Error('embedding failed: ' + lastEmbedError)
  }
  const vec = JSON.stringify(embedding) // pgvector's text format: [0.1,0.2,...]
  const supa = db()
  const { error: upErr } = await supa.from('thoughts').update({ embedding: vec }).eq('id', t.id)
  if (upErr) throw upErr

  // Digests summarise everything, so linking them would connect them to everything
  if (t.category === 'digest') return { embedded: true, links: 0 }

  // Scoped to this thought's owner — the service role key skips RLS, so the
  // p_user_id filter is the only thing keeping other users' thoughts out
  const { data: neighbours, error: rpcErr } = await supa.rpc('find_links_for_thought', {
    source_id: t.id,
    source_embedding: vec,
    p_user_id: t.user_id,
    match_threshold: LINK_THRESHOLD,
    match_count: LINK_COUNT,
  })
  if (rpcErr) { console.error(`[enrich] ${t.id} linking failed:`, rpcErr.message); return { embedded: true, links: 0 } }
  if (!neighbours?.length) return { embedded: true, links: 0 }

  const links = (neighbours as { target_id: string; similarity: number }[]).map(n => ({
    source_thought_id: t.id,
    target_thought_id: n.target_id,
    user_id: t.user_id,
    similarity_score: n.similarity,
    link_type: 'semantic',
  }))
  // Upsert one at a time: if B→A already exists, the reverse A→B hits the
  // canonical index — skip that one quietly instead of losing the whole batch
  let saved = 0
  for (const link of links) {
    const { error } = await supa.from('thought_links')
      .upsert(link, { onConflict: 'source_thought_id,target_thought_id', ignoreDuplicates: true })
    if (!error) saved++
    else if (error.code !== '23505') console.error(`[enrich] ${t.id} link not saved:`, error.message)
  }
  return { embedded: true, links: saved }
}

async function processOne(id: string, tally: Record<string, number>) {
  const bump = (k: string, n = 1) => { tally[k] = (tally[k] ?? 0) + n }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return bump('bad id')
  const { data, error } = await db().from('thoughts')
    .select('id, user_id, content, category, enriched_at, has_embedding:embedding')
    .eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) return bump('not found')
  if (!data.user_id) return bump('no owner')
  const t: Thought = { ...data, has_embedding: data.has_embedding != null }
  const needsChunks = await missingChunks(t)
  if ((t.enriched_at || t.category === 'digest') && t.has_embedding && !needsChunks) return bump('already done')

  // Each job on its own: one failing never stops the other
  try {
    const r = await enrich(t)
    if (r) bump(r)
  } catch (err) {
    console.error(`[enrich] ${id} enrichment failed:`, String(err))
    bump('enrich failed')
  }
  try {
    const r = await embedAndLink(t)
    if (r.embedded) bump('embedded')
    if (r.links) bump('links', r.links)
  } catch (err) {
    console.error(`[enrich] ${id}:`, String(err))
    bump('embed failed')
  }
  // Job 4: chunk it, if it's long enough to be worth it. Never throws.
  if (needsChunks) {
    const n = await saveThoughtChunksSafe(db(), t.id, String(t.content ?? ''), 'enrich-thought', 'summary', t.user_id!)
    if (n) bump('chunks', n)
  }
}

// Long enough to chunk, and not chunked yet? (Digests are summaries — no need.)
async function missingChunks(t: Thought): Promise<boolean> {
  if (t.category === 'digest' || !shouldChunk(t.content)) return false
  const { count, error } = await db().from('thought_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('thought_id', t.id).eq('origin', 'summary')
  if (error) { console.error(`[enrich] ${t.id} chunk check failed:`, error.message); return false }
  return (count ?? 0) === 0
}

Deno.serve(async (req) => {
  // Always answer 200: the database trigger shouldn't care whether this worked
  try {
    if (req.method !== 'POST') return json({ ok: true, note: 'POST only' })
    const body = await req.json().catch(() => ({}))

    let ids: string[] = []
    if (body?.backfill === true) {
      const { data, error } = await db().from('thoughts')
        .select('id')
        .not('user_id', 'is', null)
        .or('enriched_at.is.null,embedding.is.null')
        .order('created_at', { ascending: true })
        .limit(BACKFILL_BATCH)
      if (error) throw error
      ids = (data ?? []).map((r: { id: string }) => r.id)
    } else {
      const id = body?.record?.id ?? body?.id
      if (typeof id === 'string') ids = [id]
    }

    const results: Record<string, number> = {}
    for (const id of ids) {
      try { await processOne(id, results) } catch (err) {
        console.error(`[enrich] ${id} failed:`, String(err))
        results['failed'] = (results['failed'] ?? 0) + 1
      }
    }
    if (ids.length) console.log('[enrich]', JSON.stringify(results))
    // On a backfill, show why embedding failed (provider message only — never a key)
    const why = body?.backfill === true && results['embed failed'] ? { embed_error: lastEmbedError.slice(0, 300) } : {}
    return json({ ok: true, processed: ids.length, results, ...why })
  } catch (err) {
    console.error('[enrich] error:', String(err))
    return json({ ok: false, error: String(err) })
  }
})
