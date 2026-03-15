import OpenAI from "openai";
import type { ExportedHandler, KVNamespace, ExecutionContext } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";
export interface Env {
  ALLOWED_ORIGINS?: string;
  OPENAI_API_KEY: string;
  TEAM_STATE: KVNamespace;
  TARGETS: KVNamespace;
  COMPANY_AUTH: KVNamespace;
  MESSAGE_EVENTS: KVNamespace;
  ms_engine_db: D1Database;
  DASHBOARD_HUB: DurableObjectNamespace;
  FACILITATOR_KEY: string;
}

const proxyUrl = "https://proud-koala-28-8qvxvh0jdsjt.deno.dev"; // ← あとでRender本番URLに変更
const BUILD = "cors-v3-2025-09-14-p2";
const TARGETS = ["analyze","summarize","rewrite","translate","classify","extract","keywords","outline","chat","rescue"] as const;

type Target = typeof TARGETS[number];

const nowISO = () => new Date().toISOString();

const pick = (o: any, keys: string[]) => {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === "string" && v.length) return v;
  }
  return "";
};

function requireCompany(body: any) {
  if (!body || !body.companyCode) {
    throw new Response(
      JSON.stringify({ error: "COMPANY_CODE_REQUIRED" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  return body.companyCode;
}

function isFacilitator(req: Request, env: Env) {
  const auth = req.headers.get("Authorization") || "";
  const expected = `Bearer ${env.FACILITATOR_KEY}`;
  return auth === expected;
}

function getDashboardStub(env: Env, companyCode: string) {
  const id = env.DASHBOARD_HUB.idFromName(companyCode);
  return env.DASHBOARD_HUB.get(id);
}

function corsHeaders(origin?: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function allowedOrigin(env: Env, req: Request): string {
  const raw = env.ALLOWED_ORIGINS?.trim();
  if (!raw || raw === "*") return "*";
  const list = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") ?? "";
  return list.includes(origin) ? origin : "*"; 
}

function withCors(base: Headers, origin: string) {
  base.set("Access-Control-Allow-Origin", origin);
  base.set(
    "Access-Control-Allow-Methods",
    "GET,POST,DELETE,OPTIONS,HEAD" // ← ★ DELETE を追加
  );
  base.set(
    "Access-Control-Allow-Headers",
    "content-type, cache-control, x-otb-salt, authorization"
  );
  base.append(
    "Vary",
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
  );
  base.set("Cache-Control", "no-store");
  return base;
}

function addEngineHeaders(res: Response, method: string, path: string, rawPath: string, target?: string) {
  const h = new Headers(res.headers);
  h.set("x-engine-build", BUILD);
  h.set("x-engine-method", method);
  h.set("x-engine-path", path);
  h.set("x-engine-raw-path", rawPath);
  if (target) h.set("x-engine-target", target);
  return new Response(res.body, { status: res.status, headers: h });
}
function json(data: unknown, status = 200, headers?: HeadersInit) {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { status, headers: h });
}
function text(body = "ok", status = 200, headers?: HeadersInit) {
  const h = new Headers(headers);
  h.set("Content-Type", "text/plain;charset=UTF-8");
  return new Response(body, { status, headers: h });
}

export class DashboardHub extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const state =
      (await this.ctx.storage.get<any>("summary")) ?? {
        totalCharCount: 0,
        participantIds: [],
        teamStats: {},
        userStatsByTeam: {},
        overallUserStats: {},
        biasStats: {},
      };

    if (request.method === "POST" && url.pathname === "/apply-message") {
      const record = await request.json<any>();

      const team = record.team || "unknown";
      const user = record.userId || "unknown";
      const charCount = Number(record.charCount || 0);

      state.totalCharCount += charCount;

      if (!state.participantIds.includes(user)) {
        state.participantIds.push(user);
      }

      state.teamStats[team] = (state.teamStats[team] || 0) + charCount;

      if (!state.userStatsByTeam[team]) {
        state.userStatsByTeam[team] = {};
      }
      state.userStatsByTeam[team][user] =
        (state.userStatsByTeam[team][user] || 0) + charCount;

      state.overallUserStats[user] =
        (state.overallUserStats[user] || 0) + charCount;

      if (Array.isArray(record.allFlags)) {
        for (const flag of record.allFlags) {
          state.biasStats[flag] = (state.biasStats[flag] || 0) + 1;
        }
      }

      await this.ctx.storage.put("summary", state);
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/summary") {
      return Response.json({
        ok: true,
        totalCharCount: state.totalCharCount || 0,
        participantCount: (state.participantIds || []).length,
        teamStats: state.teamStats || {},
        userStatsByTeam: state.userStatsByTeam || {},
        biasStats: state.biasStats || {},
        overallUserStats: state.overallUserStats || {},
      });
    }

    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
}

export default {
  // Cloudflare Response 型との不一致を避けるため Response を any にする
  async fetch(request: any, env: Env, ctx: ExecutionContext): Promise<any> {
    const req = request as Request;
    const url = new URL(req.url);
    const rawPath = url.pathname;
    const path = rawPath.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();
    const origin = allowedOrigin(env, req);

    if (method === "OPTIONS") {
      const h = withCors(new Headers(), origin);
      return addEngineHeaders(new Response(null, { status: 204, headers: h }), method, path, rawPath);
    }

    // /health と /persona/health（互換）
    if (method === "GET" && (path === "/health" || path === "/persona/health")) {
      const h = withCors(new Headers(), origin);
      return addEngineHeaders(text("ok", 200, h), method, "/health", rawPath);
    }
/* ------------------------------------------
   /persona/checkKey : OPENAIキー確認用（デバッグ）
   ------------------------------------------ */




// /persona/targets（AI推定エンドポイント）
if ((method === "GET" || method === "POST") && path === "/persona/targets") {
  const h = withCors(new Headers(), origin);

  try {
    const body = method === "POST" ? await req.json() : {};
    const topic = body.topic || url.searchParams.get("topic") || "";

    // 🩹 topicが空ならエラーを出さずスルーして空配列を返す
    if (!topic.trim()) {
      return addEngineHeaders(
        json({ ok: true, topic: "", targets: [] }, 200, h),
        method,
        path,
        rawPath
      );
    }

    // === 🧠 Proxy経由でOpenAIへ接続 ===
// === 🧠 Proxy経由でOpenAIへ接続 ===
const payload = {
  model: "gpt-4o-mini",
  temperature: 0.3,
  messages: [
    {
      role: "system",
      content: `
あなたは社会分析AIです。
与えられた議題に関係しそうな「関係者（ステークホルダー）」を推定して出力します。
出力はJSON配列のみで、日本語の名詞句で8〜12件程度。
      `,
    },
    { role: "user", content: `議題: ${topic}` },
  ],
};

// 🩹 Cloudflare Fetch API でbodyが消える対策
const completion = await fetch(proxyUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload), // ✅ stringifyを事前に評価
});


    // 🩹 JSON以外が返る可能性に備えて安全にパース
    let dataText = await completion.text();
    let data: any = {};
    try {
      data = JSON.parse(dataText);
    } catch (e) {
      console.warn("⚠️ proxy JSON parse failed:", e, dataText);
      throw new Error(`proxy returned invalid JSON: ${dataText.slice(0, 120)}`);
    }

    // === OpenAIの出力を抽出 ===
    const raw = data?.choices?.[0]?.message?.content?.trim() || "[]";

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch {
      parsed = [];
    }

    // === フォールバック ===
    if (!Array.isArray(parsed) || parsed.length === 0) {
      parsed = [
        "当事者",
        "関係者",
        "専門家",
        "行政関係者",
        "研究者",
        "支援者",
        "報道関係者",
        "一般市民",
      ];
    }

    // ✅ 正常レスポンス
    return addEngineHeaders(
      json({ ok: true, topic, targets: parsed }, 200, h),
      method,
      path,
      rawPath
    );

  } catch (err) {
    console.error("❌ /persona/targets failed:", err);
    return addEngineHeaders(
      json(
        {
          error: "proxy_failed",
          message: err?.message || String(err),
        },
        500,
        h
      ),
      method,
      path,
      rawPath
    );
  }
}



// === HEADリクエスト対応 ===
if (method === "HEAD" && path === "/persona/targets") {
  const h = withCors(new Headers(), origin);
  return addEngineHeaders(
    new Response(null, { status: 204, headers: h }),
    method,
    "/persona/targets",
    rawPath
  );
}

// ===============================
// ✅ 企業ログイン（CORS対応）
// ===============================
if (method === "POST" && path === "/auth/companyLogin") {
  const h = withCors(new Headers(), origin);

  try {
    const { companyCode, password } = await req.json();

    if (!companyCode || !password) {
      return addEngineHeaders(
        json({ ok: false, error: "MISSING_PARAMS" }, 400, h),
        method,
        path,
        rawPath
      );
    }

    const record = await env.COMPANY_AUTH.get(
      `COMPANY:${companyCode}`,
      "json"
    );

    if (!record || record.enabled !== true) {
      return addEngineHeaders(
        json({ ok: false, error: "INVALID_COMPANY" }, 401, h),
        method,
        path,
        rawPath
      );
    }

    // ✅ 有効期限チェック（＋ 自動削除）
    if (record.expiresAt && Date.now() > Date.parse(record.expiresAt)) {
      await env.COMPANY_AUTH.delete(`COMPANY:${companyCode}`);

      return addEngineHeaders(
        json({ ok: false, error: "EXPIRED" }, 403, h),
        method,
        path,
        rawPath
      );
    }

    const hashed = await sha256(password);

    if (hashed !== record.passwordHash) {
      return addEngineHeaders(
        json({ ok: false, error: "INVALID_PASSWORD" }, 401, h),
        method,
        path,
        rawPath
      );
    }

    return addEngineHeaders(
      json({ ok: true, companyName: record.companyName }, 200, h),
      method,
      path,
      rawPath
    );
  } catch (err) {
    return addEngineHeaders(
      json({ ok: false, error: "LOGIN_FAILED" }, 500, h),
      method,
      path,
      rawPath
    );
  }
}


// workers
if (method === "POST" && path === "/auth/companyPing") {
  const h = withCors(new Headers(), origin);

  try {
    const { companyCode } = await req.json();
    if (!companyCode) {
      return addEngineHeaders(
        json({ ok: false }, 401, h),
        method,
        path,
        rawPath
      );
    }

    const record = await env.COMPANY_AUTH.get(
      `COMPANY:${companyCode}`,
      "json"
    );

    // ❌ 無効条件
    if (
      !record ||
      record.enabled !== true ||
      (record.expiresAt && Date.now() > Date.parse(record.expiresAt))
    ) {
      // ❗ Ping では delete しない
      return addEngineHeaders(
        json({ ok: false }, 401, h),
        method,
        path,
        rawPath
      );
    }

    return addEngineHeaders(
      json({ ok: true, companyName: record.companyName }, 200, h),
      method,
      path,
      rawPath
    );
  } catch (err) {
    console.error("companyPing error:", err);
    return addEngineHeaders(
      json({ ok: false }, 500, h),
      method,
      path,
      rawPath
    );
  }
}



async function sha256(text: string) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}



// ★ 新しいエンドポイント /persona/explainLine
if (method === "POST" && path === "/persona/explainLine") {
  const body: any = await req.json();

  const topic = body.topic || "";
  const text = body.text || "";

  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `
          あなたは教育支援AIです。以下のJSON形式で出力してください。
          強みや改善点は必ず議論内容に基づいてください。
          - 強みは必ず二つ、自然な日本語で。
          - 改善点は一つ、自然な日本語で。
          - 評価ランクは「秀/優/良/可/不可」から選び、ランダムではなく正当に判断する。
          特に重要:
          - 議論内容が少ないだけで何か埋めていれば不可は避けてください。
          出力フォーマット:
          {
            "rank": "",
            "strengths": ["強み1の文章。","強み2の文章。"],
            "improvement": "改善点の文章。"
          }
          `
        },
        { 
          role: "user", 
          content: `
          以下は学生の議論内容です。この内容を元に評価してください。
          ---
          テーマ: ${topic}
          内容:
          ${text}
          `
        }
      ],
      response_format: { type: "json_object" }
    });

    const raw = completion.choices[0].message?.content || "{}";
    let parsed: { rank: string; strengths: string[]; improvement: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { rank: "不可", strengths: [], improvement: "" };
    }

    const h = withCors(new Headers(), origin);
    return addEngineHeaders(json(parsed, 200, h), method, path, rawPath);

  } catch (err) {
    const h = withCors(new Headers(), origin);
    return addEngineHeaders(
      json({ error: "openai_failed", message: String(err) }, 500, h),
      method, path, rawPath
    );
  }
}



// ★ 改良版エンドポイント /persona/logBias（チェックリスト方式：23のバイアスを個別yes/no判定）
// helpers.jsのOUTLIER_ORDERと同期：速断,循環,二択,歪曲,飛躍,類推,偶然,曖昧,分割,中傷,同調,権威,巻添,転嫁,慣習,恐怖,憤怒,同情,嘲笑,楽観,幻想,矮小,不明
if (method === "POST" && path === "/persona/logBias") {
  const body = await req.json();
  const topic = body.topic || "";
  const fields = body.fields || {};

  console.log("🧠 [logBias] チェックリスト方式（24バイアス個別判定）", { topic, fields });

  // === バイアスごとの固定アドバイス（第2層 #1, #2, #3） ===
  const BIAS_FIXED_ADVICE: Record<string, [string, string, string]> = {
    "短絡": [
      "物事の原因は一つとは限らない。その出来事の背景に、他の要因や複雑な事情がないか考えてみよう。",
      "Aの後にBが起きたからといって、Aが原因とは限らない。偶然や別の要因の可能性も検討してみよう。",
      "その理由だけで結果に至るのは自然だろうか。見落としている段階や影響要素がないか確認してみよう。"
    ],
    "速断": [
      "いくつかの例だけで全体を判断すると、例外を見落とす可能性がある。当てはまらない事例を探してみよう。",
      "一つや二つの経験で全体を決めつけるのは早いかもしれない。まだ見ていない事例の存在を想像してみよう。",
      "その考えに当てはまらない人や状況はないだろうか。一部が全体を代表するとは限らない。"
    ],
    "循環": [
      "主張と理由が同じ内容の言い換えになっていないか確認しよう。「AだからA」になっていないだろうか。",
      "「なぜ？」と問われたとき、同じ内容を繰り返していないか振り返ってみよう。議論が前進しているか確認しよう。",
      "その主張を支える別の根拠が必要かもしれない。同じ場所を回っていないか検討してみよう。"
    ],
    "二択": [
      "白か黒かだけではなく、第三の選択肢や折衷案がないか考えてみよう。",
      "AかBかと迫られているが、CやD、あるいは組み合わせの可能性はないだろうか。",
      "選択肢が意図的に狭められていないか確認してみよう。"
    ],
    "歪曲": [
      "相手の主張を攻撃しやすい形に歪めていないか、元の言葉を確認してみよう。",
      "相手の一番伝えたい部分と向き合えているか振り返ってみよう。",
      "弱い部分だけを叩いていないか。本質部分に向き合えているか検討してみよう。"
    ],
    "飛躍": [
      "小さな出来事が必ず大きな破局につながると考えていないか、途中の段階を確認しよう。",
      "連鎖は本当に止められないのか。一つ一つ検証してみよう。",
      "最初と結末の間に具体的な因果があるか、丁寧に整理してみよう。"
    ],
    "類推": [
      "似ている点だけでなく、決定的な違いにも目を向けてみよう。",
      "例え話が本質を正しく捉えているか確認してみよう。",
      "似ている部分と異なる部分を分けて整理してみよう。"
    ],
    "偶然": [
      "連続して起きたからといって因果関係とは限らない。偶然や第三の要因を考えてみよう。",
      "原因と結果の向きが逆になっていないか確認してみよう。",
      "相関関係と因果関係を区別して考えてみよう。"
    ],
    "曖昧": [
      "同じ言葉でも意味が変わっていないか確認してみよう。",
      "お互いの定義を揃えることで誤解が解けるかもしれない。",
      "解釈が分かれる言葉を使っていないか整理してみよう。"
    ],
    "分割": [
      "全体の性質が個々にも当てはまるか確認してみよう。",
      "グループの話と個人の話を分けて考えてみよう。",
      "平均と個別の現実を混同していないか見直してみよう。"
    ],
    "中傷": [
      "人格ではなく、発言内容そのものを検討してみよう。",
      "「誰が言ったか」より「何を言ったか」に注目しよう。",
      "議論が個人攻撃にすり替わっていないか確認しよう。"
    ],
    "同調": [
      "多数派だからといって正しいとは限らない。",
      "事実と論理に基づいて自分で判断してみよう。",
      "集団に流される前に、自分の考えを確認してみよう。"
    ],
    "権威": [
      "肩書きではなく内容を検証してみよう。",
      "本当にその分野の専門家か確認してみよう。",
      "他の専門家の意見も比較してみよう。"
    ],
    "巻添": [
      "所属と個人の評価を分けて考えてみよう。",
      "レッテル貼りになっていないか確認しよう。",
      "その人自身の行動や発言に向き合ってみよう。"
    ],
    "転嫁": [
      "指摘された点そのものに向き合ってみよう。",
      "相手の過ちが自分の正当化にはならないことを確認しよう。",
      "問題の本質から目をそらしていないか振り返ってみよう。"
    ],
    "慣習": [
      "その習慣が始まった理由を考えてみよう。",
      "今の時代にも合っているか検証してみよう。",
      "ただ変えるのが面倒なだけではないか見直してみよう。"
    ],
    "恐怖": [
      "事実と感情を分けて現実性を検討してみよう。",
      "恐怖を利用している人がいないか確認してみよう。",
      "客観的なデータに基づいて再評価してみよう。"
    ],
    "憤怒": [
      "怒りの正当性と対象を冷静に確認してみよう。",
      "怒りを利用して得をする人がいないか考えてみよう。",
      "怒りの裏にある感情（悲しみ・不安など）に目を向けてみよう。"
    ],
    "同情": [
      "同情と正しさは別であることを意識しよう。",
      "公平な視点で全体を見直してみよう。",
      "感情に訴える意図がないか確認してみよう。"
    ],
    "嘲笑": [
      "笑いで終わらせず、内容を検討してみよう。",
      "相手の意見の価値を探してみよう。",
      "斬新さゆえに笑われていないか評価し直してみよう。"
    ],
    "楽観": [
      "願望と予測を分けて考えてみよう。",
      "根拠がどこにあるのか確認してみよう。",
      "最悪のケースやプランBを想定してみよう。"
    ],
    "幻想": [
      "自然だから安全とは限らないことを確認しよう。",
      "自然＝善、人工＝悪の二元論になっていないか見直そう。",
      "イメージではなく成分やデータを確認しよう。"
    ],
    "矮小": [
      "大きな問題があっても目の前の課題は無視できない。",
      "問題は比較ではなく個別に扱う必要がある。",
      "「よりマシ」という思考が言い訳になっていないか確認しよう。"
    ]
  };

  // === 23種類のバイアス定義（helpers.jsのOUTLIER_ORDERと同期、短絡は除外） ===
  const BIAS_CHECKLIST = [
    {
      id: "循環",
      question: "この発言は「循環」に該当するか？",
      criteria: `【循環とは】
結論を証明するために、その結論自体を前提として使っている状態（循環論法）。
【判定のヒント】
- 主張Aを支える根拠が、実は主張Aの言い換えになっていないか？
- 「なぜXなのか？」→「Yだから」→「なぜYなのか？」→「Xだから」という構造になっていないか？
- 定義の中に定義すべき言葉自体が含まれていないか？
- 例：「彼は優秀だ。なぜなら優れた成果を出すからだ。優れた成果とは優秀な人が出すものだ」`
    },
    {
      id: "二択",
      question: "この発言は「二択」に該当するか？",
      criteria: `【二択とは】
本来は複数の選択肢や中間的な立場があり得るのに、不当に二択に縮減している状態（二分法の誤り）。
【判定のヒント】
- 「AかBかのどちらか」と言っているが、CやDの選択肢はないのか？
- 「〜しなければ〜になる」という脅しの構造になっていないか？
- グラデーションや程度の問題を、白黒の問題として扱っていないか？
- 「味方か敵か」「賛成か反対か」という単純化をしていないか？
- 例：「この案に賛成しないなら、会社の成長を望んでいないということだ」`
    },
    {
      id: "歪曲",
      question: "この発言は「歪曲」に該当するか？",
      criteria: `【歪曲とは】
相手の主張を意図的にねじ曲げたり、本来議論すべき主題から外れた話題に論点をずらしている状態（ストローマン・論点逸脱）。
【判定のヒント】
- 相手が言っていないことを「相手の主張」として攻撃していないか？
- 元の質問や論題に直接答えているか？
- 関係はあるが別の話題にすり替わっていないか？
- 本質的な問題を避けて、周辺的な話に終始していないか？
- 「それはそうだが〜」と話題を変えていないか？
- 例：「この施策の費用対効果は？」→「とにかく挑戦することが大事だ」（質問に答えていない）`
    },
    {
      id: "飛躍",
      question: "この発言は「飛躍」に該当するか？",
      criteria: `【飛躍とは】
提示された根拠の強さに対して、結論の確実性が過大に表現されている状態。または、小さな原因から極端な結果を導く滑り坂論法。
【判定のヒント】
- 「必ず」「絶対に」「間違いなく」などの強い表現が根拠に見合っているか？
- 例外や不確実性への言及がないまま断言していないか？
- 推測や仮説を事実のように述べていないか？
- 条件付きで成り立つ主張を無条件のように述べていないか？
- 「〜したら、最終的に〜になる」と極端な結末を予測していないか？
- 例：「この施策で売上は必ず上がる」（実績データや比較検証なし）`
    },
    {
      id: "類推",
      question: "この発言は「類推」に該当するか？",
      criteria: `【類推とは】
本質的に異なる事柄を「似ている」という理由だけで同一視している状態（誤った類比）。
【判定のヒント】
- 比較している二つの事柄は、本当に比較可能か？
- 表面的な類似点だけで結論を導いていないか？
- 重要な相違点を無視していないか？
- 例え話を根拠として使っていないか？
- 例：「会社は家族だから、給料カットも我慢すべき」（会社と家族は本質的に異なる）`
    },
    {
      id: "偶然",
      question: "この発言は「偶然」に該当するか？",
      criteria: `【偶然とは】
二つの事象が同時に起きている（相関）ことを、因果関係があると誤認している状態。または、因果関係を主張しているが、原因と結果の間のメカニズムが著しく単純化されている状態。
【判定のヒント】
- 「AとBが一緒に起きている」と「AがBを引き起こす」を混同していないか？
- 逆の因果関係（BがAを引き起こす）の可能性は検討されているか？
- 第三の要因Cが両方に影響している可能性はないか？
- 偶然の一致である可能性は考慮されているか？
- 因果のメカニズムを問われたとき、説明できないほど飛躍していないか？
- 例：「アイスの売上と水難事故が相関→アイスが水難事故を起こす」（両方とも夏に増える）`
    },
    {
      id: "分割",
      question: "この発言は「分割」に該当するか？",
      criteria: `【分割とは】
個々の部分に当てはまることが、全体にも当てはまると誤認している状態（合成の誤謬）。また逆に、全体に当てはまることが個々にも当てはまると誤認する場合もある（分割の誤謬）。
【判定のヒント】
- 一人にとって良いことが、全員にとっても良いと言っていないか？
- 部分最適が全体最適になると仮定していないか？
- 個人の行動を全員がとった場合の結果を考慮しているか？
- チームや組織レベルの視点と個人レベルの視点を混同していないか？
- 例：「一人が節約すればお金が貯まる→全員が節約すれば経済が良くなる」（消費減少で不況の可能性）`
    },
    {
      id: "中傷",
      question: "この発言は「中傷」に該当するか？",
      criteria: `【中傷とは】
議論の内容ではなく、発言者の人格や属性を攻撃することで主張を否定しようとする状態（人身攻撃・アドホミネム）。
【判定のヒント】
- 主張の内容ではなく、発言者の人格・経歴・属性を理由に批判していないか？
- 特定の人々を不当に差別・排除する内容になっていないか？
- 「あの人は〜だから」という理由で主張を退けていないか？
- 侮辱的・差別的な表現が含まれていないか？
- 例：「若い人の意見だから信用できない」（年齢で主張の妥当性を判断）`
    },
    {
      id: "巻添",
      question: "この発言は「巻添」に該当するか？",
      criteria: `【巻添とは】
ある人物やグループの一部の行為・属性を理由に、関係者全体を同じように扱う状態（連座・ギルト・バイ・アソシエーション）。
【判定のヒント】
- ある集団の一部の行動を、集団全体の特徴として扱っていないか？
- 「〜の仲間だから〜も同じだ」という論理になっていないか？
- 個人の責任と所属集団の責任を混同していないか？
- 例：「あの会社の出身者だから、同じ考え方をするはずだ」`
    },
    {
      id: "転嫁",
      question: "この発言は「転嫁」に該当するか？",
      criteria: `【転嫁とは】
自分の責任や問題を、他者・外部要因に不当に押し付けている状態。または、相手の問題を指摘することで自分の問題から目をそらす（お前も論法）。
【判定のヒント】
- 自分の失敗や問題を、他人・環境・運のせいにしていないか？
- 「あなただって〜」と相手を攻撃して自分の問題から逃げていないか？
- 本来自分が取り組むべき問題を回避していないか？
- 例：「あなたに言われたくない」（相手の問題と自分の問題は別）`
    },
    {
      id: "慣習",
      question: "この発言は「慣習」に該当するか？",
      criteria: `【慣習とは】
「昔からそうだから」「伝統だから」という理由だけで、それが正しいと主張する状態（伝統への訴え）。
【判定のヒント】
- 「ずっとこうやってきた」が主な根拠になっていないか？
- 伝統や慣習が現在も有効である理由は説明されているか？
- 時代や状況の変化を考慮しているか？
- 例：「昔からこのやり方だから変える必要はない」（昔と今では状況が異なる可能性）`
    },
    {
      id: "恐怖",
      question: "この発言は「恐怖」に該当するか？",
      criteria: `【恐怖とは】
論理的な根拠ではなく、恐怖心を煽ることで説得しようとしている状態（恐怖への訴え）。
【判定のヒント】
- 「〜しないと大変なことになる」と脅していないか？
- 恐怖を感じさせる表現が、論理的根拠の代わりになっていないか？
- 実際のリスクと、示唆されているリスクは釣り合っているか？
- 冷静に見れば論理が弱いのに、恐怖で押し切ろうとしていないか？
- 例：「この対策をしないと会社は潰れる」（根拠なき脅し）`
    },
    {
      id: "憤怒",
      question: "この発言は「憤怒」に該当するか？",
      criteria: `【憤怒とは】
論理的な根拠ではなく、怒りや義憤を煽ることで説得しようとしている状態（怒りへの訴え）。
【判定のヒント】
- 怒りを感じさせる表現が、論理的根拠の代わりになっていないか？
- 「許せない」「けしからん」が判断の中心になっていないか？
- 感情的な反応を誘発することが目的になっていないか？
- 例：「こんなことを許していいのか！」（怒りで判断を促す）`
    },
    {
      id: "同情",
      question: "この発言は「同情」に該当するか？",
      criteria: `【同情とは】
論理的な根拠ではなく、同情や哀れみを誘うことで説得しようとしている状態（同情への訴え）。
【判定のヒント】
- 「かわいそう」が判断の中心になっていないか？
- 同情を誘う話が、論理的根拠の代わりになっていないか？
- 感情的な反応と、主張の妥当性は分けて考えられているか？
- 例：「頑張ってきた人を見捨てるのか」（同情で判断を促す）`
    },
    {
      id: "嘲笑",
      question: "この発言は「嘲笑」に該当するか？",
      criteria: `【嘲笑とは】
論理的な反論ではなく、馬鹿にしたり笑いものにすることで相手の主張を退けようとする状態（嘲笑への訴え）。
【判定のヒント】
- 相手の主張を真面目に検討せず、笑い話にしていないか？
- 皮肉や嘲笑が、論理的反論の代わりになっていないか？
- 主張の中身ではなく、言い方や態度を攻撃していないか？
- 例：「そんなこと本気で言ってるの？（笑）」（内容を検討せず却下）`
    },
    {
      id: "幻想",
      question: "この発言は「幻想」に該当するか？",
      criteria: `【幻想とは】
「自然だから良い」「人工だから悪い」という根拠のない二分法に基づく主張（自然への訴え）。
【判定のヒント】
- 「自然だから安全・良い」という論理になっていないか？
- 「人工的だから危険・悪い」という論理になっていないか？
- 自然・人工の区別が、本当に品質や安全性に関係するか検討されているか？
- 例：「天然成分だから体に良い」（天然でも有害なものは多い）`
    },
    {
      id: "矮小",
      question: "この発言は「矮小」に該当するか？",
      criteria: `【矮小とは】
より大きな問題があることを理由に、目の前の問題を無視または軽視する状態（相対的矮小化）。
【判定のヒント】
- 「もっと大きな問題がある」ことを理由に、問題を放置していないか？
- 比較することで、本来対処すべき問題を回避していないか？
- 問題の大小と、対処の必要性は別であることを認識しているか？
- 例：「世界には飢餓で苦しむ人がいるのに、この問題を議論する意味があるのか」`
    },
    {
      id: "速断",
      question: "この発言は「速断」に該当するか？",
      criteria: `【速断とは】
明らかに検証が必要な事柄について、検証なしに確定的な結論を述べている状態。限られた事例から過度に一般化している場合も含む。
【判定のヒント - 以下の全てを満たす場合のみyes】
- 確定的な結論や判断を述べている（「〜である」「〜すべき」「〜に違いない」など）
- その結論を出すには、明らかに追加の情報収集や検証が必要である
- 1〜2回の観察や限られた事例だけで、広範な結論を出している
- 「いつも」「みんな」「全ての」などの表現が、根拠に見合っているか？
【判定対象外 - 以下はno】
- 仮説や推測として述べている場合（「〜かもしれない」「〜の可能性がある」）
- 個人の経験や感想を述べている場合
- 事実の記述や具体例の列挙
- 例：「1回失敗しただけで『この方法は絶対に使えない』と断言する」（検証不足で確定判断）`
    },
    {
      id: "曖昧",
      question: "この発言は「曖昧」に該当するか？",
      criteria: `【曖昧とは】
議論の成否を左右する中核概念が、解釈によって結論が変わるほど曖昧な状態。または、同じ言葉を違う意味で使っている状態。
【判定のヒント - 以下の全てを満たす場合のみyes】
- 主張の中核となるキーワードが存在する
- そのキーワードの解釈によって、主張の正しさや結論が大きく変わりうる
- 文脈からも意味が十分に推測できない
- 同じ言葉が議論の途中で別の意味で使われていないか？
【判定対象外 - 以下はno】
- 日常的な言葉を日常的な意味で使っている場合
- 文脈から意味が明らかに推測できる場合
- ワークシートの「困りごと」「前提」「具体例」欄での一般的な表現
- 例：「生産性を上げる」と主張しつつ、生産性が「時間あたり産出量」なのか「付加価値」なのか「効率」なのかで結論が変わる場合`
    },
    {
      id: "権威",
      question: "この発言は「権威」に該当するか？",
      criteria: `【権威とは】
主張の根拠が、権威ある人物や組織の存在のみに依拠している状態（権威への訴え）。
【判定のヒント】
- 「専門家が言っている」「有名企業がやっている」だけが根拠になっていないか？
- その権威者は、この分野の専門家か？
- 権威者の主張の中身（論拠やデータ）は検討されているか？
- 権威者間で意見が分かれている可能性は考慮されているか？
- 例：「大手企業がやっているから正しい」（その企業の文脈や失敗例の検討なし）`
    },
    {
      id: "同調",
      question: "この発言は「同調」に該当するか？",
      criteria: `【同調とは】
多数の人が信じている・やっているという理由だけで、それが正しいと主張する状態（バンドワゴン効果・多数派への訴え）。
【判定のヒント】
- 「みんながやっている」「多くの人が信じている」が根拠になっていないか？
- 多数派であることと正しいことは別であることを認識しているか？
- 「みんな」とは具体的に誰なのか明確か？
- 例：「みんなこの方法でやっているから正しい」（全員が間違っている可能性を無視）`
    },
    {
      id: "楽観",
      question: "この発言は「楽観」に該当するか？",
      criteria: `【楽観とは】
提示された証拠や事実の量に対して、仮定や推測が過剰に積み重なっている状態。または、都合の良い結果だけを想定している状態（希望的観測）。
【判定のヒント】
- 「もし〜なら」「〜と仮定すると」が何段階も連なっていないか？
- 仮定の数と、それを支える証拠の数のバランスは適切か？
- 仮定が崩れた場合、結論全体が崩れる構造になっていないか？
- うまくいく場合だけを想定していないか？
- 例：「顧客が増え、単価も上がり、コストも下がれば利益は3倍になる」（全て仮定）`
    },
    {
      id: "不明",
      question: "この発言は意味が読み取れず「不明」に該当するか？",
      criteria: `【不明とは】
主張、前提、根拠のいずれも特定できないほど、文章の意味自体が不明瞭な状態。
【判定のヒント（これは最終手段）】
- 文章として意味をなしていないか？
- 主語・述語の関係が特定できないか？
- 何について述べているのか全く推測できないか？
- キーワードすら読み取れないほど断片的か？
注意：文が短い、くだけた表現、箇条書き、主語省略などは「不明」の理由にならない。文脈から意味が推測できる場合は「不明」にしない。`
    }
  ];

  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const results = {};

    for (const [field, rawValue] of Object.entries(fields)) {
      // 空欄スキップ
      if (!rawValue || (typeof rawValue === "string" && !rawValue.trim())) continue;

      // 🧩 plans対応: 配列やオブジェクト構造なら展開してテキスト化
      let text = "";
      if (Array.isArray(rawValue)) {
        text = rawValue
          .map((p, i) => {
            if (typeof p === "string") return p;
            return `(${i + 1}) ${p.who || "誰か"}の計画:\n- 何を: ${
              p.what || "—"
            }\n- どうやって: ${p.how || "—"}\n- 良い予想: ${
              p.good || "—"
            }\n- 良くない予想: ${p.bad || "—"}`;
          })
          .join("\n\n");
      } else if (typeof rawValue === "object") {
        const n = rawValue as any;

        text = [
          n.premise && `前提: ${n.premise}`,
          n.trouble && `困りごと: ${n.trouble}`,
          n.otherPrem && `他の前提: ${n.otherPrem}`,
          n.cause && `原因: ${n.cause}`,
          n.idea && `対策: ${n.idea}`,
        ]
          .filter(Boolean)
          .join("\n");

        if (n.plans?.length) {
          const planText = n.plans
            .map(
              (p, i) =>
                `(${i + 1}) ${p.who || "誰か"}の計画: 何=${p.what || "—"}／どうやって=${p.how || "—"}／良い予想=${p.good || "—"}／悪い予想=${p.bad || "—"}`
            )
            .join("\n");
          text += `\n\n${planText}`;
        }
      } else {
        text = String(rawValue);
      }

      // === チェックリスト形式のプロンプトを生成（2段階呼び出し） ===
      // SET1: 循環〜矮小（論理の誤り系 17種類）
      // SET2: 速断〜不明（判断の誤り系 6種類）
      const SET1_IDS = ["循環", "二択", "歪曲", "飛躍", "類推", "偶然", "分割", "中傷", "巻添", "転嫁", "慣習", "恐怖", "憤怒", "同情", "嘲笑", "幻想", "矮小"];
      const SET2_IDS = ["速断", "曖昧", "権威", "同調", "楽観", "不明"];
      
      const SET1 = BIAS_CHECKLIST.filter(b => SET1_IDS.includes(b.id));
      const SET2 = BIAS_CHECKLIST.filter(b => SET2_IDS.includes(b.id));

      const buildPrompt = (biasSet: typeof BIAS_CHECKLIST, setName: string) => {
        const checklistPrompt = biasSet.map((bias, idx) => 
          `【${idx + 1}. ${bias.id}】\n質問：${bias.question}\n${bias.criteria}`
        ).join("\n\n---\n\n");
        
        const outputKeys = biasSet.map(b => `    "${b.id}": "yes" または "no"`).join(",\n");
        
        return `あなたは教育支援AIです。以下の文章に対して、${biasSet.length}種類のバイアス（${setName}）それぞれについて該当するかどうかを判定してください。

【判定対象テキスト】
ワークシートの「${field}」欄に書かれた内容です。

【最重要原則：非該当時は沈黙】
- 判定は厳格に行い、明確にバイアスに該当する場合のみ"yes"としてください。
- 迷った場合、グレーゾーンの場合は"no"としてください。
- バイアス検出は誤検知（false positive）を最小化することを優先してください。

【判定対象外（必ずno）】
以下のような文章は、バイアス判定の対象外です。全て"no"としてください：
1. 事実の記述・観察結果の報告（「〜があった」「〜を見た」「〜という状況」）
2. 具体例の列挙・事例の紹介
3. 個人の経験談・体験の共有
4. 困りごとや課題の認識（困っていることを述べているだけ）
5. 前提条件や状況の説明
6. 感想や印象の表明（主張・提案ではない場合）
7. 質問や疑問の提示
8. ワークシートの「困りごと」「前提」「具体例」欄に書かれた内容（これらは記述欄であり、論証欄ではない）

【判定方法】
各バイアスについて、以下の形式でyes/noを判定してください。
- 明確に該当する場合のみ: "yes"
- 該当しない、または判断が微妙な場合: "no"

【重要ルール】
- 各バイアスの「判定のヒント - 以下の全てを満たす場合のみyes」を厳格に適用してください。
- 「判定対象外」に該当する場合は、そのバイアスには"no"を返してください。
- 「不明」は最終手段です。文の意味が理解できる限り「不明」にはしないでください。
- 複数のバイアスに明確に該当する場合は、全て"yes"としてください。
- どのバイアスにも該当しない場合は、全て"no"で構いません（これが最も多いはずです）。

========================================
【${setName}：${biasSet.length}種類のバイアス判定チェックリスト】
========================================

${checklistPrompt}

========================================

【出力形式（JSONのみ）】
{
  "checkResults": {
${outputKeys}
  },
  "advice": "該当するバイアスに基づいた具体的な改善アドバイス（該当なしなら空文字）"
}`;
      };

      // === 2段階でOpenAI API呼び出し ===
      console.log(`🔄 [${field}] SET1（論理の誤り系 ${SET1.length}種類）を判定中...`);
      const completion1 = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildPrompt(SET1, "論理の誤り系") },
          { role: "user", content: `テーマ: ${topic}\n\n【判定対象テキスト】\n${text}` },
        ],
      });

      console.log(`🔄 [${field}] SET2（判断の誤り系 ${SET2.length}種類）を判定中...`);
      const completion2 = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildPrompt(SET2, "判断の誤り系") },
          { role: "user", content: `テーマ: ${topic}\n\n【判定対象テキスト】\n${text}` },
        ],
      });

      const raw1 = completion1.choices[0]?.message?.content || "{}";
      const raw2 = completion2.choices[0]?.message?.content || "{}";
      console.log(`📤 [${field}] SET1応答:`, raw1);
      console.log(`📤 [${field}] SET2応答:`, raw2);

      let parsed1, parsed2;
      try { parsed1 = JSON.parse(raw1); } catch { parsed1 = { checkResults: {}, advice: "" }; }
      try { parsed2 = JSON.parse(raw2); } catch { parsed2 = { checkResults: {}, advice: "" }; }

      // === 結果を統合 ===
      const checkResults = { ...(parsed1.checkResults || {}), ...(parsed2.checkResults || {}) };

      // === checkResultsから該当するバイアス（yes）をflagsに変換 ===
      const flags: string[] = [];
      
      for (const bias of BIAS_CHECKLIST) {
        if (checkResults[bias.id] === "yes") {
          flags.push(bias.id);
        }
      }

      // === flagsに基づいて固定アドバイスを生成 ===
      let finalAdvice = "";
      if (flags.length > 0) {
        // 検出されたバイアスごとにランダムに1つのアドバイスを選択
        const adviceList = flags
          .filter(biasId => BIAS_FIXED_ADVICE[biasId]) // 固定アドバイスが定義されているもののみ
          .map(biasId => {
            const advices = BIAS_FIXED_ADVICE[biasId];
            const randomIndex = Math.floor(Math.random() * advices.length);
            return advices[randomIndex];
          });
        finalAdvice = adviceList.join(" ");
      }

      // === OUTLIER順にソート（表示の統一） ===
      const ORDER = BIAS_CHECKLIST.map(b => b.id);
      flags.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

      results[field] = {
        line: text,
        flags: flags,
        checkResults: checkResults,
        advice: finalAdvice || ""
      };
    }

    const h = withCors(new Headers(), origin);
    return addEngineHeaders(json({ topic, results }, 200, h), method, path, rawPath);
  } catch (err) {
    const h = withCors(new Headers(), origin);
    return addEngineHeaders(
      json({ error: "openai_failed", message: String(err) }, 500, h),
      method,
      path,
      rawPath
    );
  }
}


if (method === "GET" && path === "/persona/checkKey") {
  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const r = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });
    return new Response("OPENAI OK");
  } catch (e) {
    return new Response("OPENAI NG: " + String(e), { status: 500 });
  }
}

// ★ 新しいエンドポイント /persona/noise → 思考の盲点を示す4視点ヒント
if (method === "POST" && path === "/persona/noise") {
  const body = await req.json();
  const topic = body.topic || "";
  const note = body.note || {};

  // 🧩 plans対応: 複数計画を含む場合は展開して1つのテキストにまとめる
  const textForAI = Array.isArray(note.plans)
    ? note.plans
        .map((p, i) => {
          return `(${i + 1}) ${
            p.who || note.author || "誰か"
          }の計画:\n- 何を: ${p.what || "—"}\n- どうやって: ${
            p.how || "—"
          }\n- 良い予想: ${p.good || "—"}\n- 良くない予想: ${
            p.bad || "—"
          }`;
        })
        .join("\n\n")
    : typeof note === "string"
    ? note
    : JSON.stringify(note, null, 2);

  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: `
あなたは「思考の観察者AI」です。
このAIは、議論や意見の中にある「見落とされがちな盲点」や「まだ掘り下げられていない視点」を見つけ、
参加者が自分で気づきを得られるようにヒントを提示します。

目的：
- 「正解を出す」のではなく、「別の見方を促す」こと。
- 発言や意見の内容から、どんな観点が抜けていそうかを4つの異なる視点で示す。
- 各視点では、“何が盲点になっているか” と “どう広げると良いか” を一文ずつ述べる。

文体ルール：
- 「〜ない」「〜しない」「〜されていない」などの否定表現を使わず、
  「〜にも注目すると良いかも」「〜を取り入れると広がるかも」など、
  前向きな提案・肯定表現で書く。
- 柔らかくポジティブなトーンで、読み手が安心して考えを広げられるように。

出力形式（必ずJSON配列で）：
[
  {
    "view": "視点の名前",
    "blindspot": "この視点から見た盲点（例：感情的側面にも目を向けると良いかも）",
    "advice": "気持ちや関係性にも焦点を当ててみましょう"
  },
  ...
]

条件：
- 必ず4つの視点を出す。
- 視点名は自由（例：感情・制度・時間軸・他者・データ・倫理など）。
- アドバイスは柔らかい口調で、考えを促すトーンで書く。
- 「盲点」は “〜かも” で終わる。
- 出力はJSON配列のみ。他の文章や説明は含めない。
          `,
        },
        {
          role: "user",
          content: `
議題: ${topic}
対象のノート・計画内容:
${textForAI}
          `,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content || "[]";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }

    const h = withCors(new Headers(), origin);
    return addEngineHeaders(
      json({ ok: true, perspectives: parsed, source: note }, 200, h),
      method,
      path,
      rawPath
    );
  } catch (err) {
    const h = withCors(new Headers(), origin);
    return addEngineHeaders(
      json({ error: "openai_failed", message: String(err) }, 500, h),
      method,
      path,
      rawPath
    );
  }
}

// ★ 新しいエンドポイント /persona/arrangeBoard（複数Board対応）
if (method === "POST" && path === "/persona/arrangeBoard") {
  const body = await req.json();

  // 単体 or 複数両対応
  const boards = Array.isArray(body.boards)
    ? body.boards
    : [{ topic: body.topic || "", spec: body.spec || "impact-feasibility", notes: body.notes || [] }];

  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    // 各boardを個別にOpenAIへ投げる
    const results: any[] = [];

    for (const b of boards) {
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `
あなたは議論配置アシスタントです。
次のノートを、2軸(${b.spec})に沿って配置してください。
返すのはJSON形式だけです。

出力例:
{
  "positions": [
    {"id":"ノートID","xP":0-100,"yP":0-100},
    ...
  ]
}`,
          },
          {
            role: "user",
            content: `議題: ${b.topic}\nノート:\n${JSON.stringify(b.notes, null, 2)}`,
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content || "{}";
      let parsed;
      try {
        parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      } catch {
        parsed = { positions: [] };
      }

      results.push({
        topic: b.topic,
        spec: b.spec,
        positions: parsed.positions || [],
      });
    }

    const h = withCors(new Headers(), origin);
    return addEngineHeaders(json({ ok: true, results }, 200, h), method, path, rawPath);
  } catch (err) {
    console.error("❌ arrangeBoard failed:", err);
    const h = withCors(new Headers(), origin);
    return addEngineHeaders(
      json({ error: "openai_failed", message: String(err) }, 500, h),
      method,
      path,
      rawPath
    );
  }
}


if (method === "POST" && path === "/persona/evidenceQuest") {
  const { topic = "", teamName = "", notes = [] } = await req.json();

  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    // 🧩 plans対応: 各ノート内のplansを展開してまとめる
    const normalizedNotes = notes.flatMap((n) => {
      if (Array.isArray(n.plans) && n.plans.length > 0) {
        return n.plans.map((p, i) => ({
          author: p.who || n.author || "匿名",
          title: `計画(${i + 1})`,
          summary: [
            `何を: ${p.what || "—"}`,
            `どうやって: ${p.how || "—"}`,
            `良い予想: ${p.good || "—"}`,
            `良くない予想: ${p.bad || "—"}`,
          ].join(" ／ "),
        }));
      } else {
        return [
          {
            author: n.author || "匿名",
            title: n.title || "(無題)",
            summary: [
              `前提: ${n.premise || "—"}`,
              `困りごと: ${n.trouble || "—"}`,
              `原因: ${n.cause || "—"}`,
              `対策: ${n.idea || "—"}`,
            ].join(" ／ "),
          },
        ];
      }
    });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
あなたは「Evidence Quest」AIです。
このAIは、議論を終えたあとに「AIを使わずに、どうやって裏を取れるか」を考えるための“調べ方の準備”を支援します。

目的：
- 議論で出た主張や仮説を人間が自分で検証・確認するため、
  「どこを見ればわかるか」「何を調べたら根拠になるか」「誰に聞けば裏が取れそうか」
  といった視点でヒント（探究の手がかり）を示すこと。

形式：
次の6つの観点について、それぞれ **1文の問い** を生成してください。

{
  "official": "公式文書・公的資料の観点から調べる手がかり",
  "expert": "専門家・実務者の観点から調べる手がかり",
  "records": "過去の事例・統計・履歴の観点から調べる手がかり",
  "observe": "実際に観察・確認できることの観点から調べる手がかり",
  "feasible": "現実的にすぐ試せる検証の観点から調べる手がかり",
  "surrogate": "現地や本物に代わる情報源を使う観点から調べる手がかり"
}

出力ルール：
- 各項目は自然な日本語の問い文（例：「〜を確認できる資料はあるだろうか？」など）で書く。
- 回答や結論ではなく、“調べる方向性”を示すこと。
- 「○○」には議題に即した具体的な対象語（例：「政策」「データ」「現場」など）を挿入する。
- 上記のJSON形式以外の出力（説明・文脈・コメント）は一切しない。
          `,
        },
        {
          role: "user",
          content: `
議題: ${topic}
チーム名: ${teamName}

チームの議論内容・計画一覧:
${normalizedNotes
  .map(
    (n) =>
      `・${n.title}（${n.author}）: ${n.summary}`
  )
  .join("\n")}
          `,
        },
      ],
    });

    const rawText = completion.choices[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = {};
    }

    const h = withCors(new Headers(), origin);
    return addEngineHeaders(json(parsed, 200, h), method, path, rawPath);
  } catch (err) {
    const h = withCors(new Headers(), origin);
    return addEngineHeaders(
      json({ error: "openai_failed", message: String(err) }, 500, h),
      method,
      path,
      rawPath
    );
  }
}




// === 🧩 /persona/teamState（CORS対応・整理済み）===
if (method === "OPTIONS" && path === "/persona/teamState") {
  const h = withCors(new Headers(), origin);
  return addEngineHeaders(
    new Response(null, { status: 204, headers: h }),
    method,
    path,
    rawPath
  );
}

// ===============================
// ✅ POST：チーム共有メタ情報のみ保存（companyCode対応）
// ===============================
if (method === "POST" && path === "/persona/teamState") {
  const body = await req.json();
  const companyCode = requireCompany(body);
  const team = body.team;

  if (!team) {
    return json({ error: "missing_team" }, 400);
  }

  const payload = {
    team,
    users: Array.isArray(body.users) ? body.users : [], // ["Aさん","Bさん"]
    roles: body.roles ?? {},                             // { userId: role }
    updatedAt: new Date().toISOString(),
  };

  // 🔑 companyCode を含めたキー
  const key = `team:${companyCode}:${team}:meta`;
  await env.TEAM_STATE.put(key, JSON.stringify(payload));

  const h = withCors(new Headers(), origin);
  return addEngineHeaders(
    json({ ok: true }, 200, h),
    method,
    path,
    rawPath
  );
}

// ===============================
// ✅ GET：チーム共有メタ情報取得（companyCode対応）
// ===============================
if (method === "GET" && path === "/persona/teamState") {
  const h = withCors(new Headers(), origin);

  try {
    const companyCode = url.searchParams.get("companyCode");
    const team = url.searchParams.get("team");

    if (!companyCode) {
      return new Response(JSON.stringify({ error: "missing_companyCode" }), {
        status: 401,
        headers: h,
      });
    }

    if (!team) {
      return new Response(JSON.stringify({ error: "missing_team" }), {
        status: 400,
        headers: h,
      });
    }

    const key = `team:${companyCode}:${team}:meta`;
    const raw = await env.TEAM_STATE.get(key);
    const data = raw ? JSON.parse(raw) : {};

    return addEngineHeaders(
      new Response(JSON.stringify(data), {
        status: 200,
        headers: h,
      }),
      method,
      path,
      rawPath
    );
  } catch (err) {
    return addEngineHeaders(
      new Response(
        JSON.stringify({
          error: "teamState_get_failed",
          message: String(err),
        }),
        { status: 500, headers: h }
      ),
      method,
      path,
      rawPath
    );
  }
}

// ===============================
// 🗑 DELETE：チーム全削除（companyCode対応）
// ===============================
if (method === "DELETE" && path === "/persona/teamState") {
  const h = withCors(new Headers(), origin);

  const companyCode = url.searchParams.get("companyCode");
  const team = url.searchParams.get("team");

  if (!companyCode) {
    return addEngineHeaders(
      json({ ok: false, error: "companyCode is required" }, 401, h),
      method,
      path,
      rawPath
    );
  }

  if (!team) {
    return addEngineHeaders(
      json({ ok: false, error: "team is required" }, 400, h),
      method,
      path,
      rawPath
    );
  }

  // 🔑 companyCode を含めた prefix
  const prefix = `team:${companyCode}:${team}:`;

  const list = await env.TEAM_STATE.list({ prefix });

  for (const key of list.keys) {
    await env.TEAM_STATE.delete(key.name);
  }

  console.log(`🗑 team deleted: ${companyCode}/${team}, keys=${list.keys.length}`);

  return addEngineHeaders(
    json(
      {
        ok: true,
        deleted: list.keys.length,
        team,
        companyCode,
      },
      200,
      h
    ),
    method,
    path,
    rawPath
  );
}




// === 👤 /persona/userState（CORS OPTIONS）===
if (method === "OPTIONS" && path === "/persona/userState") {
  const h = withCors(new Headers(), origin);
  return addEngineHeaders(
    new Response(null, { status: 204, headers: h }),
    method,
    path,
    rawPath
  );
}

// ===============================
// ✅ POST：ユーザー状態保存（companyCode対応）
// ===============================
if (method === "POST" && path === "/persona/userState") {
  try {
    const body = await req.json();
    const companyCode = requireCompany(body);
    const team = body.team;
    const userId = body.userId;

    if (!team || !userId) {
      return json({ error: "missing_team_or_user" }, 400);
    }

    const payload = {
      team,
      userId,
      author: body.author || userId,

      topic: body.topic ?? "",
      target: body.target ?? "",
      scenario: body.scenario ?? "",
      premise: body.premise ?? "",
      trouble: body.trouble ?? "",
      otherPrem: body.otherPrem ?? "",
      cause: body.cause ?? "",
      idea: body.idea ?? "",
      plans: Array.isArray(body.plans) ? body.plans : [],

      updatedAt: new Date().toISOString(),
    };

    const key = `team:${companyCode}:${team}:user:${userId}`;
    await env.TEAM_STATE.put(key, JSON.stringify(payload));

    const h = withCors(new Headers(), origin);
    return addEngineHeaders(
      json({ ok: true }, 200, h),
      method,
      path,
      rawPath
    );
  } catch (err) {
    console.error("userState POST error:", err);
    const h = withCors(new Headers(), origin);
    return addEngineHeaders(
      json({ error: "userState_failed" }, 500, h),
      method,
      path,
      rawPath
    );
  }
}

// ===============================A
// 📄 GET：/persona/teamUserStates（companyCode対応）
// ===============================
if (method === "GET" && path === "/persona/teamUserStates") {
  const h = withCors(new Headers(), origin);
  const companyCode = url.searchParams.get("companyCode");
  const team = url.searchParams.get("team");

  if (!companyCode) {
    return new Response(JSON.stringify({ error: "missing_companyCode" }), {
      status: 401,
      headers: h,
    });
  }

  if (!team) {
    return new Response(JSON.stringify({ error: "missing_team" }), {
      status: 400,
      headers: h,
    });
  }

  const list = await env.TEAM_STATE.list({
    prefix: `team:${companyCode}:${team}:user:`,
  });

  const users: any[] = [];
  for (const k of list.keys) {
    const v = await env.TEAM_STATE.get(k.name, "json");
    if (v) users.push(v);
  }

  return addEngineHeaders(
    new Response(JSON.stringify({ users }), {
      status: 200,
      headers: h,
    }),
    method,
    path,
    rawPath
  );
}

// ===============================
// ✅ POST: チーム名簿を確定保存（除籍反映・companyCode対応）
// ===============================
if (method === "POST" && path === "/team/updateMembers") {
  const h = withCors(new Headers(), origin);

  try {
    const body = await req.json();
    const companyCode = requireCompany(body);
    const team = body.team;
    const members: string[] = body.members;

    if (!team || !Array.isArray(members)) {
      return addEngineHeaders(
        json({ error: "invalid_args" }, 400, h),
        method,
        path,
        rawPath
      );
    }

    // -----------------------------
    // ① チームメタ情報を取得
    // -----------------------------
    const metaKey = `team:${companyCode}:${team}:meta`;
    const rawMeta = await env.TEAM_STATE.get(metaKey);
    const meta = rawMeta
      ? JSON.parse(rawMeta)
      : { team, users: [], roles: {} };

    // -----------------------------
    // ② 名簿を「確定名簿」で上書き
    // -----------------------------
    meta.users = members;
    meta.updatedAt = new Date().toISOString();

    await env.TEAM_STATE.put(metaKey, JSON.stringify(meta));

    // -----------------------------
    // ③ userState KV を掃除（除籍者削除）
    // -----------------------------
    const list = await env.TEAM_STATE.list({
      prefix: `team:${companyCode}:${team}:user:`,
    });

    for (const k of list.keys) {
      const userId = k.name.replace(
        `team:${companyCode}:${team}:user:`,
        ""
      );

      if (!members.includes(userId)) {
        await env.TEAM_STATE.delete(k.name);
      }
    }

    return addEngineHeaders(
      json({ ok: true, team, members }, 200, h),
      method,
      path,
      rawPath
    );
  } catch (err) {
    console.error("❌ updateMembers failed:", err);

    return addEngineHeaders(
      json(
        {
          error: "update_members_failed",
          message: String(err),
        },
        500,
        h
      ),
      method,
      path,
      rawPath
    );
  }
}

if (req.method === "OPTIONS" && url.pathname === "/dashboard/summary") {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

if (req.method === "GET" && url.pathname === "/dashboard/summary") {
  if (!isFacilitator(req, env)) {
    return Response.json(
      { ok: false, error: "forbidden" },
      { status: 403, headers: corsHeaders(origin) }
    );
  }
  
  const companyCode = url.searchParams.get("companyCode");

  if (!companyCode) {
    return Response.json(
      { ok: false, error: "missing_companyCode" },
      { status: 400 }
    );
  }

  try {
    const stub = getDashboardStub(env, companyCode);
    const res = await stub.fetch("https://do/summary");
    const data = await res.json();

    return Response.json(data, {
      headers: corsHeaders(origin),
    });
  } catch (e) {
    console.log("DASHBOARD_SUMMARY failed", String(e));
    return Response.json(
      { ok: false, error: "dashboard_summary_failed" },
      { status: 500 }
    );
  }
}


if (method === "GET" && path === "/export/pdf") {
  const companyCode = new URL(req.url).searchParams.get("companyCode");
  const team = new URL(req.url).searchParams.get("team");

  if (!companyCode) {
    return new Response("companyCode is required", { status: 401 });
  }

  if (!team) {
    return new Response("team is required", { status: 400 });
  }

  // ① KVから取得（companyCode対応）
  const raw = await env.TEAM_STATE.get(`team:${companyCode}:${team}:meta`);
  if (!raw) {
    return new Response("team not found", { status: 404 });
  }

  const data = JSON.parse(raw);

  // ② PDF作成
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  let y = 800;
  const lineHeight = 18;

  const draw = (text: string) => {
    if (y < 40) return; // 簡易ページ下限ガード
    page.drawText(text, { x: 40, y, size: 11, font });
    y -= lineHeight;
  };

  draw("思考アスレチック 実行ログ");
  draw(`企業コード: ${companyCode}`);
  draw(`チーム: ${team}`);
  draw(`作成日時: ${new Date().toLocaleString()}`);
  y -= lineHeight;

  for (const [key, value] of Object.entries(data)) {
    draw(`${key}:`);
    draw(
      typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2)
    );
    y -= lineHeight;
  }

  // ③ PDFを返す
  const pdfBytes = await pdfDoc.save();

  return new Response(pdfBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${companyCode}_${team}.pdf"`,
    },
  });
}
// ===============================
// 🏢 管理者用：企業コード発行
// ===============================
if (method === "POST" && path === "/admin/issueCompany") {
  const h = withCors(new Headers(), origin);

  try {
    const body = await req.json();

    const {
      companyCode,
      companyName,
      password,
      expiresAt,
    } = body;

    if (!companyCode || !password) {
      return addEngineHeaders(
        json({ error: "missing_params" }, 400, h),
        method,
        path,
        rawPath
      );
    }

    const passwordHash = await sha256(password);

    const record = {
      companyName: companyName || companyCode,
      passwordHash,
      enabled: true,
      expiresAt: expiresAt || null,
      issuedAt: new Date().toISOString(),
    };

    await env.COMPANY_AUTH.put(
      `COMPANY:${companyCode}`,
      JSON.stringify(record)
    );

    return addEngineHeaders(
      json({ ok: true, companyCode }, 200, h),
      method,
      path,
      rawPath
    );
  } catch (err) {
    console.error("❌ issueCompany failed:", err);
    return addEngineHeaders(
      json({ error: "issue_failed" }, 500, h),
      method,
      path,
      rawPath
    );
  }
}


if (req.method === "POST" && url.pathname === "/events/message") {
  const body = await req.json().catch(() => null);
  if (!body) {
    return Response.json(
      { ok: false, error: "invalid_json" },
      { status: 400, headers: corsHeaders(origin) }
    );
  }

  const companyCode = body.companyCode;
  const team = body.team;

  if (!companyCode || !team) {
    return Response.json(
      { ok: false, error: "missing_company_or_team" },
      { status: 400, headers: corsHeaders(origin) }
    );
  }

  const id = crypto.randomUUID();
  const createdAt = body.createdAt ?? new Date().toISOString();

  const record = {
    id,
    companyCode,
    discussionId: body.discussionId ?? null,
    team,
    userId: body.userId ?? null,
    createdAt,
    charCount: Number(body.charCount ?? 0),
    allFlags: Array.isArray(body.allFlags) ? body.allFlags : [],
    biasGroups: body.biasGroups ?? null,
    phaseAtPost: body.phaseAtPost ?? null,
    meta: body.meta ?? null,
  };

  console.log("ENV keys:", Object.keys(env));
  console.log("env.ms_engine_db exists?", !!(env as any).ms_engine_db);
  console.log("env.DASHBOARD_HUB exists?", !!(env as any).DASHBOARD_HUB);

  try {
    // 1. D1 に生ログ保存
    await env.ms_engine_db.prepare(
      `INSERT INTO message_events
        (id, company_code, discussion_id, team, user_id, created_at, char_count, all_flags, bias_groups, phase_at_post, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        record.id,
        record.companyCode,
        record.discussionId,
        record.team,
        record.userId,
        record.createdAt,
        record.charCount,
        JSON.stringify(record.allFlags ?? []),
        JSON.stringify(record.biasGroups ?? null),
        record.phaseAtPost,
        JSON.stringify(record.meta ?? null)
      )
      .run();

    // 2. DO に集計更新依頼
    const stub = getDashboardStub(env, companyCode);
    await stub.fetch("https://do/apply-message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(record),
    });

    return Response.json(
      { ok: true, id },
      { headers: corsHeaders(origin) }
    );
  } catch (e) {
    console.log("EVENTS_MESSAGE failed", String(e));
    return Response.json(
      { ok: false, error: "message_save_failed" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}




    const h = withCors(new Headers(), origin);
    return addEngineHeaders(json({ error: "not_found", path: rawPath }, 404, h), method, path, rawPath);
  }
  
} satisfies ExportedHandler<Env>;

