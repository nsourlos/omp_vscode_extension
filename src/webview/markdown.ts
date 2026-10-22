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
		// A Mermaid block, as code the page draws once its closing fence has come (media/chat.js);
		// while a reply streams in, the block is still open and stays code.
		code: ({ text, lang, raw }) => {
			if (lang?.trim().toLowerCase() !== "mermaid") return false;
			const complete = /\n[ \t]*(`{3,}|~{3,})[ \t]*$/.test(raw.trimEnd());
			return `<div class="mermaid-block" data-complete="${complete}"><pre><code class="language-mermaid">${escapeHtml(text)}</code></pre></div>`;
		},
	},
});

export function toHtml(text: string): string {
	return DOMPurify.sanitize(markdown.parse(text) as string);
}

/**
 * Mermaid source with a mistake models often make taken out, or the source as it was: a quoted
 * label that starts with a backtick (`"`omp acp` process"`) is read as a markdown string, which must
 * be wrapped in backticks whole, so Mermaid stops with "Lexical error". Such labels lose their
 * backticks; one wrapped whole (`"`**bold**`"`), or with backticks only further on, is valid and kept.
 */
export function fixMermaidLabels(source: string): string {
	return source.replace(/"([^"\n]*)"/g, (label, text: string) =>
		text.startsWith("`") && !/^`[^`]*`$/.test(text) ? `"${text.replace(/`/g, "")}"` : label,
	);
}

/**
 * A diagram Mermaid drew, safe to put on the page: SVG with its own styles, and the HTML some
 * diagrams put in their labels (foreignObject); no scripts, event handlers or outside links.
 */
export function sanitizeSvg(svg: string): string {
	return DOMPurify.sanitize(svg, {
		USE_PROFILES: { svg: true, svgFilters: true, html: true },
		ADD_TAGS: ["foreignObject", "style"],
		// Mermaid writes most labels as HTML inside <foreignObject>, which DOMPurify empties unless it
		// is named here (its default lets HTML into MathML's annotation-xml only).
		HTML_INTEGRATION_POINTS: { foreignobject: true },
	});
}
