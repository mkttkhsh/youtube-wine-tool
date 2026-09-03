// YouTube ワイン抽出ツール — Cloudflare Worker
// エンドポイント:
//   POST /api/extract  { url }                            → 単一動画のメタ + Gemini抽出結果
//   POST /api/channel  { url } | { continuation }          → チャンネル動画一覧（ページネーション対応）
//   それ以外 → public/ の静的アセット（UI）
//
// 実装: YouTube Data API v3 を使ってメタ情報を取得（Cloudflare IP が Innertube を bot 判定するため）。
// ワイン抽出は Gemini でタイトル + 概要欄から構造化。
// 字幕は Data API では取得できないため使わない（概要欄で十分な精度が出る）。

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname === '/api/extract') return handleExtract(request, env);
    if (url.pathname === '/api/channel') return handleChannel(request, env);
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

// ---------- URL パース ----------
function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
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

// チャンネルの識別子を返す: { handle?: string, channelId?: string }
function extractChannelRef(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // 生の @handle
  const bare = s.match(/^@([\w.-]+)$/);
  if (bare) return { handle: bare[1] };
  try {
    const u = new URL(s.startsWith('http') ? s : 'https://' + s);
    const path = u.pathname.replace(/\/+$/, '');
    // /channel/UCxxx
    const chId = path.match(/\/channel\/(UC[\w-]{20,})/);
    if (chId) return { channelId: chId[1] };
    // /@handle
    const handle = path.match(/\/@([\w.-]+)/);
    if (handle) return { handle: handle[1] };
    // /c/name または /user/name → handle 検索へフォールバック
    const legacy = path.match(/\/(c|user)\/([\w.-]+)/);
    if (legacy) return { handle: legacy[2] };
  } catch (e) { /* ignore */ }
  return null;
}

// ---------- YouTube Data API v3 ----------
async function ytApi(env, endpoint, params) {
  if (!env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY が未設定です（wrangler secret put で登録してください）');
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', env.YOUTUBE_API_KEY);
  const r = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d?.error?.message || `Data API エラー (${r.status})`);
  return d;
}

// ---------- Fly.io 字幕サービス ----------
async function fetchTranscript(env, videoId) {
  if (!env.TRANSCRIPT_URL) return { text: '', lang: null, kind: null, note: 'TRANSCRIPT_URL 未設定' };
  const url = `${env.TRANSCRIPT_URL.replace(/\/+$/, '')}/transcript?v=${encodeURIComponent(videoId)}`;
  const headers = {};
  if (env.TRANSCRIPT_AUTH_TOKEN) headers['X-Auth-Token'] = env.TRANSCRIPT_AUTH_TOKEN;
  try {
    const r = await fetch(url, { headers });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { text: '', lang: null, kind: null, note: `字幕サービスエラー (${r.status}): ${(d.error || '').slice(0, 80)}` };
    return {
      text: d.text || '',
      lang: d.lang || null,
      kind: d.kind || null,
      note: d.note || '',
    };
  } catch (e) {
    return { text: '', lang: null, kind: null, note: '字幕サービス通信失敗: ' + e.message };
  }
}

// ---------- Gemini 抽出 ----------
async function extractWinesWithGemini(env, ctx) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');
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
  const trimmedDesc = (description || '').slice(0, 5000);
  const trimmedScript = (transcript || '').slice(0, 25000);
  return `# 役割
あなたはワインに詳しいアシスタントです。以下は YouTube のブラインドテイスティング動画のタイトル・概要欄・文字起こしです。この動画で「出題された」もしくは「テイスターが実際に飲んだ」ワインを、1本 = 1レコードで JSON に構造化して抽出してください。

# 入力
## 動画タイトル
${title || '(不明)'}

## 概要欄
${trimmedDesc || '(なし)'}

## 文字起こし（自動字幕を含むため多少の誤変換あり）
${trimmedScript || '(なし)'}

# 抽出ルール
- 出題ワイン（＝味わってブラインドで当てにいくワイン）を対象。比較で名前だけ挙がっているワインや、講座・イベント告知のワインは除外。
- 概要欄に「【本日のワイン】」「【テクニカルデータ】」「品種：」「産地：」「ヴィンテージ：」等のキーがある場合、それを最優先で読む。
- **ヴィンテージ**は概要欄には無い場合が多い。文字起こし中の「〜年」「20XX年産」「XX年ですね」等の発言から拾う（特に答え合わせの終盤に多い）。字幕は自動生成で「2016」を「2016年ですね」と読み上げていることもあれば「二千十六年」と表記されることもある。数字表記に正規化する。
- 迷ったら wineName だけ埋めて残りは空文字にする。推測は書かない（誤情報より空欄が良い）。特にヴィンテージは、確信が持てないなら空欄で。
- 各項目の書き方:
  - wineName: 商品名。生産者名は除く（例：「シャトー・マルゴー 2015」ではなく「シャトー・マルゴー」）。ラベル表記そのままでも可。
  - producer: 生産者名（例：「シャトー・マルゴー」「ドメーヌ・ルフレーヴ」「ラングマン」）。「〜／」の後にある名前は多くの場合これに該当。
  - variety: 品種。複数は「カベルネ・ソーヴィニヨン, メルロー」のようにカンマ+半角スペース区切り
  - country: 国名（例：「フランス」「イタリア」「日本」「オーストリア」）
  - region: 産地（例：「ボルドー・メドック」「ブルゴーニュ・シャブリ」「ヴェストシュタイヤーマルク」）
  - vintage: 年（例：「2015」「2020」）。ノン・ヴィンテージなら「N.V.」。書かれてなければ空欄。
- 日本語表記を優先。原語しか出ていない場合は原語で。
- 概要欄に登場する定型文（講座告知、Amazon リンク、テイスティングワイン募集など）は無視。
- 出題本数が読み取れないなら、確信のあるものだけ返す。0件でも構いません。

# 出力
JSON のみ。以下のスキーマに厳密に従うこと:
{ "wines": [ { "wineName": "...", "producer": "...", "variety": "...", "country": "...", "region": "...", "vintage": "..." }, ... ] }
`;
}

// ---------- /api/extract ----------
async function handleExtract(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST を使用してください' }, 405);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'リクエストが不正です' }, 400); }

  const videoId = extractVideoId(body.url);
  if (!videoId) return json({ error: 'YouTube の動画 URL または動画 ID を渡してください' }, 400);

  let d;
  try { d = await ytApi(env, 'videos', { part: 'snippet', id: videoId }); }
  catch (e) { return json({ error: '動画情報の取得に失敗しました: ' + e.message }, 502); }

  const item = (d.items || [])[0];
  if (!item) return json({ error: '動画が見つかりません（削除・非公開の可能性）' }, 404);

  const s = item.snippet || {};
  const title = s.title || '';
  const description = s.description || '';
  const publishedDate = s.publishedAt || '';

  // 字幕を Fly.io サービスから取得（失敗しても続行）
  const tr = await fetchTranscript(env, videoId);

  let wines = [];
  try {
    wines = await extractWinesWithGemini(env, { title, description, transcript: tr.text });
  } catch (e) {
    return json({ error: e.message, videoId, title, description, publishedDate }, 502);
  }

  return json({
    videoId,
    title,
    description,
    publishedDate,
    channelTitle: s.channelTitle || '',
    transcriptLang: tr.lang,
    transcriptKind: tr.kind,
    transcriptChars: (tr.text || '').length,
    transcriptNote: tr.note || '',
    wines,
  });
}

// ---------- /api/channel ----------
// 初回: { url } を受けて channelId を確定し uploads プレイリストの最初のページを返す
// 継続: { continuation: { playlistId, pageToken } } で次のページを取得
async function handleChannel(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST を使用してください' }, 405);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'リクエストが不正です' }, 400); }

  // 継続ページ
  if (body.continuation) {
    const { playlistId, pageToken } = body.continuation;
    if (!playlistId) return json({ error: 'continuation.playlistId が必要です' }, 400);
    try {
      const page = await ytApi(env, 'playlistItems', {
        part: 'snippet,contentDetails',
        playlistId,
        maxResults: 50,
        pageToken,
      });
      return json({
        videos: playlistItemsToVideos(page.items || []),
        continuation: page.nextPageToken ? { playlistId, pageToken: page.nextPageToken } : null,
      });
    } catch (e) { return json({ error: '続きの取得に失敗しました: ' + e.message }, 502); }
  }

  // 初回
  const ref = extractChannelRef(body.url);
  if (!ref) return json({ error: 'チャンネル URL または @handle を渡してください' }, 400);

  try {
    let channelId = ref.channelId;
    let channelTitle = '';

    if (!channelId) {
      // handle → channelId 解決
      const c = await ytApi(env, 'channels', {
        part: 'snippet,contentDetails',
        forHandle: ref.handle,
      });
      const it = (c.items || [])[0];
      if (!it) return json({ error: `チャンネルが見つかりません (@${ref.handle})` }, 404);
      channelId = it.id;
      channelTitle = it.snippet?.title || '';
      // uploads playlistId
      const uploads = it.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) return json({ error: 'uploads プレイリストが見つかりません' }, 502);
      const page = await ytApi(env, 'playlistItems', {
        part: 'snippet,contentDetails',
        playlistId: uploads,
        maxResults: 50,
      });
      return json({
        channelTitle, channelId,
        videos: playlistItemsToVideos(page.items || []),
        continuation: page.nextPageToken ? { playlistId: uploads, pageToken: page.nextPageToken } : null,
      });
    }

    // channelId 指定 → channels で uploads を取得
    const c = await ytApi(env, 'channels', {
      part: 'snippet,contentDetails',
      id: channelId,
    });
    const it = (c.items || [])[0];
    if (!it) return json({ error: `チャンネルが見つかりません (${channelId})` }, 404);
    channelTitle = it.snippet?.title || '';
    const uploads = it.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return json({ error: 'uploads プレイリストが見つかりません' }, 502);
    const page = await ytApi(env, 'playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: uploads,
      maxResults: 50,
    });
    return json({
      channelTitle, channelId,
      videos: playlistItemsToVideos(page.items || []),
      continuation: page.nextPageToken ? { playlistId: uploads, pageToken: page.nextPageToken } : null,
    });
  } catch (e) {
    return json({ error: 'チャンネル取得エラー: ' + e.message }, 502);
  }
}

function playlistItemsToVideos(items) {
  const out = [];
  for (const it of items) {
    const s = it.snippet || {};
    const cd = it.contentDetails || {};
    const videoId = cd.videoId || s.resourceId?.videoId;
    if (!videoId) continue;
    const thumbs = s.thumbnails || {};
    const thumb = (thumbs.medium || thumbs.high || thumbs.default || {}).url || '';
    // 相対時刻ではなく publishedAt を表示
    const publishedAt = cd.videoPublishedAt || s.publishedAt || '';
    out.push({
      id: videoId,
      title: s.title || '',
      publishedText: publishedAt ? publishedAt.slice(0, 10) : '',
      views: '',
      thumbnail: thumb,
    });
  }
  return out;
}
