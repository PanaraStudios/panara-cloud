"use node";

import { ConvexError, v } from "convex/values";
import nodemailer from "nodemailer";
import { internalAction } from "../_generated/server";

export const sendSmtp = internalAction({
	args: {
		host: v.string(),
		port: v.number(),
		username: v.string(),
		password: v.string(),
		from: v.string(),
		to: v.array(v.string()),
		subject: v.string(),
		html: v.string(),
		text: v.optional(v.string()),
	},
	handler: async (_ctx, args) => {
		const transporter = nodemailer.createTransport({
			host: args.host,
			port: args.port,
			// Port 465 is implicit TLS; other ports upgrade with STARTTLS.
			secure: args.port === 465,
			auth: args.username
				? { user: args.username, pass: args.password }
				: undefined,
		});
		try {
			await transporter.sendMail({
				from: args.from,
				to: args.to.join(", "),
				subject: args.subject,
				html: args.html,
				text: args.text,
				textEncoding: "base64",
			});
		} catch (error) {
			throw new ConvexError(
				`Failed to send email: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	},
});
