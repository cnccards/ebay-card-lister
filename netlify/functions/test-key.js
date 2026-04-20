// netlify/functions/test-key.js
// Verifies the GEMINI_API_KEY env var is set and the key actually works.
// Call this before trying to identify a card.

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

exports.handler = async function() {
  const t0 = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        stage: 'env_var_missing',
        message: 'GEMINI_API_KEY is not set on the Netlify function. Go to Site configuration > Environment variables.'
      })
    };
  }

  if (!apiKey.startsWith('AIza')) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        stage: 'env_var_malformed',
        message: 'GEMINI_API_KEY is set but does not look like a Google API key (expected to start with "AIza"). Check the value.'
      })
    };
  }

  // Make a tiny test call
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with just the word OK and nothing else.' }] }],
        generationConfig: { maxOutputTokens: 10, temperature: 0 }
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    const text = await r.text();
    if (!r.ok) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          stage: 'gemini_api_error',
          httpStatus: r.status,
          message: `Gemini API rejected the key or request. Response: ${text.slice(0, 500)}`
        })
      };
    }

    let data;
    try { data = JSON.parse(text); } catch (e) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, stage: 'parse_error', message: 'Gemini returned non-JSON: ' + text.slice(0, 300) })
      };
    }

    const reply = ((((data.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('').trim();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        stage: 'success',
        message: 'Gemini API key is working correctly.',
        modelReply: reply,
        elapsedMs: Date.now() - t0
      })
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        stage: 'network_error',
        message: e.message || String(e)
      })
    };
  }
};
