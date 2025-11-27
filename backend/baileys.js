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

  // Mantener conectado
  sock.ev.on("creds.update", saveCreds)

  // Enviar QR al panel
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

  // ────────────────────────────────────────────────
  // MEMORIA MINI (10 mensajes por chat)
  // ────────────────────────────────────────────────
  const chatHistory = {}
  const typingTimers = {}

  // ────────────────────────────────────────────────
  // MANEJO DE MENSAJES
  // ────────────────────────────────────────────────
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

    console.log(`💬 Mensaje entrante de ${from}: ${text}`)
    global.broadcast("incoming", { from, message: text })

    // Crear historial si no existe
    if (!chatHistory[from]) chatHistory[from] = []

    // Agregar mensaje del usuario
    chatHistory[from].push({ role: "user", content: text })

    // Limitar historial a 10
    if (chatHistory[from].length > 10) {
      chatHistory[from] = chatHistory[from].slice(-10)
    }

    // ────────────────────────────────────────────────
    // EVITAR RESPONDER MENSAJES SALTEADOS
    // Esperar 2.5 segundos desde el último mensaje
    // ────────────────────────────────────────────────
    if (typingTimers[from]) clearTimeout(typingTimers[from])

    typingTimers[from] = setTimeout(async () => {
      try {
        // TYPING DE 3 SEGUNDOS
        await sock.sendPresenceUpdate("composing", from)
        await delay(3000)
        await sock.sendPresenceUpdate("paused", from)
      } catch (err) {
        console.log("⚠ Error enviando typing:", err)
      }

      // Prompt del panel
      const systemPrompt = loadPrompt()

      const isFirstMessage = chatHistory[from].length === 1

      const greeting = isFirstMessage
        ? "Hola 👋 Gracias por escribir a Consultoría Virtual. Estoy listo para ayudarte."
        : ""

      // Construir mensajes OpenAI
      const messagesForAI = [
        { role: "system", content: systemPrompt },
        ...(greeting ? [{ role: "assistant", content: greeting }] : []),
        ...chatHistory[from]
      ]

      // Llamada a OpenAI
      const completion = await openai.chat.completions.create({
        model: process.env.MODEL,
        messages: messagesForAI,
        temperature: 0.3
      })

      const reply = completion.choices[0].message.content.trim()

      // Guardar en historial
      chatHistory[from].push({ role: "assistant", content: reply })

      if (chatHistory[from].length > 10) {
        chatHistory[from] = chatHistory[from].slice(-10)
      }

      // Enviar mensaje
      await sock.sendMessage(from, { text: reply })

      global.broadcast("outgoing", { to: from, message: reply })

      console.log(`📤 Enviado a ${from}: ${reply}`)
    }, 2500)
  })

  return sock
}
