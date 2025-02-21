import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { WebSocketServer } from 'ws';
import http from 'http';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = 3000;

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

let browser = null;
let page = null;

async function initPuppeteer() {
    browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.goto('http://localhost:3000/render.html');
}

wss.on('connection', async (ws) => {
    console.log('Client connected');
    
    if (!browser || !page) {
        await initPuppeteer();
    }

    // 从服务端发送场景更新到客户端
    const renderInterval = setInterval(async () => {
        try {
            const screenshot = await page.screenshot({
                encoding: 'base64'
            });
            ws.send(JSON.stringify({ type: 'render', data: screenshot }));
        } catch (error) {
            console.error('Screenshot error:', error);
        }
    }, 1000 / 30); // 30 FPS

    // 处理来自客户端的交互事件
    ws.on('message', async (message) => {
        try {
            const event = JSON.parse(message);
            if (event.type === 'interaction') {
                await page.evaluate((data) => {
                    // window.handleServerEvent(data);
                }, event.data);
            }
        } catch (error) {
            console.error('Event processing error:', error);
        }
    });

    ws.on('close', () => {
        clearInterval(renderInterval);
        console.log('Client disconnected');
    });
});

process.on('SIGINT', async () => {
    if (browser) {
        await browser.close();
    }
    process.exit();
});

app.use(express.static('public'));

// 使用server.listen代替app.listen，确保WebSocket和HTTP服务器使用相同的端口
server.listen(port, () => {
    console.log(`服务器运行在 http://localhost:${port}`);
});