/** Markdown for the chat page: GitHub-style (tables, lists, code, links), sanitised before it reaches the page. */
import DOMPurify from "dompurify";
import { Marked } from "marked";

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Replies are markdown, not HTML: a tag written in prose ("wrap it in a <form>") is shown as
 * written, and a line starting with a tag is still a markdown paragraph, so markdown around it
 * renders. The one exception is <br>, which models use for line breaks inside table cells.
 * Single newlines are line breaks, as in a chat.
 */
const markdown = new Marked({
	gfm: true,
	breaks: true,
	async: false,
	tokenizer: {
		html: () => undefined, // no raw HTML blocks: such lines are parsed as markdown paragraphs
	},
	renderer: {
		html: ({ text }) => (/^<br\s*\/?>$/i.test(text) ? "<br>" : escapeHtml(text)),
	},
});

export function toHtml(text: string): string {
	return DOMPurify.sanitize(markdown.parse(text) as string);
}
