#!/usr/bin/env node
import { geminiService } from "../services/gemini.js";

let lastPercent = -1;

try {
  const status = await geminiService.warmup(info => {
    if (info?.status !== "progress") return;
    const percent = Math.round(Number(info.progress) || 0);
    if (percent === lastPercent) return;
    lastPercent = percent;
    process.stdout.write(
      `\rPreparando ${info.file || "modelo"}: ${String(percent).padStart(3)}%`,
    );
  });
  process.stdout.write("\n");
  console.log("Modelo preparado:");
  console.log(JSON.stringify(status, null, 2));
} catch (error) {
  process.stdout.write("\n");
  console.error(`Falha ao preparar o modelo: ${error.message}`);
  console.error(
    "Para modelos que exigem licença, aceite-a no Hugging Face e defina HF_TOKEN.",
  );
  process.exitCode = 1;
}
