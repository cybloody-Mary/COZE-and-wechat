import express from "express";
import crypto from "crypto";
import { XMLParser } from "fast-xml-parser";

const app = express();

app.use(express.text({
  type: ["text/*", "application/xml", "*/xml", "*/*"],
  limit: "1mb"
}));

const {
  PORT = 3000,

  // 微信公众号后台“服务器配置”里的 Token，自己随便设置，但必须和后台一致
  WECHAT_TOKEN,

  // Coze 配置
  COZE_API_TOKEN,
  COZE_BOT_ID,

  // 国际版默认 https://api.coze.com；国内扣子通常用 https://api.coze.cn
  COZE_API_BASE = "https://api.coze.com",

  // 微信 5 秒限制下，建议 4000~4500ms
  COZE_TIMEOUT_MS = "4300",

  // Coze 超时时的兜底回复
  TIMEOUT_REPLY = "我正在思考中，请稍后再发一次～",

  // Coze 出错时的兜底回复
  ERROR_REPLY = "抱歉，我暂时无法回复，请稍后再试。"
} = process.env;

if (!WECHAT_TOKEN || !COZE_API_TOKEN || !COZE_BOT_ID) {
  console.warn("Missing required env: WECHAT_TOKEN, COZE_API_TOKEN, COZE_BOT_ID");
}

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: false
});

// 简单内存去重：Render 免费单实例够用；重启后会丢失，不影响基本功能
const replyCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function checkWechatSignature(signature, timestamp, nonce) {
  if (!signature || !timestamp || !nonce || !WECHAT_TOKEN) return false;

  const raw = [WECHAT_TOKEN, timestamp, nonce].sort().join("");
  const sha1 = crypto.createHash("sha1").update(raw).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(sha1), Buffer.from(signature));
  } catch {
    return false;
  }
}

function escapeXml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildTextXml({ toUser, fromUser, content }) {
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${escapeXml(content)}]]></Content>
</xml>`;
}

function normalizeText(input) {
  return String(input || "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, 2000);
}

function getMsgKey(msg) {
  return msg.MsgId || `${msg.FromUserName}:${msg.CreateTime}:${msg.Content || msg.Event || ""}`;
}

function cleanCache() {
  const now = Date.now();
  for (const [key, val] of replyCache.entries()) {
    if (now - val.time > CACHE_TTL_MS) replyCache.delete(key);
  }
}

// 调用 Coze v3 Chat，使用 stream=true，直接从 SSE 里提取最终 answer
async function callCoze(userId, text) {
  const timeoutMs = Number(COZE_TIMEOUT_MS) || 4300;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${COZE_API_BASE.replace(/\/$/, "")}/v3/chat`;

    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${COZE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bot_id: COZE_BOT_ID,
        user_id: userId,
        stream: true,
        auto_save_history: true,
        additional_messages: [
          {
            role: "user",
            content: text,
            content_type: "text"
          }
        ]
      })
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Coze HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }

    const sse = await resp.text();

    let finalAnswer = "";
    let deltaAnswer = "";

    for (const block of sse.split(/\n\n+/)) {
      const eventLine = block.split("\n").find(line => line.startsWith("event:"));
      const dataLine = block.split("\n").find(line => line.startsWith("data:"));

      if (!dataLine) continue;

      const eventName = eventLine ? eventLine.replace(/^event:\s*/, "").trim() : "";
      const rawData = dataLine.replace(/^data:\s*/, "").trim();

      if (!rawData || rawData === "[DONE]") continue;

      let data;
      try {
        data = JSON.parse(rawData);
      } catch {
        continue;
      }

      // Coze 常见事件：conversation.message.delta / conversation.message.completed
      if (eventName === "conversation.message.delta") {
        if (data.type === "answer" && data.content) {
          deltaAnswer += data.content;
        }
      }

      if (eventName === "conversation.message.completed") {
        if (data.type === "answer" && data.content) {
          finalAnswer = data.content;
        }
      }
    }

    const answer = normalizeText(finalAnswer || deltaAnswer);
    return answer || "我没有生成有效回复，请换个说法再试一次。";
  } finally {
    clearTimeout(timer);
  }
}

app.get("/", (req, res) => {
  res.type("text/plain").send("wechat-coze-relay ok");
});

app.get("/healthz", (req, res) => {
  res.status(200).json({
    ok: true,
    time: new Date().toISOString()
  });
});

// 微信服务器 Token 校验
app.get("/wechat", (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query;

  if (checkWechatSignature(signature, timestamp, nonce)) {
    return res.status(200).type("text/plain").send(echostr || "");
  }

  return res.status(403).type("text/plain").send("invalid signature");
});

// 微信消息推送
app.post("/wechat", async (req, res) => {
  const { signature, timestamp, nonce } = req.query;

  if (!checkWechatSignature(signature, timestamp, nonce)) {
    return res.status(403).type("text/plain").send("invalid signature");
  }

  let msg;
  try {
    const parsed = parser.parse(req.body || "");
    msg = parsed.xml;
  } catch (err) {
    console.error("XML parse error:", err);
    return res.status(200).type("text/plain").send("success");
  }

  if (!msg || !msg.FromUserName || !msg.ToUserName) {
    return res.status(200).type("text/plain").send("success");
  }

  cleanCache();

  const msgKey = getMsgKey(msg);
  if (replyCache.has(msgKey)) {
    return res.type("application/xml").send(replyCache.get(msgKey).xml);
  }

  const fromUser = msg.FromUserName; // 用户 OpenID
  const toUser = msg.ToUserName;     // 公众号 ID

  let replyText = "";

  try {
    if (msg.MsgType === "text") {
      const userText = normalizeText(msg.Content);

      if (!userText) {
        replyText = "请发送文字消息。";
      } else {
        replyText = await callCoze(fromUser, userText);
      }
    } else if (msg.MsgType === "event" && msg.Event === "subscribe") {
      replyText = "你好，欢迎关注！直接发送文字就可以和我聊天。";
    } else {
      replyText = "目前只支持文字消息。";
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn("Coze timeout");
      replyText = TIMEOUT_REPLY;
    } else {
      console.error("Coze error:", err);
      replyText = ERROR_REPLY;
    }
  }

  const xml = buildTextXml({
    toUser: fromUser,
    fromUser: toUser,
    content: replyText
  });

  replyCache.set(msgKey, {
    time: Date.now(),
    xml
  });

  return res.type("application/xml").send(xml);
});

app.listen(PORT, () => {
  console.log(`wechat-coze-relay listening on ${PORT}`);
});
