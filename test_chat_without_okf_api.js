async function testChatWithoutOkf() {
  console.log("=== TESTE DE CHAT SEM OKF (USANDO CONHECIMENTO GERAL DO GEMINI) ===");
  const url = "http://127.0.0.1:3000/api/chat";
  const payload = {
    question: "Quais são as melhores práticas recomendadas pelas normas para projetar vigas de concreto armado?"
  };

  console.log(`Enviando requisição POST para ${url}...`);
  console.log(`Pergunta: "${payload.question}"\n`);

  try {
    const start = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    const duration = Date.now() - start;

    if (!response.ok) {
      console.error(`X Erro na API de Chat (HTTP ${response.status}):`, data.error || data);
      process.exit(1);
    }

    console.log(`✓ Resposta recebida com sucesso em ${duration}ms!`);
    console.log("--------------------------------------------------------------------------------");
    console.log("RESPOSTA DA IA (GEMINI):");
    console.log("--------------------------------------------------------------------------------");
    console.log(data.answer);
    console.log("--------------------------------------------------------------------------------");
    console.log("Fontes citadas:", data.sources && data.sources.length > 0 ? data.sources : "Nenhuma (Utilizou Conhecimento Geral)");
    console.log("\n>>> SUCESSO: O chat com Gemini funcionou perfeitamente sem nenhum documento OKF cadastrado! <<<");
  } catch (e) {
    console.error("X Erro de conexão de rede ao testar a API de Chat:", e.message);
    process.exit(1);
  }
}

testChatWithoutOkf();
