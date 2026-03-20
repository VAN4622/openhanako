/**
 * Markdown 渲染器
 *
 * 包装全局 markdown-it 实例（由 lib/markdown-it.min.js 提供 window.markdownit）。
 * 此处独立创建并管理 md 实例。
 */

import mk from '@traptitech/markdown-it-katex';
import 'katex/dist/katex.min.css';

interface MarkdownItInstance {
  render(src: string): string;
  use(plugin: any, ...args: any[]): MarkdownItInstance;
  core: { ruler: { after: (name: string, ruleName: string, fn: (state: unknown) => void) => void } };
}

let _md: MarkdownItInstance | null = null;

export function getMd(): MarkdownItInstance {
  if (_md) return _md;
  const md = window.markdownit({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  }) as unknown as MarkdownItInstance;
  md.use(mk);
  _md = md;
  return _md;
}

export function renderMarkdown(src: string): string {
  return getMd().render(src);
}
