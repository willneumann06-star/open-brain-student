// ============================================================================
// SHARED TEXT HELPERS
// ============================================================================
// decodeEntities() used to live separately (and slightly differently) inside
// capture-url and capture-youtube. One copy here now, so a fix to one capture
// path is a fix to both.
//
// WHY THE FULLER ENTITY LIST
// The original table only covered the five ASCII entities every HTML tutorial
// mentions (&amp; &lt; &gt; &quot; &#39;) plus numeric escapes. Real articles
// are full of named entities that table never touched — curly quotes, em
// dashes, accented letters — and they were surviving into saved thoughts as
// literal "&rsquo;" / "&mdash;" / "&eacute;" text. Measured on a realistic
// paragraph of prose: about 40% of the punctuation and accented characters
// came through undecoded. It hits Spanish captures hardest — &iexcl; &iquest;
// &ntilde; &aacute; and friends are everywhere in ordinary Spanish writing,
// and this kit is bilingual.
//
// ORDER MATTERS FOR &amp;
// Decode &amp; before anything else and a double-escaped sequence like
// "&amp;lt;" silently turns into "&lt;" and then, if lt is decoded after,
// into a literal "<" — re-materialising markup an author deliberately
// escaped. So &amp; (and its numeric form, &#38;) decode LAST, after every
// other entity has already had its one chance to match.
// ============================================================================

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', quot: '"', apos: "'",
  lt: '<', gt: '>',
  // punctuation
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…',
  laquo: '«', raquo: '»',
  // currency / symbols
  pound: '£', euro: '€', cent: '¢', yen: '¥',
  copy: '©', reg: '®', trade: '™', deg: '°',
  times: '×', divide: '÷', plusmn: '±',
  frac12: '½', frac14: '¼', frac34: '¾',
  // Spanish / accented Latin — the ones that were hitting bilingual captures hardest
  iexcl: '¡', iquest: '¿',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ',
  uuml: 'ü', Uuml: 'Ü', ouml: 'ö', Ouml: 'Ö', auml: 'ä', Auml: 'Ä',
  ccedil: 'ç', Ccedil: 'Ç',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ',
  oslash: 'ø', Oslash: 'Ø', szlig: 'ß',
}

export function decodeEntities(s: string): string {
  return s
    // every entity EXCEPT amp gets its one pass first — single combined regex,
    // so none of these can create a NEW "&word;" sequence for a later pass to
    // (wrongly) decode again
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name === 'amp' ? m : NAMED_ENTITIES[name] ?? m))
    .replace(/&#(?!0*38;)(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x(?!0*26;)([0-9a-fA-F]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    // amp (named and numeric) decodes last
    .replace(/&amp;/g, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&')
}
