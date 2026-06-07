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
const HAPEE_PIT          = process.env.HAPEE_PIT || '';
const HAPEE_LOCATION_ID  = process.env.HAPEE_LOCATION_ID || '';
const HAPEE_API_BASE     = process.env.HAPEE_API_BASE || 'https://services.leadconnectorhq.com';
const HAPEE_API_VERSION  = process.env.HAPEE_API_VERSION || '2021-07-28';
const PSI_API_KEY        = process.env.PSI_API_KEY || ''; // opcional, sin key tiene rate-limit más bajo
if (!HAPEE_PIT || !HAPEE_LOCATION_ID) console.warn('[scan-digitals] WARN: HAPEE_PIT / HAPEE_LOCATION_ID no configurados — /api/lead fallará.');
if (!PSI_API_KEY) console.warn('[scan-digitals] WARN: PSI_API_KEY no configurado — PageSpeed Insights estará deshabilitado.');
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

// === Email report builder ===
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function buildReportHtml({ name, url, score, scanData }) {
  const s = scanData || {};
  const psi = s.psi || {};
  const psiOk = !psi.unavailable && psi.scores;
  const cons = s.consolidated || {};
  const recos = Array.isArray(cons.recommendations) ? cons.recommendations.slice(0, 10) : [];
  const seo = s.seo || {};
  const aeoScore = cons.aeoScore || 0;

  const scoreColor = score >= 80 ? '#5ec97a' : score >= 60 ? '#e5bb55' : score >= 40 ? '#db666a' : '#db666a';
  const greet = (name || '').trim().split(/\s+/)[0] || 'Hola';
  const cwv = psi.coreWebVitals || {};

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auditoría web · ${escapeHtml(url)}</title></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#f4f4f4;">
<div style="max-width:640px;margin:0 auto;background:#141414;">

  <div style="padding:32px 36px;border-bottom:1px solid rgba(255,255,255,0.08);">
    <div style="font-size:28px;font-weight:500;letter-spacing:-0.02em;color:#fff;">Digitals</div>
    <div style="height:5px;width:130px;background:linear-gradient(90deg,#12809b 0%,#5ec97a 25%,#e5bb55 50%,#e88b3a 75%,#db666a 100%);margin-top:6px;border-radius:2px;"></div>
    <div style="margin-top:24px;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#7a7a7a;font-weight:600;">Auditoría web · scan.digitals.cl</div>
  </div>

  <div style="padding:32px 36px;">
    <p style="margin:0 0 16px;color:#cccccc;font-size:15px;line-height:1.6;">${escapeHtml(greet)}, gracias por usar Digitals Scan.</p>
    <p style="margin:0 0 24px;color:#cccccc;font-size:15px;line-height:1.6;">Estos son los resultados de la auditoría de <a href="${escapeHtml(url)}" style="color:#12c1d8;text-decoration:none;">${escapeHtml(url)}</a>:</p>

    <div style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.10);border-radius:14px;padding:28px;text-align:center;margin:24px 0;">
      <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#7a7a7a;font-weight:600;margin-bottom:8px;">Score global</div>
      <div style="font-family:'Bebas Neue','Arial Narrow',sans-serif;font-size:88px;line-height:1;font-weight:400;color:${scoreColor};letter-spacing:0.01em;">${score}</div>
      <div style="font-size:12px;color:#999999;margin-top:4px;">/ 100</div>
    </div>

    <table role="presentation" style="width:100%;border-collapse:collapse;margin:24px 0;">
      <tr>
        ${psiOk ? `
        <td style="width:25%;padding:14px 8px;text-align:center;background:rgba(18,128,155,0.08);border-radius:10px;">
          <div style="font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#7a7a7a;font-weight:700;margin-bottom:6px;">Performance</div>
          <div style="font-family:'Bebas Neue','Arial Narrow',sans-serif;font-size:32px;color:${psi.scores.performance>=80?'#5ec97a':psi.scores.performance>=50?'#e5bb55':'#db666a'};">${psi.scores.performance}</div>
        </td>
        <td style="width:5px;"></td>
        <td style="width:25%;padding:14px 8px;text-align:center;background:rgba(18,128,155,0.08);border-radius:10px;">
          <div style="font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#7a7a7a;font-weight:700;margin-bottom:6px;">SEO</div>
          <div style="font-family:'Bebas Neue','Arial Narrow',sans-serif;font-size:32px;color:${psi.scores.seo>=80?'#5ec97a':psi.scores.seo>=50?'#e5bb55':'#db666a'};">${psi.scores.seo}</div>
        </td>
        <td style="width:5px;"></td>
        <td style="width:25%;padding:14px 8px;text-align:center;background:rgba(18,128,155,0.08);border-radius:10px;">
          <div style="font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#7a7a7a;font-weight:700;margin-bottom:6px;">A11y</div>
          <div style="font-family:'Bebas Neue','Arial Narrow',sans-serif;font-size:32px;color:${psi.scores.accessibility>=80?'#5ec97a':psi.scores.accessibility>=50?'#e5bb55':'#db666a'};">${psi.scores.accessibility}</div>
        </td>
        <td style="width:5px;"></td>
        <td style="width:25%;padding:14px 8px;text-align:center;background:rgba(229,187,85,0.08);border-radius:10px;">
          <div style="font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#7a7a7a;font-weight:700;margin-bottom:6px;">AEO/GEO</div>
          <div style="font-family:'Bebas Neue','Arial Narrow',sans-serif;font-size:32px;color:${aeoScore>=80?'#5ec97a':aeoScore>=50?'#e5bb55':'#db666a'};">${aeoScore}</div>
        </td>` : `
        <td colspan="7" style="padding:14px;text-align:center;background:rgba(229,187,85,0.08);border-radius:10px;border:1px dashed rgba(229,187,85,0.32);">
          <div style="font-size:11px;color:#e5bb55;font-weight:600;">PageSpeed Insights no estuvo disponible · score basado en SEO + AEO/GEO</div>
          <div style="margin-top:8px;font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#7a7a7a;font-weight:700;">AEO/GEO: ${aeoScore}/100</div>
        </td>`}
      </tr>
    </table>

    ${psiOk && (cwv.lcp || cwv.cls) ? `
    <div style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin:24px 0;">
      <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#7a7a7a;font-weight:700;margin-bottom:12px;">Core Web Vitals</div>
      <table role="presentation" style="width:100%;font-size:13px;color:#cccccc;">
        ${cwv.lcp ? `<tr><td style="padding:4px 0;width:50%;"><strong style="color:#fff;">LCP</strong> Largest Contentful Paint</td><td style="text-align:right;font-family:monospace;color:${cwv.lcp.score>=0.9?'#5ec97a':cwv.lcp.score>=0.5?'#e5bb55':'#db666a'};">${escapeHtml(cwv.lcp.display)}</td></tr>` : ''}
        ${cwv.cls ? `<tr><td style="padding:4px 0;"><strong style="color:#fff;">CLS</strong> Cumulative Layout Shift</td><td style="text-align:right;font-family:monospace;color:${cwv.cls.score>=0.9?'#5ec97a':cwv.cls.score>=0.5?'#e5bb55':'#db666a'};">${escapeHtml(cwv.cls.display)}</td></tr>` : ''}
        ${cwv.fcp ? `<tr><td style="padding:4px 0;"><strong style="color:#fff;">FCP</strong> First Contentful Paint</td><td style="text-align:right;font-family:monospace;color:${cwv.fcp.score>=0.9?'#5ec97a':cwv.fcp.score>=0.5?'#e5bb55':'#db666a'};">${escapeHtml(cwv.fcp.display)}</td></tr>` : ''}
        ${cwv.tbt ? `<tr><td style="padding:4px 0;"><strong style="color:#fff;">TBT</strong> Total Blocking Time</td><td style="text-align:right;font-family:monospace;color:${cwv.tbt.score>=0.9?'#5ec97a':cwv.tbt.score>=0.5?'#e5bb55':'#db666a'};">${escapeHtml(cwv.tbt.display)}</td></tr>` : ''}
        ${cwv.si ? `<tr><td style="padding:4px 0;"><strong style="color:#fff;">SI</strong> Speed Index</td><td style="text-align:right;font-family:monospace;color:${cwv.si.score>=0.9?'#5ec97a':cwv.si.score>=0.5?'#e5bb55':'#db666a'};">${escapeHtml(cwv.si.display)}</td></tr>` : ''}
      </table>
    </div>` : ''}

    ${recos.length ? `
    <div style="margin:32px 0 16px;">
      <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#7a7a7a;font-weight:700;margin-bottom:14px;">Plan de mejoras priorizado · top ${recos.length}</div>
      ${recos.map((r, i) => `
        <div style="background:#0d0d0d;border-left:3px solid ${r.severity==='high'?'#db666a':r.severity==='medium'?'#e5bb55':'#12c1d8'};border-radius:6px;padding:14px 18px;margin-bottom:10px;">
          <div style="font-size:9.5px;letter-spacing:0.22em;text-transform:uppercase;color:${r.severity==='high'?'#db666a':r.severity==='medium'?'#e5bb55':'#12c1d8'};font-weight:700;margin-bottom:6px;">${escapeHtml(r.severity)} · ${escapeHtml(r.area)}</div>
          <div style="font-size:14px;color:#fff;font-weight:600;margin-bottom:4px;">${i+1}. ${escapeHtml(r.title)}</div>
          <div style="font-size:13px;color:#aaaaaa;line-height:1.55;">${escapeHtml(r.tip)}</div>
        </div>
      `).join('')}
    </div>` : ''}

    <div style="background:linear-gradient(135deg,rgba(18,128,155,0.14),rgba(229,187,85,0.10));border:1px solid rgba(18,128,155,0.32);border-radius:14px;padding:24px;margin:32px 0 16px;">
      <div style="font-size:13px;color:#cccccc;line-height:1.6;">¿Quieres que Digitals te haga un <strong style="color:#fff;">upgrade real</strong> de la web? Ejecutamos el plan completo en 3-6 semanas — diseño + dev + AEO/GEO/LLMO + integración con tu CRM.</div>
      <div style="margin-top:18px;">
        <a href="https://upgrade.digitals.cl/?url=${encodeURIComponent(url)}" style="display:inline-block;background:#12809b;color:#fff;text-decoration:none;padding:13px 26px;border-radius:100px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Cotizar mi upgrade →</a>
      </div>
    </div>
  </div>

  <div style="padding:24px 36px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;color:#7a7a7a;font-size:11px;line-height:1.7;">
    <div>Digitals · agencia de marketing digital + IA en Chile</div>
    <div style="margin-top:4px;"><a href="https://digitals.cl" style="color:#7a7a7a;text-decoration:none;">digitals.cl</a> · <a href="https://scan.digitals.cl" style="color:#7a7a7a;text-decoration:none;">scan.digitals.cl</a> · <a href="https://upgrade.digitals.cl" style="color:#7a7a7a;text-decoration:none;">upgrade.digitals.cl</a></div>
  </div>
</div>
</body></html>`;
}

async function sendReportEmail({ contactId, email, name, url, score, scanData }) {
  if (!contactId) return { sent: false, reason: 'no-contact-id' };
  const html = buildReportHtml({ name, url, score, scanData });
  const subject = `Tu auditoría web · score ${score}/100 · ${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  const body = {
    type: 'Email',
    contactId,
    subject,
    html,
    emailFrom: process.env.HAPEE_EMAIL_FROM || 'hola@digitals.cl'
  };
  const r = await fetchWithTimeout(`${HAPEE_API_BASE}/conversations/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HAPEE_PIT}`,
      'Version': HAPEE_API_VERSION,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, 20000);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[hapee email error]', r.status, data);
    return { sent: false, reason: 'hapee-error', status: r.status, detail: data?.message };
  }
  return { sent: true, messageId: data?.messageId || data?.id || null };
}

app.post('/api/lead', async (req, res) => {
  try {
    const { name = '', email = '', phone = '', url = '', score = 0, scanData = null } = req.body || {};
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

    const contactId = data?.contact?.id || data?.id || null;

    // Enviar reporte por email (no bloqueante en caso de fallo)
    let emailResult = { sent: false };
    try {
      emailResult = await sendReportEmail({ contactId, email, name, url, score, scanData });
    } catch (emailErr) {
      console.error('[email send error]', emailErr);
      emailResult = { sent: false, reason: 'exception', detail: emailErr.message };
    }

    res.json({ ok: true, contactId, email: emailResult });
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
