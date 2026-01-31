const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const path = require('path');

// Import all three addon builders
const catalogBuilder = require('./index.js');
const infoBuilder = require('./info-addon.js');
const trailerBuilder = require('./trailers/addon.js');

const app = express();

// Get routers from all addons
const catalogRouter = getRouter(catalogBuilder.getInterface());
const infoRouter = getRouter(infoBuilder.getInterface());
const trailerRouter = getRouter(trailerBuilder);

// Homepage with all three install links (MUST BE FIRST)
app.get('/', (req, res) => {
    const protocol = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    const host = req.get('host') || 'localhost:7000';
    const baseUrl = `${protocol}://${host}`;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>🇭🇺 nCore Stremio Addons</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { 
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    max-width: 700px; 
                    margin: 50px auto; 
                    padding: 20px;
                    background: #1a1a2e;
                    color: #eee;
                }
                h1 { 
                    color: #7b5cfa; 
                    text-align: center;
                    margin-bottom: 40px;
                }
                .addon { 
                    background: #16213e; 
                    padding: 25px; 
                    margin: 20px 0; 
                    border-radius: 12px;
                    border: 2px solid #7b5cfa;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.3);
                }
                .addon h2 {
                    margin-top: 0;
                    color: #7b5cfa;
                }
                .addon p {
                    color: #ccc;
                    line-height: 1.6;
                }
                .url-container {
                    display: flex;
                    gap: 10px;
                    align-items: center;
                    margin: 15px 0;
                }
                .install-url {
                    flex: 1;
                    background: #0f3460;
                    padding: 10px;
                    border-radius: 5px;
                    font-family: monospace;
                    font-size: 14px;
                    color: #7b5cfa;
                    word-break: break-all;
                }
                .copy-btn {
                    background: #7b5cfa;
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 5px;
                    cursor: pointer;
                    font-weight: bold;
                    transition: background 0.3s;
                    white-space: nowrap;
                }
                .copy-btn:hover {
                    background: #6a4de8;
                }
                .copy-btn:active {
                    background: #5a3dd8;
                }
                .copy-btn.copied {
                    background: #2ecc71;
                }
                .instructions {
                    background: #0f3460;
                    padding: 15px;
                    border-radius: 5px;
                    margin-top: 15px;
                    font-size: 14px;
                    line-height: 1.8;
                }
                .instructions ol {
                    margin: 10px 0;
                    padding-left: 20px;
                }
                .badge {
                    display: inline-block;
                    background: #e74c3c;
                    color: white;
                    padding: 3px 8px;
                    border-radius: 3px;
                    font-size: 11px;
                    font-weight: bold;
                    margin-left: 8px;
                }
                .footer {
                    text-align: center;
                    margin-top: 40px;
                    color: #888;
                    font-size: 14px;
                }
            </style>
        </head>
        <body>
            <h1>🇭🇺 nCore Stremio Addons</h1>
            
            <div class="addon">
                <h2>📺 nCore Katalógus</h2>
                <p>Magyar nyelvű filmek és sorozatok katalógusa az nCore trackerről. Legfrissebb feltöltések Trakt listából.</p>
                <div class="url-container">
                    <div class="install-url" id="catalog-url">${baseUrl}/manifest.json</div>
                    <button class="copy-btn" onclick="copyUrl('catalog-url', this)">📋 Másol</button>
                </div>
                <div class="instructions">
                    <strong>📥 Telepítés:</strong>
                    <ol>
                        <li>Nyisd meg a Stremio alkalmazást</li>
                        <li>Kattints az Addons ikonra (puzzle)</li>
                        <li>Kattints a "+ Add addon" gombra</li>
                        <li>Másold be a fenti URL-t</li>
                        <li>Kattints az "Add" gombra</li>
                        <li>Kattints az Install gombra</li>
                    </ol>
                </div>
            </div>
            
            <div class="addon">
                <h2>ℹ️ nCore Epizód Infó</h2>
                <p>Az nCore Katalógus sorozatainál mutatja a legutóbb feltöltött magyar epizódot és dátumot. Csak azoknál a sorozatoknál jelenik meg, amelyek a katalógusban szerepelnek.</p>
                <p><strong>⚠️ Fontos:</strong> Ez NEM streaming addon! Csak információt nyújt a legutóbb feltöltött epizódról. A lejátszáshoz használd a StremHU Source addont!</p>
                <div class="url-container">
                    <div class="install-url" id="info-url">${baseUrl}/info/manifest.json</div>
                    <button class="copy-btn" onclick="copyUrl('info-url', this)">📋 Másol</button>
                </div>
                <div class="instructions">
                    <strong>📥 Telepítés:</strong>
                    <ol>
                        <li>Nyisd meg a Stremio alkalmazást</li>
                        <li>Kattints az Addons ikonra (puzzle)</li>
                        <li>Kattints a "+ Add addon" gombra</li>
                        <li>Másold be a fenti URL-t</li>
                        <li>Kattints az "Add" gombra</li>
                        <li>Kattints az Install gombra</li>
                    </ol>
                </div>
            </div>

            <div class="addon">
                <h2>🎬 Magyar Előzetesek <span class="badge">ÚJ</span></h2>
                <p>Magyar szinkronos/feliratos előzetesek angol tartalékkal. Intelligens keresés TMDB és YouTube alapján.</p>
                <p><strong>🔍 Keresési stratégia:</strong> TMDB magyar → YouTube magyar → TMDB angol → YouTube angol</p>
                <div class="url-container">
                    <div class="install-url" id="trailer-url">${baseUrl}/trailers/manifest.json</div>
                    <button class="copy-btn" onclick="copyUrl('trailer-url', this)">📋 Másol</button>
                </div>
                <div class="instructions">
                    <strong>📥 Telepítés:</strong>
                    <ol>
                        <li>Nyisd meg a Stremio alkalmazást</li>
                        <li>Kattints az Addons ikonra (puzzle)</li>
                        <li>Kattints a "+ Add addon" gombra</li>
                        <li>Másold be a fenti URL-t</li>
                        <li>Kattints az "Add" gombra</li>
                        <li>Kattints az Install gombra</li>
                    </ol>
                </div>
            </div>

            <div class="footer">
                <p>Made with ❤️ by Stremio Hungarian Community</p>
                <p style="margin-top: 10px; font-size: 12px;">
                    Catalog: ${baseUrl}/manifest.json<br>
                    Episode Info: ${baseUrl}/info/manifest.json<br>
                    Trailers: ${baseUrl}/trailers/manifest.json
                </p>
            </div>

            <script>
                function copyUrl(elementId, button) {
                    const urlElement = document.getElementById(elementId);
                    const url = urlElement.textContent;
                    
                    navigator.clipboard.writeText(url).then(() => {
                        const originalText = button.textContent;
                        button.textContent = '✓ Másolva!';
                        button.classList.add('copied');
                        
                        setTimeout(() => {
                            button.textContent = originalText;
                            button.classList.remove('copied');
                        }, 2000);
                    }).catch(err => {
                        console.error('Copy failed:', err);
                        alert('Másold ki manuálisan: ' + url);
                    });
                }
            </script>
        </body>
        </html>
    `);
});

// Serve trailer addon at /trailers
app.use('/trailers', trailerRouter);

// Serve info addon at /info
app.use('/info', infoRouter);

// Serve catalog addon at root (handles /manifest.json, /catalog/*, /meta/*)
app.use('/', catalogRouter);

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🇭🇺 nCore Stremio Addons Server`);
    console.log(`${'='.repeat(60)}`);
    console.log(`\n📍 Homepage: http://localhost:${PORT}`);
    console.log(`📍 Catalog: http://localhost:${PORT}/manifest.json`);
    console.log(`📍 Info: http://localhost:${PORT}/info/manifest.json`);
    console.log(`📍 Trailers: http://localhost:${PORT}/trailers/manifest.json\n`);
    console.log(`${'='.repeat(60)}\n`);
});
