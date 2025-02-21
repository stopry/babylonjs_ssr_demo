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
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        protocolTimeout: 1000*5  // 增加协议超时时间到 30 秒
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1260, height: 919 });
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

    // 将数字按钮值转换为 Puppeteer 支持的字符串
    const getButtonType = (button) => {
        switch(button) {
            case 0: return 'left';
            case 1: return 'middle';
            case 2: return 'right';
            default: return 'left';
        }
    };

    // 处理来自客户端的交互事件
    ws.on('message', async (message) => {
        try {
            const event = JSON.parse(message);
            if (event.type === 'interaction') {
                if (event.data.type === 'input') {
                    // 处理 input 输入事件
                    await page.evaluate((data) => {
                        const element = document.querySelector(data.selector);
                        if (element) {
                            element.value = data.value;
                            // 触发 input 事件
                            const inputEvent = new Event('input', { bubbles: true });
                            element.dispatchEvent(inputEvent);
                            // 触发 change 事件
                            const changeEvent = new Event('change', { bubbles: true });
                            element.dispatchEvent(changeEvent);
                        }
                    }, event.data);
                }
                else if (event.data.type === 'keydown') {
                    await page.keyboard.down(event.data.key);
                }
                else if (event.data.type === 'keyup') {
                    await page.keyboard.up(event.data.key);
                }
                // 处理鼠标按下事件
                else if (event.data.type === 'mousedown') {
                    await page.mouse.down({button: getButtonType(event.data.button)});
                }
                // 处理鼠标释放事件
                else if (event.data.type === 'mouseup') {
                    await page.mouse.up({button: getButtonType(event.data.button)});
                }
                // 处理鼠标移动事件
                else if (event.data.type === 'mousemove') {
                    await page.mouse.move(event.data.x, event.data.y);
                }
                // 处理鼠标滚轮事件
                else if (event.data.type === 'wheel') {
                    await page.mouse.wheel({deltaY: event.data.deltaY});
                }
            }else if (event.type === 'serverMethod') {
                // 处理来自 render.html 的方法调用
                switch(event.method) {
                    case 'buttonClick':
                        await page.goto('http://localhost:3000/index.html');
                        // 在这里添加你想要在服务器端执行的逻辑
                        break;
                    // 可以添加更多方法处理
                }
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