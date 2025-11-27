import fs from "fs"
import path from "path"

const promptPath = path.resolve("backend/prompt.txt")

export function loadPrompt() {
  try {
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, "utf8")
    } else {
      return "Eres un asistente útil y claro."
    }
  } catch (err) {
    console.error("Error cargando prompt.txt", err)
    return "Eres un asistente útil."
  }
}
