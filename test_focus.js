import { chromium } from 'playwright';

(async () => {
  console.log("Iniciando o navegador Chromium...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log("Navegando para o app de Engenharia em http://localhost:3000...");
  await page.goto('http://localhost:3000');
  
  // Espera a página carregar
  await page.waitForTimeout(1000);

  // Verificando se o overlay de registro é exibido
  const registerOverlayVisible = await page.locator('#reg-name').isVisible();
  if (registerOverlayVisible) {
    console.log("Overlay de cadastro encontrado. Efetuando cadastro de teste...");
    await page.fill('#reg-name', 'Usuario Teste');
    await page.selectOption('#reg-role', { label: 'Engenheiro Sênior' });
    await page.selectOption('#reg-sector', { label: 'Projetos e Obras' });
    
    // Clica no botão de cadastrar
    const registerButton = page.locator('button:has-text("Cadastrar Dispositivo")');
    await registerButton.click();
    
    // Esperar um pouco para que o cadastro seja processado e o dashboard carregue
    await page.waitForTimeout(1500);
  } else {
    console.log("Usuário já cadastrado, entrando direto no dashboard.");
  }

  console.log("Verificando carregamento do painel principal...");
  const bodyText = await page.textContent('body');
  if (bodyText.includes("Base de Conhecimento OKF")) {
    console.log("✓ Painel principal carregado com sucesso!");
  } else {
    console.error("X Erro: Painel principal não foi detectado no body.");
    await browser.close();
    process.exit(1);
  }

  // --- TESTE 1: Input de Busca de Documentos ---
  console.log("\n--- TESTE 1: Input de Busca de Documentos ---");
  const searchInput = page.locator('input[placeholder="Buscar documentos padronizados..."]');
  await searchInput.focus();
  
  let isFocused = await page.evaluate((el) => document.activeElement === el, await searchInput.elementHandle());
  console.log(`Input focado inicialmente: ${isFocused}`);
  
  const searchQueryText = "especificacao";
  console.log(`Digitando '${searchQueryText}' caractere por caractere...`);
  for (let char of searchQueryText) {
    await page.keyboard.type(char);
    isFocused = await page.evaluate((el) => document.activeElement === el, await searchInput.elementHandle());
    if (!isFocused) {
      console.error(`X Erro: Perdeu o foco ao digitar o caractere '${char}'!`);
      await browser.close();
      process.exit(1);
    }
  }
  console.log("✓ Sucesso: Texto de busca digitado completamente sem nenhuma perda de foco.");

  // Forçamos o blur manualmente e aguardamos o re-render assentar antes de prosseguir
  console.log("Desfocando campo de busca para disparar seu onblur de forma isolada...");
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(1000);

  // --- TESTE 2: Chat Técnico ---
  console.log("\n--- TESTE 2: Chat Técnico ---");
  const chatInput = page.locator('#chat-input-text');
  await chatInput.focus();
  
  isFocused = await page.evaluate((el) => document.activeElement === el, await chatInput.elementHandle());
  console.log(`Input de chat focado inicialmente: ${isFocused}`);
  
  const chatText = "Quais sao as regras?";
  console.log(`Digitando '${chatText}'...`);
  for (let char of chatText) {
    await page.keyboard.type(char);
    isFocused = await page.evaluate((el) => document.activeElement === el, await chatInput.elementHandle());
    if (!isFocused) {
      console.error(`X Erro: Perdeu o foco ao digitar o caractere '${char}' no chat!`);
      await browser.close();
      process.exit(1);
    }
  }
  console.log("✓ Sucesso: Pergunta digitada no chat sem nenhuma perda de foco.");

  // Forçamos o blur manualmente e aguardamos o re-render assentar antes de clicar na aba
  console.log("Desfocando campo de chat para disparar seu onblur de forma isolada...");
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(1000);

  // --- TESTE 3: Criação de Tarefas ---
  console.log("\n--- TESTE 3: Campo de Título e Descrição de Nova Tarefa ---");
  
  // Navega para a aba de Atividades
  console.log("Navegando para a aba de Atividades...");
  await page.locator('button:has-text("Atividades")').click();
  
  // Aguarda assentar os re-renders decorrentes do switchTab
  console.log("Aguardando 1500ms para acomodar os re-renders da mudança de aba...");
  await page.waitForTimeout(1500);

  const taskTitleInput = page.locator('#task-title-input');
  await taskTitleInput.focus();
  
  isFocused = await page.evaluate((el) => document.activeElement === el, await taskTitleInput.elementHandle());
  console.log(`Input de título focado inicialmente: ${isFocused}`);
  
  const taskTitle = "Revisar planta baixa";
  console.log(`Digitando '${taskTitle}'...`);
  for (let char of taskTitle) {
    await page.keyboard.type(char);
    isFocused = await page.evaluate((el) => document.activeElement === el, await taskTitleInput.elementHandle());
    if (!isFocused) {
      console.error(`X Erro: Perdeu o foco ao digitar o caractere '${char}' no título da tarefa!`);
      await browser.close();
      process.exit(1);
    }
  }
  console.log("✓ Sucesso: Título da tarefa digitado sem nenhuma perda de foco.");

  console.log("\n>>> TODOS OS TESTES DE FOCO PASSARAM COM SUCESSO! Os inputs do projeto 'dev/engenharia' mantêm o foco perfeitamente durante toda a digitação. <<<");
  await browser.close();
})();
