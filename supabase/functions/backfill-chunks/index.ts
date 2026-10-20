// ============================================================================
// BACKFILL-CHUNKS — one-time pass that chunks everything you saved before Level 7
// ============================================================================
// New captures are chunked automatically by enrich-thought. This catches up the
// long ones you saved in Levels 2–6: it works through the thoughts_needing_chunks
// list (biggest documents first) and gives each one its chunks.
//
// DEPLOY WITH:  npx supabase functions deploy backfill-chunks --no-verify-jwt
//
// Why it's safe to leave this door open (instead of making you paste your
// service role key into Terminal, like the course's version does): it takes no
// input except a batch size. It only ever works on thoughts that need chunks and
// don't have them yet, so once your backlog is done every call does nothing.
// It returns counts only — never any of your text.
//
//   POST {"dry_run": true}     → how many thoughts still need chunks; writes nothing
//   POST {"batch_size": 5}     → chunk up to 5 of them (default 5, max 10)
//   Run it again until remaining is 0.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const TIME_BUDGET_MS = 90_000 // stop starting new documents well before the function's time limit

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  const started = Date.now()
  try {
    if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405)
    const body = await req.json().catch(() => ({}))
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

    const remainingCount = async () => {
      const { count, error } = await db.from('thoughts_needing_chunks').select('id', { count: 'exact', head: true })
      if (error) throw error
      return count ?? 0
    }

    if (body?.dry_run === true) return json({ ok: true, needs_chunks: await remainingCount() })

    const batch = Math.min(Math.max(Math.floor(Number(body?.batch_size) || 5), 1), 10)
    const { data: todo, error } = await db.from('thoughts_needing_chunks')
      .select('id, chars').order('chars', { ascending: false }).limit(batch)
    if (error) throw error

    let processed = 0, chunked = 0, chunks = 0, failed = 0
    for (const row of (todo ?? []) as { id: string }[]) {
      if (Date.now() - started > TIME_BUDGET_MS) break
      processed++
      const { data: t, error: tErr } = await db.from('thoughts')
        .select('id, user_id, content').eq('id', row.id).maybeSingle()
      if (tErr || !t?.user_id) { failed++; continue } // ownerless test notes are skipped
      const n = await saveThoughtChunksSafe(db, t.id, String(t.content ?? ''), 'backfill-chunks', 'summary', t.user_id)
      if (n > 0) { chunked++; chunks += n } else failed++
    }

    const remaining = await remainingCount()
    console.log(`[backfill-chunks] processed=${processed} chunked=${chunked} chunks=${chunks} failed=${failed} remaining=${remaining}`)
    return json({ ok: true, processed, chunked, chunks, failed, remaining })
  } catch (err) {
    console.error('[backfill-chunks] error:', String(err))
    return json({ ok: false, error: String(err) }, 500)
  }
})
