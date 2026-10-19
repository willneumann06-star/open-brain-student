// ============================================================================
// SHARED CAPTURE HELPERS — used by capture-url and capture-youtube
// ============================================================================
// Three jobs:
//   1. corsHeaders / json()   — your web app lives on vercel.app and these
//                               functions on supabase.co; the browser needs
//                               these headers to allow that conversation.
//   2. getCaller()            — WHO is asking, read from their login token.
//                               Never trust a user id sent in the request body,
//                               or anyone could write into anyone's brain.
//   3. saveCapture()          — the same plain save your Level 2 app does: one
//                               row in thoughts, the full text in
//                               thought_sources. No summarising yet — that
//                               arrives with the AI agents in Level 5.
// ============================================================================

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// The admin client uses the service role key, which skips the Level 2 security
// rule. That's why every save below sets user_id explicitly.
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
}

export async function getCaller(req: Request, admin: SupabaseClient): Promise<{ id: string } | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) return null
  return { id: data.user.id }
}

// Generous cap so one enormous page can't bloat the table. Transcripts of
// even multi-hour videos sit well under this.
const MAX_CHARS = 200_000

export async function saveCapture(admin: SupabaseClient, opts: {
  userId: string
  content: string
  metadata: Record<string, unknown>
  sourceText: string
  sourceKind: 'web' | 'youtube_transcript' | 'youtube_description'
}): Promise<string> {
  const truncated = opts.sourceText.length > MAX_CHARS
  const sourceText = truncated ? opts.sourceText.slice(0, MAX_CHARS) : opts.sourceText

  // upsert: capturing the same page/video twice updates the existing thought
  // instead of creating a duplicate (unique index from Level 6, Step 0)
  const { data: thought, error } = await admin.from('thoughts').upsert({
    user_id: opts.userId,
    content: opts.content.slice(0, MAX_CHARS + 2000),
    metadata: opts.metadata,
  }, { onConflict: 'dedup_key,user_id', ignoreDuplicates: false }).select('id, created_at').single()
  if (error) throw new Error('Could not save the thought: ' + error.message)

  // Non-fatal: the thought is already saved either way (same rule as Level 2)
  const { error: srcErr } = await admin.from('thought_sources').insert({
    thought_id: thought.id,
    user_id: opts.userId,
    source_text: sourceText,
    source_kind: opts.sourceKind,
    char_count: sourceText.length,
    truncated,
  })
  if (srcErr) console.warn('[capture] thought_sources insert failed (thought still saved):', srcErr.message)

  return thought.id as string
}
