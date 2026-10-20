// ============================================================================
// OPEN-BRAIN-MCP — lets any MCP-compatible AI read and search your brain
// ============================================================================
// MCP (Model Context Protocol) is an open standard. An AI app (Claude Desktop
// today, anything else that speaks MCP tomorrow) sends this function small
// JSON messages like "what tools do you have?" or "run search_thoughts with
// query=valuation". This function does the work against YOUR database and
// sends the answer back. The AI never touches the database directly.
//
// DEPLOY WITH:
//   npx supabase functions deploy open-brain-mcp --no-verify-jwt
//
// Claude Desktop can't send a Supabase login token, so --no-verify-jwt opens
// the door — and this function guards itself instead, by checking the
// MCP_ACCESS_KEY password before doing anything at all.
//
// Secrets it reads (Edge Functions → Secrets):
//   MCP_ACCESS_KEY  — the password Claude Desktop must send
//   OWNER_USER_ID   — whose brain this is (same one the Telegram bot uses)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — provided automatically
//
// The service role key skips the Level 2 security rule, so every query below
// filters by OWNER_USER_ID and every insert sets it. Nothing else will.
//
// What the AI can do here is deliberately limited: search, list, read, add.
// There is no delete and no edit tool, so no AI conversation can ever
// destroy anything in your brain.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const MCP_ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

const SERVER_INFO = { name: 'open-brain', version: '1.2.0' }
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Password check ──────────────────────────────────────────────────────────
// Compared in constant time, so an attacker can't guess the key one character
// at a time by measuring how long a wrong answer takes.
function keyMatches(provided: string): boolean {
  if (!MCP_ACCESS_KEY) return false
  const a = new TextEncoder().encode(provided)
  const b = new TextEncoder().encode(MCP_ACCESS_KEY)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

// ── The tools the AI is allowed to use ──────────────────────────────────────
// Each has a name, a plain-English description (the AI reads this to decide
// when to use it), and the inputs it takes.
const TOOLS = [
  {
    name: 'search_thoughts',
    description:
      "Search the user's personal knowledge base (their 'Open Brain'). " +
      'Captures include typed notes, voice notes, Telegram messages, YouTube transcripts, PDFs and web articles. ' +
      'Hybrid search: matches by meaning (paraphrases work) AND by exact words (names, numbers, codes), and looks inside ' +
      'long captures to find the specific passage that answers the query. Each result shows a match score, the passage ' +
      'that matched when it came from inside a long capture, and the thoughts it is linked to in the user\'s thought graph. ' +
      'Long results are trimmed — use get_thought with the id to read one in full.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for — natural words, or an exact name/term, e.g. "how startups get valued" or "Berkus"' },
        limit: { type: 'number', description: 'Max results, 1-25 (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_recent',
    description: "List the most recently saved thoughts in the user's Open Brain, newest first.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many, 1-50 (default 10)' } },
    },
  },
  {
    name: 'get_thought',
    description: 'Read one saved thought in full, by its id (ids come from search_thoughts or list_recent).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The thought id' } },
      required: ['id'],
    },
  },
  {
    name: 'add_thought',
    description:
      "Save a new thought to the user's Open Brain. Only use this when the user asks you to save, remember or note something.",
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The text to save' } },
      required: ['content'],
    },
  },
]

const PREVIEW_CHARS = 1500   // per search/list result — keeps replies readable
const FULL_CHARS = 60_000    // cap for get_thought — a whole long transcript

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

type Row = {
  id: string; content: string; created_at: string
  summary?: string | null; tags?: string[] | null; category?: string | null
  metadata?: Record<string, unknown> | null
}

function formatRow(t: Row, maxChars: number, similarity?: number): string {
  const when = new Date(t.created_at).toISOString().slice(0, 10)
  const body = t.content.length > maxChars
    ? t.content.slice(0, maxChars) + `\n…[trimmed — ${t.content.length.toLocaleString('en-US')} chars total; call get_thought for the full text]`
    : t.content
  const head = [`id: ${t.id}`, `saved: ${when}`]
  if (similarity !== undefined) head.push(`match: ${Math.round(similarity * 100)}%`)
  if (t.category) head.push(`category: ${t.category}`)
  if (t.tags?.length) head.push(`tags: ${t.tags.join(', ')}`)
  return head.join(' · ') + (t.summary ? `\nsummary: ${t.summary}` : '') + `\n${body}`
}

// ── Meaning search helpers ──────────────────────────────────────────────────
const SEARCH_THRESHOLD = 0.3 // wider net than the graph's 0.5 — search should find more
const MAX_RELATED = 3

// Through the embedding gateway; null means "use keyword search instead"
async function embedQuery(query: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ text: query, userId: OWNER_USER_ID, source: 'mcp-search' }),
      signal: AbortSignal.timeout(20_000),
    })
    const d = await res.json().catch(() => ({}))
    if (!Array.isArray(d.embedding)) console.error('[mcp] no embedding:', d.error ?? res.status)
    return Array.isArray(d.embedding) ? d.embedding : null
  } catch (err) {
    console.error('[mcp] embedding call failed:', String(err))
    return null
  }
}

type Related = { id: string; similarity: number; label: string }

// For each result, the thoughts it is linked to in the graph (either direction)
// deno-lint-ignore no-explicit-any
async function linkedNeighbours(db: any, ids: string[]): Promise<Map<string, Related[]>> {
  const out = new Map<string, Related[]>()
  try {
    const list = ids.join(',')
    const { data: links, error } = await db.from('thought_links')
      .select('source_thought_id, target_thought_id, similarity_score')
      .eq('user_id', OWNER_USER_ID)
      .or(`source_thought_id.in.(${list}),target_thought_id.in.(${list})`)
      .order('similarity_score', { ascending: false })
      .limit(200)
    if (error || !links?.length) return out
    const pairs: { from: string; to: string; sim: number }[] = []
    for (const l of links as { source_thought_id: string; target_thought_id: string; similarity_score: number }[]) {
      if (ids.includes(l.source_thought_id)) pairs.push({ from: l.source_thought_id, to: l.target_thought_id, sim: l.similarity_score })
      if (ids.includes(l.target_thought_id)) pairs.push({ from: l.target_thought_id, to: l.source_thought_id, sim: l.similarity_score })
    }
    const otherIds = [...new Set(pairs.map(p => p.to))]
    const { data: others } = await db.from('thoughts')
      .select('id, content, summary').eq('user_id', OWNER_USER_ID).in('id', otherIds)
    const label = new Map<string, string>()
    for (const o of (others ?? []) as { id: string; content: string; summary: string | null }[]) {
      const first = (o.summary?.trim() || o.content.replace(/\s+/g, ' ').trim())
      label.set(o.id, first.length > 140 ? first.slice(0, 140) + '…' : first)
    }
    for (const p of pairs) {
      if (!label.has(p.to)) continue
      const arr = out.get(p.from) ?? []
      if (arr.length < MAX_RELATED && !arr.some(r => r.id === p.to)) arr.push({ id: p.to, similarity: p.sim, label: label.get(p.to)! })
      out.set(p.from, arr)
    }
  } catch (err) {
    console.error('[mcp] linked neighbours failed:', String(err))
  }
  return out
}

type HybridRow = Row & { similarity: number; matched_chunk: string | null; match_source: string }

// When the match came from inside a long capture, show THAT passage — not the
// opening of the document, which may have nothing to do with the question.
function formatHybrid(t: HybridRow): string {
  const sim = t.similarity > 0 ? t.similarity : undefined // 0 = found by exact words only
  if (!t.matched_chunk) return formatRow(t, PREVIEW_CHARS, sim)
  const title = t.content.split('\n')[0].slice(0, 200)
  const header = formatRow({ ...t, content: title }, PREVIEW_CHARS, sim)
  return `${header}\n…(from partway through a longer capture — ${t.content.length.toLocaleString('en-US')} chars total; call get_thought for all of it):\n${t.matched_chunk}`
}

function formatRelated(list?: Related[]): string {
  if (!list?.length) return ''
  return '\nlinked thoughts:\n' + list.map(r => `  ↳ (${Math.round(r.similarity * 100)}%) id: ${r.id} — ${r.label}`).join('\n')
}

const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) })

// ── Running a tool ──────────────────────────────────────────────────────────
async function callTool(name: string, args: Record<string, unknown>) {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  if (name === 'search_thoughts') {
    const query = String(args.query ?? '').trim()
    if (!query) return text('Give me something to search for.', true)
    const limit = clampInt(args.limit, 1, 25, 10)

    // Hybrid search (Level 7): meaning AND exact words, fused into one ranking,
    // checking each long capture's chunks as well as the whole thing.
    // p_user_id is required: this function uses the service role key, which
    // skips row-level security, so the query itself must say whose brain it is.
    const embedding = await embedQuery(query) // null → the database does keyword-only
    const { data, error } = await db.rpc('search_thoughts', {
      query_text: query,
      p_user_id: OWNER_USER_ID,
      query_embedding: embedding ? JSON.stringify(embedding) : null,
      match_threshold: SEARCH_THRESHOLD,
      match_count: limit,
      max_per_document: 2,
    })
    if (!error && data?.length) {
      const rows = data as HybridRow[]
      const related = await linkedNeighbours(db, rows.map(r => r.id))
      const how = embedding ? 'meaning + exact words' : 'exact words only — meaning search unavailable'
      return text(`${rows.length} thought(s) for "${query}" (${how}):\n\n` +
        rows.map(t => formatHybrid(t) + formatRelated(related.get(t.id))).join('\n\n---\n\n'))
    }
    if (error) console.error('[mcp] hybrid search failed, using plain keyword match:', error.message)
    else return text(`Nothing in the brain matches "${query}", by meaning or by exact words. Try describing it differently.`)

    // Last resort (only if the search function itself errored): plain keyword match
    // % and _ are wildcards in ilike — escape them so they're matched literally
    const pattern = '%' + query.replace(/[\\%_]/g, m => '\\' + m) + '%'
    const { data: kw, error: kwErr } = await db.from('thoughts')
      .select('id, content, summary, tags, category, created_at')
      .eq('user_id', OWNER_USER_ID)
      .ilike('content', pattern)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (kwErr) throw kwErr
    if (!kw?.length) return text(`Nothing in the brain matches "${query}".`)
    return text(`${kw.length} thought(s) containing "${query}" (plain keyword match):\n\n` + kw.map(t => formatRow(t, PREVIEW_CHARS)).join('\n\n---\n\n'))
  }

  if (name === 'list_recent') {
    const limit = clampInt(args.limit, 1, 50, 10)
    const { data, error } = await db.from('thoughts')
      .select('id, content, summary, tags, category, created_at')
      .eq('user_id', OWNER_USER_ID)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    if (!data?.length) return text('The brain is empty so far.')
    return text(`${data.length} most recent thought(s):\n\n` + data.map(t => formatRow(t, PREVIEW_CHARS)).join('\n\n---\n\n'))
  }

  if (name === 'get_thought') {
    const id = String(args.id ?? '').trim()
    if (!/^[0-9a-f-]{36}$/i.test(id)) return text('That is not a valid thought id.', true)
    const { data, error } = await db.from('thoughts')
      .select('id, content, summary, tags, category, created_at, metadata')
      .eq('user_id', OWNER_USER_ID)
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) return text('No thought with that id.', true)
    return text(formatRow(data, FULL_CHARS))
  }

  if (name === 'add_thought') {
    const content = String(args.content ?? '').trim()
    if (!content) return text('Nothing to save.', true)
    const { data, error } = await db.from('thoughts')
      // upsert: saving the exact same text twice updates the existing thought
      // instead of creating a duplicate (the unique index from Level 6, Step 0)
      .upsert({ content: content.slice(0, 20_000), user_id: OWNER_USER_ID, metadata: { source: 'mcp' } },
        { onConflict: 'dedup_key,user_id', ignoreDuplicates: false })
      .select('id, created_at')
      .single()
    if (error) throw error
    return text(`Saved to the brain (id: ${data.id}).`)
  }

  return text(`Unknown tool: ${name}`, true)
}

// ── Answering one JSON-RPC message ──────────────────────────────────────────
// JSON-RPC 2.0 is the envelope MCP uses: {"jsonrpc":"2.0","id":1,"method":...}.
// Messages with no id are "notifications" — they never get a reply.
// deno-lint-ignore no-explicit-any
async function handleMessage(msg: any): Promise<unknown | null> {
  const isNotification = msg?.id === undefined || msg?.id === null
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } })

  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request')
  if (isNotification) return null // e.g. notifications/initialized — acknowledged, no reply

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "This server is the user's personal knowledge base. Search it whenever the user refers to something they saved, " +
          'watched, read or noted, or asks what they know about a topic. Search works by meaning, and each result lists ' +
          'linked thoughts — mention those connections when useful. Quote what you find and say when nothing matches.',
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      try {
        return reply(await callTool(name, args))
      } catch (err) {
        console.error(`[mcp] tool ${name} failed:`, err)
        const m = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err)
        return reply(text('The brain could not answer: ' + m, true))
      }
    }
    // Things this server simply doesn't have — answer with empty lists, not errors
    case 'resources/list': return reply({ resources: [] })
    case 'prompts/list': return reply({ prompts: [] })
    default:
      return fail(-32601, `Method not found: ${msg.method}`)
  }
}

// ── The front door ──────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  // 1. Password first, before anything else
  const auth = req.headers.get('Authorization') ?? ''
  const provided = auth.replace(/^Bearer\s+/i, '').trim()
  if (!keyMatches(provided)) {
    return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401)
  }
  if (!OWNER_USER_ID) {
    return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'Server setup incomplete: OWNER_USER_ID secret is missing' } }, 500)
  }

  // 2. This server only answers POSTs (no live event stream) — say so clearly
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { ...corsHeaders, Allow: 'POST, OPTIONS' } })
  }

  // 3. Read the message(s) and answer
  let body: unknown
  try { body = await req.json() } catch {
    return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map(handleMessage))).filter(r => r !== null)
    return replies.length ? jsonResponse(replies) : new Response(null, { status: 202, headers: corsHeaders })
  }
  const r = await handleMessage(body)
  return r === null ? new Response(null, { status: 202, headers: corsHeaders }) : jsonResponse(r)
})
