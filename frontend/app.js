// Redirección si no hay login
if (!localStorage.getItem("auth")) {
  window.location = "login.html"
}

const ws = new WebSocket(
  location.origin.replace("http", "ws")
)

ws.onmessage = (event) => {
  const data = JSON.parse(event.data)

  // Estado de conexión
  if (data.type === "connected") {
    setStatus(data.data ? "Conectado" : "Desconectado")
  }

  // Mostrar QR
  if (data.type === "qr") {
    showQR(data.data)
  }

  // Último entrante
  if (data.type === "incoming") {
    document.getElementById("incoming").innerText = data.data.message
  }

  // Último saliente
  if (data.type === "outgoing") {
    document.getElementById("outgoing").innerText = data.data.message
  }
}

function setStatus(state) {
  const el = document.getElementById("status")
  el.innerText = state
  el.className =
    "px-4 py-2 rounded text-white " +
    (state === "Conectado" ? "bg-green-600" : "bg-gray-400")
}

// ─────────────────────────────────────────
// Botones
// ─────────────────────────────────────────

async function generateQR() {
  const res = await fetch("/api/qr")
  const data = await res.json()
  if (data.qr) showQR(data.qr)
}

async function regenerateQR() {
  await fetch("/api/qr/regenerate", { method: "POST" })
}

async function disconnect() {
  await fetch("/api/disconnect", { method: "POST" })
  document.getElementById("qrImg").classList.add("hidden")
  document.getElementById("noQR").classList.remove("hidden")
  setStatus("Desconectado")
}

// QR UI
function showQR(qr) {
  const img = document.getElementById("qrImg")
  const noQR = document.getElementById("noQR")

  img.src = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr)
  img.classList.remove("hidden")
  noQR.classList.add("hidden")
}

// ─────────────────────────────────────────
// Prompt dinámico
// ─────────────────────────────────────────
async function loadConfig() {
  const r = await fetch("/api/config")
  const cfg = await r.json()
  document.getElementById("prompt").value = cfg.systemPrompt
}

async function saveConfig() {
  const systemPrompt = document.getElementById("prompt").value

  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt })
  })

  alert("Guardado correctamente")
}

loadConfig()
