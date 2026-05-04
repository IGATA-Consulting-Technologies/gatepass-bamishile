// ================================================
// GATEPASS · SERVER v3.0 · MULTI-TENANT + AI
// Powered by IGATA Consulting Technologies
// ================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const twilio = require('twilio');
const cron = require('node-cron');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const REPORT_EMAIL = process.env.REPORT_EMAIL;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SERVER_URL = process.env.SERVER_URL || 'https://gatepass-bamishile-production.up.railway.app';
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ================================================
// QR CODE STORE
// ================================================
const qrStore = new Map();

app.get('/qr/:passCode', async (req, res) => {
  const passCode = req.params.passCode.toUpperCase();
  if (qrStore.has(passCode)) {
    res.setHeader('Content-Type', 'image/png');
    return res.send(qrStore.get(passCode));
  }
  try {
    const buf = await QRCode.toBuffer(passCode, {
      type: 'png', width: 400, margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    qrStore.set(passCode, buf);
    res.setHeader('Content-Type', 'image/png');
    res.send(buf);
  } catch {
    res.status(404).send('Not found');
  }
});

// ================================================
// HELPERS
// ================================================

async function getEstateByWhatsApp(number) {
  const { data } = await supabase
    .from('estates')
    .select('*')
    .eq('whatsapp_number', number)
    .eq('is_active', true)
    .single();
  return data;
}

async function getResident(whatsappNumber, estateId) {
  const { data } = await supabase
    .from('residents')
    .select('*')
    .eq('whatsapp_number', whatsappNumber)
    .eq('estate_id', estateId)
    .eq('is_active', true)
    .single();
  return data;
}

async function generatePassCode(prefix) {
  let code, exists;
  do {
    const digits = Math.floor(1000 + Math.random() * 9000);
    code = `${prefix}-${digits}`;
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

async function writeLog(passCode, action, performedBy, note, estateId, gateId = 'main') {
  await supabase.from('logs').insert({
    pass_code: passCode,
    action,
    performed_by: performedBy,
    note,
    estate_id: estateId,
    gate_id: gateId,
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
    hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos',
  });
}

// ================================================
// AI LAYER — HOUSEHOLD MEMBER MANAGEMENT
// ================================================

// Get household members for a primary resident
async function getHouseholdMembers(residentId, estateId) {
  const { data } = await supabase
    .from('household_members')
    .select('*')
    .eq('primary_resident_id', residentId)
    .eq('estate_id', estateId)
    .eq('is_active', true);
  return data || [];
}

// Look up a household member by their WhatsApp number
async function getHouseholdMember(whatsappNumber, estateId) {
  const { data } = await supabase
    .from('household_members')
    .select('*, residents(*)')
    .eq('whatsapp_number', whatsappNumber)
    .eq('estate_id', estateId)
    .eq('is_active', true)
    .single();
  return data;
}

// Fetch media from Twilio URL as base64 for Claude vision
async function fetchMediaAsBase64(mediaUrl) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const urlObj = new URL(mediaUrl);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { 'Authorization': `Basic ${auth}` }
    };
    https.get(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          base64: buffer.toString('base64'),
          contentType: res.headers['content-type'] || 'image/jpeg'
        });
      });
    }).on('error', reject);
  });
}

// Call Claude API
async function callClaude(messages, systemPrompt, maxTokens = 400) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || '');
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// AI: Transcribe a Twilio voice note URL using OpenAI Whisper
// NOTE: Requires OPENAI_API_KEY env var for audio transcription
async function transcribeAudio(audioUrl) {
  try {
    // Fetch the audio from Twilio
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const audioData = await new Promise((resolve, reject) => {
      const urlObj = new URL(audioUrl);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        headers: { 'Authorization': `Basic ${auth}` }
      };
      https.get(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), type: res.headers['content-type'] }));
      }).on('error', reject);
    });

    // Send to Whisper API
    const boundary = '----GatePassBoundary' + Date.now();
    const ext = audioData.type?.includes('ogg') ? 'ogg' : 'mp3';
    const filename = `audio.${ext}`;

    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${audioData.type}\r\n\r\n`,
    ];

    const header = Buffer.from(parts.join('\r\n') + '\r\n');
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const formData = Buffer.concat([header, audioData.buffer, footer]);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': formData.length
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.text || '');
          } catch { resolve(''); }
        });
      });
      req.on('error', reject);
      req.write(formData);
      req.end();
    });
  } catch (err) {
    console.error('Audio transcription error:', err);
    return '';
  }
}

// AI: Extract visitor intent from any text or transcription
async function extractVisitorIntent(text, residentName, houseName) {
  const systemPrompt = `You are a visitor pass assistant for a Nigerian residential estate called ${houseName}.
A resident named ${residentName} has sent a message. Extract their intent.

Reply ONLY with valid JSON in this exact format:
{
  "intent": "create_pass" | "cancel_pass" | "check_status" | "unknown",
  "visitor_name": "extracted name or null",
  "timing": "today" | "tomorrow" | null,
  "pass_code": "pass code if mentioned or null",
  "confidence": "high" | "medium" | "low"
}

Rules:
- Messages like "my sister Ngozi is coming today", "I dey expect one man wey call himself Emeka", "Amara akan zo yau" (Hausa for Amara is coming today) all mean create_pass
- Extract the visitor name even from informal language
- If they say "this evening", "tonight", "now now" = today
- If they say "tomorrow morning", "next day" = tomorrow  
- If no timing given, default to today
- Be generous — if there's any name mentioned with visit intent, extract it`;

  try {
    const result = await callClaude(
      [{ role: 'user', content: text }],
      systemPrompt,
      300
    );
    const cleaned = result.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { intent: 'unknown', visitor_name: null, timing: null, confidence: 'low' };
  }
}

// AI: Extract visitor name from an image (ID card, face, document)
async function extractNameFromImage(base64Image, contentType, residentName) {
  const systemPrompt = `You are a visitor pass assistant. A resident named ${residentName} has sent an image.
Look at this image and extract any person's name visible — from an ID card, driving licence, voter's card, NIN slip, or any document.

Reply ONLY with valid JSON:
{
  "found_name": "Full name or null",
  "document_type": "id_card | drivers_licence | voters_card | nin | passport | photo | other | none",
  "confidence": "high | medium | low"
}`;

  try {
    const result = await callClaude(
      [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: contentType, data: base64Image }
        }, {
          type: 'text',
          text: 'Extract the person\'s name from this image for a visitor pass.'
        }]
      }],
      systemPrompt,
      200
    );
    const cleaned = result.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { found_name: null, document_type: 'none', confidence: 'low' };
  }
}

// Core pass creation shared by both VISIT command and AI layer
async function createAndSendPass(from, resident, estate, visitorName, timing) {
  const validFrom = new Date();
  const validTo = timing === 'tomorrow' ? getTomorrowMidnight() : getTodayMidnight();
  const passCode = await generatePassCode(estate.pass_prefix);

  await supabase.from('visitors').insert({
    pass_code: passCode,
    visitor_name: visitorName,
    visitor_phone: '',
    resident_id: resident.id,
    house_number: resident.house_number,
    estate_id: estate.id,
    pass_type: 'one-time',
    valid_from: validFrom.toISOString(),
    valid_to: validTo.toISOString(),
    status: 'active',
  });

  await writeLog(passCode, 'created', resident.resident_name,
    `AI-created for ${visitorName} visiting ${resident.house_number}`, estate.id
  );

  const qrBuffer = await QRCode.toBuffer(passCode, {
    type: 'png', width: 400, margin: 2,
    color: { dark: '#000000', light: '#ffffff' }
  });
  qrStore.set(passCode, qrBuffer);

  const qrUrl = `${SERVER_URL}/qr/${passCode}`;
  const validityText = timing === 'tomorrow' ? 'Tomorrow until midnight' : 'Today until midnight';

  const message =
    `${estate.name.toUpperCase()} — VISITOR PASS\n` +
    `--------------------------------\n` +
    `Visitor: ${visitorName}\n` +
    `Visiting: ${resident.house_number}\n` +
    `Pass Code: ${passCode}\n` +
    `Valid: ${validityText}\n` +
    `--------------------------------\n` +
    `Forward this message and the QR image to your visitor.\n\n` +
    `To cancel: Reply CANCEL ${passCode}\n` +
    `To check status: Reply STATUS ${passCode}`;

  await sendWhatsApp(from, message, qrUrl);
  return passCode;
}

// ================================================
// WHATSAPP WEBHOOK
// ================================================
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);

  const body = (req.body.Body || '').trim();
  const from = (req.body.From || '').replace('whatsapp:+', '');
  const to = (req.body.To || '').replace('whatsapp:', '');
  const upperBody = body.toUpperCase();

  // Detect media
  const numMedia = parseInt(req.body.NumMedia || '0');
  const mediaUrl = numMedia > 0 ? req.body.MediaUrl0 : null;
  const mediaType = numMedia > 0 ? (req.body.MediaContentType0 || '') : '';
  const isAudio = mediaType.startsWith('audio/');
  const isImage = mediaType.startsWith('image/');

  try {
    const estate = await getEstateByWhatsApp(to) ||
      await getEstateByWhatsApp('+' + to) ||
      await supabase.from('estates').select('*').eq('is_active', true).single().then(r => r.data);

    if (!estate) {
      await sendWhatsApp(from, `This GatePass number is not linked to an active estate. Please contact support.`);
      return;
    }

    // Check if sender is a registered primary resident
    let resident = await getResident(from, estate.id);
    let isHouseholdMember = false;
    let primaryResident = null;

    // If not a primary resident, check household members
    if (!resident) {
      const member = await getHouseholdMember(from, estate.id);
      if (member && member.residents) {
        isHouseholdMember = true;
        primaryResident = member.residents;
        // Treat household member as their primary resident for pass creation
        resident = member.residents;
      }
    }

    if (!resident) {
      // Check if they are trying to register as a household member
      if (upperBody.startsWith('JOIN ')) {
        const pinPart = body.split(' ')[1]?.toUpperCase();
        if (pinPart) {
          const { data: invite } = await supabase
            .from('household_invites')
            .select('*, residents(*)')
            .eq('invite_pin', pinPart)
            .eq('estate_id', estate.id)
            .eq('used', false)
            .gt('expires_at', new Date().toISOString())
            .single();

          if (invite) {
            // Register this WhatsApp number as a household member
            await supabase.from('household_members').insert({
              estate_id: estate.id,
              primary_resident_id: invite.resident_id,
              whatsapp_number: from,
              name: invite.member_name || 'Household Member',
              relationship: invite.relationship || 'household',
              is_active: true,
            });
            await supabase.from('household_invites').update({ used: true }).eq('id', invite.id);
            await sendWhatsApp(from,
              `Welcome to GatePass ${estate.name}! ✅\n\n` +
              `You are now registered as a household member of ${invite.residents.house_number}.\n\n` +
              `You can now create visitor passes. Just send:\n` +
              `VISIT [name] today\nor describe your visitor naturally.`
            );
          } else {
            await sendWhatsApp(from, `Invalid or expired invite code. Please ask your household primary resident to resend your invite.`);
          }
        }
        return;
      }

      await sendWhatsApp(from,
        `Your number is not registered on GatePass ${estate.name}.\n\nPlease contact your estate ExCo to register.\n\nThank you.`
      );
      return;
    }

    // ── INVITE HOUSEHOLD MEMBER (primary residents only) ──
    if (upperBody.startsWith('INVITE ') && !isHouseholdMember) {
      const parts = body.split(' ');
      // Format: INVITE [name] [relationship]
      // e.g. INVITE Mama Relationship:parent
      if (parts.length < 2) {
        await sendWhatsApp(from,
          `To invite a household member:\nINVITE [their name]\n\nExample:\nINVITE Mama\nINVITE John househelp\n\nThey will receive a PIN to join GatePass.`
        );
        return;
      }

      const memberName = parts.slice(1).join(' ');
      const pin = Math.random().toString(36).substring(2, 8).toUpperCase();
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

      await supabase.from('household_invites').insert({
        estate_id: estate.id,
        resident_id: resident.id,
        member_name: memberName,
        invite_pin: pin,
        expires_at: expiresAt.toISOString(),
        used: false,
      });

      await sendWhatsApp(from,
        `Invite created for ${memberName} ✅\n\n` +
        `Ask them to send this message to this WhatsApp number:\n\n` +
        `JOIN ${pin}\n\n` +
        `This invite expires in 48 hours.\n` +
        `Once joined, they can create passes for ${resident.house_number} just like you.`
      );
      return;
    }

    // ── LIST HOUSEHOLD MEMBERS ──
    if (upperBody === 'HOUSEHOLD' || upperBody === 'MEMBERS') {
      const members = await getHouseholdMembers(resident.id, estate.id);
      if (members.length === 0) {
        await sendWhatsApp(from,
          `No household members registered yet.\n\nTo add someone:\nINVITE [their name]\n\nExample: INVITE Mama`
        );
      } else {
        const list = members.map((m, i) => `${i + 1}. ${m.name} (${m.relationship})`).join('\n');
        await sendWhatsApp(from, `Household members at ${resident.house_number}:\n\n${list}`);
      }
      return;
    }

    // ── CANCEL ──
    if (upperBody.startsWith('CANCEL ')) {
      const passCode = body.split(' ')[1]?.toUpperCase();
      if (!passCode) {
        await sendWhatsApp(from, `Please include the pass code.\nExample: CANCEL ${estate.pass_prefix}-4821`);
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
      await writeLog(passCode, 'cancelled', resident.resident_name, 'Cancelled by resident', estate.id);
      await sendWhatsApp(from, `Pass ${passCode} has been cancelled.\n\nYour visitor will not be admitted with this pass.`);
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

    // ── VISIT (structured command) ──
    if (upperBody.startsWith('VISIT ')) {
      const parts = body.split(' ');
      if (parts.length < 3) {
        await sendWhatsApp(from,
          `Please use this format:\nVISIT [name] today\n\nExamples:\nVISIT John Doe today\nVISIT John Doe tomorrow`
        );
        return;
      }

      const datePart = parts[parts.length - 1].toLowerCase();
      if (!['today', 'tomorrow'].includes(datePart)) {
        await sendWhatsApp(from,
          `Please end with "today" or "tomorrow".\n\nExample:\nVISIT John Doe today`
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

      await createAndSendPass(from, resident, estate, visitorName, datePart);
      return;
    }

    // ── HELP ──
    if (upperBody === 'HELP' || upperBody === 'HI' || upperBody === 'HELLO' || upperBody === 'START') {
      await sendWhatsApp(from,
        `GATEPASS — ${estate.name}\n\n` +
        `Create a visitor pass:\nVISIT [name] today\nVISIT [name] tomorrow\n\n` +
        `Or just describe your visitor naturally:\n"My brother Emeka is coming today"\n"Expect a delivery guy now"\n\n` +
        `You can also send a voice note or photo of their ID!\n\n` +
        `Cancel a pass:\nCANCEL ${estate.pass_prefix}-XXXX\n\n` +
        `Check pass status:\nSTATUS ${estate.pass_prefix}-XXXX\n\n` +
        `Add household member:\nINVITE [name]\n\n` +
        `View household:\nHOUSEHOLD`
      );
      return;
    }

    // ================================================
    // AI INTERPRETATION LAYER
    // Handles: voice notes, images, natural language
    // ================================================

    // ── VOICE NOTE ──
    if (isAudio && mediaUrl) {
      await sendWhatsApp(from, `🎙️ Got your voice note, processing...`);

      const transcript = await transcribeAudio(mediaUrl);

      if (!transcript || transcript.length < 3) {
        await sendWhatsApp(from,
          `Sorry, I couldn't understand the voice note clearly.\n\nPlease try again or type:\nVISIT [name] today`
        );
        return;
      }

      console.log(`Voice transcript from ${resident.resident_name}: "${transcript}"`);

      const intent = await extractVisitorIntent(transcript, resident.resident_name, estate.name);

      if (intent.intent === 'create_pass' && intent.visitor_name && intent.confidence !== 'low') {
        const timing = intent.timing || 'today';
        const passCode = await createAndSendPass(from, resident, estate, intent.visitor_name, timing);
        console.log(`AI voice pass created: ${passCode} for ${intent.visitor_name}`);
      } else if (intent.intent === 'cancel_pass' && intent.pass_code) {
        await sendWhatsApp(from, `To cancel, please reply:\nCANCEL ${intent.pass_code}`);
      } else {
        await sendWhatsApp(from,
          `I heard: "${transcript.substring(0, 100)}"\n\n` +
          `I couldn't identify a visitor name clearly.\n\nPlease try:\nVISIT [visitor name] today`
        );
      }
      return;
    }

    // ── IMAGE (ID card, photo) ──
    if (isImage && mediaUrl) {
      await sendWhatsApp(from, `📷 Got the image, checking for a name...`);

      try {
        const { base64, contentType } = await fetchMediaAsBase64(mediaUrl);
        const result = await extractNameFromImage(base64, contentType, resident.resident_name);

        if (result.found_name && result.confidence !== 'low') {
          const passCode = await createAndSendPass(from, resident, estate, result.found_name, 'today');
          console.log(`AI image pass created: ${passCode} for ${result.found_name}`);
        } else {
          await sendWhatsApp(from,
            `I could see the image but couldn't read a name clearly.\n\n` +
            `Please type their name:\nVISIT [name] today`
          );
        }
      } catch (err) {
        console.error('Image processing error:', err);
        await sendWhatsApp(from,
          `Couldn't process the image.\n\nPlease type the visitor's name:\nVISIT [name] today`
        );
      }
      return;
    }

    // ── NATURAL LANGUAGE TEXT ──
    // Catches anything that didn't match a structured command above
    if (body.length > 2) {
      const intent = await extractVisitorIntent(body, resident.resident_name, estate.name);

      if (intent.intent === 'create_pass' && intent.visitor_name && intent.confidence !== 'low') {
        const timing = intent.timing || 'today';
        const passCode = await createAndSendPass(from, resident, estate, intent.visitor_name, timing);
        console.log(`AI text pass created: ${passCode} for ${intent.visitor_name}`);
        return;
      }

      if (intent.intent === 'cancel_pass' && intent.pass_code) {
        await sendWhatsApp(from, `To cancel, please reply:\nCANCEL ${intent.pass_code}`);
        return;
      }

      if (intent.intent === 'check_status' && intent.pass_code) {
        await sendWhatsApp(from, `To check status, please reply:\nSTATUS ${intent.pass_code}`);
        return;
      }
    }

    // ── FALLBACK HELP ──
    await sendWhatsApp(from,
      `GATEPASS — ${estate.name}\n\n` +
      `Create a visitor pass:\nVISIT [name] today\nVISIT [name] tomorrow\n\n` +
      `Or just describe your visitor:\n"My sister Ngozi is coming"\n\nSend HELP for all commands.`
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
  const gateId = req.query.gate || 'main';

  try {
    const { data: standing } = await supabase
      .from('standing_passes')
      .select('*, residents(resident_name, house_number)')
      .eq('pass_code', passCode)
      .eq('is_active', true)
      .single();

    if (standing) {
      const today = new Date().toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
      const validDays = standing.valid_days || [];
      if (!validDays.includes(today)) {
        return res.json({ valid: false, reason: `Standing pass not valid today (${today})`, action: 'DENY' });
      }
      if (standing.expires_on && new Date() > new Date(standing.expires_on)) {
        await supabase.from('standing_passes').update({ is_active: false }).eq('pass_code', passCode);
        return res.json({ valid: false, reason: 'Standing pass has expired', action: 'DENY' });
      }
      return res.json({
        valid: true, action: 'STANDING', message: 'Standing access — admit',
        pass: {
          visitor_name: standing.name,
          house_number: standing.residents?.house_number,
          pass_code: passCode,
          relationship: standing.relationship,
          pass_type: 'standing',
        },
      });
    }

    const { data: pass } = await supabase
      .from('visitors')
      .select('*, residents(resident_name, house_number)')
      .eq('pass_code', passCode)
      .single();

    if (!pass) return res.json({ valid: false, reason: 'Pass not found', action: 'DENY' });

    const now = new Date();
    const validTo = new Date(pass.valid_to);

    if (now > validTo || pass.status === 'expired') {
      await supabase.from('visitors').update({ status: 'expired' }).eq('pass_code', passCode);
      await writeLog(passCode, 'denied', `Gate-${gateId}`, 'Pass expired', pass.estate_id, gateId);
      return res.json({ valid: false, reason: 'Pass has expired', action: 'DENY', pass });
    }
    if (pass.status === 'cancelled') {
      await writeLog(passCode, 'denied', `Gate-${gateId}`, 'Pass cancelled', pass.estate_id, gateId);
      return res.json({ valid: false, reason: 'Pass was cancelled by resident', action: 'DENY', pass });
    }
    if (pass.status === 'checked_out') {
      return res.json({ valid: false, reason: 'Visitor has already exited', action: 'DENY', pass });
    }
    if (pass.status === 'checked_in') {
      return res.json({ valid: true, action: 'EXIT', message: 'Visitor inside — check out', pass });
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
  const gateId = req.query.gate || 'main';

  try {
    const { data: pass } = await supabase
      .from('visitors').select('*').eq('pass_code', passCode).single();

    if (!pass || pass.status !== 'active') {
      return res.json({ success: false, message: 'Cannot admit — pass is not active' });
    }

    await supabase.from('visitors')
      .update({ status: 'checked_in', entry_time: new Date().toISOString(), gate_id: gateId })
      .eq('pass_code', passCode);

    await writeLog(passCode, 'entry', `Gate-${gateId}`, `${pass.visitor_name} admitted`, pass.estate_id, gateId);

    try {
      const { data: resident } = await supabase
        .from('residents').select('whatsapp_number').eq('id', pass.resident_id).single();

      if (resident) {
        const { data: estate } = await supabase
          .from('estates').select('name').eq('id', pass.estate_id).single();

        const gateNames = { main: 'Main Gate', community: 'Community Street Gate' };
        const gateName = gateNames[gateId] || gateId;
        const time = new Date().toLocaleTimeString('en-NG', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos'
        });
        const date = new Date().toLocaleDateString('en-NG', {
          weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Lagos'
        });
        await sendWhatsApp(
          resident.whatsapp_number,
          `GatePass Notification\n\nYour visitor ${pass.visitor_name} has been admitted at the ${gateName}.\n\n${estate.name} · ${date} · ${time}`
        );
      }
    } catch (e) {
      console.log('Resident entry notification failed — continuing');
    }

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
  const gateId = req.query.gate || 'main';

  try {
    const { data: pass } = await supabase
      .from('visitors').select('*').eq('pass_code', passCode).single();

    if (!pass || pass.status !== 'checked_in') {
      return res.json({ success: false, message: 'Cannot check out — visitor not checked in' });
    }

    await supabase.from('visitors')
      .update({ status: 'checked_out', exit_time: new Date().toISOString() })
      .eq('pass_code', passCode);

    await writeLog(passCode, 'exit', `Gate-${gateId}`, `${pass.visitor_name} exited`, pass.estate_id, gateId);
    res.json({ success: true, message: `${pass.visitor_name} checked out successfully` });

  } catch (err) {
    console.error('Exit error:', err);
    res.status(500).json({ success: false });
  }
});

// ================================================
// STANDING PASS — CREATE
// ================================================
app.post('/api/standing', async (req, res) => {
  const { resident_id, name, relationship, valid_days, expires_on, estate_id } = req.body;

  try {
    const { data: estate } = await supabase
      .from('estates').select('pass_prefix').eq('id', estate_id).single();

    const passCode = await generatePassCode(`${estate.pass_prefix}S`);

    const { data, error } = await supabase.from('standing_passes').insert({
      estate_id, resident_id, name, relationship,
      pass_code: passCode,
      valid_days: valid_days || ['mon','tue','wed','thu','fri','sat','sun'],
      expires_on: expires_on || null,
      is_active: true,
    }).select().single();

    if (error) throw error;
    res.json({ success: true, pass: data });

  } catch (err) {
    console.error('Standing pass error:', err);
    res.status(500).json({ success: false });
  }
});

// ================================================
// INCIDENT — REPORT
// ================================================
app.post('/api/incident', async (req, res) => {
  const { estate_id, gate_id, description, severity, reported_by } = req.body;

  try {
    const { data, error } = await supabase.from('incidents').insert({
      estate_id, gate_id, description,
      severity: severity || 'low',
      reported_by, status: 'open',
    }).select().single();

    if (error) throw error;

    const { data: estate } = await supabase
      .from('estates').select('*').eq('id', estate_id).single();

    if (estate) {
      const alertMsg =
        `GATEPASS INCIDENT ALERT\n` +
        `Estate: ${estate.name}\nGate: ${gate_id}\n` +
        `Severity: ${severity?.toUpperCase() || 'LOW'}\n` +
        `Report: ${description}\nReported by: ${reported_by}\n` +
        `Time: ${new Date().toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos' })}`;
      try {
        await sendWhatsApp(estate.whatsapp_number.replace('+', ''), alertMsg);
      } catch (e) {
        console.log('Incident WhatsApp alert failed — continuing');
      }
    }

    res.json({ success: true, incident: data });

  } catch (err) {
    console.error('Incident error:', err);
    res.status(500).json({ success: false });
  }
});

// ================================================
// ADMIN APIs (unchanged from v2.0)
// ================================================
app.get('/api/admin/residents', async (req, res) => {
  const { estate_id } = req.query;
  if (!estate_id) return res.status(400).json({ error: 'estate_id required' });
  try {
    const { data, error } = await supabase
      .from('residents').select('*').eq('estate_id', estate_id).order('house_number');
    if (error) throw error;
    res.json({ residents: data });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/residents', async (req, res) => {
  const { estate_id, house_number, resident_name, whatsapp_number, role } = req.body;
  try {
    const { data, error } = await supabase.from('residents').insert({
      estate_id, house_number, resident_name, whatsapp_number,
      role: role || 'resident', is_active: true,
    }).select().single();
    if (error) throw error;
    res.json({ success: true, resident: data });
  } catch (err) {
    console.error('Add resident error:', err);
    res.status(500).json({ success: false, error: 'Could not add resident' });
  }
});

app.patch('/api/admin/residents/:id', async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;
  try {
    const { error } = await supabase.from('residents').update({ is_active }).eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
});

app.get('/api/admin/dashboard', async (req, res) => {
  const { estate_id } = req.query;
  if (!estate_id) return res.status(400).json({ error: 'estate_id required' });
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data: todayPasses } = await supabase.from('visitors').select('*')
      .eq('estate_id', estate_id).gte('created_at', today.toISOString());
    const { data: insideNow } = await supabase.from('visitors').select('*')
      .eq('estate_id', estate_id).eq('status', 'checked_in');
    const { data: recentLogs } = await supabase.from('logs').select('*')
      .eq('estate_id', estate_id).gte('timestamp', today.toISOString())
      .order('timestamp', { ascending: false }).limit(50);
    const { data: openIncidents } = await supabase.from('incidents').select('*')
      .eq('estate_id', estate_id).eq('status', 'open').order('created_at', { ascending: false });
    const { data: estate } = await supabase.from('estates').select('*').eq('id', estate_id).single();
    res.json({
      estate,
      summary: {
        total_today: todayPasses?.length || 0,
        inside_now: insideNow?.length || 0,
        completed_today: todayPasses?.filter(p => p.status === 'checked_out').length || 0,
        denied_today: recentLogs?.filter(l => l.action === 'denied').length || 0,
      },
      inside_now: insideNow || [],
      recent_logs: recentLogs || [],
      open_incidents: openIncidents || [],
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/gates', async (req, res) => {
  const { estate_id } = req.query;
  if (!estate_id) return res.status(400).json({ error: 'estate_id required' });
  try {
    const { data: estate } = await supabase.from('estates').select('*').eq('id', estate_id).single();
    if (!estate) return res.status(404).json({ error: 'Estate not found' });
    const baseUrl = 'https://gatepass-bamishile.netlify.app';
    res.json({
      gates: [
        { id: 'main', name: 'Main Gate', url: `${baseUrl}?gate=main&estate=${estate_id}` },
        { id: 'community', name: 'Community Gate', url: `${baseUrl}?gate=community&estate=${estate_id}` },
      ],
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/auth', async (req, res) => {
  const { email, password, estate_id } = req.body;
  try {
    const { data: estate } = await supabase.from('estates').select('*')
      .eq('id', estate_id).eq('is_active', true).single();
    if (!estate) return res.json({ success: false, reason: 'Estate not found' });

    const masterPassword = process.env.ADMIN_PASSWORD;
    const masterEmail = process.env.ADMIN_EMAIL;

    if (email === masterEmail && password === masterPassword) {
      return res.json({ success: true, role: 'superadmin', estate: estate.name });
    }
    if (estate.admin_email && estate.admin_password &&
        email === estate.admin_email && password === estate.admin_password) {
      return res.json({ success: true, role: 'admin', estate: estate.name });
    }
    return res.json({ success: false, reason: 'Invalid credentials' });
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ success: false, reason: 'Server error' });
  }
});

// ================================================
// WEEKLY REPORT
// ================================================
cron.schedule('0 20 * * 0', async () => {
  console.log('Generating weekly reports...');
  try {
    const { data: estates } = await supabase.from('estates').select('*').eq('is_active', true);
    if (!estates) return;

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransporter({
      service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    for (const estate of estates) {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const { data: passes } = await supabase.from('visitors').select('*')
        .eq('estate_id', estate.id).gte('created_at', weekAgo.toISOString());
      if (!passes) continue;

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
GATEPASS — ${estate.name.toUpperCase()}
Weekly Operations Report — ${reportDate}
${'─'.repeat(44)}

SUMMARY
Total passes issued:       ${total}
Completed (entry + exit):  ${completed} (${completionRate}%)
Cancelled by residents:    ${cancelled}
Expired unused:            ${expired}
Entered, no exit logged:   ${noExit}

${'─'.repeat(44)}
${noExit > 0 ? `NOTE: ${noExit} visitor(s) entered but have no exit log.\nRemind guards to scan visitors on departure.\n\n` : ''}
This report is automatically generated every Sunday evening.
GatePass · ${estate.name} · Built by IGATA Consulting Technologies
      `.trim();

      await transporter.sendMail({
        from: `GatePass ${estate.name} <${SMTP_USER}>`,
        to: REPORT_EMAIL,
        subject: `GatePass Weekly Report · ${estate.name} · ${reportDate}`,
        text: emailBody,
      });
      console.log(`Weekly report sent for ${estate.name}`);
    }
  } catch (err) {
    console.error('Report error:', err);
  }
}, { timezone: 'Africa/Lagos' });

// ================================================
// AUTO EXPIRY
// ================================================
cron.schedule('0 * * * *', async () => {
  try {
    await supabase.from('visitors').update({ status: 'expired' })
      .eq('status', 'active').lt('valid_to', new Date().toISOString());
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
    system: 'GatePass',
    version: '3.0',
    status: 'online',
    ai: 'active',
    powered_by: 'IGATA Consulting Technologies',
  });
});

app.listen(PORT, () => {
  console.log(`GatePass server v3.0 with AI running on port ${PORT}`);
});
