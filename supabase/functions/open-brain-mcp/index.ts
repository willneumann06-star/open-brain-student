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

const SERVER_INFO = { name: 'open-brain', version: '1.0.0' }
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
      "Search the user's personal knowledge base (their 'Open Brain') for saved thoughts containing a word or phrase. " +
      'Captures include typed notes, voice notes, Telegram messages, YouTube transcripts, PDFs and web articles. ' +
      'This is keyword search: try several short keywords or synonyms if the first search finds nothing. ' +
      'Long results are trimmed — use get_thought with the id to read one in full.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Word or short phrase to look for, e.g. "valuation" or "term sheet"' },
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

type Row = { id: string; content: string; created_at: string; metadata?: Record<string, unknown> | null }

function formatRow(t: Row, maxChars: number): string {
  const when = new Date(t.created_at).toISOString().slice(0, 10)
  const body = t.content.length > maxChars
    ? t.content.slice(0, maxChars) + `\n…[trimmed — ${t.content.length.toLocaleString('en-US')} chars total; call get_thought for the full text]`
    : t.content
  return `id: ${t.id}\nsaved: ${when}\n${body}`
}

const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) })

// ── Running a tool ──────────────────────────────────────────────────────────
async function callTool(name: string, args: Record<string, unknown>) {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  if (name === 'search_thoughts') {
    const query = String(args.query ?? '').trim()
    if (!query) return text('Give me something to search for.', true)
    const limit = clampInt(args.limit, 1, 25, 10)
    // % and _ are wildcards in ilike — escape them so they're matched literally
    const pattern = '%' + query.replace(/[\\%_]/g, m => '\\' + m) + '%'
    const { data, error } = await db.from('thoughts')
      .select('id, content, created_at')
      .eq('user_id', OWNER_USER_ID)
      .ilike('content', pattern)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    if (!data?.length) return text(`No thoughts contain "${query}". Try a shorter keyword or a synonym.`)
    return text(`${data.length} thought(s) containing "${query}":\n\n` + data.map(t => formatRow(t, PREVIEW_CHARS)).join('\n\n---\n\n'))
  }

  if (name === 'list_recent') {
    const limit = clampInt(args.limit, 1, 50, 10)
    const { data, error } = await db.from('thoughts')
      .select('id, content, created_at')
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
      .select('id, content, created_at, metadata')
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
      .insert({ content: content.slice(0, 20_000), user_id: OWNER_USER_ID, metadata: { source: 'mcp' } })
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
          'watched, read or noted, or asks what they know about a topic. Quote what you find and say when nothing matches.',
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
