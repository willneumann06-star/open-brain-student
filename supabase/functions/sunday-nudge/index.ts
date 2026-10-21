// ============================================================================
// SUNDAY-NUDGE — Sunday 6pm Arizona: "load your week before tomorrow's plan"
// ============================================================================
// pg_cron calls this Sunday at 6pm Arizona time. It sends one Telegram message
// listing the week: items you've saved so far, so you can add what's missing
// before the week planner runs Monday at 7am. No AI involved — costs nothing.
//
// DEPLOY WITH:  npx supabase functions deploy sunday-nudge --no-verify-jwt
//
// Safe to leave open: it only sends on Sunday afternoon/evening (Arizona), at
// most once a week (tracked in the bot_runs table), and only to YOUR chat.
// ============================================================================

import { db, isWeekItem, json, OWNER_USER_ID, sendTelegram, startOfAzWeek } from '../_shared/bots.ts'

const BOT = 'sunday-nudge'

Deno.serve(async () => {
  try {
    if (!OWNER_USER_ID) return json({ ok: false, error: 'OWNER_USER_ID secret is missing' })
    const now = new Date()
    const az = new Date(now.getTime() - 7 * 3600e3) // Arizona wall-clock via getUTC*
    if (az.getUTCDay() !== 0 || az.getUTCHours() < 12) return json({ ok: true, skipped: 'only sends Sunday afternoon/evening' })

    const supa = db()
    const { data: run } = await supa.from('bot_runs').select('last_run').eq('bot', BOT).maybeSingle()
    if (run && new Date(run.last_run).getTime() >= startOfAzWeek(now).getTime()) return json({ ok: true, skipped: 'already sent this week' })

    const { data, error } = await supa.from('thoughts')
      .select('content, metadata')
      .eq('user_id', OWNER_USER_ID)
      .gte('created_at', new Date(now.getTime() - 8 * 864e5).toISOString())
      .order('created_at', { ascending: true })
      .limit(500)
    if (error) throw error
    const items = (data ?? [])
      .filter((r: { content: string; metadata: Record<string, unknown> | null }) => !r.metadata?.bot && isWeekItem(r.content))
      .map((r: { content: string }) => r.content.split('\n')[0].replace(/^\s*week\s*:\s*/i, '').trim().slice(0, 120))

    const msg = items.length
      ? `🗓️ Your week plan is built tomorrow at 7am.\n\nSo far you've loaded ${items.length} item${items.length === 1 ? '' : 's'}:\n` +
        items.map(i => `• ${i}`).join('\n') +
        '\n\nAnything missing? Send it now, starting with week:'
      : '🗓️ Your week plan is built tomorrow at 7am — and nothing is loaded yet.\n\nSend each item for the week starting with week:\ne.g. week: FIN 450 exam Thursday 10am'

    const sent = await sendTelegram(msg)
    await supa.from('bot_runs').upsert({ bot: BOT, last_run: now.toISOString() }, { onConflict: 'bot' })
    return json({ ok: true, items: items.length, telegram: sent })
  } catch (err) {
    console.error(`[${BOT}] failed:`, String(err))
    return json({ ok: false, error: String(err) }, 500)
  }
})
