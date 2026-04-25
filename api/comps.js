// /api/comps - Fetches recent sold listings from eBay for a card title
// Returns: { ok, count, median, low, high, average, samples }

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    // Get title from query string
    const title = (req.query && req.query.title) || '';
    if (!title || title.length < 5) {
      return res.status(400).json({
        ok: false,
        error: 'Missing or too-short "title" query parameter (need 5+ chars).'
      });
    }

    // Limit title length to avoid 414 URI Too Long errors
    const cleanTitle = String(title).trim().slice(0, 200);

    // Build eBay sold-listings URL
    // _sacat=261328 = Sports Trading Card Singles (matches our app's category)
    // LH_Sold=1 = sold only
    // LH_Complete=1 = completed listings only
    // _ipg=60 = 60 results per page (more data without pagination)
    const ebayUrl = 'https://www.ebay.com/sch/i.html?_nkw=' +
      encodeURIComponent(cleanTitle) +
      '&_sacat=261328&LH_Sold=1&LH_Complete=1&_ipg=60';

    // Fetch with browser-like headers to avoid being blocked
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const fetchRes = await fetch(ebayUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!fetchRes.ok) {
      return res.status(200).json({
        ok: false,
        error: 'eBay returned HTTP ' + fetchRes.status,
        elapsedMs: Date.now() - t0
      });
    }

    const html = await fetchRes.text();

    // Parse sold prices from HTML
    // eBay's listing items are in <li class="s-item ..."> blocks
    // Each has a <span class="s-item__price"> tag with the price
    // For ranges (rare for sold), we take the lowest in the range
    const prices = [];
    const samples = [];

    // Regex to find each item block + extract title + price
    // s-item__title and s-item__price are stable class names eBay uses
    const itemRe = /<li class="s-item[^"]*"[^>]*>[\s\S]*?<\/li>/g;
    let itemMatch;
    let count = 0;
    while ((itemMatch = itemRe.exec(html)) !== null && count < 30) {
      const block = itemMatch[0];

      // Skip "Shop on eBay" promotional cards (they have no price match anyway)
      if (block.indexOf('Shop on eBay') !== -1) continue;

      // Extract title
      const titleMatch = block.match(/<span[^>]*class="[^"]*s-item__title[^"]*"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?([^<]+)<\/span>/);
      const itemTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

      // Skip the placeholder "New Listing" text
      if (!itemTitle || itemTitle === 'New Listing') continue;

      // Extract price - handle "$XX.XX" or "$XX.XX to $YY.YY" (ranges)
      const priceMatch = block.match(/<span[^>]*class="[^"]*s-item__price[^"]*"[^>]*>([^<]+)<\/span>/);
      if (!priceMatch) continue;
      const priceStr = priceMatch[1].replace(/[,\s]/g, '');
      const priceNumMatch = priceStr.match(/\$(\d+(?:\.\d+)?)/);
      if (!priceNumMatch) continue;
      const price = parseFloat(priceNumMatch[1]);
      if (isNaN(price) || price <= 0) continue;

      prices.push(price);
      if (samples.length < 10) {
        samples.push({ title: itemTitle.slice(0, 80), price: price });
      }
      count++;
    }

    if (prices.length === 0) {
      return res.status(200).json({
        ok: false,
        error: 'No sold listings found for this title. Try a shorter/simpler search.',
        searchUrl: ebayUrl,
        elapsedMs: Date.now() - t0
      });
    }

    // Compute stats
    const sorted = prices.slice().sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length/2 - 1] + sorted[sorted.length/2]) / 2
      : sorted[Math.floor(sorted.length/2)];
    const sum = prices.reduce((a, b) => a + b, 0);
    const average = sum / prices.length;
    const low = sorted[0];
    const high = sorted[sorted.length - 1];

    // Trimmed mean: drop highest 10% and lowest 10% (removes outliers)
    let trimmedMedian = median;
    if (sorted.length >= 5) {
      const trimCount = Math.floor(sorted.length * 0.1);
      const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
      const trimSum = trimmed.reduce((a, b) => a + b, 0);
      trimmedMedian = trimSum / trimmed.length;
    }

    res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 min cache
    return res.status(200).json({
      ok: true,
      count: prices.length,
      median: Math.round(median * 100) / 100,
      low: Math.round(low * 100) / 100,
      high: Math.round(high * 100) / 100,
      average: Math.round(average * 100) / 100,
      trimmedAverage: Math.round(trimmedMedian * 100) / 100,
      suggested: Math.round(trimmedMedian * 100) / 100,
      samples: samples,
      searchUrl: ebayUrl,
      elapsedMs: Date.now() - t0
    });

  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: e.message || String(e),
      elapsedMs: Date.now() - t0
    });
  }
}
