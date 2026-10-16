/** Markdown for the chat page: GitHub-style (tables, lists, code, links), sanitised before it reaches the page. */
import DOMPurify from "dompurify";
import { marked } from "marked";

export function toHtml(text: string): string {
	return DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }));
}
