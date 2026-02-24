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
const MIN_REPLY_DELAY_MS = 9_000 + Math.floor(Math.random() * 6_000) // 9–15 segundos

let sock = null
let starting = false
let messageHandlerReady = false

// ✅ Soporta sesión en volumen (Railway): SESSION_DIR=/data/session
const SESSION_DIR = process.env.SESSION_DIR || "./session"

// ───────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────
function safeBroadcast(event, payload) {
  try {
    if (typeof global.broadcast === "function") global.broadcast(event, payload)
  } catch {}
}

function clearSessionFolder() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true })
    }
  } catch (e) {
    console.log("⚠️ No pude borrar sesión:", e?.message || e)
  }
}

async function stopSocket() {
  try {
    if (sock) {
      // Cierra el socket actual (sin hacer logout)
      sock.end?.(new Error("Restart"))
    }
  } catch {}
  sock = null
}

function getDisconnectCode(lastDisconnect) {
  // En Baileys normalmente viene como Boom con .output.statusCode,
  // pero lo sacamos de forma segura por si cambia la forma.
  try {
    const err = lastDisconnect?.error
    return (
      err?.output?.statusCode ??
      err?.output?.payload?.statusCode ??
      err?.statusCode ??
      null
    )
  } catch {
    return null
  }
}

// ───────────────────────────────────────────────
// INICIAR CLIENTE (USADO POR index.js)
// ───────────────────────────────────────────────
export async function loadClient() {
  if (starting) return sock
  starting = true

  console.log("🔵 Iniciando cliente Baileys...")

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

    // Evitar sockets duplicados
    await stopSocket()

    sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      browser: ["OliverPanel", "Chrome", "1.0.0"],
      logger: pino({ level: "silent" })
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update

      if (qr) {
        global.LAST_QR = qr
        safeBroadcast("qr", { qr })
        console.log("⚪ Nuevo QR listo")
      }

      if (connection === "open") {
        console.log("🟢 WhatsApp conectado")
        safeBroadcast("status", { connected: true })
      }

      if (connection === "close") {
        const code = getDisconnectCode(lastDisconnect)
        console.log("🔴 Conexión cerrada. code =", code, "raw =", lastDisconnect?.error?.message || lastDisconnect?.error)

        safeBroadcast("status", { connected: false, code })

        // 1) Si te desloguearon, hay que limpiar sesión para forzar QR
        if (code === DisconnectReason.loggedOut) {
          console.log("🧨 loggedOut → limpiar sesión y forzar QR")
          clearSessionFolder()
          global.LAST_QR = null
          await delay(1200)
          starting = false
          return loadClient()
        }

        // 2) Sesión mala/corrupta (típico cuando se actualiza Baileys o creds dañadas)
        if (code === DisconnectReason.badSession) {
          console.log("🧨 badSession → limpiar sesión y forzar QR")
          clearSessionFolder()
          global.LAST_QR = null
          await delay(1200)
          starting = false
          return loadClient()
        }

        // 3) Otra instancia tomó control (no reconectar o será loop)
        if (code === DisconnectReason.connectionReplaced) {
          console.log("⚠️ connectionReplaced → otra sesión ya está conectada. No reconecto.")
          return
        }

        // 4) Default: reintentar
        await delay(3000)
        starting = false
        return loadClient()
      }
    })

    // ✅ Importante: NO montar handler de mensajes varias veces
    if (!messageHandlerReady) {
      setupMessageHandler()
      messageHandlerReady = true
    }

    return sock
  } catch (err) {
    console.log("❌ Error al iniciar Baileys:", err?.message || err)
    await delay(3000)
    starting = false
    return loadClient()
  } finally {
    // Si no llegó ningún update, liberamos el lock
    starting = false
  }
}

// ───────────────────────────────────────────────
// REGENERAR QR (limpiar sesión)
// ───────────────────────────────────────────────
export async function regenerateQR() {
  console.log("🟡 Regenerando QR...")
  await stopSocket()
  clearSessionFolder()
  global.LAST_QR = null
  await delay(800)
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
    console.log("❌ Error al desconectar:", err?.message || err)
  } finally {
    sock = null
    global.LAST_QR = null
  }
}

// ───────────────────────────────────────────────
// MANEJO DE MENSAJES (IA + memoria + typing)
// ───────────────────────────────────────────────
function setupMessageHandler() {
  const chatHistory = {}
  const typingTimers = {}

  sock.ev.on("messages.upsert", async ({ messages }) => {
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
    safeBroadcast("incoming", { from, message: text })

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

      // ⏱️ Arranca contador
      const typingStart = Date.now()

      // ✍️ Empieza a escribir
      try { await sock.sendPresenceUpdate("composing", from) } catch {}

      let reply = "Perfecto, enseguida te ayudo 😊"
      try {
        const completion = await openai.chat.completions.create({
          model: process.env.MODEL,
          messages: messagesForAI,
          temperature: 0.2
        })
        reply = completion.choices?.[0]?.message?.content?.trim() || reply
      } catch (e) {
        console.log("❌ OpenAI error:", e?.message || e)
      }

      // ⏳ Espera mínima
      const elapsed = Date.now() - typingStart
      const remaining = Math.max(0, MIN_REPLY_DELAY_MS - elapsed)
      if (remaining > 0) await delay(remaining)

      // 🛑 Deja de escribir
      try { await sock.sendPresenceUpdate("paused", from) } catch {}

      // Guardar historial
      chatHistory[from].push({ role: "assistant", content: reply })
      if (chatHistory[from].length > 10) chatHistory[from] = chatHistory[from].slice(-10)

      // 📤 Enviar mensaje
      await sock.sendMessage(from, { text: reply })
      safeBroadcast("outgoing", { to: from, message: reply })

      console.log("📤 Respondido:", reply)

      // 🧹 Limpieza
      clearTimeout(typingTimers[from])
      delete typingTimers[from]
    }, 9000)
  })
}