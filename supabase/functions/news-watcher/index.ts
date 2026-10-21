// ============================================================================
// NEWS-WATCHER — a Monday-morning brief from Grok's live web + X search
// ============================================================================
// pg_cron calls this every Monday at 6:30am Arizona time. Grok searches the
// last 7 days of the web and X on your topics, writes a brief with sources,
// and it's saved into your brain (labelled 🤖) and sent to your Telegram.
//
// DEPLOY WITH:  npx supabase functions deploy news-watcher --no-verify-jwt
//
// Privacy: Grok only ever sees the TOPICS below — nothing from your brain.
// Cost: about $0.15–0.60 per brief (tokens + searches), receipts in llm_usage.
// Safe to leave open: it runs at most once a week (Mon–Sun, Arizona time).
//
// To change what it watches, edit TOPICS and redeploy.
// ============================================================================

import { askGateway, azDate, db, json, lastRun, ranThisWeek, OWNER_USER_ID, saveBotNote, sendTelegram } from '../_shared/bots.ts'

const BOT = 'news-watcher'

const TOPICS = [
  'PE and VC across the US: notable fund raises, big or unusual deals, exits, and where investors are moving money',
  'Emerging markets and sectors that are just starting to attract capital',
  'Early business opportunities most people have not noticed yet, or are only beginning to see',
  'Old, traditional occupations and businesses that are still succeeding (trades, family businesses, "boring" industries) — and why',
  'Companies valued at $500M+ that are pivoting to stay relevant: what they are changing and why',
]

const SYSTEM_PROMPT =
  'You are a sharp research analyst writing a weekly brief for a finance and entrepreneurship student ' +
  'who leads deal reviews at an angel investor group and wants a PE/VC career. Use live search. ' +
  'Only include things from the last 7 days that you found in sources, and never invent figures. ' +
  'Prefer specifics (names, amounts, dates) over generalities. Plain text, no tables, short lines that read well on a phone.'

function prompt(today: string): string {
  return `Week ending ${today}. Write this week's brief with one section per topic below. ` +
    `For each section give the 2–3 most important items. For each item: one line on what happened, ` +
    `one line starting "Why it matters:" from an investor's point of view, and the source link.\n` +
    `Then finish with a section "ONE TO WATCH": the single early opportunity from this week you'd look into first, in 2–3 sentences.\n` +
    `Keep the whole brief under 700 words.\n\nTopics:\n` + TOPICS.map((t, i) => `${i + 1}. ${t}`).join('\n')
}

Deno.serve(async () => {
  try {
    if (!OWNER_USER_ID) return json({ ok: false, error: 'OWNER_USER_ID secret is missing' })
    const supa = db()

    const last = await lastRun(supa, BOT)
    if (ranThisWeek(last)) {
      console.log(`[${BOT}] already ran ${last.toISOString()} — skipping`)
      return json({ ok: true, skipped: 'already ran this week' })
    }

    const today = azDate(new Date(), { day: 'numeric', month: 'short', year: 'numeric' })
    const { text, sources } = await askGateway({
      provider: 'xai', search: true, searchDays: 7,
      prompt: prompt(today), systemPrompt: SYSTEM_PROMPT, maxTokens: 2500, source: BOT,
    })

    const title = `🗞️ Weekly news brief — ${today}`
    const content = `${title}\n\n${text}` + (sources.length ? `\n\nSources searched:\n${sources.slice(0, 25).join('\n')}` : '')
    const id = await saveBotNote(supa, BOT, content, {
      category: 'reference',
      tags: ['news-brief', 'venture capital', 'private equity', 'emerging markets'],
      summary: `Grok's weekly news brief for ${today}: PE/VC, emerging markets, early opportunities, enduring trades, big-company pivots.`,
      metadata: { model: 'grok', sources: sources.length },
    })
    const sent = await sendTelegram(`${title}\n\n${text}`)

    console.log(`[${BOT}] saved ${id}, telegram=${sent}`)
    return json({ ok: true, id, telegram: sent, chars: content.length })
  } catch (err) {
    console.error(`[${BOT}] failed:`, String(err))
    return json({ ok: false, error: String(err) }, 500)
  }
})
