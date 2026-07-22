import { describe, expect, it } from 'bun:test'
import { escapeHtml, renderMarkdown } from './markdown.js'

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('renderMarkdown', () => {
  it('wraps a single line in a paragraph', () => {
    expect(renderMarkdown('hello world')).toBe('<p>hello world</p>')
  })

  it('joins consecutive lines within a paragraph with <br>, blank lines start a new paragraph', () => {
    const out = renderMarkdown('line one\nline two\n\nsecond paragraph')
    expect(out).toBe('<p>line one<br>line two</p>\n<p>second paragraph</p>')
  })

  it('transforms bold, italic, and code', () => {
    expect(renderMarkdown('**bold** and *italic* and `code`')).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>',
    )
  })

  it('renders headings level 1-3', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>')
    expect(renderMarkdown('## Subtitle')).toBe('<h2>Subtitle</h2>')
    expect(renderMarkdown('### Small')).toBe('<h3>Small</h3>')
  })

  it('renders unordered lists from - or * prefixed lines', () => {
    expect(renderMarkdown('- one\n- two\n* three')).toBe(
      '<ul><li>one</li><li>two</li><li>three</li></ul>',
    )
  })

  it('links http(s) and mailto schemes, dropping the link (keeping the text) for anything else', () => {
    expect(renderMarkdown('[site](https://example.com)')).toBe(
      '<p><a href="https://example.com" rel="noopener noreferrer" target="_blank">site</a></p>',
    )
    expect(renderMarkdown('[mail](mailto:a@b.com)')).toBe(
      '<p><a href="mailto:a@b.com" rel="noopener noreferrer" target="_blank">mail</a></p>',
    )
    expect(renderMarkdown('[bad](javascript:alert(1))')).toBe('<p>bad</p>')
    expect(renderMarkdown('[bad](data:text/html,x)')).toBe('<p>bad</p>')
  })

  it('escapes a raw <script> tag instead of rendering it', () => {
    const out = renderMarkdown('before <script>alert(1)</script> after')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('never turns a javascript: URL into an href, even nested in other markup', () => {
    const out = renderMarkdown('**[click me](javascript:alert(1))**')
    expect(out).not.toContain('href="javascript:')
    expect(out).toContain('<strong>click me</strong>')
  })

  it('leaves nested/unbalanced brackets as inert escaped text instead of crashing or half-matching', () => {
    const out = renderMarkdown('[outer [inner] text](https://example.com)')
    expect(out).not.toContain('<a ')
    expect(out).toContain('[outer [inner] text](https://example.com)')
  })

  it('unrecognized syntax stays as escaped plain text', () => {
    expect(renderMarkdown('50% > 40% && true')).toBe('<p>50% &gt; 40% &amp;&amp; true</p>')
  })
})
