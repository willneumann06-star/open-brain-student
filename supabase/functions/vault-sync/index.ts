// ============================================================================
// vault-sync — feeds the Obsidian vault on William's Mac
// ============================================================================
// Two actions, both POST, both need the VAULT_SYNC_KEY password:
//   { action: "export" }                 → every thought + every link (no embeddings)
//   { action: "add", content, file? }    → saves a note written in Obsidian's Inbox
//
// The Mac keeps the key in its Keychain and calls this every 15 minutes.
// Without the key this function refuses everything, so the open URL is safe.
// Uses the service role key, so every query is pinned to OWNER_USER_ID.
//
// Secrets: VAULT_SYNC_KEY, OWNER_USER_ID (already set for the other functions)
// Deploy:  npx supabase functions deploy vault-sync --project-ref <ref> --no-verify-jwt
// ============================================================================

import { db, json, OWNER_USER_ID } from '../_shared/bots.ts'

const VAULT_SYNC_KEY = Deno.env.get('VAULT_SYNC_KEY') ?? ''
const PAGE = 1000

// Constant-time compare, so the key can't be guessed one character at a time
function keyMatches(provided: string): boolean {
  if (!VAULT_SYNC_KEY || !provided) return false
  const a = new TextEncoder().encode(provided)
  const b = new TextEncoder().encode(VAULT_SYNC_KEY)
  let diff = a.length ^ b.length
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]
  return diff === 0
}

async function fetchAll(table: string, columns: string, order: string) {
  const supa = db()
  const rows: Record<string, unknown>[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa.from(table).select(columns)
      .eq('user_id', OWNER_USER_ID).order(order).range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...((data ?? []) as Record<string, unknown>[]))
    if (!data || data.length < PAGE) return rows
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!VAULT_SYNC_KEY || !OWNER_USER_ID) return json({ error: 'Setup incomplete: VAULT_SYNC_KEY or OWNER_USER_ID missing' }, 500)

  const provided = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!keyMatches(provided)) return json({ error: 'Unauthorized' }, 401)

  try {
    const body = await req.json().catch(() => ({}))

    if (body.action === 'export') {
      const thoughts = await fetchAll('thoughts', 'id, created_at, category, tags, summary, metadata, content', 'created_at')
      const links = await fetchAll('thought_links', 'source_thought_id, target_thought_id', 'created_at')
      return json({ thoughts, links })
    }

    if (body.action === 'add') {
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      if (!content) return json({ error: 'Empty note' }, 400)
      const file = typeof body.file === 'string' ? body.file.slice(0, 200) : null
      // Same upsert as Telegram/MCP: sending the same note twice updates, never duplicates.
      // Enrichment (tags, summary, embedding, links) runs automatically on insert.
      const { data, error } = await db().from('thoughts').upsert({
        content: content.slice(0, 20_000),
        user_id: OWNER_USER_ID,
        metadata: { source: 'obsidian', ...(file ? { obsidian_file: file } : {}) },
      }, { onConflict: 'dedup_key,user_id', ignoreDuplicates: false }).select('id').single()
      if (error) throw error
      return json({ ok: true, id: data.id })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (err) {
    console.error('[vault-sync]', err)
    return json({ error: String((err as { message?: unknown })?.message ?? err).slice(0, 300) }, 500)
  }
})
