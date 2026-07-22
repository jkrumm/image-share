// Hand-written markdown → HTML, no dependency (Stage 3 brief §F). The security
// property is the ORDER: escape every character first, then transform a small
// recognized subset back into real tags. Nothing that wasn't already escaped
// text can ever become a tag, so there is no HTML-injection surface — anything
// unrecognized (an unmatched `<script>`, a bad link scheme, an unbalanced
// bracket) just stays as escaped, inert text.
//
// Supported subset: paragraphs (blank-line separated), single line breaks
// within a paragraph, **bold**, *italic*, `code`, [text](url) (http(s)/mailto
// schemes only — any other scheme drops the link and keeps the text),
// `-`/`*` unordered lists, `#`/`##`/`###` headings.

/** HTML-escape a string for use in text nodes and double-quoted attributes. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

const ALLOWED_LINK_SCHEME = /^(https?:|mailto:)/i

// URL group allows one level of balanced parens (`alert(1)`) without letting
// the match run away and swallow a second link on the same line — matched as
// a repetition of "non-paren chars" or "one balanced (...) span".
const LINK_RE = /\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)/g

// Applied to already-escaped text, in an order chosen so later steps cannot
// re-interpret markup produced by earlier ones: code spans first (their
// content is inert once wrapped), then links, then bold, then italic.
function applyInline(text: string): string {
  let out = text
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`)
  out = out.replace(LINK_RE, (match, label: string, url: string) => {
    const trimmed = url.trim()
    if (!ALLOWED_LINK_SCHEME.test(trimmed)) return label
    return `<a href="${trimmed}" rel="noopener noreferrer" target="_blank">${label}</a>`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, (_match, bold: string) => `<strong>${bold}</strong>`)
  out = out.replace(/\*([^*]+)\*/g, (_match, em: string) => `<em>${em}</em>`)
  return out
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/
const LIST_ITEM_RE = /^[-*]\s+(.*)$/

/** Render a share's markdown `note` (Stage 3 brief §F) into safe HTML. */
export function renderMarkdown(raw: string): string {
  const escaped = escapeHtml(raw)
  const lines = escaped.split(/\r\n|\r|\n/)
  const blocks: string[] = []
  let paragraph: string[] = []
  let list: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push(`<p>${applyInline(paragraph.join('<br>'))}</p>`)
    paragraph = []
  }
  const flushList = (): void => {
    if (list.length === 0) return
    blocks.push(`<ul>${list.map((item) => `<li>${applyInline(item)}</li>`).join('')}</ul>`)
    list = []
  }

  for (const line of lines) {
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1]!.length
      blocks.push(`<h${level}>${applyInline(heading[2]!)}</h${level}>`)
      continue
    }
    const listItem = LIST_ITEM_RE.exec(line)
    if (listItem) {
      flushParagraph()
      list.push(listItem[1]!)
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()

  return blocks.join('\n')
}
