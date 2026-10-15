// ============================================================================
// CAPTURE-YOUTUBE — paste a YouTube link, the transcript lands in your brain
// ============================================================================
// WHY THIS FILE LOOKS COMPLICATED — read this before changing anything:
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a data centre — which is exactly what a Supabase function runs in. Code
// that works perfectly on your laptop fails once deployed. That isn't a bug in
// your code; it's YouTube treating servers differently from people.
//
// So we try several routes and take the first one that works:
//
//   1. SUPADATA    — a service built for this job. It fetches from home
//                    internet connections, so it gets real transcripts.
//                    Free tier ≈ 100 videos/month. Optional: with no
//                    SUPADATA_API_KEY secret, we skip straight to route 2.
//   2. INNERTUBE   — YouTube's own internal app API. We introduce ourselves
//                    as the iPhone app, then the Android app, which YouTube
//                    still serves properly from a data centre. Free, no key,
//                    works often but not always.
//   3. DESCRIPTION — if no captions can be had, save the title + description
//                    so you still capture something. Clearly labelled, so
//                    you're never fooled into thinking it's the transcript.
//
// DEPLOY WITH:  npx supabase functions deploy capture-youtube
// No AI summary yet — that arrives with Level 5's agent.
// ============================================================================

import { decodeEntities } from '../_shared/text.ts'
import { adminClient, corsHeaders, getCaller, json, saveCapture } from '../_shared/capture.ts'

const SUPADATA_KEY = Deno.env.get('SUPADATA_API_KEY') ?? '' // optional

interface VideoContent {
  content: string
  hasTranscript: boolean
  via: 'supadata' | 'innertube' | 'description'
  description?: string
}

function extractVideoId(input: string): string | null {
  const s = input.trim()
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  if (m) return m[1]
  return /^[a-zA-Z0-9_-]{11}$/.test(s) ? s : null
}

// Title via oEmbed — lightweight, no key, almost always works
async function fetchTitle(videoUrl: string): Promise<{ title: string; author: string } | null> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(videoUrl)}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const d = await res.json()
      return { title: decodeEntities(d?.title ?? ''), author: decodeEntities(d?.author_name ?? '') }
    }
  } catch { /* fall through */ }
  return null
}

// ── ROUTE 1: Supadata ───────────────────────────────────────────────────────
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) return null
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&lang=en`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(25_000) },
    )
    if (!res.ok) {
      // 402 almost always means the free monthly quota is used up
      console.log(`[youtube] Supadata HTTP ${res.status} — trying the next route`)
      return null
    }
    const data = await res.json()
    const transcript = (typeof data?.content === 'string'
      ? data.content
      : (data?.content ?? []).map((s: { text?: string }) => s.text ?? '').join(' '))
      .replace(/\s+/g, ' ').trim()
    if (!transcript) return null
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`)
    return { content: decodeEntities(transcript), hasTranscript: true, via: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

// ── ROUTE 2 + 3: Innertube, falling back to the description ────────────────
async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: { clientName: 'IOS', clientVersion: '19.29.1', deviceMake: 'Apple', deviceModel: 'iPhone17,2', osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US' },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en', gl: 'US' },
    },
  ]

  // deno-lint-ignore no-explicit-any
  let best: any = null
  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) { console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`); continue }
      const result = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length) { best = result; break }
      if (!best) best = result // keep it — even without captions it has the description
      console.log(`[youtube] Innertube ${client.name}: no caption tracks`)
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err))
    }
  }
  if (!best) return null

  const description: string = best?.videoDetails?.shortDescription ?? ''
  const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  if (Array.isArray(tracks) && tracks.length) {
    // Prefer human-written English, then auto-generated English, then anything
    // deno-lint-ignore no-explicit-any
    const track = tracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr')
      // deno-lint-ignore no-explicit-any
      ?? tracks.find((t: any) => String(t.languageCode ?? '').startsWith('en'))
      ?? tracks[0]
    try {
      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })
      if (capRes.ok) {
        const xml = await capRes.text()
        // Caption XML looks like: <text start="1.2" dur="3.4">words here</text>
        // (some formats use <p> or <s> instead — handle those too)
        const pieces = [...xml.matchAll(/<(?:text|s|p)\b[^>]*>([^<]*)<\/(?:text|s|p)>/g)].map(m => m[1])
        // Caption files are escaped twice (an apostrophe arrives as &amp;#39;),
        // so decode twice: once for the XML layer, once for the HTML inside it
        const transcript = decodeEntities(decodeEntities(pieces.join(' '))).replace(/\s+/g, ' ').trim()
        if (transcript) {
          console.log(`[youtube] Innertube transcript OK — ${transcript.length} chars`)
          return { content: transcript, hasTranscript: true, via: 'innertube', description }
        }
      }
    } catch (err) {
      console.error('[youtube] caption download error:', String(err))
    }
  }

  // ROUTE 3 — no captions to be had. Use the description.
  const keywords: string = (best?.videoDetails?.keywords as string[] | undefined)?.join(', ') ?? ''
  if (description || keywords) {
    console.log(`[youtube] falling back to description — ${description.length} chars`)
    return {
      content: [description, keywords ? `Keywords: ${keywords}` : ''].filter(Boolean).join('\n\n'),
      hasTranscript: false,
      via: 'description',
    }
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const admin = adminClient()
    const user = await getCaller(req, admin)
    if (!user) return json({ ok: false, error: 'Not signed in' }, 401)

    const body = await req.json().catch(() => ({}))
    const videoId = extractVideoId(String(body?.url ?? ''))
    if (!videoId) {
      return json({ ok: false, error: 'That does not look like a YouTube link. Expected something like https://www.youtube.com/watch?v=…' }, 400)
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const meta = await fetchTitle(videoUrl)
    const title = meta?.title || `Video ${videoId}`

    // First route that works wins
    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId))
    if (!result) {
      return json({ ok: false, error: 'Could not read anything from that video. It may be private, age-restricted or region-locked — paste the transcript by hand instead.' }, 422)
    }

    const label = result.hasTranscript ? '' : '(No transcript available — this is the video description)\n\n'
    const thoughtId = await saveCapture(admin, {
      userId: user.id,
      content: `📹 YouTube: ${title}\n${videoUrl}\n\n${label}${result.content}`,
      metadata: {
        video_id: videoId,
        video_url: videoUrl,
        title,
        channel: meta?.author || null,
        has_transcript: result.hasTranscript,
        fetched_via: result.via,
      },
      sourceText: result.content,
      sourceKind: result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
    })

    return json({
      ok: true,
      id: thoughtId,
      title,
      has_transcript: result.hasTranscript,
      fetched_via: result.via,
      chars: result.content.length,
    })
  } catch (err) {
    console.error('[capture-youtube] failed:', String(err))
    return json({ ok: false, error: String(err) }, 500)
  }
})
