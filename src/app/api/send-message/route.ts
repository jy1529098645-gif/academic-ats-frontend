import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/send-message
 *
 * Sends a user message to jy1529098645@gmail.com via Gmail SMTP.
 *
 * Requires these env vars in .env.local (never commit them):
 *   EMAIL_USER=jy1529098645@gmail.com
 *   EMAIL_PASS=<your Gmail App Password>
 *
 * To get an App Password:
 *   Google Account → Security → 2-Step Verification → App passwords → create one
 *
 * If the env vars are missing the request still succeeds (message is saved
 * client-side as danmu only).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { text?: string; isPublic?: boolean };
    const text = String(body.text ?? "").trim();
    if (!text) {
      return NextResponse.json({ error: "Message is empty" }, { status: 400 });
    }

    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!user || !pass) {
      // No email config — silently succeed so the UI still works
      return NextResponse.json({ ok: true, note: "Email not configured (EMAIL_USER / EMAIL_PASS missing)" });
    }

    // Dynamic import so build doesn't fail if nodemailer is somehow absent
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport({
      service: "gmail",
      auth: { user, pass },
    });

    const visibility = body.isPublic ? "🟢 PUBLIC" : "🔒 PRIVATE";
    await transporter.sendMail({
      from: user,
      to: "jy1529098645@gmail.com",
      subject: `[Academic ATS] ${visibility} message from user`,
      text: [
        `Visibility: ${visibility}`,
        `Message:\n${text}`,
        `\nTimestamp: ${new Date().toISOString()}`,
      ].join("\n"),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[send-message] error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
