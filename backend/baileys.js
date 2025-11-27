import {
  default as makeWASocket,
  useMultiFileAuthState,
  Browsers
} from "@whiskeysockets/baileys"
import P from "pino"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import OpenAI from "openai"

// Necesario para rutas correctas
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const SESSION_FOLDER = path.join(__dirname, "storage", "session")
const CONFIG_PATH = path.join(__dirname, "storage", "config.json")

// Crear carpetas si no existen
if (!fs.existsSync(SESSION_FOLDER)) fs.mkdirSync(SESSION_FOLDER, { recursive: true })

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const MODEL = process.env.MODEL || "gpt-4o-mini"

// Variables globales
global.sock = null
global.LAST_QR = null

// ─────────────────────────────────────────────────────────────
// CARGAR CONFIG (prompt editable)
// ─────────────────────────────────────────────────────────────
function loadPrompt() {
  try {
    const data = fs.readFileSync(CONFIG_PATH)
    const json = JSON.parse(data)
    return json.systemPrompt || "Eres un asistente útil."
  } catch {
    return "Eres un asistente útil."
  }
}

// ─────────────────────────────────────────────────────────────
// FUNCIONES PÚBLICAS: loadClient / regenerateQR / disconnectClient
// ─────────────────────────────────────────────────────────────

export async function loadClient() {
  console.log("🔵 Inicializando cliente Baileys...")

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER)

  const sock = makeWASocket({
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    markOnlineOnConnect: false
  })

  global.sock = sock

  // Guardar eventos
  sock.ev.on("creds.update", saveCreds)

  // QR
  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      global.LAST_QR = qr
      console.log("📌 Nuevo QR generado")
      global.broadcast("qr", qr)
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== 401

      console.log("❌ Conexión cerrada:", lastDisconnect?.error)
      if (shouldReconnect) {
        console.log("🔄 Reintentando conexión...")
        await loadClient()
      } else {
        console.log("🚫 Sesión eliminada — requiere nuevo QR")
      }
    }

    if (connection === "open") {
      console.log("✅ Conectado correctamente")
      global.LAST_QR = null
      global.broadcast("connected", true)
    }
  })

  // ─────────────────────────────
  // MANEJO DE MENSAJES
  // ─────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return
    if (msg.key.fromMe) return

    const from = msg.key.remoteJid
    const textMessage = msg.message.conversation ||
                        msg.message.extendedTextMessage?.text ||
                        ""

    if (!textMessage) return

    console.log(`💬 Mensaje de ${from}: ${textMessage}`)

    // Notificar al panel
    global.broadcast("incoming", {
      from,
      message: textMessage
    })

    // Construir respuesta con OpenAI
    const systemPrompt = loadPrompt()

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: textMessage }
      ],
      temperature: 0.4
    })

    const reply = completion.choices[0].message.content.trim()

    // Enviar respuesta
    await sock.sendMessage(from, { text: reply })

    // Notificar al panel
    global.broadcast("outgoing", {
      to: from,
      message: reply
    })

    console.log(`📤 Respuesta enviada a ${from}`)
  })
}

// ─────────────────────────────────────────────────────────────
// REGENERAR QR
// ─────────────────────────────────────────────────────────────
export async function regenerateQR() {
  console.log("🔄 Forzando regeneración de QR...")

  if (!global.sock) {
    console.log("⚠️ Sock no existente, regenerando cliente...")
    await loadClient()
    return
  }

  // Forzar que genere nuevo QR → cerrar sesión temporalmente
  await disconnectClient(true)
  await loadClient()
}

// ─────────────────────────────────────────────────────────────
// DESCONECTAR SESIÓN
// ─────────────────────────────────────────────────────────────
export async function disconnectClient(keepFiles = false) {
  try {
    console.log("🟠 Desconectando sesión...")

    if (global.sock) {
      await global.sock.logout()
      await global.sock.end()
    }

    global.sock = null
    global.LAST_QR = null

    if (!keepFiles) {
      console.log("🗑 Eliminando archivos de sesión...")
      fs.rmSync(SESSION_FOLDER, { recursive: true, force: true })
      fs.mkdirSync(SESSION_FOLDER, { recursive: true })
    }

    global.broadcast("connected", false)
  } catch (e) {
    console.error("❌ Error al desconectar:", e)
  }
}
