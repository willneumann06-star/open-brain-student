// ============================================================================
// WEEKLY-DIGEST — a Sunday-morning report on what you've been learning
// ============================================================================
// pg_cron (your database's built-in scheduler) calls this once a week. It
// reads your last 7 days of captures, asks the AI — through call-llm, never
// directly — to write you a report, and saves that report back into your
// brain as a thought with category 'digest'.
//
// DEPLOY WITH:  npx supabase functions deploy weekly-digest --no-verify-jwt
//
// Why it's safe to leave this door open: it writes at most ONE digest every
// 6 days. Anyone who found the address and called it again would just get
// "already done this week" — they can't read your digest or run up your bill.
//
// Secrets it reads: OWNER_USER_ID (whose brain), plus the automatic
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

const MIN_THOUGHTS = 5
const MAX_CHARS_PER_THOUGHT = 700
const MAX_PROMPT_CHARS = 45_000

const SYSTEM_PROMPT =
  "You write a short weekly digest of someone's personal knowledge base, addressed to them as \"you\". " +
  'Base every statement only on the notes provided — never invent. Be specific and concrete, no filler. ' +
  'Plain text with short section headings, no markdown tables.'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Row = { content: string; category: string | null; summary: string | null; tags: string[] | null; created_at: string }

Deno.serve(async () => {
  try {
    if (!OWNER_USER_ID) return json({ ok: false, error: 'OWNER_USER_ID secret is missing' })
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const now = new Date()
    const weekAgo = new Date(now.getTime() - 7 * 864e5)
    const sixDaysAgo = new Date(now.getTime() - 6 * 864e5)

    // 1. At most one digest a week
    const { count: recent } = await db.from('thoughts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', OWNER_USER_ID).eq('category', 'digest')
      .gte('created_at', sixDaysAgo.toISOString())
    if ((recent ?? 0) > 0) {
      console.log('[digest] already written this week — skipping')
      return json({ ok: true, skipped: 'already written this week' })
    }

    // 2. This week's captures (not old digests)
    const { data, error } = await db.from('thoughts')
      .select('content, category, summary, tags, created_at')
      .eq('user_id', OWNER_USER_ID)
      .gte('created_at', weekAgo.toISOString())
      .or('category.is.null,category.neq.digest')
      .order('created_at', { ascending: true })
      .limit(300)
    if (error) throw error
    const rows = (data ?? []) as Row[]
    if (rows.length < MIN_THOUGHTS) {
      console.log(`[digest] only ${rows.length} thoughts this week — not enough for a digest`)
      return json({ ok: true, skipped: `only ${rows.length} thoughts this week (need ${MIN_THOUGHTS})` })
    }

    // 3. Group by category (filled in by the enrichment agent)
    const groups = new Map<string, Row[]>()
    for (const r of rows) {
      const k = r.category ?? 'uncategorised'
      groups.set(k, [...(groups.get(k) ?? []), r])
    }
    let notes = ''
    for (const [cat, list] of groups) {
      notes += `\n## ${cat} (${list.length})\n`
      for (const r of list) {
        const day = r.created_at.slice(0, 10)
        const body = (r.summary?.trim() ? r.summary : r.content).replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS_PER_THOUGHT)
        const tags = r.tags?.length ? ` [${r.tags.join(', ')}]` : ''
        notes += `- (${day})${tags} ${body}\n`
      }
      if (notes.length > MAX_PROMPT_CHARS) break
    }

    const prompt =
      `Here are ${rows.length} notes captured in the last 7 days, grouped by category:\n${notes.slice(0, MAX_PROMPT_CHARS)}\n\n` +
      'Write the weekly digest with exactly these three sections:\n' +
      '1. WHAT YOU WERE LEARNING — the main things learned or explored this week, grouped sensibly.\n' +
      '2. KEY THEMES — 2 to 4 threads that connect several notes.\n' +
      '3. A QUESTION YOU SEEM TO BE EXPLORING — one question, in one or two sentences.\n' +
      'Keep the whole digest under 350 words.'

    // 4. Through the gateway
    const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ prompt, systemPrompt: SYSTEM_PROMPT, maxTokens: 1200, userId: OWNER_USER_ID, source: 'weekly-digest' }),
      signal: AbortSignal.timeout(120_000),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok || !d.text) throw new Error(`call-llm ${res.status}: ${d.error ?? 'empty reply'}`)

    // 5. Save it back into the brain
    const fmt = (x: Date) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const title = `🗓️ Weekly digest — ${fmt(weekAgo)} to ${fmt(now)}`
    const { error: insErr } = await db.from('thoughts').insert({
      user_id: OWNER_USER_ID,
      content: `${title}\n\n${String(d.text).trim()}`,
      category: 'digest',
      tags: ['digest'],
      summary: `Weekly digest of ${rows.length} thoughts, ${fmt(weekAgo)}–${fmt(now)}`,
      enriched_at: now.toISOString(), // tells the enrichment agent to leave it alone
      metadata: { source: 'weekly-digest', thought_count: rows.length },
    })
    if (insErr) throw insErr

    console.log(`[digest] written from ${rows.length} thoughts`)
    return json({ ok: true, thoughts: rows.length })
  } catch (err) {
    console.error('[digest] failed:', String(err))
    return json({ ok: false, error: String(err) }, 500)
  }
})
