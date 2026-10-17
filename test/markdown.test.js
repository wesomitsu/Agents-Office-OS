import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/markdown.js';

test('renders headings, lists, emphasis, code and links', () => {
  const html = renderMarkdown('## Plan\n\n1. Draft **post**\n2. Use `#launch`\n\n- one\n- *two*\n\nSee [docs](https://example.com).\n\n```js\nconst a = 1 < 2;\n```');
  assert.match(html, /<h4>Plan<\/h4>/);
  assert.match(html, /<ol><li>Draft <strong>post<\/strong><\/li><li>Use <code>#launch<\/code><\/li><\/ol>/);
  assert.match(html, /<ul><li>one<\/li><li><em>two<\/em><\/li><\/ul>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(html, /<pre><code>const a = 1 &lt; 2;<\/code><\/pre>/);
});

test('never lets output inject HTML or script links', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) `<b>`');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href="javascript'));
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
});
