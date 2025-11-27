import express from "express"
import cors from "cors"
import bodyParser from "body-parser"
import path from "path"
import { fileURLToPath } from "url"
import dotenv from "dotenv"
import { createServer } from "http"
import { WebSocketServer } from "ws"
import {
  loadClient,
  regenerateQR,
  disconnectClient
} from "./baileys.js"
import fs from "fs"

dotenv.config()

// Para rutas correctas (ESM)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Inicializar app
const app = express()
app.use(cors())
app.use(bodyParser.json())

// Carpeta del frontend
const FRONTEND = path.join(__dirname, "..", "frontend")

// ──────────────────────────────────────────────
// LOGIN API (usuario/contraseña fijos)
// ──────────────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { user, pass } = req.body

  if (user === process.env.PANEL_USER && pass === process.env.PANEL_PASS) {
    return res.json({ ok: true })
  }

  res.status(401).json({ ok: false })
})

// ──────────────────────────────────────────────
// CONFIG del BOT
// ──────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "storage", "config.json")

// Crear config si no existe
if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ systemPrompt: "Eres un bot útil." }, null, 2)
  )
}

app.get("/api/config", (_, res) => {
  res.json(JSON.parse(fs.readFileSync(CONFIG_PATH)))
})

app.post("/api/config", (req, res) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2))
  res.json({ ok: true })
})

// ──────────────────────────────────────────────
// QR API
// ──────────────────────────────────────────────
app.get("/api/qr", (_, res) => {
  res.json({ qr: global.LAST_QR || null })
})

app.post("/api/qr/regenerate", async (_, res) => {
  await regenerateQR()
  res.json({ ok: true })
})

// ──────────────────────────────────────────────
// DESCONEXIÓN
// ──────────────────────────────────────────────
app.post("/api/disconnect", async (_, res) => {
  await disconnectClient()
  res.json({ ok: true })
})

// ──────────────────────────────────────────────
// FRONTEND STATIC (login y panel)
// ──────────────────────────────────────────────
app.use(express.static(FRONTEND))

// si entra a / directamente → login
app.get("/", (_, res) => {
  res.sendFile(path.join(FRONTEND, "login.html"))
})

// fallback (para panel.html y otros)
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/panel.html'))
})


// ──────────────────────────────────────────────
// HTTP + WEBSOCKET SERVER
// ──────────────────────────────────────────────
const httpServer = createServer(app)

const wss = new WebSocketServer({ server: httpServer })
global.WS_CLIENTS = []

wss.on("connection", (ws) => {
  global.WS_CLIENTS.push(ws)
  console.log("🟦 Panel conectado vía WebSocket")

  ws.on("close", () => {
    global.WS_CLIENTS = global.WS_CLIENTS.filter(c => c !== ws)
  })
})

// Función global para mandar eventos al panel
global.broadcast = (type, data) => {
  const payload = JSON.stringify({ type, data })
  global.WS_CLIENTS.forEach(ws => ws.send(payload))
}

// ──────────────────────────────────────────────
// INICIAR SERVIDOR + BAILEYS
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000

httpServer.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP + WebSocket listo en puerto ${PORT}`)
})

// iniciar Baileys
loadClient()
