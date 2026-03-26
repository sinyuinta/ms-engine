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

  console.log("🧠 [logBias] 単一ラベル分類モード", { topic, fields });

const BIAS_FIXED_ADVICE: Record<string, [string, string, string]> = {
  "短絡": [
    "物事の原因は、一つだけとは限らないよ。その出来事が起きた背景には、隠れた他の理由や、もっと複雑な事情があるかもしれない。",
    "Aの後にBが起きたからといって、Aが原因とは限らないよね。見えない要因が隠れていたり、もっと多くのことが影響しているかもしれない。",
    "その理由だけで、この結果になるのは少し不思議じゃない？結果につながるまでには、私たちが気づいていない、もっとたくさんのステップがあるかもしれないよ。"
  ],
  "速断": [
    "いくつかの例を見ただけで「全部こうだ」と決めつけてしまうと、大事なことを見落とすかもしれない。当てはまらない例外を探してみて。",
    "一つや二つの例で全体を判断するのは、少し早いかもしれない。まだ見ていない、たくさんの違う例がある可能性を考えてみよう。",
    "その考えに当てはまらない人や状況を想像してみて。たった一つの経験が、必ずしも全体の真実を映しているとは限らないよ。"
  ],
  "循環": [
    "主張と理由が同じ言葉の言い換えになっているみたい。「AだからAだ」という形になっていないか、もう一度、話の構造を確認してみて。",
    "「なぜ？」と聞かれて、質問と同じ内容を答えていないかな。議論が一歩も前に進んでいないかもしれない。新しい情報を探してみよう。",
    "その主張を支えるための、まったく別の根拠が必要みたい。今のままだと、同じ場所をぐるぐる回っているだけかもしれないよ。"
  ],
  "二択": [
    "世の中は白か黒かだけじゃないことが多いよ。3つ目の選択肢や、両方を少しずつ取り入れる方法、そもそも選ばないという道もあるかも。",
    "「AかBか」と迫られると、他の可能性を見落としがち。視点を変えれば、CやD、あるいはAとBを組み合わせる道も見つかるかもしれない。",
    "その二つの選択肢以外は、本当にあり得ないのかな。誰かが意図的に選択肢を狭めている可能性も考えてみて。"
  ],
  "歪曲": [
    "相手の意見を、自分が攻撃しやすいように、少しだけ歪めて解釈していないかな。相手が言った言葉そのものと、もう一度向き合ってみて。",
    "相手の主張を、わざと弱く見せかけて反論するのはフェアじゃないかも。相手が一番伝えたかったことは何か、もう一度考えてみよう。",
    "相手の意見の「一番強い部分」と向き合ってみよう。弱い部分だけを叩いても、本当の意味で議論に勝ったことにはならないよ。"
  ],
  "飛躍": [
    "「これを許したら、次々と悪いことが起きて、最後は大変なことになる」と考えていないかな。その連鎖は、本当に途中で止められない？",
    "一つの小さなステップが、本当にそこまで大きな破局につながるのかな。ドミノ倒しのように考えているけど、途中でドミノが倒れない可能性はない？",
    "その予測、少し飛躍しすぎかもしれない。最初のステップと最終的な結末の間に、具体的に何が起きるのか、一つ一つ検証してみて。"
  ],
  "類推": [
    "ある点で似ているからといって、他の点でも同じとは限らないよ。その例えと、今話していることの「決定的な違い」はどこだろう？",
    "その例え話、面白いけど、本質的な部分でズレているかもしれない。例えのせいで、大事なことを見落としていないか注意してみて。",
    "2つのものは、どこが似ていて、どこが違う？似ている点だけに注目すると、違う点を見過ごしてしまう。その違いが、結論を左右するかも。"
  ],
  "偶然": [
    "2つのことが続けて起きると、つい関係があると思いがち。でも、本当に「Aが起きたからBが起きた」のかな。ただの偶然や、別の原因も考えてみて。",
    "「雨が降ると事故が増える」と「事故が増えると雨が降る」は違うよね。どちらが原因でどちらが結果か、あるいは両方とも別の原因から来ているのか、考えてみよう。",
    "相関関係と因果関係は違うものだよ。2つのことが同時に起きていても、片方がもう片方の原因であるとは限らない。共通の原因を探してみて。"
  ],
  "曖昧": [
    "同じ言葉でも、人や文脈によって意味が変わることがあるよ。話の途中で、言葉の意味をすり替えて使っていないか、確認してみて。",
    "その言葉、自分と相手で違う意味で使っているかもしれない。一度立ち止まって、言葉の定義をお互いに確認しあうと、誤解が解けるかも。",
    "「普通」とか「自由」とか、人によって解釈が違う言葉を使ってない？議論を始める前に、まず言葉の意味をはっきりさせることが大事だよ。"
  ],
  "分割": [
    "「チーム全体が良いチームだから、メンバー一人一人も優秀だ」とは限らないよね。全体に当てはまる性質が、個々の部分にも当てはまるか、考えてみて。",
    "アメリカは裕福な国だけど、アメリカ人全員が裕福なわけじゃない。全体についての話と、個々の部分についての話は、分けて考える必要があるよ。",
    "その大きなグループの性質が、中にいる一人一人にも当てはまると思い込んでいないかな。グループの平均と、個人の現実は違うかもしれない。"
  ],
  "中傷": [
    "相手の人格や見た目を攻撃するのと、相手の意見に反論するのは別のこと。その人の「言っていること」自体の良し悪しを考えてみよう。",
    "「誰が言ったか」ではなく「何を言ったか」に集中してみない？どんな人でも、正しいことを言う時もあれば、間違う時もあるよ。",
    "相手の意見ではなく、相手自身を攻撃し始めたら、それは議論に負けそうになっているサインかもしれない。冷静に、話の中身に戻ろう。"
  ],
  "同調": [
    "「みんながやってる」と聞くと安心するよね。でも、その「みんな」が本当に正しいとは限らない。自分の頭で考えて、判断することが大事だよ。",
    "かつては「みんな」が地球は平らだと信じていた。多数派が常に正しいわけじゃない。周りに流されず、事実や論理に基づいて考えてみよう。",
    "その「みんな」は、本当にあなたのことを考えてくれているのかな。集団の意見に安易に同調する前に、一度立ち止まって、自分の心の声を聞いてみて。"
  ],
  "権威": [
    "偉い人や専門家でも、間違うことはあるよ。その人の肩書きではなく、言っている内容が本当に正しいか、自分の頭で考えてみよう。",
    "その専門家は、本当にその分野の専門家？専門外のことについて語っていないか、確認が必要だよ。肩書きだけで信じるのは危険かも。",
    "一人の専門家の意見を鵜呑みにしないで、他の専門家が反対意見を言っていないか探してみよう。複数の視点を比較することが大事だよ。"
  ],
  "巻添": [
    "ある人が、良くない評判のグループに属しているからといって、その人自身も良くないとは限らない。レッテルを貼らずに、個人を見てみよう。",
    "「AさんはBグループだからダメだ」と決めつけるのは、思考のショートカットかも。その人自身の行動や言葉に、ちゃんと向き合ってみよう。",
    "誰と友達か、どこの会社にいるかで、その人のすべてが決まるわけじゃない。色眼鏡を外して、その人自身を評価してみる必要があるんじゃないかな。"
  ],
  "転嫁": [
    "相手から指摘されたときに「お前だって同じじゃないか」と返すのは、議論のすり替えかも。まずは指摘された点について考えてみよう。",
    "相手も同じ過ちを犯しているからといって、自分の過ちが消えるわけじゃない。他人のことは一旦置いておいて、自分の行動を振り返ってみよう。",
    "「お前もな」は、議論を終わらせるための便利な言葉だけど、何も解決しない。問題の本質から目をそらさず、誠実に向き合うことが大事だよ。"
  ],
  "慣習": [
    "「昔からこうだから」というのは、思考停止のサインかもしれない。その伝統が始まった理由や、今の時代に合っているかを考えてみて。",
    "昔は正しかったことでも、時代が変われば合わなくなることもある。伝統を守ることと、変化に対応することは、両方大事な視点だよ。",
    "そのやり方、本当にみんなが納得してるのかな。ただ「変えるのが面倒だから」続いてるだけ、なんてことはない？一度、根本から見直してみよう。"
  ],
  "恐怖": [
    "恐怖を煽られると、冷静な判断ができなくなることがあるよ。その怖い話は、どのくらい現実的なの？事実と感情を分けて考えてみて。",
    "その話、わざと怖くして、あなたを操ろうとしていないかな。誰かが恐怖を利用して得をしていないか、一歩引いて考えてみよう。",
    "怖いという気持ちはわかるけど、その気持ちが判断を曇らせていないかな。客観的なデータや事実に基づいて、もう一度考えてみよう。"
  ],
  "憤怒": [
    "強い怒りを感じている時は、物事を正しく見られないかもしれない。何に対して怒っているのか、その怒りは正当なものなのか、一度立ち止まって考えてみて。",
    "その怒り、誰かに利用されていないかな。怒りによって得をする人がいないか、考えてみよう。あなたの怒りは、誰かの武器になっていない？",
    "怒りの裏には、悲しみや不安、失望が隠れていることがあるよ。「本当は何が悲しいんだろう？」と自分に聞いてみて。怒りの奥にある気持ちに気づくと、見え方が変わるかもしれない。"
  ],
  "同情": [
    "同情する気持ちは大切だけど、それだけで判断を誤ってはいけない。「かわいそう」という気持ちと、その意見が「正しい」かどうかは別の話だよ。",
    "その人に同情することで、他の誰かが不利益を被ることはないかな。公平な視点から、もう一度全体を見渡してみよう。",
    "「かわいそう」という感情に訴えかけて、あなたを思い通りに動かそうとしている人がいるかもしれない。感情と論理を切り離して考えてみて。"
  ],
  "嘲笑": [
    "相手の意見を真面目に検討せず、笑いものにして貶めるのはフェアじゃない。どんな意見にも、聞くべき点があるかもしれないよ。",
    "誰かの意見を笑いものにするのは、議論に負けを認めているのと同じかもしれない。相手の意見の良いところを探す努力をしてみよう。",
    "斬新なアイデアは、最初は笑われることが多い。でも、それが世界を変えることもある。嘲笑に惑わされず、そのアイデアの価値を真剣に評価してみよう。"
  ],
  "楽観": [
    "「こうなったらいいな」という願望と、「こうなるだろう」という客観的な予測は違うよ。最悪の事態も想定して、計画を立ててみよう。",
    "明るい未来を語られると、つい信じたくなっちゃうよね。でも、その話の根拠はどこにあるんだろう。感情ではなく、事実を確認することが大事だよ。",
    "計画が全部うまくいくなんてことは、ほとんどない。うまくいかなかった時にどうするか、プランBを用意しておくのが、本当の意味で賢いやり方だよ。"
  ],
  "幻想": [
    "「自然」という言葉は、良いイメージがあるよね。でも、自然のものが全て安全で、人工のものが全て危険とは限らない。事実に基づいて判断しよう。",
    "自然界にも毒はあるし、人工的に作られた薬で助かる命もある。「自然＝善、人工＝悪」という単純な二元論で考えていないか、見直してみて。",
    "その製品が「自然」であることを強調するのは、何か隠したいことがあるからかもしれない。イメージに惑わされず、成分やデータをしっかり確認しよう。"
  ],
  "矮小": [
    "「もっと大きな問題があるから、この問題は無視していい」とはならないよ。目の前の問題から目をそらさず、一つ一つ向き合っていこう。",
    "他にもっと大変な人がいるからといって、あなたの辛さが消えるわけじゃない。問題の大小を比べるのではなく、それぞれの問題に個別に対処しよう。",
    "「Aよりはマシ」という考え方は、思考停止につながる危険があるよ。現状を肯定するための言い訳になっていないか、自分に問いかけてみて。"
  ]
};



  // === システムプロンプト ===
// === システムプロンプト ===
const SYSTEM_PROMPT = `あなたは議論支援ツール「思考アスレチック」に組み込まれたバイアス検出AIです。

# 役割
あなたはユーザーの発言に含まれる論理的誤謬を検出する、高性能な分類器です。

# タスク
ユーザーの発言を一つ受け取り、その発言に最も顕著に表れている誤謬の種類を、後述する23種類の中から一つだけ選んで返してください。

# 出力形式（JSONのみ）
{"fallacy": "<バイアス名またはnone>"}
発言に誤謬が見当たらない場合は、必ず {"fallacy": "none"} を返してください。
# 誤謬の23種類と判定基準

## Logos（論理の誤り）
- 短絡: 複雑な問題を単一の原因に帰着させている。
- 速断: 少数の事例から全体を結論付けている。
- 循環: 結論を根拠にしている（「AだからAだ」）。
- 二択: 他の選択肢があるのに二択に限定している。
- 歪曲: 相手の主張を意図的に歪めて、弱く見せかけて反論している。
- 飛躍: 一つの行動が、必然的に破滅的な結果の連鎖を引き起こすと主張している。
- 類推: 表面的な類似点だけで、本質的に異なるものを同一視している。
- 偶然: 時間的な前後関係や相関関係を、因果関係と混同している。
- 曖昧: 同じ言葉を、文脈の中で異なる意味で使い分けている。
- 分割: 全体に当てはまる性質が、その部分にも当てはまると思い込んでいる。

## Ethos（信頼性の誤り）
- 中傷: 主張の中身ではなく、発言者の人格・経歴・属性などを攻撃している。
- 同調: 「みんなそう言っている」といった人気を根拠にしている。
- 権威: 専門外の権威や、権威の意見を文脈を無視して引用している。
- 巻添: 評判の悪い人物・集団と関連付けることで、主張の価値を下げようとしている。
- 転嫁: 指摘に対して「お前だってやっている」と論点をすり替えている。
- 慣習: 「昔からそうだから」「伝統だから」という理由だけで正当化している。

## Pathos（感情の誤り）
- 恐怖: 聞き手の恐怖や不安を煽り、冷静な判断を妨げている。
- 憤怒: 聞き手の怒りの感情に訴えかけ、行動を促している。
- 同情: 聞き手の同情心に訴えかけ、正常な判断を歪めようとしている。
- 嘲笑: 相手の主張を真面目に検討せず、嘲笑したり馬鹿にしたりして貶めている。
- 楽観: 希望・楽観・幸福感といったポジティブな感情に訴えかけ、判断を歪めている。
- 幻想: 「自然だから良い」「人工的だから悪い」と、自然であることを根拠にしている。
- 矮小: 「もっと大きな問題がある」と指摘することで、目の前の問題を矮小化している。

# 判定手順
必ず以下の2段階で判定せよ。
第1段階：発言の主たる問題がLogos（論理構造の誤り）、Ethos（信頼性の誤り）、Pathos（感情への訴え）のいずれかを判定。
第2段階：該当カテゴリ内の下位分類から一つ選択。

# 注意
- 感情に訴えかける表現が含まれている場合、Logosに分類する前にPathosの可能性を必ず検討せよ。
- 論理的な構造を持つ発言でも、主たる説得手段が感情であればPathosに分類せよ。
`;

try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const results = {};

    for (const [field, rawValue] of Object.entries(fields)) {
      if (!rawValue || (typeof rawValue === "string" && !rawValue.trim())) continue;

      // === テキスト整形 ===
      let text = "";
      if (Array.isArray(rawValue)) {
        text = rawValue
          .map((p, i) => {
            if (typeof p === "string") return p;
            return `(${i + 1}) ${p.who || "誰か"}の計画:
- 何を: ${p.what || "—"}
- どうやって: ${p.how || "—"}
- 良い予想: ${p.good || "—"}
- 悪い予想: ${p.bad || "—"}`;
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

      console.log(`🔄 [${field}] 判定中...`);

      // === API呼び出し ===
      const completion = await client.chat.completions.create({
        model: "gpt-5.4-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `テーマ: ${topic}\n\n${text}` },
        ],
      });

      const raw = completion.choices[0]?.message?.content || "{}";
      console.log(`📤 [${field}] 応答:`, raw);

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { fallacy: "none" };
      }

      // === fallacy安全処理 ===
      let fallacy = parsed.fallacy || "none";

      if (!BIAS_FIXED_ADVICE[fallacy]) {
        fallacy = "none";
      }

      // === アドバイス取得 ===
      let finalAdvice = "";
      let adviceIndex = 0; // ← 追加
      if (fallacy !== "none") {
        const advices = BIAS_FIXED_ADVICE[fallacy];
        adviceIndex = Math.floor(Math.random() * advices.length); // ← 追加
        finalAdvice = advices[adviceIndex];
      }

      results[field] = {
        line: text,
        fallacy: fallacy,
        advice: finalAdvice,
        adviceIndex, // ← 追加
      };

      console.log(`🎯 [${field}] ラベル:「${fallacy}」 index:${adviceIndex} 第2層:「${finalAdvice}」`);
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
  scenarioFixed: body.scenarioFixed ?? false, // ← 追加
  premise: body.premise ?? "",
  trouble: body.trouble ?? "",
  otherPrem: body.otherPrem ?? "",
  cause: body.cause ?? "",
  idea: body.idea ?? "",
  freeNote: body.freeNote ?? "",
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

