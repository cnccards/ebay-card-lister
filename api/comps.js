// /api/comps - Fetches recent eBay sold listings for a card title
// v2 (rebuilt): strict filtering, player name validation, returns sample data

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    const title = (req.query && req.query.title) || '';
    const player = (req.query && req.query.player) || '';
    const debug = !!(req.query && req.query.debug);

    if (!title || title.length < 5) {
      return res.status(400).json({
        ok: false,
        error: 'Missing or too-short "title" query parameter (need 5+ chars).'
      });
    }

    const cleanTitle = String(title).trim().slice(0, 200);
    const ebayUrl = 'https://www.ebay.com/sch/i.html?_nkw=' +
      encodeURIComponent(cleanTitle) +
      '&_sacat=261328&LH_Sold=1&LH_Complete=1&_ipg=60&rt=nc';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const fetchRes = await fetch(ebayUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1'
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

    let playerKey = (player || '').trim().toLowerCase();

    // Parse all li.s-item blocks
    const itemRe = /<li[^>]+class="[^"]*s-item[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
    const allMatches = [];
    let m;
    while ((m = itemRe.exec(html)) !== null && allMatches.length < 60) {
      const block = m[1];
      if (block.indexOf('Shop on eBay') !== -1) continue;

      let itemTitle = '';
      const t1 = block.match(/<span[^>]*class="[^"]*s-item__title[^"]*"[^>]*>([\s\S]*?)<\/span>/);
      if (t1) {
        itemTitle = t1[1].replace(/<span[^>]*>[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!itemTitle) {
          const inner = t1[1].match(/<span[^>]*>([^<]+)<\/span>/);
          if (inner) itemTitle = inner[1].trim();
        }
      }
      if (!itemTitle) continue;
      if (itemTitle.toLowerCase() === 'new listing') continue;
      if (itemTitle.toLowerCase().indexOf('shop on ebay') !== -1) continue;

      const p1 = block.match(/<span[^>]*class="[^"]*s-item__price[^"]*"[^>]*>([\s\S]*?)<\/span>/);
      if (!p1) continue;
      const priceText = p1[1].replace(/<[^>]+>/g, '').replace(/[,\s]/g, '');
      const priceNumMatch = priceText.match(/\$(\d+(?:\.\d+)?)/);
      if (!priceNumMatch) continue;
      const price = parseFloat(priceNumMatch[1]);
      if (isNaN(price) || price < 1) continue;

      allMatches.push({ title: itemTitle, price: price });
    }

    // Filter by player name relevance (if we have one)
    let filtered = allMatches;
    let usedFiltering = false;
    if (playerKey) {
      const playerFiltered = allMatches.filter(item => {
        return item.title.toLowerCase().indexOf(playerKey) !== -1;
      });
      if (playerFiltered.length >= 1) {
        filtered = playerFiltered;
        usedFiltering = true;
      }
    }

    // If we have a grade in the title, prefer matches with same grade
    const gradeMatch = cleanTitle.match(/\b(PSA|BGS|SGC|CGC)\s*(\d+(?:\.\d+)?)\b/i);
    let gradeFiltered = filtered;
    let usedGradeFilter = null;
    if (gradeMatch) {
      const grader = gradeMatch[1].toUpperCase();
      const grade = gradeMatch[2];
      const gradeMatched = filtered.filter(item => {
        const t = item.title.toUpperCase();
        // Match "PSA 9", "PSA9", "PSA  9"
        const re = new RegExp('\\b' + grader + '\\s*' + grade.replace('.', '\\.') + '\\b');
        return re.test(t);
      });
      if (gradeMatched.length >= 1) {
        gradeFiltered = gradeMatched;
        usedGradeFilter = grader + ' ' + grade;
      }
    }

    if (gradeFiltered.length === 0) {
      return res.status(200).json({
        ok: false,
        error: 'No matching sold listings found. Try a shorter or simpler title.',
        searchUrl: ebayUrl,
        rawCount: allMatches.length,
        rawSamples: allMatches.slice(0, 5),
        elapsedMs: Date.now() - t0
      });
    }

    // Drop extreme outliers
    const initSorted = gradeFiltered.map(x => x.price).sort((a, b) => a - b);
    const initMed = initSorted.length % 2
      ? initSorted[Math.floor(initSorted.length / 2)]
      : (initSorted[initSorted.length/2 - 1] + initSorted[initSorted.length/2]) / 2;
    const finalSet = gradeFiltered.filter(x => x.price >= initMed / 10 && x.price <= initMed * 10);

    const sorted = finalSet.map(x => x.price).sort((a, b) => a - b);
    if (!sorted.length) {
      return res.status(200).json({
        ok: false,
        error: 'No valid prices after filtering.',
        searchUrl: ebayUrl,
        elapsedMs: Date.now() - t0
      });
    }

    const median = sorted.length % 2
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length/2 - 1] + sorted[sorted.length/2]) / 2;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const average = sum / sorted.length;
    const low = sorted[0];
    const high = sorted[sorted.length - 1];

    let suggested = median;
    if (sorted.length >= 5) {
      const trim = Math.floor(sorted.length * 0.15);
      const trimmed = sorted.slice(trim, sorted.length - trim);
      const trimSum = trimmed.reduce((a, b) => a + b, 0);
      suggested = trimSum / trimmed.length;
    }

    res.setHeader('Cache-Control', 'public, max-age=1800');
    return res.status(200).json({
      ok: true,
      count: sorted.length,
      rawCount: allMatches.length,
      filteredByPlayer: usedFiltering ? playerKey : null,
      filteredByGrade: usedGradeFilter,
      median: Math.round(median * 100) / 100,
      low: Math.round(low * 100) / 100,
      high: Math.round(high * 100) / 100,
      average: Math.round(average * 100) / 100,
      suggested: Math.round(suggested * 100) / 100,
      samples: finalSet.slice(0, 10).map(x => ({
        title: x.title.slice(0, 100),
        price: x.price
      })),
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
