@echo off
REM ============================================================
REM Iniciar Phill_da_rythm.bat
REM   1. Sobe um servidor HTTP local (python http.server) na porta 8000,
REM      servindo a pasta atual (= esta pasta Phill_da_rythm).
REM   2. Espera 2 segundos.
REM   3. Abre o Chrome em modo --app apontando pra http://localhost:8000/
REM      (janela enxuta, sem barra de endereco, parece nativo).
REM   Fallback: se Chrome nao for encontrado, abre no navegador padrao.
REM
REM Como usar:
REM   - Duplo-clique neste arquivo.
REM   - Pra criar atalho na area de trabalho: clique com botao direito neste
REM     arquivo -> Enviar para -> Area de trabalho (criar atalho). Ai voce
REM     pode renomear o atalho pra "Phill da Rythm" e/ou trocar o icone.
REM
REM Como parar:
REM   - Feche a janela do navegador.
REM   - Feche a janela minimizada do "Phill_da_rythm Server" na barra de
REM     tarefas (ou no Gerenciador de Tarefas: processo python.exe).
REM ============================================================

setlocal

REM Pasta deste .bat (= raiz dos arquivos servidos pelo http.server)
cd /d "%~dp0"

REM 1. Servidor HTTP local. /MIN abre minimizado na barra de tarefas.
REM    Se a porta 8000 ja estiver em uso (servidor de uma execucao anterior),
REM    o python falha silenciosamente nessa nova janela e o app continua
REM    funcionando porque o servidor antigo ainda esta vivo.
start "Phill_da_rythm Server" /MIN cmd /c "python -m http.server 8000"

REM 2. Pequeno delay pra o servidor estabilizar antes do navegador conectar.
timeout /t 2 /nobreak >nul

REM 3. Procura o Chrome nos 3 caminhos padrao do Windows.
set "CHROME="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" set "CHROME=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"

if defined CHROME (
    start "" "%CHROME%" --app=http://localhost:8000/ --window-size=960,720
) else (
    REM Sem Chrome no caminho padrao -- abre no navegador default do sistema
    REM (Edge, Firefox, etc). Vai funcionar, mas com barra de endereco visivel.
    start "" http://localhost:8000/
)

endlocal
exit /b 0
