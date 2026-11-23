// The one layout every Panara Cloud email uses: a white 640px sheet on a grey
// page with the logo on top, a title and a line of text, optional detail
// rows, an error block, a button, a note, and a footer. Styles are inline and
// the structure is tables, which is what mail clients render reliably.

export const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

export type EmailStatus = "success" | "error" | "warning";

export type EmailLayout = {
	/** The line a mail client shows next to the subject. */
	preview: string;
	title: string;
	intro: string;
	/** The outcome, as a coloured word above the title. */
	status?: EmailStatus;
	details?: { label: string; value: string }[];
	/** A block of preformatted text: an error message, a log tail. */
	reason?: { label: string; text: string };
	button?: { url: string; label: string };
	/** Small print under the button. */
	note?: string;
	/** Why the recipient got this email; the footer's first line. */
	footer: string;
};

const FONT =
	"Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const INK = "#101828";
const BODY = "#475467";
const PAGE = "#f9fafb";
const RULE = "#eaecf0";
const BRAND = "#623E96";
const BUTTON = "#18181b";
const STATUS: Record<EmailStatus, { color: string; word: string }> = {
	success: { color: "#079455", word: "Successful" },
	error: { color: "#d92d20", word: "Failed" },
	warning: { color: "#dc6803", word: "Needs attention" },
};

const siteUrl = () => (process.env.SITE_URL ?? "").replace(/\/+$/, "");

// The logo is an image only where a mail client can fetch it: a logo URL the
// operator set, or the panel's own icon when it is served over HTTPS. An
// install on a bare IP gets a drawn tile instead of a broken image.
const logoSrc = () => {
	const custom = process.env.PANARA_CLOUD_LOGO_URL;
	if (custom) return custom;
	const site = siteUrl();
	return site.startsWith("https://") ? `${site}/apple-icon` : null;
};

const brand = (size: number) => {
	const src = logoSrc();
	const mark = src
		? `<img src="${escapeHtml(src)}" width="${size}" height="${size}" alt="" style="display:block;border:0;border-radius:${Math.round(size / 4)}px">`
		: `<div style="width:${size}px;height:${size}px;line-height:${size}px;border-radius:${Math.round(size / 4)}px;background:${BRAND};color:#ffffff;font-size:${Math.round(size * 0.6)}px;font-weight:700;text-align:center">P</div>`;
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="vertical-align:middle">${mark}</td><td style="vertical-align:middle;padding-left:10px;font-size:${Math.round(size * 0.6)}px;font-weight:600;color:${INK};letter-spacing:-0.01em">Panara Cloud</td></tr></table>`;
};

const text = (content: string, style: string) =>
	`<p style="margin:0;${style}">${content}</p>`;

/** The email as HTML. Every value is escaped here; pass plain text. */
export function renderEmail(email: EmailLayout): string {
	const details = (email.details ?? [])
		.map(
			(row) =>
				`<tr><td style="padding:8px 16px 8px 0;width:160px;vertical-align:top;font-size:14px;line-height:20px;color:${BODY}">${escapeHtml(row.label)}</td><td style="padding:8px 0;vertical-align:top;font-size:14px;line-height:20px;font-weight:600;color:${INK};word-break:break-word">${escapeHtml(row.value)}</td></tr>`,
		)
		.join("");
	const site = siteUrl();
	const parts = [
		email.status
			? text(
					`<span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${STATUS[email.status].color};margin-right:8px"></span>${STATUS[email.status].word}`,
					`margin-bottom:8px;font-size:14px;line-height:20px;font-weight:600;color:${STATUS[email.status].color}`,
				)
			: "",
		text(
			escapeHtml(email.title),
			`font-size:24px;line-height:32px;font-weight:600;color:${INK}`,
		),
		text(
			escapeHtml(email.intro),
			`margin-top:8px;font-size:16px;line-height:24px;color:${BODY}`,
		),
		details
			? `<div style="height:1px;line-height:1px;font-size:1px;background:${RULE};margin:24px 0">&nbsp;</div><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">${details}</table>`
			: "",
		email.reason
			? `<div style="margin-top:24px;padding:12px 16px;background:${PAGE};border:1px solid ${RULE};border-radius:8px">${text(escapeHtml(email.reason.label), `font-size:14px;line-height:20px;font-weight:600;color:${INK}`)}<pre style="margin:6px 0 0;font-family:${MONO};font-size:12px;line-height:18px;color:${BODY};white-space:pre-wrap;word-break:break-word">${escapeHtml(email.reason.text)}</pre></div>`
			: "",
		email.button
			? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px"><tr><td style="border-radius:8px;background:${BUTTON}"><a href="${escapeHtml(email.button.url)}" style="display:inline-block;padding:12px 20px;font-size:16px;line-height:24px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(email.button.label)}</a></td></tr></table>${text(`Or open this link: <a href="${escapeHtml(email.button.url)}" style="color:${INK};word-break:break-all">${escapeHtml(email.button.url)}</a>`, `margin-top:16px;font-size:14px;line-height:20px;color:${BODY}`)}`
			: "",
		email.note
			? text(
					escapeHtml(email.note),
					`margin-top:24px;font-size:14px;line-height:20px;color:${BODY}`,
				)
			: "",
	].join("");
	const footer = [
		text(
			escapeHtml(email.footer),
			`font-size:14px;line-height:20px;color:${BODY}`,
		),
		`<div style="margin-top:32px">${brand(24)}</div>`,
		site
			? text(
					`<a href="${escapeHtml(site)}" style="color:${INK};text-decoration:none">${escapeHtml(site.replace(/^https?:\/\//, ""))}</a>`,
					`margin-top:20px;font-size:14px;line-height:20px;color:${BODY}`,
				)
			: "",
	].join("");
	return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head><body style="margin:0;padding:0;background:${PAGE};font-family:${FONT}"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(email.preview)}</div><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE}"><tr><td align="center" style="padding:32px 12px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="width:100%;max-width:640px;background:#ffffff;border:1px solid ${RULE};border-radius:12px;font-family:${FONT}"><tr><td style="padding:24px">${brand(32)}</td></tr><tr><td style="padding:8px 24px 32px">${parts}</td></tr><tr><td style="padding:32px 24px;border-top:1px solid ${RULE}">${footer}</td></tr></table></td></tr></table></body></html>`;
}
