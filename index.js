import express from "express";
import crypto from "crypto";
import { XMLParser } from "fast-xml-parser";

const app = express();

app.use(express.text({
  type: ["text/*", "application/xml", "*/xml", "*/*"]
}));

const parser = new XMLParser({
  ignoreAttributes: true
});

const {
  PORT = 3000,
  WECHAT_TOKEN,
  COZE_API_TOKEN,
  COZE_BOT_ID,
  COZE_API_BASE = "https://api.coze.cn"
} = process.env;

function checkWechatSignature(signature, timestamp, nonce) {
  const raw = [WECHAT_TOKEN, timestamp, nonce].sort().join("");
  const sha1 = crypto.createHash("sha1").update(raw).digest("hex");
  return sha1 === signature;
}

function parseWechatXml(xml) {
  const parsed = parser.parse(xml || "");
  return parsed.xml || {};
}

function buildTextReply(toUser, fromUser, content) {
  const now = Math.floor(Date.now() / 1000);

  return `
<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${now}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>
`.trim();
}

async function callCoze(userId, text) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 4500);

  try {
    const resp = await fetch(
      `${COZE_API_BASE.replace(/\/$/, "")}/v3/chat`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${COZE_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        signal: controller.signal,
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
      }
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Coze HTTP ${resp.status}: ${body}`);
    }

    const sseText = await resp.text();

    let finalAnswer = "";
    let deltaAnswer = "";

    for (const block of sseText.split(/\n\n+/)) {
      const lines = block.split("\n");

      const eventLine = lines.find(i => i.startsWith("event:"));
      const dataLine = lines.find(i => i.startsWith("data:"));

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

      if (
        eventName === "conversation.message.delta" &&
        data.type === "answer"
      ) {
        deltaAnswer += data.content || "";
      }

      if (
        eventName === "conversation.message.completed" &&
        data.type === "answer"
      ) {
        finalAnswer = data.content || "";
      }
    }

    return (
      finalAnswer ||
      deltaAnswer ||
      "我暂时没有生成有效回复，请稍后再试。"
    ).slice(0, 2000);

  } finally {
    clearTimeout(timeout);
  }
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.get("/wechat", (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query;

  if (!checkWechatSignature(signature, timestamp, nonce)) {
    return res.status(403).send("invalid signature");
  }

  return res.send(echostr || "");
});

app.post("/wechat", async (req, res) => {
  const { signature, timestamp, nonce } = req.query;

  if (!checkWechatSignature(signature, timestamp, nonce)) {
    return res.status(403).send("invalid signature");
  }

  try {
    const msg = parseWechatXml(req.body);

    console.log("parsed msg:", msg);

    if (msg.MsgType !== "text") {
      return res.send("success");
    }

    const answer = await callCoze(
      msg.FromUserName,
      msg.Content || ""
    );

    const xml = buildTextReply(
      msg.FromUserName,
      msg.ToUserName,
      answer
    );

    return res.type("application/xml").send(xml);

  } catch (err) {
    console.error(err);

    const fallbackXml = buildTextReply(
      "user",
      "gh_xxx",
      "我思考时间有点长，请稍后再试。"
    );

    return res.type("application/xml").send(fallbackXml);
  }
});

app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
