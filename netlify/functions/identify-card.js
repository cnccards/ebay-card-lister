// netlify/functions/identify-card.js
// Takes one or more base64 images of a sports card, uses Gemini 2.5 Flash
// vision to identify it, and returns structured data for an eBay listing.

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// System prompt - tells Gemini exactly what to extract and how to format it
const SYSTEM_PROMPT = `You are an expert sports card identifier and eBay lister. You will see one or more photos of a sports trading card (front, back, possibly a grading slab). Identify the card with extreme precision and return ONLY a valid JSON object matching this exact schema - no prose, no markdown fences, no explanation:

{
  "player": "Full player name (e.g. 'Mike Trout')",
  "year": "4-digit year of the set (e.g. '2011')",
  "manufacturer": "Topps | Panini | Bowman | Upper Deck | Donruss | Leaf | Fleer | Score | other",
  "set": "Set name (e.g. 'Topps Update', 'Panini Prizm', 'Bowman Chrome Draft')",
  "cardNumber": "Card number as shown (e.g. 'US175', '1', '#BDP12')",
  "parallel": "Parallel/variety if any (e.g. 'Base', 'Refractor', 'Silver Prizm', 'Gold /10', 'Red Wave')",
  "sport": "Baseball | Basketball | Football | Hockey | Soccer | Other",
  "league": "MLB | NBA | NFL | NHL | MLS | NCAA | Other",
  "team": "Team name shown on card",
  "isRookie": true or false,
  "isAutograph": true or false,
  "isMemorabilia": true or false,
  "memorabiliaType": "Jersey | Patch | Bat | Ball | None",
  "isGraded": true or false,
  "grader": "PSA | BGS | SGC | CGC | None",
  "grade": "Grade as string (e.g. '10', '9.5', '8'), or 'None' if ungraded",
  "certNumber": "Grading cert number if visible, else ''",
  "cardCondition": "Near Mint or Better | Excellent | Very Good | Poor | Graded",
  "cardThickness": "35 Pt. | 55 Pt. | 75 Pt. | 100 Pt. | 130 Pt. | 180 Pt. | Unknown",
  "features": "Comma-separated relevant features (e.g. 'Rookie, Refractor', 'Autograph, Memorabilia')",
  "vintage": true or false,
  "originalReprint": "Original | Reprint",
  "language": "English",
  "era": "Modern (2000-Now) | Pre-Modern (1970-1999) | Vintage (Pre-1970)",
  "season": "Year of the season (often same as card year)",
  "title": "eBay title MAX 80 CHARACTERS, keyword-packed, in format: 'YEAR SET PLAYER CARDNUM PARALLEL ROOKIE TEAM SPORT' — use abbreviations to fit",
  "description": "4-6 sentence buyer-friendly description highlighting condition, eye appeal, centering, corners, any flaws. Mention rookie/autograph/grade. Professional tone.",
  "suggestedPrice": "Estimated market value in USD as a number (e.g. 24.99). Be conservative. Round to .99.",
  "confidence": "high | medium | low — how confident are you in the identification"
}

CRITICAL RULES:
- Title must be at most 80 characters. Count carefully. Use abbreviations (RC = rookie, Auto = autograph).
- Return ONLY the JSON object. No preamble, no "here is the JSON", no backticks.
- If you cannot see a field clearly, make your best reasonable guess based on the set/year, but lower confidence to "medium" or "low".
- For ungraded cards, set grader to "None", grade to "None", certNumber to "".
- For non-rookie cards, isRookie = false.
- Keep every field filled in — never leave a field null or undefined.
- Prices: rookies/stars priced higher than base commons. Parallels and autos priced higher. Be realistic based on recent comps you know.`;

async function callGemini(apiKey, images) {
  // Build the parts array - one inline_data per image, then the prompt text
  const parts = [];
  for (const img of images) {
    parts.push({
      inline_data: {
        mime_type: img.mimeType || 'image/jpeg',
        data: img.data
      }
    });
  }
  parts.push({ text: SYSTEM_PROMPT });

  const body = {
    contents: [{ parts: parts }],
    generationConfig: {
      temperature: 0.2, // lower = more consistent identification
      maxOutputTokens: 2048,
      responseMimeType: 'application/json' // tell Gemini to return JSON
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Gemini HTTP ${r.status}: ${txt.slice(0, 500)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonFromResponse(geminiResp) {
  // Gemini returns: candidates[0].content.parts[0].text (the JSON string)
  const candidates = geminiResp.candidates || [];
  if (!candidates.length) throw new Error('Gemini returned no candidates. Full response: ' + JSON.stringify(geminiResp).slice(0, 500));
  const parts = (candidates[0].content && candidates[0].content.parts) || [];
  if (!parts.length) throw new Error('Gemini returned candidate with no parts');
  // Concatenate all text parts (usually just 1)
  let text = '';
  for (const p of parts) if (p.text) text += p.text;
  if (!text) throw new Error('Gemini returned no text in parts');
  // Strip markdown fences if present (Gemini sometimes adds them despite responseMimeType)
  text = text.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Gemini returned non-JSON text: ${text.slice(0, 300)}`);
  }
}

exports.handler = async function(event) {
  const t0 = Date.now();
  try {
    // Only accept POST
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Method not allowed. Use POST.' })
      };
    }

    // Check API key exists
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'GEMINI_API_KEY environment variable is not set on the Netlify function. Go to Site configuration > Environment variables and add it.'
        })
      };
    }

    // Parse body
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Invalid JSON in request body' })
      };
    }

    const images = payload.images || [];
    if (!images.length) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'No images provided. Send { images: [{mimeType, data}, ...] }' })
      };
    }

    // Validate images
    for (const img of images) {
      if (!img.data) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: false, error: 'Each image must have { mimeType, data (base64 string) }' })
        };
      }
    }

    // Call Gemini
    const geminiResp = await callGemini(apiKey, images);
    const cardData = extractJsonFromResponse(geminiResp);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        elapsedMs: Date.now() - t0,
        imageCount: images.length,
        card: cardData
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error: e.message || String(e),
        elapsedMs: Date.now() - t0
      })
    };
  }
};
