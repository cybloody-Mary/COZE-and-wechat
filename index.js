import express from "express";
import crypto from "crypto";
import { XMLParser } from "fast-xml-parser";

const app = express();

app.use(express.text({
  type: ["text/*", "application/xml", "*/xml", "*/*"],
  limit: "1mb"
}));

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: false
});

const {
  PORT = 3000,
  WECHAT_TOKEN,
  WECHAT_APP_ID,
  WECHAT_APP_SECRET,
  COZE_API_TOKEN,
  COZE_BOT_ID,
  COZE_API_BASE = "https://api.coze.cn",
  WAITING_REPLY = "收到，我正在思考，请稍等一下。",
  ERROR_REPLY = "抱歉，我暂时无法回复，请稍后再试。"
} = process.env;

let cachedAccessToken = "";
let cachedAccessTokenExpireAt = 0;
const processing = new Map();

function checkWechatSignature(signature, timestamp, nonce) {
  if (!signature || !timestamp || !nonce || !WECHAT_TOKEN) return false;
  const raw = [WECHAT_TOKEN, timestamp, nonce].sort().join("");
  const sha1 = crypto.createHash("sha1").update(raw).digest("hex");
  return sha1 === signature;
}

function parseWechatXml(xml) {
  const parsed = parser.parse(xml || "");
  return parsed.xml || {};
}

function getMsgKey(msg) {
  return msg.MsgId || `${msg.FromUserName}:${msg.CreateTime}:${msg.Content || ""}`;
}

async function getWechatAccessToken() {
  const now = Date.now();

  if (cachedAccessToken && now < cachedAccessTokenExpireAt) {
    return cachedAccessToken;
  }

  const url =
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
    `&appid=${WECHAT_APP_ID}` +
    `&secret=${WECHAT_APP_SECRET}`;

  const resp = await fetch(url);
  const data = await resp.json();

  if (!data.access_token) {
    throw new Error(`get access_token failed: ${JSON.stringify(data)}`);
  }

  cachedAccessToken = data.access_token;
  cachedAccessTokenExpireAt = now + 7000 * 1000;

  return cachedAccessToken;
}

async function sendWechatCustomerMessage(openid, content) {
  const accessToken = await getWechatAccessToken();

  const url =
    `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      touser: openid,
      msgtype: "text",
      text: {
        content: String(content || "").slice(0, 2000)
      }
    })
  });

  const data = await resp.json();

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`custom send failed: ${JSON.stringify(data)}`);
  }

  return data;
}

async function callCoze(userId, text) {
  const resp = await fetch(`${COZE_API_BASE.replace(/\/$/, "")}/v3/chat`, {
    method: "POST",
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
    throw new Error(`Coze HTTP ${resp.status}: ${body.slice(0, 500)}`);
  }

  const sseText = await resp.text();

  let finalAnswer = "";
  let deltaAnswer = "";

  for (const block of sseText.split(/\n\n+/)) {
    const lines = block.split("\n");
    const eventLine = lines.find(line => line.startsWith("event:"));
    const dataLine = lines.find(line => line.startsWith("data:"));

    if (!dataLine) continue;

    const eventName = eventLine
      ? eventLine.replace(/^event:\s*/, "").trim()
      : "";

    const rawData = dataLine.replace(/^data:\s*/, "").trim();

    if (!rawData || rawData === "[DONE]") continue;

    let data;
    try {
      data = JSON.parse(rawData);
    } catch {
      continue;
    }

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

  return (finalAnswer || deltaAnswer || "我没有生成有效回复，请换个说法再试一次。")
    .trim()
    .slice(0, 2000);
}

async function processMessage(msg) {
  const openid = msg.FromUserName;
  const text = String(msg.Content || "").trim();

  if (!text) return;

  try {
    await sendWechatCustomerMessage(openid, WAITING_REPLY);
    const answer = await callCoze(openid, text);
    await sendWechatCustomerMessage(openid, answer);
  } catch (err) {
    console.error(err);
    try {
      await sendWechatCustomerMessage(openid, ERROR_REPLY);
    } catch (sendErr) {
      console.error(sendErr);
    }
  }
}

app.get("/", (req, res) => {
  res.type("text/plain").send("ok");
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/wechat", (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query;

  if (!checkWechatSignature(signature, timestamp, nonce)) {
    return res.status(403).type("text/plain").send("invalid signature");
  }

  return res.type("text/plain").send(echostr || "");
});

app.post("/wechat", async (req, res) => {
  const { signature, timestamp, nonce } = req.query;

  if (!checkWechatSignature(signature, timestamp, nonce)) {
    return res.status(403).type("text/plain").send("invalid signature");
  }

  let msg;
  try {
    msg = parseWechatXml(req.body);
  } catch (err) {
    console.error("xml parse error:", err);
    return res.type("text/plain").send("success");
  }

  if (!msg || !msg.FromUserName || !msg.ToUserName) {
    return res.type("text/plain").send("success");
  }

  if (msg.MsgType === "text") {
    const key = getMsgKey(msg);

    if (!processing.has(key)) {
      processing.set(key, Date.now());

      processMessage(msg).finally(() => {
        setTimeout(() => processing.delete(key), 5 * 60 * 1000);
      });
    }
  }

  return res.type("text/plain").send("success");
});

app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
