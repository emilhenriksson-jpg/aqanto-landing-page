/**
 * HTML to structured plain text.
 *
 * Headings become markdown headings rather than being flattened away, because the
 * chunker splits on them and a citation is only useful if it can say which section
 * it came from.
 */

import { type HTMLElement, type Node, NodeType, parse } from 'node-html-parser';
import { noTextFound } from '../errors.js';
import {
  capCharacters,
  extensionOf,
  normaliseMimeType,
  tidyText,
  type ExtractedDocument,
  type ExtractionRequest,
  type Extractor,
} from './types.js';

const SKIPPED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'canvas',
  'iframe',
  'template',
  'head',
  'link',
  'meta',
  'object',
  'embed',
  'video',
  'audio',
  'select',
  'option',
  'button',
]);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'dialog',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hgroup',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'ul',
]);

class TextSink {
  private out = '';
  private pendingBreaks = 0;

  write(text: string): void {
    if (text.length === 0) return;
    let value = text;
    if (this.pendingBreaks > 0 || this.out.length === 0) {
      value = value.replace(/^[ \t]+/, '');
      if (value.length === 0) return;
      if (this.out.length > 0) this.out += '\n'.repeat(Math.min(this.pendingBreaks, 2));
      this.pendingBreaks = 0;
    }
    this.out += value;
  }

  lineBreak(count = 1): void {
    if (this.out.length === 0) return;
    this.pendingBreaks = Math.max(this.pendingBreaks, count);
  }

  toString(): string {
    return this.out;
  }
}

export function htmlToText(html: string): string {
  const root = parse(html, { comment: false });
  const sink = new TextSink();

  const title = root.querySelector('title')?.text?.trim();
  const hasHeading = root.querySelector('h1, h2') !== null;
  if (title && !hasHeading) {
    sink.write(`# ${collapse(title)}`);
    sink.lineBreak(2);
  }

  for (const child of root.childNodes) visit(child, sink, false);
  return tidyText(sink.toString());
}

function visit(node: Node, sink: TextSink, preformatted: boolean): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    const text = node.text;
    sink.write(preformatted ? text : collapse(text));
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;

  const element = node as HTMLElement;
  const tag = (element.rawTagName ?? '').toLowerCase();
  if (SKIPPED_TAGS.has(tag)) return;

  const headingLevel = /^h([1-6])$/.exec(tag);
  if (headingLevel) {
    const text = collapse(element.text);
    if (text.length > 0) {
      sink.lineBreak(2);
      sink.write(`${'#'.repeat(Number(headingLevel[1]))} ${text}`);
      sink.lineBreak(2);
    }
    return;
  }

  switch (tag) {
    case 'br':
      sink.lineBreak(1);
      return;
    case 'hr':
      sink.lineBreak(2);
      return;
    case 'img': {
      const alt = collapse(element.getAttribute('alt') ?? '');
      if (alt.length > 0) sink.write(`[bild: ${alt}] `);
      return;
    }
    case 'li': {
      sink.lineBreak(1);
      sink.write(markerFor(element));
      for (const child of element.childNodes) visit(child, sink, preformatted);
      sink.lineBreak(1);
      return;
    }
    case 'td':
    case 'th': {
      const text = collapse(element.text);
      if (text.length > 0) sink.write(`${text} | `);
      return;
    }
    case 'tr': {
      sink.lineBreak(1);
      for (const child of element.childNodes) visit(child, sink, preformatted);
      sink.lineBreak(1);
      return;
    }
    default:
      break;
  }

  const isBlock = BLOCK_TAGS.has(tag);
  if (isBlock) sink.lineBreak(2);
  const nowPreformatted = preformatted || tag === 'pre';
  for (const child of element.childNodes) visit(child, sink, nowPreformatted);
  if (isBlock) sink.lineBreak(2);
}

/** Ordered lists keep their numbers: "steg 3" is only meaningful if 3 survives. */
function markerFor(item: HTMLElement): string {
  const parent = item.parentNode;
  const parentTag = (parent?.rawTagName ?? '').toLowerCase();
  if (!parent || parentTag !== 'ol') return '- ';
  const siblings = parent.childNodes.filter(
    (n) => n.nodeType === NodeType.ELEMENT_NODE && (n as HTMLElement).rawTagName?.toLowerCase() === 'li',
  );
  const index = siblings.indexOf(item);
  return `${index >= 0 ? index + 1 : 1}. `;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

export class HtmlExtractor implements Extractor {
  readonly name = 'html';

  supports(input: { mimeType: string; filename: string }): boolean {
    const mime = normaliseMimeType(input.mimeType);
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return true;
    return ['html', 'htm', 'xhtml'].includes(extensionOf(input.filename));
  }

  async extract(request: ExtractionRequest): Promise<ExtractedDocument> {
    const warnings: string[] = [];
    const html = new TextDecoder('utf-8').decode(request.bytes).replace(/^\uFEFF/, '');
    const text = capCharacters(htmlToText(html), request.limits, warnings);
    if (text.trim().length === 0) throw noTextFound(request.filename);
    return { text, pageCount: null, warnings, extractor: this.name };
  }
}
