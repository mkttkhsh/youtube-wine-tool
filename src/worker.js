// YouTube ワイン抽出ツール — Cloudflare Worker
// エンドポイント:
//   POST /api/extract  { url }  → { videoId, title, description, publishedDate, transcriptLang, wines: [...] }
//   それ以外 → public/ の静的アセット（UI）

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname === '/api/extract') return handleExtract(request, env);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return new Response(resp.body, { status: resp.status, headers: h });
}
function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  }));
}

// ---------- YouTube URL → videoId ----------
function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  // 11-char ID that appears in youtube URLs
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return null;
}

// ---------- 動画ページ取得＋字幕トラック抽出 ----------
async function fetchWatchPage(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}&hl=ja&gl=JP`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ja,en;q=0.8',
    },
  });
  if (!r.ok) throw new Error(`YouTube ページ取得失敗 (${r.status})`);
  return await r.text();
}

// ytInitialPlayerResponse を HTML から抜く
function parsePlayerResponse(html) {
  // 複数の書き方があるので順に試す
  const patterns = [
    /var ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var |<\/script>)/s,
    /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var |<\/script>)/s,
    /"ytInitialPlayerResponse"\s*:\s*(\{.+?\})\s*,\s*"/s,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch (e) {
        // 継続して次のパターンを試す
      }
    }
  }
  return null;
}

// 字幕トラックリストから最良の1本を選ぶ（ja → ja自動 → en → 最初の1本）
function pickCaptionTrack(tracks) {
  if (!tracks || !tracks.length) return null;
  // 1) 日本語の手動字幕
  let t = tracks.find(x => (x.languageCode === 'ja') && x.kind !== 'asr');
  if (t) return t;
  // 2) 日本語の自動字幕
  t = tracks.find(x => x.languageCode === 'ja');
  if (t) return t;
  // 3) 英語の手動字幕
  t = tracks.find(x => (x.languageCode === 'en') && x.kind !== 'asr');
  if (t) return t;
  // 4) 英語の自動字幕
  t = tracks.find(x => x.languageCode === 'en');
  if (t) return t;
  return tracks[0];
}

// 字幕XML → プレーンテキスト
function transcriptXmlToText(xml) {
  // <text start="..." dur="...">本文</text> を抽出
  const out = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push(decodeHtml(m[1]).replace(/\s+/g, ' ').trim());
  }
  return out.filter(Boolean).join('\n');
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

async function fetchTranscript(track) {
  if (!track || !track.baseUrl) return { lang: null, text: '' };
  // 日本語がなければ翻訳パラメータで日本語化を試みる
  const url = new URL(track.baseUrl);
  const r = await fetch(url.toString(), { headers: { 'User-Agent': UA } });
  if (!r.ok) return { lang: track.languageCode || null, text: '' };
  const xml = await r.text();
  return { lang: track.languageCode || null, text: transcriptXmlToText(xml) };
}

// ---------- Gemini でワイン抽出 ----------
async function extractWinesWithGemini(env, ctx) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です（wrangler secret put で登録してください）');
  const model = env.GEMINI_MODEL || 'gemini-3.6-flash';
  const prompt = buildWinePrompt(ctx);
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          wines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                wineName: { type: 'string' },
                producer: { type: 'string' },
                variety: { type: 'string' },
                country: { type: 'string' },
                region: { type: 'string' },
                vintage: { type: 'string' },
              },
              required: ['wineName'],
            },
          },
        },
        required: ['wines'],
      },
    },
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Gemini エラー: ' + t.slice(0, 300));
  }
  const d = await r.json();
  const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.wines) ? parsed.wines : [];
  } catch (e) {
    throw new Error('Gemini 応答の JSON 解析に失敗しました');
  }
}

function buildWinePrompt({ title, description, transcript }) {
  // 入力サイズを抑制
  const trimmedDesc = (description || '').slice(0, 3000);
  const trimmedScript = (transcript || '').slice(0, 20000);
  return `# 役割
あなたはワインに詳しいアシスタントです。以下は YouTube のブラインドテイスティング動画に付随するメタ情報と文字起こしです。この動画に「出題された」もしくは「登場した」ワインを、1本 = 1レコードで JSON に構造化して抽出してください。

# 入力
## 動画タイトル
${title || '(不明)'}

## 概要欄
${trimmedDesc || '(なし)'}

## 文字起こし（自動字幕を含む・多少の誤変換あり）
${trimmedScript || '(なし)'}

# 抽出ルール
- 出題ワイン（＝味わってブラインドで当てにいくワイン）を対象。テイスターが飲んでいなくても、比較で名前だけ挙がっているワインは除外。
- 迷ったら wineName だけ埋めて残りは空文字にする。推測は書かない（誤情報より空欄が良い）。
- 各項目の書き方:
  - wineName: 商品名。生産者名は除く（例：「Château Margaux 2015」ではなく「Château Margaux」または「シャトー・マルゴー」）
  - producer: 生産者名（例：「シャトー・マルゴー」「ドメーヌ・ルフレーヴ」）
  - variety: 品種。複数は「カベルネ・ソーヴィニヨン, メルロー」のようにカンマ+半角スペース区切り
  - country: 国名（例：「フランス」「イタリア」「日本」「アメリカ」）
  - region: 産地（例：「ボルドー・メドック」「ブルゴーニュ・シャブリ」「山梨」）
  - vintage: 年（例：「2015」「2020」）。ノン・ヴィンテージなら「N.V.」
- 日本語表記を優先。原語しか出ていない場合は原語で。
- 字幕は自動生成のため誤字が多いです。文脈から正しい表記を推定してよいが、断片的すぎるものは避ける。
- 出題本数が読み取れないなら、確信のあるものだけ返す。0件でも構いません。

# 出力
JSON のみ。以下のスキーマに厳密に従うこと:
{ "wines": [ { "wineName": "...", "producer": "...", "variety": "...", "country": "...", "region": "...", "vintage": "..." }, ... ] }
`;
}

// ---------- メタ情報抜き出し ----------
function extractMeta(playerResponse, html) {
  const vd = playerResponse?.videoDetails || {};
  const microformat = playerResponse?.microformat?.playerMicroformatRenderer || {};
  const title = vd.title || (html.match(/<meta name="title" content="([^"]+)"/) || [])[1] || '';
  const description = vd.shortDescription || microformat.description?.simpleText || '';
  const publishedDate = microformat.publishDate || microformat.uploadDate || '';
  return { title, description, publishedDate };
}

// ---------- ハンドラ本体 ----------
async function handleExtract(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST を使用してください' }, 405);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'リクエストが不正です' }, 400); }

  const videoId = extractVideoId(body.url);
  if (!videoId) return json({ error: 'YouTube の URL または動画 ID を渡してください' }, 400);

  let html;
  try { html = await fetchWatchPage(videoId); }
  catch (e) { return json({ error: '動画ページの取得に失敗しました: ' + e.message }, 502); }

  const playerResponse = parsePlayerResponse(html);
  if (!playerResponse) return json({ error: 'YouTube ページの解析に失敗しました（構造が変わった可能性）' }, 502);

  // 年齢制限/非公開など
  const status = playerResponse?.playabilityStatus?.status;
  if (status && status !== 'OK') {
    return json({ error: `動画にアクセスできません: ${status} - ${playerResponse?.playabilityStatus?.reason || ''}` }, 403);
  }

  const meta = extractMeta(playerResponse, html);
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const track = pickCaptionTrack(tracks);
  let transcriptLang = null;
  let transcriptText = '';
  let transcriptNote = '';
  if (track) {
    try {
      const t = await fetchTranscript(track);
      transcriptLang = t.lang;
      transcriptText = t.text;
    } catch (e) {
      transcriptNote = '字幕は見つかりましたが取得に失敗しました: ' + e.message;
    }
  } else {
    transcriptNote = 'この動画には字幕がありません。概要欄のみで抽出します。';
  }

  let wines = [];
  try {
    wines = await extractWinesWithGemini(env, {
      title: meta.title,
      description: meta.description,
      transcript: transcriptText,
    });
  } catch (e) {
    return json({
      error: e.message,
      videoId,
      title: meta.title,
      description: meta.description,
      publishedDate: meta.publishedDate,
      transcriptLang,
      transcriptNote,
    }, 502);
  }

  return json({
    videoId,
    title: meta.title,
    description: meta.description,
    publishedDate: meta.publishedDate,
    transcriptLang,
    transcriptNote,
    transcriptChars: transcriptText.length,
    wines,
  });
}
