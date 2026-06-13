'use client';

/**
 * MarkdownText — assistant reply renderer for the embedded chat.
 * Wraps @assistant-ui/react-markdown's MarkdownTextPrimitive; visual styling
 * lives in .mx-prose (src/styles/ds-components.css) so the markdown output
 * reads in the same observatory voice as the rest of the console.
 */

import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="mx-prose" />;
}
