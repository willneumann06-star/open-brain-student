// ============================================================================
// WEEK-PLANNER — your week, by day and by importance, every Monday at 7am
// ============================================================================
// During the week (by Sunday night), save anything for the coming week with
// "week:" at the start — in the app, Telegram, or via Claude:
//     week: FIN 450 exam Thursday 10am
//     week: Canyon Angels EnKoat review — slides due Wed
// For a PDF or link, put "week:" in its title.
//
// Monday 7am Arizona, pg_cron calls this. It collects every week: item saved
// since the last plan, asks Claude Haiku (through call-llm) to lay out
// Monday–Sunday with priorities, saves the plan into your brain (labelled 🤖)
// and sends it to your Telegram.
//
// DEPLOY WITH:  npx supabase functions deploy week-planner --no-verify-jwt
//
// Privacy: your week items are personal, so this uses your normal provider
// (Claude Haiku via LLM_PROVIDER) — never Grok.
// Safe to leave open: it plans at most once every 5 days.
// ============================================================================

import { askGateway, azDate, db, json, lastRun, MIN_DAYS_BETWEEN_RUNS, OWNER_USER_ID, saveBotNote, sendTelegram } from '../_shared/bots.ts'

const BOT = 'week-planner'
const MAX_ITEM_CHARS = 1500
const MAX_PROMPT_CHARS = 40_000

// "week:" at the very start of a note — or in the title of a PDF/link/YouTube
// capture (their first line starts with 📄 / 🔗 / 📹). A journal entry that
// merely says "This week: ..." is NOT picked up.
export function isWeekItem(content: string): boolean {
  if (/^\s*week\s*:/i.test(content)) return true
  const firstLine = content.split('\n')[0].slice(0, 300)
  return /^\s*(📄|🔗|📹)/u.test(firstLine) && /\bweek\s*:/i.test(firstLine)
}

const SYSTEM_PROMPT =
  "You plan someone's week from the items they saved. Be practical and specific. Never invent tasks, " +
  'times or deadlines that are not in the items; if a date or time is unclear, say so. Plain text, no tables, ' +
  'short lines that read well on a phone.'

function buildPrompt(days: string[], items: string): string {
  return `The week runs ${days[0]} to ${days[6]}. The days are: ${days.join(', ')}.\n\n` +
    `Here is everything I saved for this week:\n${items}\n\n` +
    'Write my week plan in exactly this shape:\n' +
    'TOP 3 THIS WEEK — the three things that matter most, one line each.\n' +
    'Then one section per day, in order, headed with the day and date (e.g. "MON 26 OCT"). Under each day list ' +
    'its tasks, most important first, each starting with a priority marker:\n' +
    '🔴 must do (deadlines, exams, commitments to other people)\n🟡 should do (important but flexible)\n🟢 could do (nice to have)\n' +
    'If a day has nothing, write "Free". Spread flexible work sensibly before its deadline (e.g. prep a presentation the day before it is due).\n' +
    'Then "NO DAY GIVEN" for items with no clear day, with a suggested day.\n' +
    'Then "WATCH OUT" — any clashes, tight turnarounds or missing details, one line each (skip if none).'
}

Deno.serve(async () => {
  try {
    if (!OWNER_USER_ID) return json({ ok: false, error: 'OWNER_USER_ID secret is missing' })
    const supa = db()

    const last = await lastRun(supa, BOT)
    if (last && Date.now() - last.getTime() < MIN_DAYS_BETWEEN_RUNS * 864e5) {
      console.log(`[${BOT}] already planned ${last.toISOString()} — skipping`)
      return json({ ok: true, skipped: 'already planned this week' })
    }

    // Everything since the last plan (or the last 8 days if this is the first one)
    const since = last ?? new Date(Date.now() - 8 * 864e5)
    const { data, error } = await supa.from('thoughts')
      .select('content, created_at, metadata')
      .eq('user_id', OWNER_USER_ID)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true })
      .limit(500)
    if (error) throw error
    const rows = (data ?? []).filter((r: { content: string; metadata: Record<string, unknown> | null }) =>
      !r.metadata?.bot && isWeekItem(r.content))

    // Today plus the next 6 days (on the Monday 7am run, that's Monday–Sunday)
    const now = new Date()
    const days = Array.from({ length: 7 }, (_, i) => azDate(new Date(now.getTime() + i * 864e5)))
    const title = `🗓️ Week plan — ${days[0]} to ${days[6]}`

    if (!rows.length) {
      const msg = `${title}\n\nNothing saved with "week:" since the last plan, so there's nothing to plan.\n` +
        'Next time, save items like:\nweek: FIN 450 exam Thursday 10am'
      await sendTelegram(msg)
      console.log(`[${BOT}] no week: items`)
      return json({ ok: true, items: 0, note: 'no week: items found — nothing saved' })
    }

    let items = ''
    for (const r of rows as { content: string; created_at: string }[]) {
      const body = r.content.replace(/^\s*week\s*:\s*/i, '').trim().slice(0, MAX_ITEM_CHARS)
      items += `- (saved ${azDate(new Date(r.created_at))}) ${body}\n`
      if (items.length > MAX_PROMPT_CHARS) break
    }

    const { text } = await askGateway({ prompt: buildPrompt(days, items), systemPrompt: SYSTEM_PROMPT, maxTokens: 2000, source: BOT }, 120_000)

    const content = `${title}\n\n${text}`
    const id = await saveBotNote(supa, BOT, content, {
      category: 'plan',
      tags: ['week-plan'],
      summary: `Week plan for ${days[0]}–${days[6]}, built from ${rows.length} week: item(s).`,
      metadata: { items: rows.length },
    })
    const sent = await sendTelegram(content)

    console.log(`[${BOT}] planned ${rows.length} items → ${id}, telegram=${sent}`)
    return json({ ok: true, id, items: rows.length, telegram: sent })
  } catch (err) {
    console.error(`[${BOT}] failed:`, String(err))
    return json({ ok: false, error: String(err) }, 500)
  }
})
