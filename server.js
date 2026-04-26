// ================================================
// GATEPASS BAMISHILE · SERVER v1.1
// Built by IGATA Consulting Technologies
// Updates: Clean WhatsApp messages, QR code image
// ================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const twilio = require('twilio');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const cors = require('cors');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const REPORT_EMAIL = process.env.REPORT_EMAIL;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || 'https://gatepass-bamishile-production.up.railway.app';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ================================================
// QR CODE STORAGE — serve QR images from memory
// ================================================
const qrStore = new Map();

app.get('/qr/:passCode', async (req, res) => {
  const passCode = req.params.passCode.toUpperCase();
  if (qrStore.has(passCode)) {
    const buf = qrStore.get(passCode);
    res.setHeader('Content-Type', 'image/png');
    res.send(buf);
  } else {
    try {
      const buf = await QRCode.toBuffer(passCode, {
        type: 'png',
        width: 400,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
      qrStore.set(passCode, buf);
      res.setHeader('Content-Type', 'image/png');
      res.send(buf);
    } catch {
      res.status(404).send('Not found');
    }
  }
});

// ================================================
// HELPERS
// ================================================
async function generatePassCode() {
  let code, exists;
  do {
    const digits = Math.floor(1000 + Math.random() * 9000);
    code = `BS-${digits}`;
    const { data } = await supabase
      .from('visitors')
      .select('id')
      .eq('pass_code', code)
      .single();
    exists = !!data;
  } while (exists);
  return code;
}

async function sendWhatsApp(to, message, mediaUrl = null) {
  const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:+${to}`;
  const payload = {
    from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
    to: formattedTo,
    body: message,
  };
  if (mediaUrl) payload.mediaUrl = [mediaUrl];
  await twilioClient.messages.create(payload);
}

async function writeLog(passCode, action, performedBy, note = '') {
  await supabase.from('logs').insert({
    pass_code: passCode,
    action,
    performed_by: performedBy,
    note,
  });
}

function getTodayMidnight() {
  const now = new Date();
  const lagos = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  lagos.setHours(23, 59, 59, 999);
  return lagos;
}

function getTomorrowMidnight() {
  const midnight = getTodayMidnight();
  midnight.setDate(midnight.getDate() + 1);
  return midnight;
}

function formatTime(isoString) {
  if (!isoString) return 'N/A';
  return new Date(isoString).toLocaleTimeString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });
}

function formatDate(isoString) {
  if (!isoString) return 'N/A';
  return new Date(isoString).toLocaleDateString('en-NG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Africa/Lagos',
  });
}

// ================================================
// WHATSAPP WEBHOOK
// ================================================
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  const body = (req.body.Body || '').trim();
  const from = (req.body.From || '').replace('whatsapp:+', '');
  const upperBody = body.toUpperCase();

  try {
    const { data: resident } = await supabase
      .from('residents')
      .select('*')
      .eq('whatsapp_number', from)
      .eq('is_active', true)
      .single();

    if (!resident) {
      await sendWhatsApp(from,
        `Your number is not registered on GatePass Bamishile Estate.\n\nPlease contact the estate ExCo to register.\n\nThank you.`
      );
      return;
    }

    // ── CANCEL ──
    if (upperBody.startsWith('CANCEL ')) {
      const passCode = body.split(' ')[1]?.toUpperCase();
      if (!passCode) {
        await sendWhatsApp(from, `Please include the pass code.\nExample: CANCEL BS-4821`);
        return;
      }
      const { data: pass } = await supabase
        .from('visitors')
        .select('*')
        .eq('pass_code', passCode)
        .eq('resident_id', resident.id)
        .single();

      if (!pass) {
        await sendWhatsApp(from, `Pass ${passCode} not found or does not belong to your house.`);
        return;
      }
      if (pass.status === 'checked_in') {
        await sendWhatsApp(from, `Cannot cancel ${passCode}. Visitor has already entered the estate.`);
        return;
      }
      if (['checked_out', 'cancelled', 'expired'].includes(pass.status)) {
        await sendWhatsApp(from, `Pass ${passCode} is already ${pass.status}.`);
        return;
      }
      await supabase.from('visitors').update({ status: 'cancelled' }).eq('pass_code', passCode);
      await writeLog(passCode, 'cancelled', resident.resident_name, 'Cancelled by resident');
      await sendWhatsApp(from,
        `Pass ${passCode} has been cancelled.\n\nYour visitor will not be admitted with this pass.`
      );
      return;
    }

    // ── STATUS ──
    if (upperBody.startsWith('STATUS ')) {
      const passCode = body.split(' ')[1]?.toUpperCase();
      const { data: pass } = await supabase
        .from('visitors').select('*').eq('pass_code', passCode).single();
      if (!pass) {
        await sendWhatsApp(from, `Pass ${passCode} not found.`);
        return;
      }
      await sendWhatsApp(from,
        `Pass Status: ${passCode}\n\n` +
        `Visitor: ${pass.visitor_name}\n` +
        `Status: ${pass.status.toUpperCase()}\n` +
        `Entry: ${formatTime(pass.entry_time)}\n` +
        `Exit: ${formatTime(pass.exit_time)}`
      );
      return;
    }

    // ── VISIT ──
    if (upperBody.startsWith('VISIT ')) {
      const parts = body.split(' ');
      if (parts.length < 3) {
        await sendWhatsApp(from,
          `Please use this format:\nVISIT [name] today\n\nExamples:\nVISIT John Doe today\nVISIT John Doe tomorrow\nVISIT John Doe 08012345678 today`
        );
        return;
      }

      const datePart = parts[parts.length - 1].toLowerCase();
      if (!['today', 'tomorrow'].includes(datePart)) {
        await sendWhatsApp(from,
          `Please end your message with "today" or "tomorrow".\n\nExample:\nVISIT John Doe today`
        );
        return;
      }

      let visitorPhone = '';
      let visitorName = '';
      const phonePattern = /^0[789][01]\d{8}$/;

      if (phonePattern.test(parts[parts.length - 2])) {
        visitorPhone = parts[parts.length - 2];
        visitorName = parts.slice(1, parts.length - 2).join(' ');
      } else {
        visitorName = parts.slice(1, parts.length - 1).join(' ');
      }

      if (!visitorName) {
        await sendWhatsApp(from, `Please include your visitor's name.\nExample: VISIT John Doe today`);
        return;
      }

      const validFrom = new Date();
      const validTo = datePart === 'tomorrow' ? getTomorrowMidnight() : getTodayMidnight();
      const passCode = await generatePassCode();

      await supabase.from('visitors').insert({
        pass_code: passCode,
        visitor_name: visitorName,
        visitor_phone: visitorPhone,
        resident_id: resident.id,
        house_number: resident.house_number,
        valid_from: validFrom.toISOString(),
        valid_to: validTo.toISOString(),
        status: 'active',
      });

      await writeLog(passCode, 'created', resident.resident_name,
        `Created for ${visitorName} visiting ${resident.house_number}`
      );

      // Generate QR and store it
      const qrBuffer = await QRCode.toBuffer(passCode, {
        type: 'png', width: 400, margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
      qrStore.set(passCode, qrBuffer);

      const qrUrl = `${SERVER_URL}/qr/${passCode}`;
      const validityText = datePart === 'tomorrow'
        ? `Tomorrow, ${formatDate(validTo.toISOString())}`
        : `Today until midnight`;

      const message =
        `BAMISHILE ESTATE — VISITOR PASS\n` +
        `--------------------------------\n` +
        `Visitor: ${visitorName}\n` +
        `Visiting: ${resident.house_number}\n` +
        `Pass Code: ${passCode}\n` +
        `Valid: ${validityText}\n` +
        `--------------------------------\n` +
        `Forward this message and the QR image to your visitor to show at the gate.\n\n` +
        `To cancel: Reply CANCEL ${passCode}\n` +
        `To check status: Reply STATUS ${passCode}`;

      await sendWhatsApp(from, message, qrUrl);
      return;
    }

    // ── HELP ──
    await sendWhatsApp(from,
      `GATEPASS — Bamishile Estate\n\n` +
      `Create a visitor pass:\nVISIT [name] today\nVISIT [name] tomorrow\n\n` +
      `Cancel a pass:\nCANCEL BS-XXXX\n\n` +
      `Check pass status:\nSTATUS BS-XXXX\n\n` +
      `Example:\nVISIT Tunde Bello today`
    );

  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }
});

// ================================================
// GATE VERIFICATION
// ================================================
app.get('/api/verify/:passCode', async (req, res) => {
  const passCode = req.params.passCode.toUpperCase();
  try {
    const { data: pass } = await supabase
      .from('visitors')
      .select('*, residents(resident_name, house_number)')
      .eq('pass_code', passCode)
      .single();

    if (!pass) {
      return res.json({ valid: false, reason: 'Pass not found', action: 'DENY' });
    }

    const now = new Date();
    const validTo = new Date(pass.valid_to);

    if (now > validTo) {
      await supabase.from('visitors').update({ status: 'expired' }).eq('pass_code', passCode);
      await writeLog(passCode, 'denied', 'Gate', 'Pass expired');
      return res.json({ valid: false, reason: 'Pass has expired', action: 'DENY', pass });
    }
    if (pass.status === 'cancelled') {
      await writeLog(passCode, 'denied', 'Gate', 'Pass cancelled');
      return res.json({ valid: false, reason: 'Pass was cancelled by resident', action: 'DENY', pass });
    }
    if (pass.status === 'checked_out') {
      await writeLog(passCode, 'denied', 'Gate', 'Already checked out');
      return res.json({ valid: false, reason: 'Visitor has already exited', action: 'DENY', pass });
    }
    if (pass.status === 'expired') {
      return res.json({ valid: false, reason: 'Pass has expired', action: 'DENY', pass });
    }
    if (pass.status === 'checked_in') {
      return res.json({ valid: true, action: 'EXIT', message: 'Visitor is inside', pass });
    }

    return res.json({ valid: true, action: 'ENTRY', message: 'Valid pass — admit visitor', pass });

  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ valid: false, reason: 'Server error' });
  }
});

// ================================================
// ENTRY
// ================================================
app.post('/api/entry/:passCode', async (req, res) => {
  const passCode = req.params.passCode.toUpperCase();
  try {
    const { data: pass } = await supabase
      .from('visitors').select('*').eq('pass_code', passCode).single();
    if (!pass || pass.status !== 'active') {
      return res.json({ success: false, message: 'Cannot admit — pass is not active' });
    }
    await supabase.from('visitors')
      .update({ status: 'checked_in', entry_time: new Date().toISOString() })
      .eq('pass_code', passCode);
    await writeLog(passCode, 'entry', 'Gate', `${pass.visitor_name} admitted`);
    res.json({ success: true, message: `${pass.visitor_name} admitted successfully` });
  } catch (err) {
    console.error('Entry error:', err);
    res.status(500).json({ success: false });
  }
});

// ================================================
// EXIT
// ================================================
app.post('/api/exit/:passCode', async (req, res) => {
  const passCode = req.params.passCode.toUpperCase();
  try {
    const { data: pass } = await supabase
      .from('visitors').select('*').eq('pass_code', passCode).single();
    if (!pass || pass.status !== 'checked_in') {
      return res.json({ success: false, message: 'Cannot check out — visitor not checked in' });
    }
    await supabase.from('visitors')
      .update({ status: 'checked_out', exit_time: new Date().toISOString() })
      .eq('pass_code', passCode);
    await writeLog(passCode, 'exit', 'Gate', `${pass.visitor_name} exited`);
    res.json({ success: true, message: `${pass.visitor_name} checked out successfully` });
  } catch (err) {
    console.error('Exit error:', err);
    res.status(500).json({ success: false });
  }
});

// ================================================
// WEEKLY REPORT
// ================================================
cron.schedule('0 20 * * 0', async () => {
  console.log('Generating weekly ExCo report...');
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const { data: passes } = await supabase
      .from('visitors').select('*').gte('created_at', weekAgo.toISOString());
    if (!passes) return;

    const total = passes.length;
    const completed = passes.filter(p => p.status === 'checked_out').length;
    const cancelled = passes.filter(p => p.status === 'cancelled').length;
    const expired = passes.filter(p => p.status === 'expired').length;
    const noExit = passes.filter(p => p.status === 'checked_in').length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    const reportDate = now.toLocaleDateString('en-NG', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const emailBody = `
GATEPASS BAMISHILE ESTATE
Weekly Operations Report — ${reportDate}
${'─'.repeat(42)}

SUMMARY
Total passes issued:       ${total}
Completed (entry + exit):  ${completed} (${completionRate}%)
Cancelled by residents:    ${cancelled}
Expired unused:            ${expired}
Entered, no exit logged:   ${noExit}

${'─'.repeat(42)}
${noExit > 0 ? `NOTE: ${noExit} visitor(s) entered but have no exit log.\nPlease remind guards to scan visitors on departure.\n\n` : ''}
This report is automatically generated every Sunday evening.
GatePass · Bamishile Estate · Built by IGATA Consulting Technologies
    `.trim();

    const transporter = nodemailer.createTransporter({
      service: 'gmail',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    await transporter.sendMail({
      from: `GatePass Bamishile <${SMTP_USER}>`,
      to: REPORT_EMAIL,
      subject: `GatePass Weekly Report · Bamishile Estate · ${reportDate}`,
      text: emailBody,
    });

    console.log('Weekly report sent');
  } catch (err) {
    console.error('Report error:', err);
  }
}, { timezone: 'Africa/Lagos' });

// ================================================
// AUTO EXPIRY
// ================================================
cron.schedule('0 * * * *', async () => {
  try {
    await supabase.from('visitors')
      .update({ status: 'expired' })
      .eq('status', 'active')
      .lt('valid_to', new Date().toISOString());
    console.log('Auto expiry check complete');
  } catch (err) {
    console.error('Auto expiry error:', err);
  }
});

// ================================================
// HEALTH CHECK
// ================================================
app.get('/', (req, res) => {
  res.json({
    system: 'GatePass Bamishile Estate',
    status: 'online',
    version: '1.1',
    built_by: 'IGATA Consulting Technologies',
  });
});

app.listen(PORT, () => {
  console.log(`GatePass server v1.1 running on port ${PORT}`);
});
