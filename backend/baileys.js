// backend/baileys.js
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import pino from "pino"
import { loadPrompt } from "./prompt.js"
import { openai } from "./openai.js"

const delay = (ms) => new Promise(res => setTimeout(res, ms))

export async function startBaileys() {
  const { state, saveCreds } = await useMultiFileAuthState("./session")

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    browser: ["OliverBot", "Chrome", "1.0.0"],
    logger: pino({ level: "silent" })
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      global.broadcast("qr", { qr })
    }

    if (connection === "open") {
      global.broadcast("status", { connected: true })
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode
      if (reason !== DisconnectReason.loggedOut) {
        startBaileys()
      }
    }
  })

  // Mini memoria por chat
  const chatHistory = {}
  const typingTimers = {}

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return
    if (msg.key.fromMe) return

    const from = msg.key.remoteJid
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    if (!text.trim()) return

    global.broadcast("incoming", { from, message: text })

    if (!chatHistory[from]) chatHistory[from] = []

    chatHistory[from].push({ role: "user", content: text })
    if (chatHistory[from].length > 10) chatHistory[from].slice(-10)

    // esperar si manda varios mensajes seguidos
    if (typingTimers[from]) clearTimeout(typingTimers[from])

    typingTimers[from] = setTimeout(async () => {
      try {
        await sock.sendPresenceUpdate("composing", from)
        await delay(3000)
        await sock.sendPresenceUpdate("paused", from)
      } catch (_) {}

      const systemPrompt = loadPrompt()
      const isFirst = chatHistory[from].length === 1

      const greeting = isFirst
        ? "¡Hola! Gracias por escribir a Consultoría Virtual. Estoy aquí para ayudarte."
        : ""

      const finalMessages = [
        { role: "system", content: systemPrompt },
        ...(greeting ? [{ role: "assistant", content: greeting }] : []),
        ...chatHistory[from]
      ]

      const completion = await openai.chat.completions.create({
        model: process.env.MODEL,
        messages: finalMessages,
        temperature: 0.2
      })

      const reply = completion.choices[0].message.content.trim()

      chatHistory[from].push({ role: "assistant", content: reply })
      if (chatHistory[from].length > 10) chatHistory[from] = chatHistory[from].slice(-10)

      await sock.sendMessage(from, { text: reply })

      global.broadcast("outgoing", { to: from, message: reply })
    }, 2500)
  })

  return sock
}

// ─────────────────────────────
// FUNCIÓN FALTANTE (obligatoria)
// ─────────────────────────────
export async function disconnectClient(sock) {
  try {
    await sock.logout()
  } catch (err) {
    console.log("❌ Error al desconectar:", err)
  }
}
