// backend/baileys.js
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys"
import pino from "pino"
import fs from "fs"
import { loadPrompt } from "./prompt.js"
import { openai } from "./openai.js"

const delay = (ms) => new Promise(res => setTimeout(res, ms))

let sock = null

// ───────────────────────────────────────────────
// LIMPIAR SESIÓN (para regenerar QR)
// ───────────────────────────────────────────────
function clearSessionFolder() {
  const folder = "./session"
  if (fs.existsSync(folder)) {
    fs.rmSync(folder, { recursive: true })
  }
}

// ───────────────────────────────────────────────
// INICIAR CLIENTE (USADO POR index.js)
// ───────────────────────────────────────────────
export async function loadClient() {
  console.log("🔵 Iniciando cliente Baileys...")

  const { state, saveCreds } = await useMultiFileAuthState("./session")

  sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    browser: ["OliverPanel", "Chrome", "1.0.0"],
    logger: pino({ level: "silent" })
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      global.LAST_QR = qr
      global.broadcast("qr", { qr })
      console.log("⚪ Nuevo QR listo")
    }

    if (connection === "open") {
      console.log("🟢 WhatsApp conectado")
      global.broadcast("status", { connected: true })
    }

    if (connection === "close") {
      console.log("🔴 Conexión cerrada")
      const reason = lastDisconnect?.error?.output?.statusCode

      if (reason !== DisconnectReason.loggedOut) {
        loadClient()
      }
    }
  })

  setupMessageHandler()

  return sock
}

// ───────────────────────────────────────────────
// REGENERAR QR (limpiar sesión)
// ───────────────────────────────────────────────
export async function regenerateQR() {
  console.log("🟡 Regenerando QR...")
  clearSessionFolder()
  await loadClient()
}

// ───────────────────────────────────────────────
// DESCONECTAR CLIENTE
// ───────────────────────────────────────────────
export async function disconnectClient() {
  if (!sock) return
  try {
    await sock.logout()
    console.log("🔌 Cliente desconectado")
  } catch (err) {
    console.log("❌ Error al desconectar:", err)
  }
}

// ───────────────────────────────────────────────
// MANEJO DE MENSAJES (IA + memoria + typing)
// ───────────────────────────────────────────────
function setupMessageHandler() {
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

    console.log("💬 Entrante:", from, text)
    global.broadcast("incoming", { from, message: text })

    if (!chatHistory[from]) chatHistory[from] = []
    chatHistory[from].push({ role: "user", content: text })

    if (chatHistory[from].length > 10) {
      chatHistory[from] = chatHistory[from].slice(-10)
    }

    if (typingTimers[from]) clearTimeout(typingTimers[from])

    typingTimers[from] = setTimeout(async () => {
      try {
        await sock.sendPresenceUpdate("composing", from)
        await delay(3000)
        await sock.sendPresenceUpdate("paused", from)
      } catch {}

      const systemPrompt = loadPrompt()
      const isFirst = chatHistory[from].length === 1

      const greeting = isFirst
        ? "Hola 👋 Gracias por escribir a Consultoría Virtual. Estoy listo para ayudarte."
        : ""

      const messagesForAI = [
        { role: "system", content: systemPrompt },
        ...(greeting ? [{ role: "assistant", content: greeting }] : []),
        ...chatHistory[from]
      ]

      const completion = await openai.chat.completions.create({
        model: process.env.MODEL,
        messages: messagesForAI,
        temperature: 0.2
      })

      const reply = completion.choices[0].message.content.trim()

      chatHistory[from].push({ role: "assistant", content: reply })
      if (chatHistory[from].length > 10) {
        chatHistory[from] = chatHistory[from].slice(-10)
      }

      await sock.sendMessage(from, { text: reply })
      global.broadcast("outgoing", { to: from, message: reply })

      console.log("📤 Respondido:", reply)
    }, 2500)
  })
}
