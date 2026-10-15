// ============================================================================
// TELEGRAM-BOT — text your brain from your phone
// ============================================================================
// Telegram calls this function (a "webhook") every time someone messages your
// bot. It saves the message as a thought, or searches your brain, then replies.
//
// DEPLOY WITH:
//   npx supabase functions deploy telegram-bot --no-verify-jwt
//
// Telegram can't send a Supabase login token, so --no-verify-jwt opens the
// door. That means this code has to check who's knocking itself: it only
// answers the one chat id stored in the TELEGRAM_CHAT_ID secret.
//
// Secrets it reads (Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN  — from BotFather
//   OWNER_USER_ID       — your account id (Authentication → Users → UID)
//   TELEGRAM_CHAT_ID    — your chat id; the bot tells you it on first message
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// The service role key skips the Level 2 security rule entirely, so every
// insert sets user_id and every read filters by it. Nothing else will.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Always answer Telegram with 200. Anything else and Telegram retries the
// same message over and over, which would save it again and again.
function ok(): Response {
  return new Response('ok', { status: 200, headers: corsHeaders })
}

async function reply(chatId: number | string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000), // Telegram's per-message limit is 4096
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.error('[telegram] could not send reply:', String(err))
  }
}

function formatThought(t: { content: string; created_at: string }, n: number): string {
  const when = new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const body = t.content.replace(/\s+/g, ' ').trim()
  return `${n}. [${when}] ${body.slice(0, 350)}${body.length > 350 ? '…' : ''}`
}

const HELP = [
  '🧠 Your Open Brain',
  '',
  'Send any message → saved as a thought',
  '/search word  (or  ? word) → find thoughts containing it',
  '/recent → your last 5 thoughts',
  '/help → this message',
].join('\n')

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return ok()

  let chatId: number | string | undefined
  try {
    const update = await req.json().catch(() => null)
    const message = update?.message ?? update?.edited_message
    chatId = message?.chat?.id
    if (!message || chatId === undefined) return ok() // not a message we handle (joins, reactions…)

    // ── Who's knocking? ────────────────────────────────────────────────
    if (!ALLOWED_CHAT_ID) {
      await reply(chatId,
        'This brain is not locked yet.\n\n' +
        `Your chat id is: ${chatId}\n\n` +
        'Add it in Supabase → Edge Functions → Secrets as TELEGRAM_CHAT_ID, then message me again.')
      return ok()
    }
    if (String(chatId) !== String(ALLOWED_CHAT_ID)) {
      await reply(chatId, 'This is a private brain. It does not talk to strangers.')
      console.log(`[telegram] rejected chat ${chatId}`)
      return ok()
    }
    if (!OWNER_USER_ID) {
      await reply(chatId, 'Setup incomplete: OWNER_USER_ID is missing from your Supabase secrets.')
      return ok()
    }

    const text: string = (message.text ?? message.caption ?? '').trim()
    if (!text) {
      await reply(chatId, 'I can only save text for now. Type it out, or use your phone keyboard\'s microphone.')
      return ok()
    }

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // ── Commands ───────────────────────────────────────────────────────
    // "/search@MyBot word" is what Telegram sends from a command menu — strip the @BotName
    const command = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '')

    if (command === '/start' || command === '/help') {
      await reply(chatId, HELP)
      return ok()
    }

    if (command === '/recent') {
      const { data, error } = await db.from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error
      await reply(chatId, data?.length
        ? '🕘 Most recent:\n\n' + data.map((t, i) => formatThought(t, i + 1)).join('\n\n')
        : 'Your brain is empty. Send me something to remember.')
      return ok()
    }

    if (command === '/search' || text.startsWith('?')) {
      const query = (command === '/search' ? text.replace(/^\/search(@\w+)?/i, '') : text.slice(1)).trim()
      if (!query) {
        await reply(chatId, 'Search for what? Try:  /search valuation')
        return ok()
      }
      // % and _ are wildcards in ilike — escape them so they're matched literally
      const pattern = '%' + query.replace(/[\\%_]/g, m => '\\' + m) + '%'
      const { data, error } = await db.from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .ilike('content', pattern)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error
      await reply(chatId, data?.length
        ? `🔍 "${query}":\n\n` + data.map((t, i) => formatThought(t, i + 1)).join('\n\n')
        : `Nothing in your brain matches "${query}".`)
      return ok()
    }

    if (text.startsWith('/')) {
      await reply(chatId, `I don't know ${command}.\n\n${HELP}`)
      return ok()
    }

    // ── Anything else: save it ─────────────────────────────────────────
    const { error } = await db.from('thoughts').insert({
      content: text,
      user_id: OWNER_USER_ID,
      metadata: { source: 'telegram', telegram_message_id: message.message_id },
    })
    if (error) throw error
    await reply(chatId, '✅ Saved to your brain')
    return ok()
  } catch (err) {
    console.error('[telegram] error:', err)
    if (chatId !== undefined) {
      const msg = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err)
      await reply(chatId, '⚠️ Something went wrong: ' + msg)
    }
    return ok() // still 200, so Telegram doesn't retry forever
  }
})
