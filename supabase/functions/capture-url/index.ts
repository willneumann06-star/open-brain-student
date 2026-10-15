// ============================================================================
// CAPTURE-URL — paste a link, the article's text lands in your brain
// ============================================================================
// WHY THIS RUNS ON A SERVER: browsers forbid a web page from reading other
// websites (that rule is called CORS, and it's there for good security
// reasons). A server has no such limit. So your app hands the link to this
// function, and this function does the fetching.
//
// DEPLOY WITH:  npx supabase functions deploy capture-url
// (No --no-verify-jwt here: only your logged-in app calls this one, so
//  Supabase's normal login check at the door is exactly what we want.)
//
// No AI summary yet — that needs an AI key, which arrives in Level 5. For now
// it saves the readable text itself; Level 5's agent summarises later.
// ============================================================================

import { decodeEntities } from '../_shared/text.ts'
import { adminClient, corsHeaders, getCaller, json, saveCapture } from '../_shared/capture.ts'

const MAX_BYTES = 3_000_000 // don't try to swallow a 50MB page

// Simple HTML → readable text. Strip the machinery (scripts, menus, footers),
// keep paragraph breaks, drop the remaining tags. Not perfect on every site,
// but handles articles and blog posts well.
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : ''

  // If the page marks up its article properly, use just that part
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text: cleaned }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const admin = adminClient()
    const user = await getCaller(req, admin)
    if (!user) return json({ ok: false, error: 'Not signed in' }, 401)

    const body = await req.json().catch(() => ({}))
    let url = String(body?.url ?? '').trim()
    if (!url) return json({ ok: false, error: 'A link is required' }, 400)
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url // add https:// only if no scheme was given

    // Only http(s) — stops anyone using this to poke at internal addresses
    let parsed: URL
    try { parsed = new URL(url) } catch { return json({ ok: false, error: 'That is not a valid web address' }, 400) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json({ ok: false, error: 'Only http and https links are supported' }, 400)
    }
    const host = parsed.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) {
      return json({ ok: false, error: 'That address is not allowed' }, 400)
    }

    // Identify as a normal browser — some sites refuse anything that looks automated
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    if (!pageRes.ok) {
      return json({ ok: false, error: `That page returned an error (HTTP ${pageRes.status}). It may need a login or block automated readers — paste the text in by hand instead.` }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (contentType.includes('pdf')) {
      return json({ ok: false, error: 'That link is a PDF. Download it and use the PDF tab instead.' }, 415)
    }
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return json({ ok: false, error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page.` }, 415)
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) return json({ ok: false, error: 'That page is too large to process' }, 413)

    const { title: pageTitle, text } = htmlToText(raw)
    if (text.length < 200) {
      return json({
        ok: false,
        error: 'Almost no readable text was found. The page probably builds itself with JavaScript or sits behind a paywall. Paste the text in by hand instead.',
      }, 422)
    }

    const finalUrl = pageRes.url || parsed.toString()
    const title = pageTitle || new URL(finalUrl).hostname.replace(/^www\./, '')

    const thoughtId = await saveCapture(admin, {
      userId: user.id,
      content: `🔗 ${title}\n${finalUrl}\n\n${text}`,
      metadata: { url: finalUrl, title, hostname: new URL(finalUrl).hostname, captured_via: 'capture-url' },
      sourceText: text,
      sourceKind: 'web',
    })

    return json({ ok: true, id: thoughtId, title, chars: text.length, preview: text.slice(0, 200) })
  } catch (err) {
    console.error('[capture-url] failed:', String(err))
    const msg = String(err).includes('TimeoutError') || String(err).toLowerCase().includes('timed out')
      ? 'That page took too long to respond.'
      : String(err)
    return json({ ok: false, error: msg }, 500)
  }
})
