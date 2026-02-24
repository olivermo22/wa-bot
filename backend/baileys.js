// backend/baileys.js
import "dotenv/config"

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys"
import pino from "pino"
import fs from "fs"
import { loadPrompt } from "./prompt.js"
import { openai } from "./openai.js"

const delay = (ms) => new Promise((res) => setTimeout(res, ms))
const MIN_REPLY_DELAY_MS = 9_000 + Math.floor(Math.random() * 6_000) // 9–15s

const SESSION_DIR = process.env.SESSION_DIR || "./session"

let sock = null
let starting = false
let reconnectAttempts = 0
let reconnectTimer = null

function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true })
  }
}

function clearSessionFolder() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true })
    }
  } catch {}
  ensureSessionDir()
}

function scheduleReconnect(statusCode) {
  // backoff exponencial (tope 2 min)
  const base = 3_000
  const exp = Math.min(reconnectAttempts, 6)
  let wait = Math.min(120_000, base * Math.pow(2, exp))

  // 405 / 429: normalmente es por rate-limit/bloqueo temporal → espera más
  if (statusCode === 405) wait = Math.max(wait, 60_000)
  if (statusCode === 429) wait = Math.max(wait, 120_000)

  reconnectAttempts++

  console.log(`🟠 Reintento en ${Math.round(wait / 1000)}s (statusCode=${statusCode ?? "?"})`)

  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    loadClient().catch(() => {})
  }, wait)
}

function safeEndSocket() {
  try {
    sock?.ev?.removeAllListeners("messages.upsert")
    sock?.ev?.removeAllListeners("connection.update")
  } catch {}

  try {
    sock?.end?.()
  } catch {}

  sock = null
}

export async function loadClient() {
  if (starting) return sock
  starting = true

  try {
    ensureSessionDir()

    // Evita 2 instancias peleándose por listeners/sock
    if (sock) safeEndSocket()

    console.log("🔵 Iniciando cliente Baileys...")

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

    sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      browser: ["OliverPanel", "Chrome", "1.0.0"],
      logger: pino({ level: "silent" }),

      // valores “cloud friendly”
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 20_000,
      defaultQueryTimeoutMs: 0,
      markOnlineOnConnect: false
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", (update) => {
      const { qr, connection, lastDisconnect } = update

      if (qr) {
        global.LAST_QR = qr
        // para tu panel via WS: manda el string directo
        global.broadcast?.("qr", qr)
        console.log("⚪ Nuevo QR listo")
      }

      if (connection === "open") {
        reconnectAttempts = 0
        console.log("🟢 WhatsApp conectado")
        global.broadcast?.("connected", true)
      }

      if (connection === "close") {
        global.broadcast?.("connected", false)

        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.data?.statusCode

        console.log("🔴 Conexión cerrada.", "code =", statusCode, "raw =", lastDisconnect?.error?.message || "Connection Failure")

        // loggedOut: ya no reconectes, requiere QR nuevo
        if (statusCode === DisconnectReason.loggedOut) {
          console.log("🔒 Sesión cerrada (loggedOut). Necesitas regenerar QR.")
          return
        }

        scheduleReconnect(statusCode)
      }
    })

    setupMessageHandler(sock)

    return sock
  } finally {
    starting = false
  }
}

export async function regenerateQR() {
  console.log("🟡 Regenerando QR...")

  // corta socket y limpia sesión
  try {
    await sock?.logout?.()
  } catch {}
  safeEndSocket()

  global.LAST_QR = null
  global.broadcast?.("qr", null)
  global.broadcast?.("connected", false)

  clearSessionFolder()
  reconnectAttempts = 0

  await loadClient()
}

export async function disconnectClient() {
  if (!sock) return

  try {
    await sock.logout()
    console.log("🔌 Cliente desconectado")
  } catch (err) {
    console.log("❌ Error al desconectar:", err)
  } finally {
    safeEndSocket()
    global.broadcast?.("connected", false)
  }
}

function setupMessageHandler(socket) {
  // importante: evita duplicar listeners en reconexiones
  try {
    socket.ev.removeAllListeners("messages.upsert")
  } catch {}

  const chatHistory = {}
  const typingTimers = {}

  socket.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0]
    if (!msg?.message) return
    if (msg.key?.fromMe) return

    const from = msg.key.remoteJid
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    if (!text.trim()) return

    console.log("💬 Entrante:", from, text)
    global.broadcast?.("incoming", { from, message: text })

    if (!chatHistory[from]) chatHistory[from] = []
    chatHistory[from].push({ role: "user", content: text })
    if (chatHistory[from].length > 10) chatHistory[from] = chatHistory[from].slice(-10)

    if (typingTimers[from]) clearTimeout(typingTimers[from])

    typingTimers[from] = setTimeout(async () => {
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

      const typingStart = Date.now()

      try {
        await socket.sendPresenceUpdate("composing", from)
      } catch {}

      const completion = await openai.chat.completions.create({
        model: process.env.MODEL,
        messages: messagesForAI,
        temperature: 0.2
      })

      const reply =
        completion.choices?.[0]?.message?.content?.trim() ||
        "Perfecto, enseguida te ayudo 😊"

      const elapsed = Date.now() - typingStart
      const remaining = Math.max(0, MIN_REPLY_DELAY_MS - elapsed)
      if (remaining > 0) await delay(remaining)

      try {
        await socket.sendPresenceUpdate("paused", from)
      } catch {}

      chatHistory[from].push({ role: "assistant", content: reply })
      if (chatHistory[from].length > 10) chatHistory[from] = chatHistory[from].slice(-10)

      await socket.sendMessage(from, { text: reply })
      global.broadcast?.("outgoing", { to: from, message: reply })

      console.log("📤 Respondido:", reply)

      clearTimeout(typingTimers[from])
      delete typingTimers[from]
    }, 9000)
  })
}