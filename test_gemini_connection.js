import dotenv from "dotenv";
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || "AIzaSyAsTNq0haGV_jcdqK1ESpjYDYFC7ivCgxo";
const model = "gemini-2.5-flash";
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

async function testGemini() {
  console.log("=== TESTE DE CONEXÃO COM A GEMINI API ===");
  console.log(`Modelo: ${model}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Chave API: ${apiKey ? apiKey.slice(0, 8) + "..." + apiKey.slice(-4) : "NÃO CONFIGURADA"}`);

  if (!apiKey) {
    console.error("X Erro: GEMINI_API_KEY não foi encontrada.");
    process.exit(1);
  }

  const systemInstruction = "Você é um assistente de validação de rede técnica.";
  const promptText = "Por favor, responda 'CONEXÃO_GEMINI_OK' e uma saudação bem curta se você puder ler esta mensagem.";

  const body = {
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: promptText }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 100
    }
  };

  try {
    console.log("Enviando requisição de teste para a Generative Language API...");
    const start = Date.now();
    const response = await fetch(`${endpoint}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    const duration = Date.now() - start;

    if (!response.ok) {
      console.error(`X Erro do Gemini (HTTP ${response.status}):`, data?.error?.message || data);
      process.exit(1);
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log(`\n✓ Conexão bem-sucedida em ${duration}ms!`);
    console.log("Resposta recebida da IA:");
    console.log("-----------------------------------------");
    console.log(text.trim());
    console.log("-----------------------------------------");
    console.log("Conexão do chat com Gemini está 100% OPERACIONAL.");
  } catch (e) {
    console.error("X Erro de conexão de rede ao contactar a Gemini API:", e.message);
    process.exit(1);
  }
}

testGemini();
