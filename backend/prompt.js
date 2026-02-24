// backend/prompt.js
import fs from "fs"
import path from "path"

const promptTxtPath = path.resolve("backend/prompt.txt")
const configPath = path.resolve("backend/storage/config.json")

export function loadPrompt() {
  try {
    // 1) Si el panel guardó un prompt, úsalo
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))
      if (cfg?.systemPrompt && String(cfg.systemPrompt).trim()) {
        return String(cfg.systemPrompt).trim()
      }
    }

    // 2) Si existe prompt.txt, úsalo
    if (fs.existsSync(promptTxtPath)) {
      return fs.readFileSync(promptTxtPath, "utf8")
    }

    // 3) Fallback
    return "Eres un asistente útil y claro."
  } catch (err) {
    console.error("Error cargando prompt:", err)
    return "Eres un asistente útil."
  }
}