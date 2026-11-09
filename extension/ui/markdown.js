// Short code stays on one line; longer code is usually a path or a link and may break anywhere.
const LONG_CODE_CHARS = 24;
function renderInline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, (_match, code) => `<code${code.length > LONG_CODE_CHARS ? ' class="long"' : ''}>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');
}

function renderMarkdown(source) {
  const lines = String(source ?? '').split('\n');
  const out = [];
  let list = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flushParagraph();
      flushList();
      const code = [];
      for (i += 1; i < lines.length && !lines[i].startsWith('```'); i += 1) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.*)/);
    const item = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)/);
    if (heading) {
      flushParagraph();
      flushList();
      out.push(`<h3>${renderInline(heading[1])}</h3>`);
    } else if (item) {
      flushParagraph();
      const kind = item[1] ? 'ol' : 'ul';
      if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${renderInline(item[2])}</li>`);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return `<div class="md">${out.join('')}</div>`;
}
