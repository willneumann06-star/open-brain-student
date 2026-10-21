// ============================================================================
// SHARED BOT HELPERS — used by news-watcher and week-planner
// ============================================================================
// Every bot follows the same three rules:
//   1. AI only through call-llm (the gateway) — no bot holds an AI key.
//   2. Whatever a bot writes is LABELLED: metadata.bot = true, plus which bot.
//      Your weekly digest skips bot notes, and the app marks them with 🤖, so
//      bot writing never gets mistaken for your own thinking.
//   3. At most one run per bot per week (Monday–Sunday, Arizona time), so its
//      open address can't be used to run up your AI bill — and a test run
//      mid-week never blocks the next Monday's real run.
// ============================================================================

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

export const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

/** Monday 00:00 of the current week, Arizona time (UTC−7, no daylight saving). */
export function startOfAzWeek(now = new Date()): Date {
  const AZ = 7 * 3600e3
  const az = new Date(now.getTime() - AZ)                 // Arizona wall-clock, read via getUTC*
  const daysSinceMonday = (az.getUTCDay() + 6) % 7
  const mondayAz = Date.UTC(az.getUTCFullYear(), az.getUTCMonth(), az.getUTCDate() - daysSinceMonday)
  return new Date(mondayAz + AZ)
}

/** Has this bot already written a note this week? */
export function ranThisWeek(last: Date | null, now = new Date()): boolean {
  return !!last && last.getTime() >= startOfAzWeek(now).getTime()
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export function db(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
}

/** When did this bot last write a note? null if never. */
export async function lastRun(supa: SupabaseClient, bot: string): Promise<Date | null> {
  const { data, error } = await supa.from('thoughts')
    .select('created_at')
    .eq('user_id', OWNER_USER_ID)
    .eq('metadata->>source', bot)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return data?.[0] ? new Date(data[0].created_at) : null
}

/** Through the gateway, carrying the service role key like every function-to-function call. */
export async function askGateway(body: Record<string, unknown>, timeoutMs = 145_000): Promise<{ text: string; sources: string[] }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ userId: OWNER_USER_ID, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok || !d.text) throw new Error(`call-llm ${res.status}: ${d.error ?? 'empty reply'}`)
  return { text: String(d.text).trim(), sources: Array.isArray(d.sources) ? d.sources : [] }
}

/** Save a labelled bot note. Upsert, like every other save since Level 6. */
export async function saveBotNote(supa: SupabaseClient, bot: string, content: string, extra: {
  category: string; tags: string[]; summary: string; metadata?: Record<string, unknown>
}): Promise<string> {
  const { data, error } = await supa.from('thoughts').upsert({
    user_id: OWNER_USER_ID,
    content,
    category: extra.category,
    tags: extra.tags,
    summary: extra.summary,
    enriched_at: new Date().toISOString(), // already tagged — skip the enrichment AI call (it still gets embedded + chunked)
    metadata: { source: bot, bot: true, ...(extra.metadata ?? {}) },
  }, { onConflict: 'dedup_key,user_id', ignoreDuplicates: false }).select('id').single()
  if (error) throw error
  return data.id as string
}

/** Send to your Telegram chat. Never throws — a failed message must not lose the saved note. */
export async function sendTelegram(text: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
  const chat = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''
  if (!token || !chat) return false
  try {
    // Telegram caps one message at 4,096 characters — split on line breaks
    const parts: string[] = []
    let cur = ''
    for (const line of text.split('\n')) {
      if ((cur + '\n' + line).length > 3900 && cur) { parts.push(cur); cur = '' }
      cur = cur ? cur + '\n' + line : line.slice(0, 3900)
    }
    if (cur) parts.push(cur)
    for (const part of parts) {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: part, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!r.ok) { console.warn('[bots] telegram send failed:', r.status); return false }
    }
    return true
  } catch (e) {
    console.warn('[bots] telegram send failed:', String(e))
    return false
  }
}

/** "Mon 26 Oct" style, in Arizona time (no daylight saving, UTC−7 all year). */
export function azDate(d: Date, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  return d.toLocaleDateString('en-AU', { timeZone: 'America/Phoenix', ...opts })
}
