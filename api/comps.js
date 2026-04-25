// /api/comps - v3 with diagnostics
// If parsing fails, returns HTML preview to diagnose what eBay is returning

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    const title = (req.query && req.query.title) || '';
    const player = (req.query && req.query.player) || '';

    if (!title || title.length < 5) {
      return res.status(400).json({ ok: false, error: 'Missing title' });
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
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

    const status = fetchRes.status;
    const html = await fetchRes.text();

    // Diagnostic info
    const htmlLength = html.length;
    const looksBlocked = html.length < 5000 ||
                         html.toLowerCase().indexOf('captcha') !== -1 ||
                         html.toLowerCase().indexOf('robot') !== -1 ||
                         html.toLowerCase().indexOf('access denied') !== -1;

    // Try MULTIPLE parsing strategies
    const allMatches = [];

    // Strategy 1: Original li.s-item with span price
    const re1 = /<li[^>]+class="[^"]*s-item[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = re1.exec(html)) !== null && allMatches.length < 60) {
      const block = m[1];
      if (block.indexOf('Shop on eBay') !== -1) continue;
      const t = block.match(/<span[^>]*class="[^"]*s-item__title[^"]*"[^>]*>([\s\S]*?)<\/span>/);
      const p = block.match(/<span[^>]*class="[^"]*s-item__price[^"]*"[^>]*>([\s\S]*?)<\/span>/);
      if (!t || !p) continue;
      const itemTitle = t[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!itemTitle || itemTitle.toLowerCase() === 'new listing') continue;
      const priceText = p[1].replace(/<[^>]+>/g, '').replace(/[,\s]/g, '');
      const priceNumMatch = priceText.match(/\$(\d+(?:\.\d+)?)/);
      if (!priceNumMatch) continue;
      const price = parseFloat(priceNumMatch[1]);
      if (isNaN(price) || price < 1) continue;
      allMatches.push({ title: itemTitle, price: price });
    }

    // Strategy 2: If strategy 1 found nothing, try div-based parsing
    // eBay also uses <div class="s-item__wrapper"> and <div class="s-card">
    if (allMatches.length === 0) {
      // Try finding any element with class containing "s-item__title" and "s-item__price"
      // These could be in any container, not just <li>
      const titles = [];
      const titleRe = /<(?:span|div|h3|a)[^>]*class="[^"]*s-item__title[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|h3|a)>/g;
      while ((m = titleRe.exec(html)) !== null) {
        const t = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (t && t.toLowerCase() !== 'new listing' && t.toLowerCase().indexOf('shop on') === -1) {
          titles.push(t);
        }
      }
      const prices = [];
      const priceRe = /<(?:span|div)[^>]*class="[^"]*s-item__price[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/g;
      while ((m = priceRe.exec(html)) !== null) {
        const pt = m[1].replace(/<[^>]+>/g, '').replace(/[,\s]/g, '');
        const pm = pt.match(/\$(\d+(?:\.\d+)?)/);
        if (pm) {
          const pv = parseFloat(pm[1]);
          if (!isNaN(pv) && pv >= 1) prices.push(pv);
        }
      }
      // Pair them up by index
      const pairs = Math.min(titles.length, prices.length);
      for (let i = 0; i < pairs; i++) {
        allMatches.push({ title: titles[i], price: prices[i] });
      }
    }

    // Strategy 3: Find any "POSITIVE" sold-price spans by class POSITIVE
    if (allMatches.length === 0) {
      // eBay uses class="POSITIVE" for sold prices
      const posRe = /<span[^>]*class="POSITIVE"[^>]*>([\s\S]*?)<\/span>/g;
      const posPrices = [];
      while ((m = posRe.exec(html)) !== null) {
        const pt = m[1].replace(/<[^>]+>/g, '').replace(/[,\s]/g, '');
        const pm = pt.match(/\$(\d+(?:\.\d+)?)/);
        if (pm) {
          const pv = parseFloat(pm[1]);
          if (!isNaN(pv) && pv >= 1) posPrices.push(pv);
        }
      }
      // Pair with sequential dummy titles
      posPrices.forEach(p => allMatches.push({ title: '(price only)', price: p }));
    }

    // If STILL no matches, return diagnostic info
    if (allMatches.length === 0) {
      return res.status(200).json({
        ok: false,
        error: 'No matches parsed. ' + (looksBlocked ? 'eBay may be blocking us.' : 'eBay HTML format may have changed.'),
        diagnostic: {
          httpStatus: status,
          htmlLength: htmlLength,
          looksBlocked: looksBlocked,
          htmlPreview: html.slice(0, 800),
          containsListings: html.indexOf('s-item') !== -1,
          containsPrices: html.indexOf('$') !== -1,
          containsCaptcha: html.toLowerCase().indexOf('captcha') !== -1,
          containsPleaseVerify: html.toLowerCase().indexOf('please verify') !== -1
        },
        searchUrl: ebayUrl,
        elapsedMs: Date.now() - t0
      });
    }

    // Filter by player if provided
    let filtered = allMatches;
    let usedPlayerFilter = false;
    const playerKey = (player || '').trim().toLowerCase();
    if (playerKey) {
      const lastNameOnly = playerKey.split(' ').pop(); // "Aaron Judge" → "judge"
      const playerFiltered = allMatches.filter(item =>
        item.title.toLowerCase().indexOf(lastNameOnly) !== -1
      );
      if (playerFiltered.length >= 1) {
        filtered = playerFiltered;
        usedPlayerFilter = true;
      }
    }

    // Filter by grade if title has one
    const gradeMatch = cleanTitle.match(/\b(PSA|BGS|SGC|CGC)\s*(\d+(?:\.\d+)?)\b/i);
    let gradeFiltered = filtered;
    let usedGradeFilter = null;
    if (gradeMatch) {
      const grader = gradeMatch[1].toUpperCase();
      const grade = gradeMatch[2];
      const re = new RegExp('\\b' + grader + '\\s*' + grade.replace('.', '\\.') + '\\b', 'i');
      const gMatched = filtered.filter(item => re.test(item.title));
      if (gMatched.length >= 1) {
        gradeFiltered = gMatched;
        usedGradeFilter = grader + ' ' + grade;
      }
    }

    // Drop extreme outliers
    const initSorted = gradeFiltered.map(x => x.price).sort((a, b) => a - b);
    const initMed = initSorted[Math.floor(initSorted.length / 2)];
    const finalSet = gradeFiltered.filter(x => x.price >= initMed / 10 && x.price <= initMed * 10);

    const sorted = finalSet.map(x => x.price).sort((a, b) => a - b);
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
      suggested = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    }

    return res.status(200).json({
      ok: true,
      count: sorted.length,
      rawCount: allMatches.length,
      filteredByPlayer: usedPlayerFilter ? playerKey : null,
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
