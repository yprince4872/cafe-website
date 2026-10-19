// mailer.js — sends an email to the cafe whenever a new reservation comes in.
// If SMTP credentials aren't set in .env, this quietly skips sending and
// just logs to the console instead, so the API still works during local
// testing without email configured.

const nodemailer = require('nodemailer');

const hasSmtpConfig = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;

const transporter = hasSmtpConfig
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

async function sendReservationEmail(reservation) {
  const subject = `New reservation request — ${reservation.name} (${reservation.date} ${reservation.time})`;
  const body = [
    `A new table reservation came in from the website:`,
    ``,
    `Name:    ${reservation.name}`,
    `Phone:   ${reservation.phone}`,
    `Date:    ${reservation.date}`,
    `Time:    ${reservation.time}`,
    `Guests:  ${reservation.guests}`,
    `Message: ${reservation.message || '(none)'}`,
    ``,
    `Reservation ID: ${reservation.id}`,
  ].join('\n');

  if (!transporter) {
    console.log('[mailer] SMTP not configured — skipping email. Reservation details:\n' + body);
    return { sent: false, reason: 'smtp-not-configured' };
  }

  try {
    await transporter.sendMail({
      from: process.env.NOTIFY_FROM || process.env.SMTP_USER,
      to: process.env.NOTIFY_TO || process.env.SMTP_USER,
      subject,
      text: body,
    });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] Failed to send reservation email:', err.message);
    return { sent: false, reason: 'send-failed' };
  }
}

async function sendOrderEmail(order) {
  const items = JSON.parse(order.items);
  const itemLines = items.map((i) => `  • ${i.qty} x ${i.name}  (₹${i.price} each)`).join('\n');
  const payLine = order.payment_method === 'upi'
    ? `Payment: UPI — customer says they paid ₹${order.total}. UTR: ${order.payment_ref || 'n/a'}. Check your UPI app, then mark "Payment received" in the admin panel.`
    : 'Payment: Cash — pay at cafe / on delivery';

  const isDineIn = order.order_type === 'dine-in' && order.table_number;
  const subject = isDineIn
    ? `New food order — TABLE ${order.table_number} — ${order.name} (₹${order.total})`
    : `New food order — ${order.name} (₹${order.total})`;
  const body = [
    `A new order came in from the website:`,
    ``,
    `Name:    ${order.name}`,
    `Phone:   ${order.phone}`,
    isDineIn ? `Type:    DINE-IN — TABLE ${order.table_number}` : `Type:    ${order.order_type}`,
    order.address ? `Address: ${order.address}` : null,
    `Notes:   ${order.notes || '(none)'}`,
    ``,
    `Items:`,
    itemLines,
    ``,
    `Total: ₹${order.total}`,
    payLine,
    ``,
    `Order ID: ${order.id}`,
  ]
    .filter(Boolean)
    .join('\n');

  if (!transporter) {
    console.log('[mailer] SMTP not configured — skipping email. Order details:\n' + body);
    return { sent: false, reason: 'smtp-not-configured' };
  }

  try {
    await transporter.sendMail({
      from: process.env.NOTIFY_FROM || process.env.SMTP_USER,
      to: process.env.NOTIFY_TO || process.env.SMTP_USER,
      subject,
      text: body,
    });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] Failed to send order email:', err.message);
    return { sent: false, reason: 'send-failed' };
  }
}

module.exports = { sendReservationEmail, sendOrderEmail };
