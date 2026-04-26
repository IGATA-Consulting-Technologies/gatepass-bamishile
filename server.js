// ================================================
// GATEPASS BAMISHILE · SERVER v1.0
// Built by IGATA Consulting Technologies
// ================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const twilio = require('twilio');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ================================================
// CONFIGURATION — pulled from Railway environment
// ================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const REPORT_EMAIL = process.env.REPORT_EMAIL;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ================================================
// HELPERS
// ================================================

// Generate unique BS-XXXX pass code
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

// Send WhatsApp message via Twilio
async function sendWhatsApp(to, message) {
  const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:+${to}`;
  await twilioClient.messages.create({
    from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
    to: formattedTo,
    body: message,
  });
}

// Write to logs table
async function writeLog(passCode, action, performedBy, note = '') {
  await supabase.from('logs').insert({
    pass_code: passCode,
    action,
    performed_by: performedBy,
    note,
  });
}

// Get today midnight (Lagos time UTC+1)
function getTodayMidnight() {
  const now = new Date();
  const lagos = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  lagos.setHours(23, 59, 59, 999);
  return lagos;
}

// Format time nicely
function formatTime(isoString) {
  if (!isoString) return 'N/A';
  return new Date(isoString).toLocaleTimeString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });
}

// ================================================
// WHATSAPP WEBHOOK — receives resident messages
// ================================================
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);

  const body = (req.body.Body || '').trim();
  const from = (req.body.From || '').replace('whatsapp:+', '');
  const upperBody = body.toUpperCase();

  try {
    // Look up resident by WhatsApp number
    const { data: resident } = await supabase
      .from('residents')
      .select('*')
      .eq('whatsapp_number', from)
      .eq('is_active', true)
      .single();

    // ── UNREGISTERED RESIDENT ──
    if (!resident) {
      await sendWhatsApp(from,
        `Hello! Your number is not registered on GatePass Bamishile Estate.\n\nPlease contact your estate ExCo to get registered.\n\nThank you.`
      );
      return;
    }

    // ── CANCEL COMMAND ──
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
        await sendWhatsApp(from, `Cannot cancel ${passCode} — visitor has already entered the estate.`);
        return;
      }

      if (['checked_out', 'cancelled', 'expired'].includes(pass.status)) {
        await sendWhatsApp(from, `Pass ${passCode} is already ${pass.status} and cannot be cancelled.`);
        return;
      }

      await supabase
        .from('visitors')
        .update({ status: 'cancelled' })
        .eq('pass_code', passCode);

      await writeLog(passCode, 'cancelled', resident.resident_name, 'Cancelled by resident via WhatsApp');

      await sendWhatsApp(from,
        `✅ Pass ${passCode} has been cancelled.\n\nYour visitor will no longer be admitted with this pass.`
      );
      return;
    }

    // ── STATUS CHECK ──
    if (upperBody.startsWith('STATUS ')) {
      const passCode = body.split(' ')[1]?.toUpperCase();
      const { data: pass } = await supabase
        .from('visitors')
        .select('*')
        .eq('pass_code', passCode)
        .single();

      if (!pass) {
        await sendWhatsApp(from, `Pass ${passCode} not found.`);
        return;
      }

      await sendWhatsApp(from,
        `📋 Pass Status: ${passCode}\n\n` +
        `Visitor: ${pass.visitor_name}\n` +
        `Status: ${pass.status.toUpperCase()}\n` +
        `Entry: ${formatTime(pass.entry_time)}\n` +
        `Exit: ${formatTime(pass.exit_time)}`
      );
      return;
    }

    // ── VISIT COMMAND (quick format) ──
    // Format: VISIT [name] [phone] today/tomorrow
    if (upperBody.startsWith('VISIT ')) {
      const parts = body.split(' ');
      if (parts.length < 3) {
        await sendWhatsApp(from,
          `Please use this format:\nVISIT [visitor name] [phone] today\n\nExample:\nVISIT John Doe 08012345678 today`
        );
        return;
      }

      // Parse: last word is date, second-to-last might be phone
      const datePart = parts[parts.length - 1].toLowerCase();
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
      let validTo;

      if (datePart === 'tomorrow') {
        validTo = new Date();
        validTo.setDate(validTo.getDate() + 1);
        validTo.setHours(23, 59, 59, 999);
      } else {
        validTo = getTodayMidnight();
      }

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

      const validityText = datePart === 'tomorrow' ? 'Tomorrow until midnight' : 'Today until midnight';

      await sendWhatsApp(from,
        `✅ *Visitor Pass Created*\n\n` +
        `👤 Visitor: ${visitorName}\n` +
        `🏠 Visiting: ${resident.house_number}\n` +
        `🎫 Pass Code: *${passCode}*\n` +
        `⏰ Valid: ${validityText}\n\n` +
        `Forward this message to your visitor to show at the gate.\n\n` +
        `To cancel: Reply *CANCEL ${passCode}*\n` +
        `To check status: Reply *STATUS ${passCode}*`
      );
      return;
    }

    // ── HELP / DEFAULT ──
    await sendWhatsApp(from,
      `👋 Welcome to *GatePass Bamishile Estate*\n\n` +
      `*Create a visitor pass:*\nVISIT [name] [phone] today\n\n` +
      `*Cancel a pass:*\nCANCEL BS-XXXX\n\n` +
      `*Check pass status:*\nSTATUS BS-XXXX\n\n` +
      `Example:\nVISIT Tunde Bello 08056781234 today`
    );

  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }
});

// ================================================
// GATE VERIFICATION ENDPOINT
// Used by the security guard dashboard
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
      return res.json({ valid: false, reason: 'Visitor already exited', action: 'DENY', pass });
    }

    if (pass.status === 'checked_in') {
      return res.json({
        valid: true,
        action: 'EXIT',
        message: 'Visitor is inside — ready to check out',
        pass,
      });
    }

    // Status is active — ready for entry
    return res.json({
      valid: true,
      action: 'ENTRY',
      message: 'Valid pass — admit visitor',
      pass,
    });

  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ valid: false, reason: 'Server error' });
  }
});

// ================================================
// ENTRY ENDPOINT — guard taps Admit
// ================================================
app.post('/api/entry/:passCode', async (req, res) => {
  const passCode = req.params.passCode.toUpperCase();

  try {
    const { data: pass } = await supabase
      .from('visitors')
      .select('*')
      .eq('pass_code', passCode)
      .single();

    if (!pass || pass.status !== 'active') {
      return res.json({ success: false, message: 'Cannot admit — pass is not active' });
    }

    await supabase
      .from('visitors')
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
// EXIT ENDPOINT — guard taps Check Out
// ================================================
app.post('/api/exit/:passCode', async (req, res) => {
  const passCode = req.params.passCode.toUpperCase();

  try {
    const { data: pass } = await supabase
      .from('visitors')
      .select('*')
      .eq('pass_code', passCode)
      .single();

    if (!pass || pass.status !== 'checked_in') {
      return res.json({ success: false, message: 'Cannot check out — visitor not checked in' });
    }

    await supabase
      .from('visitors')
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
// WEEKLY REPORT ENGINE
// Runs every Sunday at 8PM Lagos time
// ================================================
cron.schedule('0 20 * * 0', async () => {
  console.log('Generating weekly ExCo report...');

  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { data: passes } = await supabase
      .from('visitors')
      .select('*')
      .gte('created_at', weekAgo.toISOString());

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
Weekly Operations Report
${reportDate}
${'─'.repeat(40)}

SUMMARY
Total passes issued:     ${total}
Completed (entry+exit):  ${completed} (${completionRate}%)
Cancelled by residents:  ${cancelled}
Expired unused:          ${expired}
Entered, no exit logged: ${noExit}

${'─'.repeat(40)}
${noExit > 0 ? `⚠ ACTION NEEDED: ${noExit} visitor(s) entered but have no exit log.\nPlease remind guards to scan visitors on departure.\n\n` : ''}
This report is automatically generated every Sunday.
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

    console.log('Weekly report sent successfully');
  } catch (err) {
    console.error('Report error:', err);
  }
}, { timezone: 'Africa/Lagos' });

// ================================================
// AUTO EXPIRY — runs every hour
// ================================================
cron.schedule('0 * * * *', async () => {
  try {
    await supabase
      .from('visitors')
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
    version: '1.0',
    built_by: 'IGATA Consulting Technologies',
  });
});

app.listen(PORT, () => {
  console.log(`GatePass server running on port ${PORT}`);
});
