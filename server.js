/* Digitals Scan · backend ESM Node 22+
   Endpoints:
     POST /api/scan   { url }                       → análisis completo
     POST /api/lead   { name, email, phone, url, score, scanData? } → crea contacto Hapee
   Stack: Express + native fetch (Node 20+) · no deps adicionales para mantenerlo lean */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const app = express();
app.use(express.json({ limit: '300kb' }));

const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

// === Env vars ===
const HAPEE_PIT          = process.env.HAPEE_PIT || 'pit-60913a06-a23c-4de4-9f60-7b484dac855b';
const HAPEE_LOCATION_ID  = process.env.HAPEE_LOCATION_ID || 'tPqE8ZXL6r8h5e9k0SGQ';
const HAPEE_API_BASE     = process.env.HAPEE_API_BASE || 'https://services.leadconnectorhq.com';
const HAPEE_API_VERSION  = process.env.HAPEE_API_VERSION || '2021-07-28';
const PSI_API_KEY        = process.env.PSI_API_KEY || ''; // opcional, sin key tiene rate-limit más bajo
const PSI_BASE           = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

// === Utils ===
function normalizeUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('URL inválida');
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { throw new Error('URL inválida'); }
  return url;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r;
  } finally { clearTimeout(id); }
}

// === Google PageSpeed Insights ===
async function runPSI(url, strategy = 'mobile') {
  if (!PSI_API_KEY) {
    return { unavailable: true, reason: 'missing-api-key', message: 'PSI API key no configurada (set PSI_API_KEY env var en Dokploy).' };
  }
  const psiUrl = `${PSI_BASE}?url=${encodeURIComponent(url)}&strategy=${strategy}` +
                 `&category=performance&category=accessibility&category=best-practices&category=seo` +
                 `&key=${PSI_API_KEY}`;
  const r = await fetchWithTimeout(psiUrl, {}, 35000);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    let reason = 'api-error';
    if (r.status === 429) reason = 'rate-limit';
    if (r.status === 400) reason = 'bad-url';
    return { unavailable: true, reason, status: r.status, message: text.slice(0, 300) };
  }
  const data = await r.json();
  const lh = data.lighthouseResult || {};
  const cats = lh.categories || {};
  const audits = lh.audits || {};
  const cls = audits['cumulative-layout-shift'] || {};
  const lcp = audits['largest-contentful-paint'] || {};
  const fcp = audits['first-contentful-paint'] || {};
  const tbt = audits['total-blocking-time'] || {};
  const si  = audits['speed-index'] || {};
  const inp = (data.loadingExperience && data.loadingExperience.metrics &&
               data.loadingExperience.metrics.INTERACTION_TO_NEXT_PAINT_MS) || null;

  return {
    strategy,
    scores: {
      performance:   Math.round((cats.performance?.score ?? 0) * 100),
      accessibility: Math.round((cats.accessibility?.score ?? 0) * 100),
      bestPractices: Math.round((cats['best-practices']?.score ?? 0) * 100),
      seo:           Math.round((cats.seo?.score ?? 0) * 100)
    },
    coreWebVitals: {
      lcp: { display: lcp.displayValue || '—', score: lcp.score ?? null, value: lcp.numericValue ?? null },
      cls: { display: cls.displayValue || '—', score: cls.score ?? null, value: cls.numericValue ?? null },
      fcp: { display: fcp.displayValue || '—', score: fcp.score ?? null, value: fcp.numericValue ?? null },
      tbt: { display: tbt.displayValue || '—', score: tbt.score ?? null, value: tbt.numericValue ?? null },
      si:  { display: si.displayValue || '—',  score: si.score ?? null,  value: si.numericValue ?? null },
      inp: inp ? { display: inp.percentile + ' ms', category: inp.category, value: inp.percentile } : null
    },
    // Top opportunities (improvements with significant savings)
    opportunities: Object.values(audits)
      .filter(a => a.details?.type === 'opportunity' && (a.numericValue || 0) > 100)
      .sort((a, b) => (b.numericValue || 0) - (a.numericValue || 0))
      .slice(0, 8)
      .map(a => ({ id: a.id, title: a.title, description: a.description, displayValue: a.displayValue || '' }))
  };
}

// === SEO + AEO/GEO scraper ===
async function scrapeSeo(url) {
  let html = '';
  let headers = {};
  let httpStatus = 0;
  try {
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 DigitalsScan/1.0 (+https://scan.digitals.cl)' } }, 20000);
    httpStatus = r.status;
    headers = Object.fromEntries(r.headers.entries());
    html = await r.text();
  } catch (e) {
    throw new Error('No se pudo cargar la URL: ' + e.message);
  }

  const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] || html;
  const body = html.replace(/<head[\s\S]*?<\/head>/i, '');

  const m = (re) => (html.match(re) || [])[1] || '';
  const all = (re) => Array.from(html.matchAll(re));

  const title = m(/<title[^>]*>([^<]*)<\/title>/i);
  const description = m(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)
    || m(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i);
  const keywords = m(/<meta\s+name=["']keywords["']\s+content=["']([^"']*)["']/i);
  const canonical = m(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || m(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const ogTitle = m(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i);
  const ogDescription = m(/<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i);
  const ogImage = m(/<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']/i);
  const twitterCard = m(/<meta\s+name=["']twitter:card["']\s+content=["']([^"']*)["']/i);
  const robots = m(/<meta\s+name=["']robots["']\s+content=["']([^"']*)["']/i);
  const viewport = m(/<meta\s+name=["']viewport["']\s+content=["']([^"']*)["']/i);
  const lang = m(/<html[^>]+lang=["']([^"']+)["']/i);
  const hreflangs = all(/<link[^>]+hreflang=["']([^"']+)["'][^>]+href=["']([^"']+)["']/gi).map(x => ({ lang: x[1], href: x[2] }));

  const h1 = all(/<h1[^>]*>([\s\S]*?)<\/h1>/gi).map(x => x[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  const h2 = all(/<h2[^>]*>([\s\S]*?)<\/h2>/gi).map(x => x[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  const imgs = all(/<img[^>]+>/gi);
  const imgsWithoutAlt = imgs.filter(t => !/\salt=["']/i.test(t[0])).length;

  // Schema.org JSON-LD
  const jsonLd = all(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
    .map(x => { try { return JSON.parse(x[1]); } catch { return null; } })
    .filter(Boolean);

  const schemaTypes = [];
  for (const ld of jsonLd) {
    const traverse = (n) => {
      if (!n) return;
      if (Array.isArray(n)) n.forEach(traverse);
      else if (typeof n === 'object') {
        if (n['@type']) {
          (Array.isArray(n['@type']) ? n['@type'] : [n['@type']]).forEach(t => schemaTypes.push(t));
        }
        if (n['@graph']) traverse(n['@graph']);
      }
    };
    traverse(ld);
  }

  const hasFaqPage = schemaTypes.includes('FAQPage');
  const hasBreadcrumb = schemaTypes.includes('BreadcrumbList');
  const hasOrg = schemaTypes.some(t => t === 'Organization' || t === 'LocalBusiness');
  const hasSpeakable = /SpeakableSpecification|"speakable"/i.test(html);

  // Performance / técnicos
  const cspHeader = headers['content-security-policy'] || '';
  const xfo = headers['x-frame-options'] || '';
  const hsts = headers['strict-transport-security'] || '';
  const cacheControl = headers['cache-control'] || '';

  return {
    url,
    httpStatus,
    finalUrl: url,
    isHttps: url.startsWith('https://'),
    html: { size: html.length },
    title: { text: title, length: title.length, ok: title.length >= 30 && title.length <= 70 },
    description: { text: description, length: description.length, ok: description.length >= 70 && description.length <= 320 },
    keywords: { has: !!keywords, value: keywords.slice(0, 200) },
    canonical: { has: !!canonical, value: canonical },
    og: { title: !!ogTitle, description: !!ogDescription, image: !!ogImage },
    twitter: { card: !!twitterCard, type: twitterCard },
    robots: { has: !!robots, value: robots },
    viewport: { has: !!viewport, value: viewport },
    lang: { has: !!lang, value: lang },
    hreflangs: { count: hreflangs.length, list: hreflangs.slice(0, 5) },
    headings: { h1Count: h1.length, h1First: h1[0] || '', h2Count: h2.length },
    images: { total: imgs.length, withoutAlt: imgsWithoutAlt, altCoverage: imgs.length ? Math.round(((imgs.length - imgsWithoutAlt) / imgs.length) * 100) : 100 },
    schema: { count: jsonLd.length, types: [...new Set(schemaTypes)].slice(0, 12), hasOrg, hasFaqPage, hasBreadcrumb, hasSpeakable },
    security: { https: url.startsWith('https://'), hsts: !!hsts, xfo: !!xfo, csp: !!cspHeader, cacheControl: !!cacheControl }
  };
}

// === robots.txt + sitemap.xml + llms.txt checks ===
async function fetchTextOrNull(u) {
  try {
    const r = await fetchWithTimeout(u, { headers: { 'User-Agent': 'DigitalsScan/1.0' } }, 6000);
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

async function siteFiles(url) {
  const u = new URL(url);
  const base = `${u.protocol}//${u.host}`;
  const [robots, sitemap, llms] = await Promise.all([
    fetchTextOrNull(`${base}/robots.txt`),
    fetchTextOrNull(`${base}/sitemap.xml`),
    fetchTextOrNull(`${base}/llms.txt`)
  ]);
  // Detección de AI crawlers permitidos
  const aiBots = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-Web', 'anthropic-ai',
                  'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'Meta-ExternalAgent', 'CCBot', 'Bytespider'];
  const aiBotsAllowed = robots ? aiBots.filter(bot => new RegExp(`User-agent:\\s*${bot}[\\s\\S]*?Allow:\\s*\\/`, 'i').test(robots)) : [];
  return {
    robots: { exists: !!robots, hasSitemap: !!robots && /Sitemap:/i.test(robots), aiBotsAllowedCount: aiBotsAllowed.length, aiBotsAllowed },
    sitemap: { exists: !!sitemap, urlCount: sitemap ? (sitemap.match(/<url>/g) || []).length : 0 },
    llms: { exists: !!llms, length: llms?.length || 0 }
  };
}

// === Score consolidado + recomendaciones priorizadas ===
function consolidate(scan) {
  const psi = scan.psi || {};
  const seo = scan.seo || {};
  const files = scan.files || {};

  // Score AEO/GEO/LLMO (0-100)
  let aeoScore = 0;
  const aeoChecks = [
    { key: 'schema-org',    ok: seo.schema?.hasOrg,         weight: 12 },
    { key: 'faq-page',      ok: seo.schema?.hasFaqPage,     weight: 18, label: 'FAQPage schema (citaciones LLM)' },
    { key: 'breadcrumb',    ok: seo.schema?.hasBreadcrumb,  weight: 8 },
    { key: 'speakable',     ok: seo.schema?.hasSpeakable,   weight: 8, label: 'speakable (voice AI)' },
    { key: 'llms-txt',      ok: files.llms?.exists,         weight: 15, label: 'llms.txt (estándar LLMO)' },
    { key: 'ai-bots',       ok: (files.robots?.aiBotsAllowedCount || 0) >= 5, weight: 12, label: 'AI bots permitidos (GPTBot/Claude/Gemini/etc)' },
    { key: 'og-complete',   ok: seo.og?.title && seo.og?.description && seo.og?.image, weight: 8 },
    { key: 'twitter-card',  ok: seo.twitter?.card,          weight: 5 },
    { key: 'alt-coverage',  ok: (seo.images?.altCoverage || 0) >= 90, weight: 8 },
    { key: 'h1-single',     ok: seo.headings?.h1Count === 1, weight: 6 }
  ];
  for (const c of aeoChecks) if (c.ok) aeoScore += c.weight;

  // Score global ponderado · si PSI no disponible, score basado solo en SEO/AEO scrape
  const psiOk = !psi.unavailable && psi.scores;
  let globalScore;
  if (psiOk) {
    globalScore = Math.round(
      (psi.scores.performance || 0) * 0.30 +
      (psi.scores.seo || 0)         * 0.25 +
      aeoScore                       * 0.25 +
      (psi.scores.accessibility || 0) * 0.10 +
      (psi.scores.bestPractices || 0) * 0.10
    );
  } else {
    // SEO básico: tiene title+desc+canonical+H1+viewport ok = 70 puntos
    const seoBasic = (seo.title?.ok ? 18 : 0) + (seo.description?.ok ? 18 : 0) +
                     (seo.canonical?.has ? 12 : 0) + (seo.viewport?.has ? 10 : 0) +
                     (seo.headings?.h1Count === 1 ? 12 : 0);
    globalScore = Math.round(aeoScore * 0.55 + seoBasic * 0.45);
  }

  // Top recomendaciones priorizadas
  const recos = [];
  if (!seo.title?.ok) recos.push({ severity: 'high', area: 'SEO', title: 'Title tag fuera de rango óptimo', tip: 'El title ideal mide 30-70 caracteres. Actualmente: ' + (seo.title?.length || 0) + ' chars.' });
  if (!seo.description?.ok) recos.push({ severity: 'high', area: 'SEO', title: 'Meta description fuera de rango', tip: 'Ideal 70-320 chars con keywords clave. Actualmente: ' + (seo.description?.length || 0) + ' chars.' });
  if (!seo.canonical?.has) recos.push({ severity: 'high', area: 'SEO', title: 'Falta canonical', tip: 'Agregar <link rel="canonical" href="..."> para evitar contenido duplicado.' });
  if (!seo.viewport?.has) recos.push({ severity: 'high', area: 'Mobile', title: 'Falta viewport meta', tip: '<meta name="viewport" content="width=device-width, initial-scale=1"> es obligatorio.' });
  if (seo.headings?.h1Count !== 1) recos.push({ severity: 'medium', area: 'SEO', title: 'H1 incorrecto', tip: 'Cada página debe tener exactamente 1 <h1>. Encontrados: ' + seo.headings?.h1Count + '.' });
  if ((seo.images?.withoutAlt || 0) > 0) recos.push({ severity: 'medium', area: 'A11y/SEO', title: seo.images.withoutAlt + ' imágenes sin alt', tip: 'Agregar texto alternativo a todas las <img> para accesibilidad y SEO.' });
  if (!files.llms?.exists) recos.push({ severity: 'high', area: 'AEO/LLMO', title: 'Falta llms.txt', tip: 'Crear /llms.txt con resumen estructurado del negocio para citaciones de ChatGPT, Claude, Gemini y Perplexity.' });
  if (!seo.schema?.hasFaqPage) recos.push({ severity: 'high', area: 'AEO/GEO', title: 'Sin FAQPage schema', tip: 'Implementar Schema.org FAQPage con 5-8 Q&A para featured snippets y citaciones AI.' });
  if (!seo.schema?.hasOrg) recos.push({ severity: 'medium', area: 'SEO', title: 'Sin Organization schema', tip: 'Agregar Schema.org Organization/LocalBusiness con name, url, logo, telephone, address y sameAs.' });
  if (!seo.schema?.hasSpeakable) recos.push({ severity: 'low', area: 'AEO', title: 'Sin SpeakableSpecification', tip: 'Marcar bloques principales como speakable para asistentes de voz (Siri, Google Assistant).' });
  if ((files.robots?.aiBotsAllowedCount || 0) < 5) recos.push({ severity: 'high', area: 'LLMO', title: 'AI crawlers no explícitamente permitidos', tip: 'Agregar a robots.txt: GPTBot, ChatGPT-User, ClaudeBot, Google-Extended, PerplexityBot, Applebot-Extended, Meta-ExternalAgent, CCBot.' });
  if (!seo.security?.hsts) recos.push({ severity: 'medium', area: 'Security', title: 'Falta HSTS', tip: 'Agregar Strict-Transport-Security header en respuestas HTTPS.' });
  if (!seo.og?.image) recos.push({ severity: 'medium', area: 'Social', title: 'Falta og:image', tip: 'Crear imagen 1200×630 JPG y agregar <meta property="og:image">.' });
  if (!seo.twitter?.card) recos.push({ severity: 'low', area: 'Social', title: 'Sin Twitter Card', tip: 'Agregar <meta name="twitter:card" content="summary_large_image">.' });

  // PSI opportunities como mejoras adicionales de performance
  for (const op of (psi.opportunities || []).slice(0, 5)) {
    recos.push({ severity: 'medium', area: 'Performance', title: op.title, tip: op.description.replace(/\[Learn[^\]]*\]\([^)]+\)/g, '').trim() });
  }

  return {
    globalScore,
    aeoScore,
    aeoChecks,
    recommendations: recos.sort((a, b) => {
      const o = { high: 0, medium: 1, low: 2 };
      return (o[a.severity] - o[b.severity]);
    }).slice(0, 12)
  };
}

// === ROUTES ===

app.post('/api/scan', async (req, res) => {
  const start = Date.now();
  try {
    const url = normalizeUrl(req.body?.url || '');
    const [psi, seo, files] = await Promise.allSettled([
      runPSI(url, 'mobile'),
      scrapeSeo(url),
      siteFiles(url)
    ]);

    const scan = {
      url,
      timing: { ms: 0 },
      psi:   psi.status   === 'fulfilled' ? psi.value   : { error: psi.reason?.message },
      seo:   seo.status   === 'fulfilled' ? seo.value   : { error: seo.reason?.message },
      files: files.status === 'fulfilled' ? files.value : { error: files.reason?.message }
    };
    const cons = consolidate(scan);
    scan.consolidated = cons;
    scan.timing.ms = Date.now() - start;
    res.json(scan);
  } catch (e) {
    console.error('[scan error]', e);
    res.status(400).json({ error: e.message || 'Error procesando la URL' });
  }
});

app.post('/api/lead', async (req, res) => {
  try {
    const { name = '', email = '', phone = '', url = '', score = 0 } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    const [firstName, ...rest] = name.trim().split(/\s+/);
    const lastName = rest.join(' ');

    const payload = {
      firstName: firstName || '',
      lastName: lastName || '',
      email,
      phone: phone || undefined,
      locationId: HAPEE_LOCATION_ID,
      tags: ['scan-tool', 'lead-magnet', 'free-audit'],
      source: 'scan.digitals.cl',
      customFields: [
        { key: 'scanned_url', field_value: url },
        { key: 'global_score', field_value: String(score) }
      ]
    };

    const r = await fetchWithTimeout(`${HAPEE_API_BASE}/contacts/upsert`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HAPEE_PIT}`,
        'Version': HAPEE_API_VERSION,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, 15000);

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[hapee error]', r.status, data);
      return res.status(502).json({ error: 'No se pudo crear el contacto en CRM', detail: data?.message });
    }
    res.json({ ok: true, contactId: data?.contact?.id || data?.id || null });
  } catch (e) {
    console.error('[lead error]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// === Static frontend ===
app.use(express.static(join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  }
}));

app.listen(PORT, () => {
  console.log(`[scan-digitals] listening on :${PORT}`);
});
